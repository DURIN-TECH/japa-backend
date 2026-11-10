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
 *
 * Run record (issue #81): the run is recorded like a scheduled one, as a
 * `scrapeRuns/{runId}` doc with kind "visa" and trigger "script" (written
 * `running` before the FX refresh, finalised at the end with the counters,
 * per-source and per-page outcomes and the first errors; `failed` if the
 * script crashes). The script options (country, visa, limit, ...) are stored
 * as `options`. Stale `running` runs older than 1h are swept to `failed`
 * first, as on every scheduled tick. The run id is printed at the end.
 */
import * as fs from "fs";
import * as path from "path";
// Type-only import: erased at compile time, so it doesn't trigger Firebase init
// before the env below is set.
import type { VisaSource } from "../types/visa-catalog";
import type { VisaType } from "../types";
import type { ScrapeRunRecorder } from "../services/scrape-run.service";
import type { ScrapeRunPageOutcome, ScrapeRunSourceStatus } from "../types/scrape-run";

// The run record of this invocation (issue #81), module-level so the crash
// handler at the bottom can mark it failed. Unset until the run starts.
let activeRecorder: ScrapeRunRecorder | undefined;

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

  // ---- Run record (issue #81) ----
  // Same recorder as the orchestrator. Sweep crashed runs first, then start
  // ours as `running` before any FX / fetch / LLM work.
  const { scrapeRunService } = await import("../services/scrape-run.service");
  await scrapeRunService.sweepStaleRuns();
  const recorder = await scrapeRunService.start({
    kind: "visa",
    trigger: "script",
    options: {
      country: args.country,
      visa: args.visa,
      limit: args.limit,
      maxExtractions: args.maxExtractions,
      force: args.force,
    },
  });
  activeRecorder = recorder;

  // Pick sources: one country, or all.
  const sourcesSnap = args.country
    ? await collections.visaSources.where("countryCode", "==", args.country).get()
    : await collections.visaSources.get();
  if (sourcesSnap.empty) {
    const msg = `No visaSources found${args.country ? ` for ${args.country}` : ""}. Seed first.`;
    console.error(msg);
    await recorder.fail(new Error(msg));
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
  // Re-converted fee count, for the run record's feesReconverted (#81).
  let reconverted = 0;
  try {
    const reconvert = await visaCatalogService.reconvertFlaggedFees(fx);
    reconverted = reconvert.reconverted;
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
    // Issue #81 (run record): pages whose hash changed (sent to extraction),
    // hosts that answered 429/503 and linked-surcharge failures — the
    // orchestrator's CrawlSummary counters the script did not keep before.
    pagesChanged: 0,
    hostsBackedOff: 0,
    linkedSurchargeErrors: 0,
    sourcesProcessed: 0,
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
    // Filter pages by --visa name if provided.
    const pages = source.pages.filter(
      (p) => !args.visa || p.routeName.toLowerCase().includes(args.visa)
    );
    // ---- Per-source run-record tallies (issue #81) ----
    const src = { attempted: 0, fetched: 0, errors: 0, deferred: 0 };
    const srcCounts: Record<string, number> = {};
    // Note one page outcome on the run record + this source's tallies.
    const notePage = (
      page: (typeof pages)[number],
      outcome: ScrapeRunPageOutcome,
      extra: { visaId?: string; error?: string } = {}
    ) => {
      src.attempted++;
      srcCounts[outcome] = (srcCounts[outcome] ?? 0) + 1;
      recorder.recordPage({ sourceId: source.countryCode, url: page.url, routeName: page.routeName, outcome, ...extra });
    };
    for (const page of pages) {
      if (processed >= args.limit) break;
      processed++;
      // Host backed off (this run, or a stored retry-after still ahead)?
      // Skip without any request.
      const blocking = hostState.blocking(hostOf(page.url));
      if (blocking) {
        totals.deferred++;
        src.deferred++;
        notePage(page, "deferred", { error: backoffMessage(blocking) });
        console.log(`\n[${source.countryCode}] ${page.routeName}\n  -> skipped: ${backoffMessage(blocking)}`);
        continue;
      }
      // The resolved catalog id, once known (for the page's run-record line).
      let pageVisaId: string | undefined;
      // Same hash but re-extracted for a newer prompt (#71) — not a content change.
      let promptReextract = false;
      try {
        console.log(`\n[${source.countryCode}] ${page.routeName}\n  ${page.url}`);
        // Resolve the record id BEFORE fetching/extracting (same rule as the
        // scheduled orchestrator): pinned `visaId`, else the URL path, never
        // extraction output. A page with no derivable id (empty path, bad URL)
        // throws here and is counted as an error without costing an LLM call.
        const resolvedVisaId = visaCatalogService.buildVisaId(source.countryCode, page.url, {
          visaId: page.visaId,
        });
        pageVisaId = resolvedVisaId;
        // Fetch through the source's adapter (same choice as the orchestrator).
        const adapter = pickSourceAdapter(source.adapter, page.url);
        const fetched = await adapter.fetch(page);
        totals.fetched++;
        src.fetched++;
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
          notePage(page, "withdrawn", { visaId: resolvedVisaId });
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
        let linked;
        try {
          linked = await linkedSurcharges.forPage(page);
        } catch (err) {
          // Counted like the orchestrator's linkedSurchargeErrors (#69), then
          // handled as a normal page error below.
          totals.linkedSurchargeErrors++;
          throw err;
        }
        const gateHash = linkedGateHash(fetched.contentHash, linked);
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
              notePage(page, "unchanged", { visaId: resolvedVisaId });
              console.log(`  -> unchanged (hash gate, no extraction): ${resolvedVisaId}`);
              continue;
            }
            totals.promptReextracts++;
            promptReextract = true;
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
            notePage(page, "unchanged", { visaId: resolvedVisaId });
            console.log(`  -> unchanged (approved doc, text already crawled/proposed, no extraction): ${resolvedVisaId}`);
            continue;
          }
        }

        // Extraction cap: every LLM call counts, counted BEFORE the call so a
        // failing call (API / validation error) also uses up a slot.
        if (extractionsUsed >= args.maxExtractions) {
          notePage(page, "capped", { visaId: resolvedVisaId });
          console.log(`  -> skipped: --max-extractions ${args.maxExtractions} reached`);
          continue;
        }
        extractionsUsed++;
        // A content change unless this is a #71 prompt re-extract (counted
        // above). Under --force a same-text page also counts (approximate).
        if (!promptReextract) totals.pagesChanged++;
        const extracted = await visaCatalogExtractor.extract(fetched.text, {
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
        });
        totals[outcome]++;
        notePage(page, outcome, { visaId });
        console.log(`  -> ${outcome}: ${visaId} (conf ${Math.round(extracted.confidence * 100)}%)`);
      } catch (err) {
        totals.errors++;
        src.errors++;
        // Issue #81: on the run record (redacted there).
        recorder.recordError({ sourceId: source.countryCode, url: page.url, error: err });
        notePage(page, "error", { visaId: pageVisaId, error: (err as Error)?.message ?? String(err) });
        // 429/503: stop requesting this host for the rest of the manual run.
        // Recorded against the answering host, the requested host and the
        // page host (see the orchestrator's catch for why all three).
        if (isHostBackoffError(err)) {
          const entry = err.toEntry(Date.now());
          if (!hostState.isFresh(entry.host)) totals.hostsBackedOff++;
          for (const h of new Set([entry.host, err.requestedHost, hostOf(page.url)])) {
            if (h) hostState.record({ ...entry, host: h });
          }
        }
        console.log(`  -> ERROR: ${(err as Error).message}`);
      }
    }
    // ---- This source's run-record line (issue #81) ----
    // Same rule as the orchestrator's per-source status. A source the
    // --visa filter left with no pages, or reached after --limit, is not
    // recorded (it was not attempted).
    if (src.attempted > 0) {
      totals.sourcesProcessed++;
      let status: ScrapeRunSourceStatus;
      if (src.deferred === src.attempted) status = "deferred";
      else if (src.fetched === 0) status = "failed";
      else if (src.errors === 0) status = "succeeded";
      else status = "partial";
      recorder.recordSource({
        sourceId: source.countryCode,
        name: source.countryName,
        status,
        pagesAttempted: src.attempted,
        pagesFetched: src.fetched,
        errors: src.errors,
        counts: srcCounts,
      });
    }
    if (processed >= args.limit) break;
  }

  console.log(
    `\nDone. fetched ${totals.fetched} | created ${totals.created} | updated ${totals.updated} | ` +
      `unchanged ${totals.unchanged} | skipped ${totals.skipped} | proposed ${totals.proposed} | ` +
      `withdrawn ${totals.withdrawn} | restored ${totals.restored} | errors ${totals.errors} | host backed off ${totals.deferred} | ` +
      `prompt re-extracts ${totals.promptReextracts}`
  );
  // ---- Finalise the run record (issue #81) ----
  // Stored in the orchestrator's CrawlSummary vocabulary (pagesFetched,
  // pagesDeferred, ...) so script and scheduled runs read the same, plus the
  // script-only `unchanged` count.
  const finalRun = await recorder.finalize({
    summary: {
      sourcesProcessed: totals.sourcesProcessed,
      pagesFetched: totals.fetched,
      pagesChanged: totals.pagesChanged,
      promptReextracts: totals.promptReextracts,
      created: totals.created,
      updated: totals.updated,
      skipped: totals.skipped,
      proposed: totals.proposed,
      withdrawn: totals.withdrawn,
      restored: totals.restored,
      errors: totals.errors,
      fxRefreshed: fxRefresh.refreshed,
      feesReconverted: reconverted,
      hostsBackedOff: totals.hostsBackedOff,
      pagesDeferred: totals.deferred,
      linkedSurchargeErrors: totals.linkedSurchargeErrors,
      unchanged: totals.unchanged,
    },
    anySuccess: totals.fetched > 0,
  });
  activeRecorder = undefined;
  console.log(`Run record: scrapeRuns/${recorder.id} (${finalRun?.status ?? "not recorded"})`);
  console.log("Review pending scraped visas at: admin → Visa Review (filter source=scraped).");
  // Proposed edits to approved visas have no portal UI yet (follow-up issue).
  if (totals.proposed > 0) console.log("Proposed edits to approved visas: GET /admin/visa-changes?status=open");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("Crawl failed:", e);
  // Issue #81: a crash after the run started marks its record failed
  // (redacted message). If this write also fails, the next run's stale
  // sweep marks it failed after 1h.
  if (activeRecorder) await activeRecorder.fail(e);
  process.exit(1);
});
