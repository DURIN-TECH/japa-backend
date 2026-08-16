/**
 * Manual visa-catalog crawl — fetch + extract + ingest on demand.
 *
 * Runs the same fetch → extract → ingest pipeline as the scheduled orchestrator,
 * but scoped to a country and/or a visa name you pass in, so you can test or
 * force a refresh without waiting for the weekly tick. Ingested visas land in
 * countries/{code}/visaTypes as reviewStatus="pending_review" / source="scraped"
 * and show up in the admin visa-review page for approval.
 *
 * Usage (after `npm run build`):
 *   node lib/scripts/crawl-visa-catalog.js --country GB
 *   node lib/scripts/crawl-visa-catalog.js --visa "skilled worker"
 *   node lib/scripts/crawl-visa-catalog.js --country GB --visa "student" --limit 3
 *   node lib/scripts/crawl-visa-catalog.js --country GB --project durin-seli-dev
 *
 * Needs DEEPSEEK_API_KEY (loaded from functions/.env.local automatically) and a
 * Firestore target (an emulator via FIRESTORE_EMULATOR_HOST, or --project <id>).
 * At least one of --country / --visa is required so it never crawls everything
 * by accident.
 */
import * as fs from "fs";
import * as path from "path";

// ---- CLI args ----
function parseArgs(argv: string[]) {
  const out: { country?: string; visa?: string; project?: string; limit: number } = {
    limit: 25,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--country") out.country = argv[++i]?.toUpperCase();
    else if (a === "--visa") out.visa = argv[++i]?.toLowerCase();
    else if (a === "--project" || a === "-p") out.project = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i] || "25", 10);
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
  const { collections } = await import("../utils/firebase");
  const { visaCatalogFetchService } = await import("../services/visa-catalog-fetch.service");
  const { visaCatalogExtractor } = await import("../services/visa-catalog-extract.service");
  const { visaCatalogService } = await import("../services/visa-catalog.service");
  const { VisaSource } = { VisaSource: null }; // (type only; not needed at runtime)
  void VisaSource;

  // Pick sources: one country, or all.
  const sourcesSnap = args.country
    ? await collections.visaSources.where("countryCode", "==", args.country).get()
    : await collections.visaSources.get();
  if (sourcesSnap.empty) {
    console.error(`No visaSources found${args.country ? ` for ${args.country}` : ""}. Seed first.`);
    process.exit(1);
  }

  let processed = 0;
  const totals = { fetched: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };

  for (const doc of sourcesSnap.docs) {
    const source = doc.data() as {
      countryCode: string;
      countryName: string;
      pages: { url: string; routeName: string }[];
    };
    // Filter pages by --visa name if provided.
    const pages = source.pages.filter(
      (p) => !args.visa || p.routeName.toLowerCase().includes(args.visa)
    );
    for (const page of pages) {
      if (processed >= args.limit) break;
      processed++;
      try {
        console.log(`\n[${source.countryCode}] ${page.routeName}\n  ${page.url}`);
        const fetched = await visaCatalogFetchService.fetchAndClean(page.url, { checkRobots: true });
        totals.fetched++;
        const extracted = await visaCatalogExtractor.extract(fetched.cleanText, {
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
      `unchanged ${totals.unchanged} | skipped ${totals.skipped} | errors ${totals.errors}`
  );
  console.log("Review pending scraped visas at: admin → Visa Review (filter source=scraped).");
  process.exit(0);
}

main().catch((e) => {
  console.error("Crawl failed:", e);
  process.exit(1);
});
