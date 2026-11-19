/**
 * READ-ONLY audit of the approved scraped GB visas against the official page's
 * own list items (issue #212, criterion F).
 *
 * Background: the extractor can silently skip an item the GOV.UK page lists
 * under a "you'll need to provide:" lead-in. New crawls now append such items
 * (item-coverage.ts), but visas approved BEFORE that still carry whatever the
 * extractor returned. This script lists, per approved scraped GB visa, which
 * page items its stored checklist does not contain, so the gap is known before
 * the re-crawl proposes the fix.
 *
 * IT WRITES NOTHING. It reads `countries/GB/visaTypes` (source == "scraped",
 * reviewStatus == "approved"), fetches each visa's live page through the real
 * GovukContentApiAdapter (same bot UA, rate limit and robots handling as a
 * crawl), runs the collector and the same match the crawl uses, and prints a
 * table + writes a JSON report. No Firestore write call exists in this file
 * (a test checks that). It refuses to run unless the target project is exactly
 * `durin-seli-dev`.
 *
 * A fix is NEVER written here. The path is: re-crawl so a pendingVisaChanges
 * proposal appears, and an admin approves it in /admin/visa-changes (with the
 * missing-items acknowledgement where it applies).
 *
 * Usage (run by a human with their own credentials; nothing is deployed):
 *   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
 *     npm run audit:visa-items -- --project durin-seli-dev [--out report.json] [--json]
 * A read-only role (datastore viewer) is enough.
 */

import * as fs from "fs";
// These two are imported from their modules (not the `scrapers` barrel) on
// purpose: the barrel initialises Firebase on import, and this script must set
// its project (and refuse a wrong one) BEFORE any Firebase init. Both modules
// are pure (adapter contract: importable without Admin init).
// eslint-disable-next-line no-restricted-imports
import type { SourceDocument } from "../scrapers/visa-catalog/adapters";
// eslint-disable-next-line no-restricted-imports
import { findMissingItems } from "../scrapers/visa-catalog/item-coverage";

// ============================================
// Types
// ============================================

/** The only project this audit may read. */
export const AUDIT_PROJECT = "durin-seli-dev";

/** The visa fields the audit reads (a subset of VisaType). */
export interface AuditedVisa {
  id: string;
  name?: string;
  sourceUrl?: string;
  requiredDocuments?: string[];
  scrapeMeta?: {
    sourceUrl?: string;
    routeName?: string;
    extractorPromptVersion?: string;
    citations?: Record<string, string>;
    sectionsUsed?: string[];
  };
}

/** What happened to one visa. Never silently skipped. */
export type AuditStatus = "checked" | "page_withdrawn" | "fetch_error" | "no_stored_documents";

/** One report row. */
export interface AuditRow {
  visaId: string;
  name: string | null;
  extractorPromptVersion: string | null;
  status: AuditStatus;
  /** Why a visa was not checked (fetch error message, etc.). */
  detail?: string;
  pageItems: number;
  matched: number;
  /** Each missing item, verbatim, with its lead-in and section. */
  missing: { text: string; leadIn: string; section: string }[];
}

/** The whole report (plain data, safe to JSON.stringify). */
export interface VisaItemsReport {
  project: string;
  generatedAt: string;
  /** How many approved scraped GB visas were actually found (the issue guessed 12). */
  approvedScrapedGbVisas: number;
  rows: AuditRow[];
}

/** Fetches the live document for a visa (the real adapter in main(); a stub in tests). */
export type FetchVisaDocument = (visa: AuditedVisa) => Promise<SourceDocument>;

// ============================================
// The audit (pure over its inputs)
// ============================================

/**
 * Audit `visas`: one row each, in the order given. A page that is withdrawn, a
 * fetch error and a visa with no stored `requiredDocuments` (crawled before
 * #129) each get their own status instead of being skipped.
 */
export async function auditVisaItems(
  visas: AuditedVisa[],
  fetchDocument: FetchVisaDocument,
  project: string = AUDIT_PROJECT,
  now: Date = new Date()
): Promise<VisaItemsReport> {
  const rows: AuditRow[] = [];
  for (const v of visas) {
    const base = {
      visaId: v.id,
      name: v.name ?? null,
      extractorPromptVersion: v.scrapeMeta?.extractorPromptVersion ?? null,
      pageItems: 0,
      matched: 0,
      missing: [] as AuditRow["missing"],
    };
    // No stored list: nothing to compare against (visa from before #129).
    if (!Array.isArray(v.requiredDocuments) || v.requiredDocuments.length === 0) {
      rows.push({ ...base, status: "no_stored_documents" });
      continue;
    }
    let doc: SourceDocument;
    try {
      doc = await fetchDocument(v);
    } catch (err) {
      rows.push({ ...base, status: "fetch_error", detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (doc.withdrawn) {
      rows.push({ ...base, status: "page_withdrawn" });
      continue;
    }
    const pageItems = doc.listItems ?? [];
    // The stored visa has the same shape the match reads: items + citations.
    const missing = findMissingItems(
      { requiredDocuments: v.requiredDocuments, citations: v.scrapeMeta?.citations ?? {} },
      pageItems
    );
    rows.push({
      ...base,
      status: "checked",
      pageItems: pageItems.length,
      matched: pageItems.length - missing.length,
      missing: missing.map((m) => ({ text: m.text, leadIn: m.leadIn, section: m.section })),
    });
  }
  return { project, generatedAt: now.toISOString(), approvedScrapedGbVisas: visas.length, rows };
}

/** The printed table + the missing items under each visa. */
export function formatVisaItemsReport(report: VisaItemsReport): string {
  const out: string[] = [];
  out.push(`Visa item coverage audit for project: ${report.project}   (READ-ONLY: nothing was changed)`);
  out.push(`Approved scraped GB visas found: ${report.approvedScrapedGbVisas}\n`);
  out.push(["visa id".padEnd(44), "prompt version".padEnd(34), "status".padEnd(20), "page", "matched", "missing"].join(" "));
  for (const r of report.rows) {
    out.push(
      [
        r.visaId.padEnd(44),
        (r.extractorPromptVersion ?? "(none)").padEnd(34),
        r.status.padEnd(20),
        String(r.pageItems).padStart(4),
        String(r.matched).padStart(7),
        String(r.missing.length).padStart(7),
      ].join(" ")
    );
  }
  for (const r of report.rows) {
    if (r.status !== "checked") out.push(`\n${r.visaId}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
    if (r.missing.length === 0) continue;
    out.push(`\n${r.visaId} (${r.name ?? "unnamed"}) is missing ${r.missing.length} page item(s):`);
    for (const m of r.missing) out.push(`  [${m.section}] ${m.leadIn || "(no lead-in)"} ${m.text}`);
  }
  out.push(
    "\nWhat to do with a finding: nothing here. Re-crawl GB (the pipeline version bump makes these visas re-extract) " +
      "so a proposal with the appended items appears in /admin/visa-changes, and approve it there."
  );
  return out.join("\n");
}

// ============================================
// CLI
// ============================================

/** Parse --project <id> | --project=<id>, --out <file>, --json. */
function parseArgs(argv: string[]): { project?: string; out?: string; json: boolean } {
  let project: string | undefined;
  let out: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--out") out = argv[++i];
    else if (a === "--json") json = true;
  }
  return { project, out, json };
}

/** Entry point when run as `node lib/scripts/audit-visa-items.js`. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectId = args.project || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  // Shared dev is the only target; prod (japa-platform) and anything else is refused.
  if (projectId !== AUDIT_PROJECT) {
    console.error(`\nRefusing to run: this audit reads ${AUDIT_PROJECT} only (got "${projectId ?? "none"}"). Pass --project ${AUDIT_PROJECT}.\n`);
    process.exit(1);
  }
  // An emulator variable would silently redirect the read to an empty emulator.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.error("\nRefusing to run: FIRESTORE_EMULATOR_HOST is set, so this would read the emulator, not durin-seli-dev.\n");
    process.exit(1);
  }
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  if (!process.env.FIREBASE_STORAGE_BUCKET) process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;

  const { subcollections } = await import("../utils/firebase");
  // eslint-disable-next-line no-restricted-imports
  const { GovukContentApiAdapter } = await import("../scrapers/visa-catalog/adapters");
  const { visaCatalogFetchService } = await import("../scrapers/shared/fetch/visa-catalog-fetch.service");
  const adapter = new GovukContentApiAdapter(visaCatalogFetchService);

  // READ: the approved scraped GB visas.
  const snap = await subcollections.visaTypes("GB").where("source", "==", "scraped").where("reviewStatus", "==", "approved").get();
  const visas: AuditedVisa[] = snap.docs.map((d) => ({ ...(d.data() as Omit<AuditedVisa, "id">), id: d.id }));

  const report = await auditVisaItems(visas, (v) => {
    const url = v.sourceUrl ?? v.scrapeMeta?.sourceUrl;
    if (!url) return Promise.reject(new Error("visa has no sourceUrl"));
    // The sections the model saw are exactly the stored `sectionsUsed` slugs
    // (literal slug patterns), so the page items are collected from the same parts.
    const used = v.scrapeMeta?.sectionsUsed;
    return adapter.fetch({
      url,
      routeName: v.scrapeMeta?.routeName ?? v.name ?? v.id,
      validation: "text_verified",
      ...(used && used.length > 0 ? { includeSections: used, excludeSections: [] } : {}),
    });
  }, projectId);

  const file = args.out ?? `audit-visa-items-${projectId}-${report.generatedAt.slice(0, 10)}.json`;
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(args.json ? JSON.stringify(report, null, 2) : `\n${formatVisaItemsReport(report)}\n\nJSON report: ${file}\n`);
  process.exit(0);
}

// Only when executed directly: importing this module (tests) runs nothing.
if (require.main === module) {
  main().catch((error) => {
    console.error("\naudit-visa-items failed:", error);
    process.exit(1);
  });
}
