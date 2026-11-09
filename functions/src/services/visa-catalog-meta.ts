import { Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../types";
import type { ExtractedVisa, VisaScrapeMeta } from "../types/visa-catalog";
import type { ScrapeSourceMeta } from "./visa-source-adapters";

// ============================================
// VISA CATALOG — SCRAPE META + WITHDRAWN RULES (pure)
// ============================================
//
// Decisions the ingest side makes, kept free of Firestore I/O so they are
// unit-testable without an emulator (`Timestamp` from firebase-admin/firestore
// works without Admin init). `visa-catalog.service.ts` does the reads/writes.

/**
 * Build the `scrapeMeta` written on a scraped visa doc. The optional
 * `sourceMeta` (adapter provenance: provider, GOV.UK content_id / updated_at,
 * sections used, truncated) is merged in; only defined values are copied so
 * pre-adapter callers produce exactly the old shape.
 */
export function buildScrapeMeta(params: {
  sourceUrl: string;
  routeName: string;
  model: string;
  contentHash: string;
  extracted: Pick<ExtractedVisa, "confidence" | "citations">;
  extractedAt: Timestamp;
  sourceMeta?: ScrapeSourceMeta;
}): VisaScrapeMeta {
  const meta: VisaScrapeMeta = {
    sourceUrl: params.sourceUrl,
    routeName: params.routeName,
    model: params.model,
    confidence: params.extracted.confidence,
    citations: params.extracted.citations,
    contentHash: params.contentHash,
    extractedAt: params.extractedAt,
  };
  for (const [k, v] of Object.entries(params.sourceMeta ?? {})) {
    // Cast: keys are a subset of VisaScrapeMeta by construction (ScrapeSourceMeta).
    if (v !== undefined) (meta as unknown as Record<string, unknown>)[k] = v;
  }
  return meta;
}

/** What the withdrawn path does to the doc at the resolved visa id. */
export type WithdrawnOutcome =
  | "deactivated" // scraped doc flipped to isActive:false (+ staleSince if unset)
  | "already_inactive" // scraped doc already inactive with staleSince — no write
  | "not_scraped" // doc exists but is seeded/agent-authored — never touched
  | "missing"; // no doc — nothing is created

/**
 * Decide the withdrawn-guide update for the doc at the resolved visa id.
 *
 * Rules (issue #58, user-confirmed):
 *  - Only a doc with `source === "scraped"` is ever modified — whatever its
 *    `reviewStatus` (an APPROVED scraped visa that GOV.UK withdrew must come
 *    off the app). Seeded `uk-*` / agent docs are never touched.
 *  - The update is `isActive: false` + `staleSince` — `staleSince` is set ONCE
 *    (an existing value is kept). The doc is never deleted.
 *  - No doc → nothing is created.
 *
 * NOTE: there is deliberately no inverse. A guide that later stops being
 * withdrawn does NOT reactivate the doc here — reactivation stays a human
 * review step (re-extraction of a pending doc leaves isActive alone; an
 * approved doc is skipped by ingest).
 */
export function planWithdrawnUpdate(
  existing: Pick<VisaType, "source" | "isActive" | "staleSince"> | undefined,
  now: Timestamp
): { outcome: WithdrawnOutcome; update?: { isActive: false; staleSince: Timestamp; updatedAt: Timestamp } } {
  if (!existing) return { outcome: "missing" };
  if (existing.source !== "scraped") return { outcome: "not_scraped" };
  if (existing.isActive === false && existing.staleSince) return { outcome: "already_inactive" };
  return {
    outcome: "deactivated",
    update: {
      isActive: false,
      // Set once: keep the first time we saw it withdrawn.
      staleSince: existing.staleSince ?? now,
      updatedAt: now,
    },
  };
}
