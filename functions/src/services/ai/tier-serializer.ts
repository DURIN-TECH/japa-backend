import { hasFeature, FEATURES, ROLES, type Entitlements } from "@durin-tech/authz";
import type { ApplicationAssessment, ReadinessBand } from "../../types/assessment";

// ============================================
// TIER SERIALIZER — the only path to a response body (issue #42)
// ============================================
//
// Two tiers, decided once per request from the caller's entitlement:
//
//   full  admin, or resolved entitlements that include `ai.case_officer`
//   free  everyone else, INCLUDING callers whose entitlements did not resolve
//         (fail closed: an unresolved caller never gets the full review)
//
// The FREE body is built from a whitelist: a new object with exactly two data
// keys, `readiness` and `topIssues`. It is never made by deleting keys from the
// stored document, so a field added to the document later cannot leak through
// by accident. A test asserts that no other finding key appears at any depth.
//
// The FULL body is the stored document minus operational fields (token usage,
// cost, the injection log, the requester, the input hash), which are for the
// operator and never for an applicant or agent. For a client-role caller
// `internalCall` is removed at every depth, including a client who owns the
// application.
//
// Job metadata (`meta`) sits beside `data`, not inside it, so the free `data`
// keeps exactly the keys above.

/** The response tier. */
export type AssessmentTier = "free" | "full";

/**
 * The tier for a caller. `entitlements` is what the auth middleware resolved:
 * null or undefined means not resolved, and the caller is on the free tier.
 */
export function tierFor(role: string | undefined, entitlements: Entitlements | null | undefined): AssessmentTier {
  if (role === ROLES.ADMIN) return "full";
  if (!entitlements) return "free";
  return hasFeature(entitlements, FEATURES.AI_CASE_OFFICER) ? "full" : "free";
}

/** Why a stored assessment no longer matches the current state. Computed server-side. */
export type StaleReason = "inputs_changed" | "rules_updated";

/** Job metadata: beside `data`, never inside it. */
export interface AssessmentMeta {
  assessmentId: string;
  status: ApplicationAssessment["status"];
  tier: AssessmentTier;
  rubricVersion: number;
  // Null when current. `inputs_changed`: the application's inputs differ from the
  // ones assessed. `rules_updated`: the approved rubric has moved on. The client
  // cannot compute either (it cannot compute the input hash).
  staleReason: StaleReason | null;
  // Kept for existing readers: true exactly when `staleReason` is set.
  stale: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string } | null;
}

/**
 * The whole free `data` object: the band, the top three, and ONE boolean. The
 * boolean tells a free applicant that a mandatory bar applies; it carries no
 * rule text, citation or title.
 */
export interface FreeAssessmentData {
  readiness: ReadinessBand | null;
  topIssues: Array<{ criterionId: string; title: string }>;
  hasBlockingRule: boolean;
}

/** Build the free `data` from the whitelist. */
export function serializeFree(assessment: ApplicationAssessment): FreeAssessmentData {
  return {
    readiness: assessment.readiness,
    topIssues: assessment.topIssues.map((i) => ({ criterionId: i.criterionId, title: i.title })),
    // `=== true`: a document written before this field existed reads as false.
    hasBlockingRule: assessment.hasBlockingRule === true,
  };
}

/** Copy of `value` with every `key` removed, at any depth. */
export function stripKeyDeep(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeyDeep(v, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key) continue;
      out[k] = stripKeyDeep(v, key);
    }
    return out;
  }
  return value;
}

/**
 * Fields of the stored document that are operational: spend, the injection log,
 * who asked, and the input hash. Removed from every full response so an
 * applicant or agent never reads them (the suspicious-content log in particular
 * is "stored, never shown").
 */
const OPERATIONAL_FIELDS = ["usage", "costUsd", "suspiciousContent", "requestedBy", "inputHash", "models", "promptVersion", "viaBatch", "batchId", "batchPhase", "batchAttempts", "bulkRunId"] as const;

/** A stored time as an ISO string, or null. */
function isoOf(ts: { toDate?: () => Date } | null | undefined): string | null {
  return ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;
}

/** The full `data`: the stored document, without operational fields, and without `internalCall` for client-role callers. */
export function serializeFull(assessment: ApplicationAssessment, role: string | undefined): unknown {
  const visible: Record<string, unknown> = { ...(assessment as unknown as Record<string, unknown>) };
  for (const f of OPERATIONAL_FIELDS) delete visible[f];
  // A client-role caller never sees the verdict call, nor (issue #37) what the
  // rule change was or that an agent was asked to review: the applicant sees
  // the update only as the normal stale / updated state.
  if (role === ROLES.CLIENT) {
    delete visible.changeSummary;
    delete visible.reviewRequired;
    delete visible.reviewNotifiedAt;
    return stripKeyDeep(visible, "internalCall");
  }
  return visible;
}

/** The envelope: `meta` and `data`. */
export function envelope(
  assessment: ApplicationAssessment,
  tier: AssessmentTier,
  role: string | undefined,
  staleReason: StaleReason | null
): { meta: AssessmentMeta; data: FreeAssessmentData | unknown | null } {
  const meta: AssessmentMeta = {
    assessmentId: assessment.id,
    status: assessment.status,
    tier,
    rubricVersion: assessment.rubricVersion,
    staleReason,
    stale: staleReason !== null,
    startedAt: isoOf(assessment.startedAt),
    finishedAt: isoOf(assessment.finishedAt),
    error: assessment.error,
  };
  if (assessment.status !== "succeeded") return { meta, data: null };
  if (tier === "free") return { meta, data: serializeFree(assessment) };
  return { meta, data: serializeFull(assessment, role) };
}
