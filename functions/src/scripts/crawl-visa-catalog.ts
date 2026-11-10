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
 * Exception (issue #71): a PENDING scraped doc whose
 * `scrapeMeta.extractorPromptVersion` differs from EXTRACTOR_PROMPT_VERSION is
 * re-extracted anyway (within --max-extractions). For an APPROVED scraped doc
 * (whose live hash ingest never updates — a changed page becomes a #61
 * proposal) the text also counts as unchanged when it equals the registry
 * page's `lastContentHash` or a pendingVisaChanges row was already made from
 * it (issue #68), so it is not re-extracted on every run. Pass --force to
 * extract anyway.
 *
 * Restored guides (issue #68): a scraped visa that was deactivated as
 * withdrawn and was approved goes back to pending_review when its page is
 * live again (admin → Visa Review shows it); it is never reactivated.
 *
 * FX (issue #59): `appConfig/fx` is refreshed once at the start of the run
 * (Frankfurter / ECB), flagged pending fees are re-converted, and each
 * extracted fee is converted to `baseCostUsd` in code.
 *
 * Withdrawn pages (GOV.UK `withdrawn_notice`) are never extracted: a scraped
 * doc at the resolved id is deactivated (isActive:false + staleSince, set
 * once); seeded/agent docs are never touched; nothing is created.
 *
 * Host backoff (issue #64): a 429/503 from a host stops this run from
 * requesting that host again (its remaining pages are reported as skipped),
 * and pages on a host whose stored `hostBackoffs` retry-after time (written by
 * the scheduled orchestrator) is still ahead are skipped too. This script does
 * NOT write source health, so it neither persists a new backoff nor counts a
 * failure — the scheduled orchestrator owns that.
 *
 * Usage (after `npm run build`, or with `npx tsx src/scripts/crawl-visa-catalog.ts`):
 *   node lib/scripts/crawl-visa-catalog.js --country GB
 *   node lib/scripts/crawl-visa-catalog.js --visa "skilled worker"
 *   node lib/scripts/crawl-visa-catalog.js --country GB --visa "student" --limit 3
 *   node lib/scripts/crawl-visa-catalog.js --country GB --limit 2 --force
 *   node lib/scripts/crawl-visa-catalog.js --country GB --max-extractions 3
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
  // `maxExtractions`: cap on LLM calls this run (every call counts, success
  // or failure — same rule as the orchestrator's maxExtractions).
  const out: {
    country?: string;
    visa?: string;
    project?: string;
    limit: number;
    maxExtractions: number;
    force: boolean;
  } = {
    limit: 25,
    maxExtractions: 25,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--country") out.country = argv[++i]?.toUpperCase();
    else if (a === "--visa") out.visa = argv[++i]?.toLowerCase();
    else if (a === "--project" || a === "-p") out.project = argv[++i];
    else if (a === "--limit") out.limit = parseInt(argv[++i] || "25", 10);
    else if (a === "--force") out.force = true;
    else if (a === "--max-extractions") out.maxExtractions = parseInt(argv[++i] || "25", 10);
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
  const { visaCatalogExtractor, EXTRACTOR_PROMPT_VERSION } = await import(
    "../services/visa-catalog-extract.service"
  );
  // Pure prompt-version rule shared with the orchestrator (issue #71).
  const { isPendingPromptStale, isApprovedTextAlreadyHandled } = await import(
    "../services/visa-catalog-diff"
  );
  // Proposal lookup for the approved-doc hash gate (issue #68).
  const { visaChangeService } = await import("../services/visa-catalog-changes.service");
  const { visaCatalogService } = await import("../services/visa-catalog.service");
  // Pure host-backoff helper (issue #64): same skip rules as the orchestrator.
  const { HostBackoffTracker, backoffMessage, hostOf, isHostBackoffError } = await import(
    "../services/visa-crawl-host-state"
  );
  // Same Firestore -> helper mapper as the orchestrator (one implementation).
  const { hostBackoffEntriesFromSource } = await import("../services/visa-crawl-host-backoff-store");
  // One tracker for the whole manual run (shared across countries).
  const hostState = new HostBackoffTracker(Date.now());
  // Linked surcharge pages (issue #69, e.g. UK IHS): fetched at most once per
  // manual run, same rules as the orchestrator (skipped if the host backed off).
  const { LinkedSurchargeCache, linkedGateHash, linkedSurchargePage } = await import(
    "../services/visa-catalog-linked-surcharge"
  );
  const linkedSurcharges = new LinkedSurchargeCache(async (cfg) => {
    const blocked = hostState.blocking(hostOf(cfg.url));
    if (blocked) throw new Error(`linked surcharge page not fetched: ${backoffMessage(blocked)}`);
    return pickSourceAdapter(cfg.adapter, cfg.url).fetch(linkedSurchargePage(cfg));
  });

  // Supplementary pages (issue #86): same helpers as the orchestrator.
  const {
    SupplementaryPageCache,
    combineSupplementaryText,
    supplementaryGateHash,
    supplementaryPagesMeta,
  } = await import("../services/visa-catalog-supplementary");

  // Pick sources: one country, or all.
  const sourcesSnap = args.country
    ? await collections.visaSources.where("countryCode", "==", args.country).get()
    : await collections.visaSources.get();
  if (sourcesSnap.empty) {
    console.error(`No visaSources found${args.country ? ` for ${args.country}` : ""}. Seed first.`);
    process.exit(1);
  }

  // ---- FX: refresh appConfig/fx once per run, before extraction (issue #59) ----
  // Same as the orchestrator: on failure the previous doc is kept; then
  // pending scraped visas whose fee was flagged stale/missing are
  // re-converted from their stored components (no LLM call).
  const fxRefresh = await visaCatalogService.refreshFx();
  const fx = fxRefresh.fx;
  console.log(
    fxRefresh.refreshed
      ? `FX: refreshed appConfig/fx (ECB date ${fx?.rateDate})`
      : `FX: refresh FAILED (${fxRefresh.error}); using previous appConfig/fx: ${fx ? fx.rateDate : "none"}`
  );
  // A failed re-convert must not abort the manual run (same as the orchestrator).
  try {
    const reconvert = await visaCatalogService.reconvertFlaggedFees(fx);
    console.log(`FX: re-converted ${reconvert.reconverted} flagged fee(s), re-flagged ${reconvert.reflagged}`);
  } catch (err) {
    console.error(`FX: re-converting flagged fees FAILED (continuing): ${(err as Error).message}`);
  }

  // LLM calls made this run (successful or not), capped by --max-extractions.
  let extractionsUsed = 0;

  let processed = 0;
  // `unchanged` also counts hash-gate skips (no LLM call); `withdrawn` = pages
  // the source marked withdrawn (never extracted).
  const totals = {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    // Approved scraped visa whose page changed → pendingVisaChanges row (issue #61).
    proposed: 0,
    withdrawn: 0,
    // Withdrawn scraped visa whose guide is live again → pending_review (issue #68).
    restored: 0,
    errors: 0,
    deferred: 0, // pages skipped: host backed off (issue #64)
    // Same hash, but the pending doc came from an older prompt → re-extracted (issue #71).
    promptReextracts: 0,
  };

  for (const doc of sourcesSnap.docs) {
    // Registry doc; pages are full VisaSourcePage objects so the pinned
    // `visaId` / `visaCode` (registry-owned identity) reach ingestExtraction.
    const source = doc.data() as Pick<
      VisaSource,
      "countryCode" | "countryName" | "pages" | "adapter" | "hostBackoffs"
    >;
    // Stored retry-after times from the scheduled crawl (Firestore Timestamps
    // -> the helper's ms form; malformed entries ignored).
    hostState.load(hostBackoffEntriesFromSource(source.hostBackoffs));
    // Supplementary pages (issue #86): one cache per source (its adapter),
    // each fetched at most once, skipped when its host is backed off.
    const supplements = new SupplementaryPageCache(async (suppPage) => {
      const blocked = hostState.blocking(hostOf(suppPage.url));
      if (blocked) throw new Error(`supplementary page not fetched: ${backoffMessage(blocked)}`);
      return pickSourceAdapter(source.adapter, suppPage.url).fetch(suppPage);
    });
    // Filter pages by --visa name if provided. Supplement-only rows (#86, e.g.
    // a fee table) are not visas: never extracted on their own.
    const pages = source.pages.filter(
      (p) => !p.supplementOnly && (!args.visa || p.routeName.toLowerCase().includes(args.visa))
    );
    for (const page of pages) {
      if (processed >= args.limit) break;
      processed++;
      // Host backed off (this run, or a stored retry-after still ahead)?
      // Skip without any request.
      const blocking = hostState.blocking(hostOf(page.url));
      if (blocking) {
        totals.deferred++;
        console.log(`\n[${source.countryCode}] ${page.routeName}\n  -> skipped: ${backoffMessage(blocking)}`);
        continue;
      }
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

        // Restored at source (issue #68, same rule as the orchestrator): a
        // withdrawn + approved scraped doc goes back to pending_review so an
        // admin sees it. Before the hash gate → independent of the hash.
        if ((await visaCatalogService.markRestored(source.countryCode, resolvedVisaId)).outcome === "flagged") {
          totals.restored++;
          console.log(`  -> guide restored on source: ${resolvedVisaId} back to pending_review`);
        }

        // Linked surcharges (issue #69): [] for an unmarked page. The gate
        // hash folds the linked pages' hashes in (same as the orchestrator).
        const linked = await linkedSurcharges.forPage(page);
        // Supplementary pages (issue #86): resolved against the FULL page
        // list (supplements are filtered out of `pages` above).
        const supps = await supplements.forPage(page, source.pages);
        if (supps.length) console.log(`  supplementary pages: ${supps.map((s) => s.page.url).join(", ")}`);
        const extractText = combineSupplementaryText(fetched.text, supps);
        const gateHash = linkedGateHash(supplementaryGateHash(fetched.contentHash, supps), linked);
        if (linked.length) console.log(`  linked surcharges: ${linked.map((l) => l.resolved.id).join(", ")}`);

        // Hash gate: same text as the stored extraction → no LLM call.
        if (!args.force) {
          const existingSnap = await subcollections
            .visaTypes(source.countryCode)
            .doc(resolvedVisaId)
            .get();
          const existing = existingSnap.exists ? (existingSnap.data() as VisaType) : undefined;
          if (existing?.scrapeMeta?.contentHash === gateHash) {
            // Same text — but a PENDING scraped doc from an older extractor
            // prompt is re-extracted anyway (issue #71, same rule as the
            // orchestrator). Approved / seeded / agent docs never qualify.
            // Still counted against --max-extractions below.
            if (!isPendingPromptStale(existing, EXTRACTOR_PROMPT_VERSION)) {
              totals.unchanged++;
              console.log(`  -> unchanged (hash gate, no extraction): ${resolvedVisaId}`);
              continue;
            }
            totals.promptReextracts++;
            console.log(
              "  -> same hash, but extracted with prompt " +
                `${existing.scrapeMeta?.extractorPromptVersion ?? "(none)"} ≠ ${EXTRACTOR_PROMPT_VERSION}: re-extracting`
            );
          } else if (
            // Approved doc (issue #68): its live hash never moves on ingest,
            // so the text also counts as handled when the orchestrator
            // already processed it (registry page hash) or a proposal row
            // was made from it. The second clause passes
            // `hasProposalForHash: true` only to ask "is this a proposable
            // approved doc?" BEFORE spending the Firestore query, so the
            // query runs only for approved docs the cheap check missed.
            isApprovedTextAlreadyHandled(existing, fetched.contentHash, {
              pageLastContentHash: page.lastContentHash,
            }) ||
            (isApprovedTextAlreadyHandled(existing, fetched.contentHash, { hasProposalForHash: true }) &&
              (await visaChangeService.hasProposalForHash(source.countryCode, resolvedVisaId, fetched.contentHash)))
          ) {
            totals.unchanged++;
            console.log(`  -> unchanged (approved doc, text already crawled/proposed, no extraction): ${resolvedVisaId}`);
            continue;
          }
        }

        // Extraction cap: every LLM call counts, counted BEFORE the call so a
        // failing call (API / validation error) also uses up a slot.
        if (extractionsUsed >= args.maxExtractions) {
          console.log(`  -> skipped: --max-extractions ${args.maxExtractions} reached`);
          continue;
        }
        extractionsUsed++;
        const extracted = await visaCatalogExtractor.extract(extractText, {
          url: page.url,
          countryName: source.countryName,
          routeName: page.routeName,
        });
        const { visaId, outcome } = await visaCatalogService.ingestExtraction({
          countryCode: source.countryCode,
          sourceUrl: page.url,
          routeName: page.routeName,
          contentHash: gateHash, // page hash unless linked surcharges apply (#69)
          extracted,
          model: visaCatalogExtractor.model,
          // Registry-owned identity: the id resolved above (used verbatim by
          // ingest, not recomputed) + the pinned code, if any.
          visaId: resolvedVisaId,
          visaCode: page.visaCode,
          // Adapter provenance for scrapeMeta.
          sourceMeta: sourceMetaFromDocument(fetched),
          // This run's rate doc: the fee is converted in code (issue #59).
          fx,
          // Linked-page surcharges for this route (issue #69).
          linkedSurcharges: linked,
          // Supplementary pages used (issue #86), for scrapeMeta.
          supplementaryPages: supplementaryPagesMeta(supps),
        });
        totals[outcome]++;
        console.log(`  -> ${outcome}: ${visaId} (conf ${Math.round(extracted.confidence * 100)}%)`);
        // Issue #86: say when uncited numbers were left out (never written as 0).
        if (extracted.processingUnknown) console.log("     processing time unknown (no cited figure): days omitted");
        if (extracted.uncitedFieldsDropped?.length) {
          console.log(`     uncited fields dropped: ${extracted.uncitedFieldsDropped.join(", ")}`);
        }
      } catch (err) {
        totals.errors++;
        // 429/503: stop requesting this host for the rest of the manual run.
        // Recorded against the answering host, the requested host and the
        // page host (see the orchestrator's catch for why all three).
        if (isHostBackoffError(err)) {
          const entry = err.toEntry(Date.now());
          for (const h of new Set([entry.host, err.requestedHost, hostOf(page.url)])) {
            if (h) hostState.record({ ...entry, host: h });
          }
        }
        console.log(`  -> ERROR: ${(err as Error).message}`);
      }
    }
    if (processed >= args.limit) break;
  }

  console.log(
    `\nDone. fetched ${totals.fetched} | created ${totals.created} | updated ${totals.updated} | ` +
      `unchanged ${totals.unchanged} | skipped ${totals.skipped} | proposed ${totals.proposed} | ` +
      `withdrawn ${totals.withdrawn} | restored ${totals.restored} | errors ${totals.errors} | host backed off ${totals.deferred} | ` +
      `prompt re-extracts ${totals.promptReextracts}`
  );
  console.log("Review pending scraped visas at: admin → Visa Review (filter source=scraped).");
  // Proposed edits to approved visas have no portal UI yet (follow-up issue).
  if (totals.proposed > 0) console.log("Proposed edits to approved visas: GET /admin/visa-changes?status=open");
  process.exit(0);
}

main().catch((e) => {
  console.error("Crawl failed:", e);
  process.exit(1);
});
