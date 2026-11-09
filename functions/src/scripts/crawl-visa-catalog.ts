/**
 * Manual visa-catalog crawl — fetch + extract + ingest on demand.
 *
 * Runs the same fetch → extract → ingest pipeline as the scheduled orchestrator,
 * but scoped to a country and/or a visa name you pass in, so you can test or
 * force a refresh without waiting for the weekly tick. Ingested visas land in
 * countries/{code}/visaTypes as reviewStatus="pending_review" / source="scraped"
 * and show up in the admin visa-review page for approval.
 *
 * Fetching uses the source's adapter (VisaSource.adapter: govuk-content-api for
 * GB, generic-html otherwise), exactly like the orchestrator.
 *
 * Hash gate: before calling the LLM, the fetched content hash is compared with
 * the `scrapeMeta.contentHash` on the existing doc at the resolved id; when
 * equal the page is reported "unchanged (hash gate)" and NO extraction runs.
 * Pass --force to extract anyway.
 *
 * Withdrawn pages (GOV.UK `withdrawn_notice`) are never extracted: a scraped
 * doc at the resolved id is deactivated (isActive:false + staleSince, set
 * once); seeded/agent docs are never touched; nothing is created.
 *
 * Usage (after `npm run build`, or with `npx tsx src/scripts/crawl-visa-catalog.ts`):
 *   node lib/scripts/crawl-visa-catalog.js --country GB
 *   node lib/scripts/crawl-visa-catalog.js --visa "skilled worker"
 *   node lib/scripts/crawl-visa-catalog.js --country GB --visa "student" --limit 3
 *   node lib/scripts/crawl-visa-catalog.js --country GB --limit 2 --force
 *   node lib/scripts/crawl-visa-catalog.js --country GB --project durin-seli-dev
 *
 * Needs DEEPSEEK_API_KEY (loaded from functions/.env.local automatically) and a
 * Firestore target (an emulator via FIRESTORE_EMULATOR_HOST, or --project <id>).
 * At least one of --country / --visa is required so it never crawls everything
 * by accident.
 */
import * as fs from "fs";
import * as path from "path";
// Type-only import: erased at compile time, so it doesn't trigger Firebase init
// before the env below is set.
import type { VisaSource } from "../types/visa-catalog";
import type { VisaType } from "../types";

// ---- CLI args ----
function parseArgs(argv: string[]) {
  // `force`: skip the hash gate and always extract.
  const out: { country?: string; visa?: string; project?: string; limit: number; force: boolean } = {
    limit: 25,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--country") out.country = argv[++i]?.toUpperCase();
    else if (a === "--visa") out.visa = argv[++i]?.toLowerCase();
    else if (a === "--project" || a === "-p") out.project = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i] || "25", 10);
    else if (a === "--force") out.force = true;
  }
  return out;
}

// Load functions/.env.local into process.env (node scripts don't auto-load it,
// unlike the Functions runtime). Only sets keys that aren't already present.
function loadLocalEnv() {
  const file = path.resolve(__dirname, "../../.env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.country && !args.visa) {
    console.error("\n❌ Pass --country <CODE> and/or --visa <name>.\n");
    process.exit(1);
  }

  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("\n❌ DEEPSEEK_API_KEY not set (add it to functions/.env.local).\n");
    process.exit(1);
  }

  // Resolve the Firestore target (mirrors seed-all: no silent prod default).
  const onEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const projectId =
    args.project ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    (onEmulator ? "demo-seli" : undefined);
  if (!projectId) {
    console.error("\n❌ No project. Pass --project <id> or run against an emulator.\n");
    process.exit(1);
  }
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;

  // Import AFTER env is set so utils/firebase initializes against this project.
  await import("../utils/firebase");
  const { collections, subcollections } = await import("../utils/firebase");
  const { pickSourceAdapter, sourceMetaFromDocument } = await import(
    "../services/visa-source-adapters"
  );
  const { visaCatalogExtractor } = await import("../services/visa-catalog-extract.service");
  const { visaCatalogService } = await import("../services/visa-catalog.service");

  // Pick sources: one country, or all.
  const sourcesSnap = args.country
    ? await collections.visaSources.where("countryCode", "==", args.country).get()
    : await collections.visaSources.get();
  if (sourcesSnap.empty) {
    console.error(`No visaSources found${args.country ? ` for ${args.country}` : ""}. Seed first.`);
    process.exit(1);
  }

  let processed = 0;
  // `unchanged` also counts hash-gate skips (no LLM call); `withdrawn` = pages
  // the source marked withdrawn (never extracted).
  const totals = {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    withdrawn: 0,
    errors: 0,
  };

  for (const doc of sourcesSnap.docs) {
    // Registry doc; pages are full VisaSourcePage objects so the pinned
    // `visaId` / `visaCode` (registry-owned identity) reach ingestExtraction.
    const source = doc.data() as Pick<VisaSource, "countryCode" | "countryName" | "pages" | "adapter">;
    // Filter pages by --visa name if provided.
    const pages = source.pages.filter(
      (p) => !args.visa || p.routeName.toLowerCase().includes(args.visa)
    );
    for (const page of pages) {
      if (processed >= args.limit) break;
      processed++;
      try {
        console.log(`\n[${source.countryCode}] ${page.routeName}\n  ${page.url}`);
        // Resolve the record id BEFORE fetching/extracting (same rule as the
        // scheduled orchestrator): pinned `visaId`, else the URL path, never
        // extraction output. A page with no derivable id (empty path, bad URL)
        // throws here and is counted as an error without costing an LLM call.
        const resolvedVisaId = visaCatalogService.buildVisaId(source.countryCode, page.url, {
          visaId: page.visaId,
        });
        // Fetch through the source's adapter (same choice as the orchestrator).
        const adapter = pickSourceAdapter(source.adapter, page.url);
        const fetched = await adapter.fetch(page);
        totals.fetched++;
        console.log(
          `  adapter ${adapter.id} | ${fetched.text.length} chars | hash ${fetched.contentHash.slice(0, 12)}` +
            (fetched.sections.length && adapter.id !== "generic-html"
              ? ` | sections ${fetched.sections.map((s) => s.slug).join(",")}`
              : "") +
            (fetched.truncated ? " | TRUNCATED" : "")
        );

        // Withdrawn at source → never extract (see header).
        if (fetched.withdrawn) {
          const result = await visaCatalogService.markWithdrawn(source.countryCode, resolvedVisaId);
          totals.withdrawn++;
          console.log(`  -> withdrawn on source: ${resolvedVisaId} (${result})`);
          continue;
        }

        // Hash gate: same text as the stored extraction → no LLM call.
        if (!args.force) {
          const existingSnap = await subcollections
            .visaTypes(source.countryCode)
            .doc(resolvedVisaId)
            .get();
          const existing = existingSnap.exists ? (existingSnap.data() as VisaType) : undefined;
          if (existing?.scrapeMeta?.contentHash === fetched.contentHash) {
            totals.unchanged++;
            console.log(`  -> unchanged (hash gate, no extraction): ${resolvedVisaId}`);
            continue;
          }
        }

        const extracted = await visaCatalogExtractor.extract(fetched.text, {
          url: page.url,
          countryName: source.countryName,
          routeName: page.routeName,
        });
        const { visaId, outcome } = await visaCatalogService.ingestExtraction({
          countryCode: source.countryCode,
          sourceUrl: page.url,
          routeName: page.routeName,
          contentHash: fetched.contentHash,
          extracted,
          model: visaCatalogExtractor.model,
          // Registry-owned identity: the id resolved above (used verbatim by
          // ingest, not recomputed) + the pinned code, if any.
          visaId: resolvedVisaId,
          visaCode: page.visaCode,
          // Adapter provenance for scrapeMeta.
          sourceMeta: sourceMetaFromDocument(fetched),
        });
        totals[outcome]++;
        console.log(`  -> ${outcome}: ${visaId} (conf ${Math.round(extracted.confidence * 100)}%)`);
      } catch (err) {
        totals.errors++;
        console.log(`  -> ERROR: ${(err as Error).message}`);
      }
    }
    if (processed >= args.limit) break;
  }

  console.log(
    `\nDone. fetched ${totals.fetched} | created ${totals.created} | updated ${totals.updated} | ` +
      `unchanged ${totals.unchanged} | skipped ${totals.skipped} | withdrawn ${totals.withdrawn} | ` +
      `errors ${totals.errors}`
  );
  console.log("Review pending scraped visas at: admin → Visa Review (filter source=scraped).");
  process.exit(0);
}

main().catch((e) => {
  console.error("Crawl failed:", e);
  process.exit(1);
});
