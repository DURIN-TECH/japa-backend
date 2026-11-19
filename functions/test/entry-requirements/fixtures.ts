// ============================================
// Entry requirements (issue #236) — shared test fixtures (not a test file)
// ============================================
//
// Made-up codes and ids only: XA..XZ are ISO user-assigned codes, and the bloc
// id is invented. No real country, bloc, treaty or nationality is named.

import { Timestamp } from "firebase-admin/firestore";
import type { EntryRule } from "../../src/types/entry-requirements";

/** The destination every fixture rule is about. */
export const DEST = "XA";
/** A made-up bloc (members_of scope / group). */
export const BLOC = "test-bloc";
/** A fixed time. */
export const T0 = Timestamp.fromMillis(Date.parse("2026-11-01T00:00:00Z"));
/** The day rules are checked on in the pure tests. */
export const ON_DATE = "2026-11-14";

/** A published rule for DEST with sensible defaults; override any field. */
export function rule(id: string, over: Partial<EntryRule> = {}): EntryRule {
  return {
    id,
    issuingAuthorityId: DEST,
    destination: { kind: "countries", countryCodes: [DEST] },
    destinationCodes: [DEST],
    scopeAuthorityId: null,
    outcome: "visa_required",
    group: { members: [{ kind: "nationality", code: "XB", asWritten: "Xbland" }], uncoded: [] },
    conditions: [],
    quote: "Nationals of the countries listed in Annex 1 shall be required to hold a visa.",
    url: "https://www.gov.example.org/entry",
    sourceId: "xa-entry",
    contentHash: "hash-1",
    fetchedAt: "2026-11-10T00:00:00.000Z",
    publishedAt: T0,
    status: "published",
    runId: "XA__run1",
    promptVersion: "entry-rules-test",
    checkPromptVersion: "entry-check-test",
    createdAt: T0,
    ...over,
  };
}
