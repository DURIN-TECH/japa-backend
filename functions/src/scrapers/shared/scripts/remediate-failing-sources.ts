/**
 * One-off data fix for the five failing scraper sources (issue #107).
 *
 * The seed files (news/seed-news-sources.ts, the vendored
 * official_visa_links_verified_v3.md + visa-catalog/data/seed-visa-sources.ts)
 * now carry the fixes, but existing Firestore docs only change when they are
 * re-seeded. This script applies JUST these five sources, through the SAME
 * pure builders the seeders use, so the result is exactly what a re-seed
 * would write (admin `adminOverrides` kept, crawl state kept):
 *
 *   news/au-home-affairs        -> paused, statusReason (Akamai 403 on our bot UA, no feed)
 *   news/visa-reporter          -> retired, statusReason (domain does not resolve)
 *   news/cic-news               -> config.requestTimeoutMs 30000 + resetFailures
 *   news/newsdata-immigration   -> resetFailures (the next run pauses it with
 *                                  "missing API key" when the secret is absent,
 *                                  or runs it when it is set)
 *   visa/HK                     -> pages rebuilt from the markdown: the 404
 *                                  tech-professionals-stream.html row becomes
 *                                  TPStream.html, pinned to the old record id
 *
 * "resetFailures" = what `PATCH /admin/scrape-sources/:kind/:id
 * { "resetFailures": true }` does: consecutiveFailures 0, a source the crawler
 * held (`broken`, or `paused` + `autoPaused`) back to `active`, auto-pause
 * flags cleared. It is skipped when an admin set the status
 * (`adminOverrides.status`): the admin's choice wins.
 *
 * SAFETY
 *  - DRY RUN BY DEFAULT: prints the planned field changes and writes nothing.
 *    Pass `--apply` to write (one batch).
 *  - The target project must be named explicitly with GCLOUD_PROJECT (or an
 *    emulator via FIRESTORE_EMULATOR_HOST); there is no default project.
 *  - No network other than Firestore, no LLM call.
 *
 * Run (from functions/):
 *   npm run build
 *   GCLOUD_PROJECT=<project> node lib/scrapers/shared/scripts/remediate-failing-sources.js          # dry run
 *   GCLOUD_PROJECT=<project> node lib/scrapers/shared/scripts/remediate-failing-sources.js --apply  # write
 * or `npm run remediate:sources-107 -- [--apply]` with GCLOUD_PROJECT set.
 */
import * as fs from "fs";
import { Timestamp } from "firebase-admin/firestore";
import { NEWS_SOURCES, buildSeededNewsSource } from "../../news/seed-news-sources";
import {
  buildSeededVisaSource,
  findVisaSourcesMarkdown,
  parseVisaSourcesMarkdown,
} from "../../visa-catalog/data/seed-visa-sources";

// ============================================
// THE PLAN (pure, unit-tested)
// ============================================

/** News sources this fix touches (newsSources doc ids = seed slugs). */
export const REMEDIATED_NEWS_SOURCE_IDS = ["au-home-affairs", "visa-reporter", "cic-news", "newsdata-immigration"] as const;
/** News sources that also get the resetFailures treatment. */
export const RESET_NEWS_SOURCE_IDS = ["cic-news", "newsdata-immigration"] as const;
/** Visa sources this fix touches (visaSources doc ids = country codes). */
export const REMEDIATED_VISA_SOURCE_IDS = ["HK"] as const;

/** One planned doc write. */
export interface RemediationWrite {
  path: string; // e.g. "newsSources/cic-news"
  // The doc to write: merge for news (like the news seed), full overwrite
  // for visa (like the visa seed).
  doc: Record<string, unknown>;
  merge: boolean;
  // Human-readable field changes (for the dry run).
  changes: string[];
}

/** Deep copy with object keys sorted (stable JSON for comparisons). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
    );
  }
  return v;
}

/** Compact, comparable rendering of a field value for the dry-run output. */
function show(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return new Date((v as { toMillis(): number }).toMillis()).toISOString();
  }
  // FieldValue.delete() (a merge write removing the field) reads as absent.
  if (v && typeof v === "object" && v.constructor && v.constructor.name.includes("Transform")) return "(absent)";
  // Sorted keys: Firestore returns map fields in its own order, which must
  // not read as a change (keeps a re-run's dry run clean).
  const s = JSON.stringify(sortKeys(v));
  return s && s.length > 160 ? `${s.slice(0, 157)}...` : String(s);
}

/** Field-level diff of the top-level keys a write sets (dry-run output). */
function describeChanges(before: Record<string, unknown> | undefined, doc: Record<string, unknown>, keys?: string[]): string[] {
  const out: string[] = [];
  for (const key of keys ?? Object.keys(doc)) {
    if (key === "updatedAt") continue; // always refreshed, noise
    const a = show(before?.[key]);
    const b = show(doc[key]);
    if (a !== b) out.push(`${key}: ${a} -> ${b}`);
  }
  return out;
}

/**
 * The resetFailures part (mirrors scraperSettingsService.updateSource):
 * consecutiveFailures 0; a crawler-held source back to active; flags
 * cleared. Nothing when an admin set the status.
 */
export function resetFailuresFields(existing: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!existing) return {};
  const overrides = existing.adminOverrides as { status?: unknown } | undefined;
  if (overrides && typeof overrides.status === "string") return {};
  const out: Record<string, unknown> = { consecutiveFailures: 0 };
  const crawlerHeld = existing.status === "broken" || (existing.status === "paused" && existing.autoPaused === true);
  if (crawlerHeld) out.status = "active";
  if (existing.autoPaused === true) {
    Object.assign(out, { autoPaused: false, autoPausedAt: null, autoPausedReason: null, autoPauseCause: null });
  }
  return out;
}

/**
 * Build every write of the fix from the CURRENT docs (pure).
 *
 * @param existing  path -> stored doc (absent = no such doc: it is skipped,
 *                  this script never creates sources; run the seed for that)
 * @param markdown  the vendored verified-links markdown (for HK)
 * @param now       timestamp stamped as updatedAt
 */
export function planRemediation(
  existing: Map<string, Record<string, unknown>>,
  markdown: string,
  now: Timestamp
): { writes: RemediationWrite[]; skipped: string[] } {
  const writes: RemediationWrite[] = [];
  const skipped: string[] = [];

  // ---- News: the registry entry as the seed now writes it (+ reset) ----
  for (const id of REMEDIATED_NEWS_SOURCE_IDS) {
    const path = `newsSources/${id}`;
    const before = existing.get(path);
    const seed = NEWS_SOURCES.find((s) => s.slug === id);
    if (!before || !seed) {
      skipped.push(`${path}: ${!seed ? "not in NEWS_SOURCES" : "no such doc (run the news seed to create it)"}`);
      continue;
    }
    const doc = buildSeededNewsSource(seed, before, now);
    // Keep the stored schedule: this is a data fix, not "make it due now".
    delete doc.nextScrapeAt;
    if ((RESET_NEWS_SOURCE_IDS as readonly string[]).includes(id)) Object.assign(doc, resetFailuresFields(before));
    const changes = describeChanges(before, doc);
    if (changes.length === 0) {
      skipped.push(`${path}: already up to date`);
      continue;
    }
    writes.push({ path, doc, merge: true, changes });
  }

  // ---- Visa: rebuild the HK source from the markdown (the seed's builder) ----
  const parsed = parseVisaSourcesMarkdown(markdown);
  for (const cc of REMEDIATED_VISA_SOURCE_IDS) {
    const path = `visaSources/${cc}`;
    const before = existing.get(path);
    const country = parsed.find((c) => c.countryCode === cc);
    if (!before || !country) {
      skipped.push(`${path}: ${!country ? "not in the markdown" : "no such doc (run the visa seed to create it)"}`);
      continue;
    }
    const { doc } = buildSeededVisaSource({ country, existing: before, now });
    // The interesting part for the dry run is the page list.
    const beforeUrls = ((before.pages as { url?: string }[] | undefined) ?? []).map((p) => p.url ?? "?");
    const afterUrls = ((doc.pages as { url?: string; visaId?: string }[] | undefined) ?? []).map((p) =>
      p.visaId ? `${p.url} (visaId ${p.visaId})` : String(p.url)
    );
    const changes: string[] = [];
    const removed = beforeUrls.filter((u) => !afterUrls.some((a) => a.startsWith(u)));
    const added = afterUrls.filter((a) => !beforeUrls.some((u) => a.startsWith(u)));
    for (const u of removed) changes.push(`pages: - ${u}`);
    for (const u of added) changes.push(`pages: + ${u}`);
    changes.push(...describeChanges(before, doc).filter((c) => !c.startsWith("pages:")));
    if (removed.length === 0 && added.length === 0 && changes.length === 0) {
      skipped.push(`${path}: already up to date`);
      continue;
    }
    writes.push({ path, doc, merge: false, changes });
  }
  return { writes, skipped };
}

// ============================================
// CLI
// ============================================

/** Run the fix: dry run unless `--apply`. */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
  const emulator = process.env.FIRESTORE_EMULATOR_HOST || "";
  if (!project) {
    console.error("[remediate-sources-107] set GCLOUD_PROJECT to the target project (there is no default).");
    process.exitCode = 1;
    return;
  }
  const markdownPath = findVisaSourcesMarkdown();
  if (!markdownPath) {
    console.error("[remediate-sources-107] vendored official_visa_links_verified_v3.md not found.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `[remediate-sources-107] project ${project}${emulator ? ` (emulator ${emulator})` : ""} — ` +
      (apply ? "APPLY: changes will be written" : "DRY RUN: nothing is written (pass --apply to write)")
  );

  // Loaded here (not at the top) so a missing GCLOUD_PROJECT fails before
  // Firebase Admin initialises against an unintended default.
  const { db } = await import("../../../utils/firebase");
  const paths = [
    ...REMEDIATED_NEWS_SOURCE_IDS.map((id) => `newsSources/${id}`),
    ...REMEDIATED_VISA_SOURCE_IDS.map((cc) => `visaSources/${cc}`),
  ];
  const snaps = await db.getAll(...paths.map((p) => db.doc(p)));
  const existing = new Map<string, Record<string, unknown>>();
  snaps.forEach((snap, i) => {
    if (snap.exists) existing.set(paths[i], snap.data() as Record<string, unknown>);
  });

  const { writes, skipped } = planRemediation(existing, fs.readFileSync(markdownPath, "utf8"), Timestamp.now());
  for (const w of writes) {
    console.log(`\n${w.path} (${w.merge ? "merge" : "full rewrite, crawl state kept"}):`);
    for (const c of w.changes) console.log(`  ${c}`);
  }
  for (const s of skipped) console.log(`\nskipped ${s}`);

  if (!apply) {
    console.log(`\n[remediate-sources-107] dry run: ${writes.length} doc(s) would change. Re-run with --apply to write.`);
    return;
  }
  if (writes.length === 0) {
    console.log("\n[remediate-sources-107] nothing to write.");
    return;
  }
  const batch = db.batch();
  for (const w of writes) {
    if (w.merge) batch.set(db.doc(w.path), w.doc, { merge: true });
    else batch.set(db.doc(w.path), w.doc);
  }
  await batch.commit();
  console.log(`\n[remediate-sources-107] wrote ${writes.length} doc(s).`);
}

// Only when run as a script (the tests import planRemediation).
if (require.main === module) {
  main().catch((err) => {
    console.error("[remediate-sources-107] failed:", err);
    process.exitCode = 1;
  });
}
