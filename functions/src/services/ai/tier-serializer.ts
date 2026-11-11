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
// The FULL body is the stored document. For a client-role caller `internalCall`
// is removed at every depth, including a client who owns the application.
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

/** Job metadata: beside `data`, never inside it. */
export interface AssessmentMeta {
  assessmentId: string;
  status: ApplicationAssessment["status"];
  tier: AssessmentTier;
  rubricVersion: number;
  // True when the rubric has moved on since this assessment was run.
  stale: boolean;
  error: { code: string; message: string } | null;
}

/** The whole free `data` object. */
export interface FreeAssessmentData {
  readiness: ReadinessBand | null;
  topIssues: Array<{ criterionId: string; title: string }>;
}

/** Build the free `data` from the whitelist. */
export function serializeFree(assessment: ApplicationAssessment): FreeAssessmentData {
  return {
    readiness: assessment.readiness,
    topIssues: assessment.topIssues.map((i) => ({ criterionId: i.criterionId, title: i.title })),
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

/** The full `data`: the stored document, with `internalCall` removed for client-role callers. */
export function serializeFull(assessment: ApplicationAssessment, role: string | undefined): unknown {
  if (role === ROLES.CLIENT) return stripKeyDeep(assessment, "internalCall");
  return assessment;
}

/** The envelope: `meta` and `data`. */
export function envelope(
  assessment: ApplicationAssessment,
  tier: AssessmentTier,
  role: string | undefined,
  approvedVersion: number | null
): { meta: AssessmentMeta; data: FreeAssessmentData | unknown | null } {
  const meta: AssessmentMeta = {
    assessmentId: assessment.id,
    status: assessment.status,
    tier,
    rubricVersion: assessment.rubricVersion,
    stale: approvedVersion !== null && assessment.rubricVersion < approvedVersion,
    error: assessment.error,
  };
  if (assessment.status !== "succeeded") return { meta, data: null };
  if (tier === "free") return { meta, data: serializeFree(assessment) };
  return { meta, data: serializeFull(assessment, role) };
}
