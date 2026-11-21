import { hasFeature, FEATURES, ROLES, type Entitlements } from "@durin-tech/authz";
import type { ApplicationAssessment, AssessmentNarrative, AvailableCountryContext, BlockingRule, ReadinessBand } from "../../types/assessment";
import { blockingRuleOf } from "./assessment-engine";

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
//
// (#384) THE WORKING. Inside the full tier, the rule-by-rule findings
// (`refusalGrounds`, `credibilityFlags`, `strengths`, `statementFindings`,
// `insufficientInformation`, `statement`) are "the working". Who gets it:
//
//   staff (agent, owner, admin)   always, on the full tier (portal unchanged)
//   client-role caller            only with `ai.case_officer` AND `ai.review_working`
//   anyone else                   never (unknown or missing role fails closed)
//
// A client on the full tier WITHOUT the working gets the READING body
// (`serializeReading`): band, blocking rule, top issues, the narrative and the
// country context. Like the free body it is built from a whitelist, never by
// deleting keys, and a test asserts that no finding key appears at any depth.
// `meta.working` is true exactly when `data` carries the working.

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

/** Roles that get the working on the full tier without the extra entitlement (#384). */
const STAFF_ROLES: readonly string[] = [ROLES.AGENT, ROLES.OWNER, ROLES.ADMIN];

/**
 * (#384) Does this caller get the rule-by-rule working? Decided server-side,
 * once per request, beside `tierFor`:
 *  - never on the free tier;
 *  - staff roles on the full tier: yes (today's full body, unchanged);
 *  - a client-role caller: only when resolved entitlements hold BOTH
 *    `ai.case_officer` and `ai.review_working`. Unresolved entitlements fail
 *    closed (no working), and `ai.review_working` alone does not lift a
 *    caller off the free tier;
 *  - any other or missing role: no (fail closed).
 */
export function workingFor(role: string | undefined, entitlements: Entitlements | null | undefined, tier: AssessmentTier = tierFor(role, entitlements)): boolean {
  if (tier !== "full") return false;
  if (role && STAFF_ROLES.includes(role)) return true;
  if (role !== ROLES.CLIENT || !entitlements) return false;
  return hasFeature(entitlements, FEATURES.AI_CASE_OFFICER) && hasFeature(entitlements, FEATURES.AI_REVIEW_WORKING);
}

/** Why a stored assessment no longer matches the current state. Computed server-side. */
export type StaleReason = "inputs_changed" | "rules_updated";

/** Job metadata: beside `data`, never inside it. */
export interface AssessmentMeta {
  assessmentId: string;
  status: ApplicationAssessment["status"];
  tier: AssessmentTier;
  // (#384) True exactly when `data` carries the rule-by-rule findings.
  working: boolean;
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

/**
 * (#384) The stored narrative as served: a fresh object with exactly its three
 * keys, or null. Null for a document stored before #384 (no key) and for
 * anything that is not the stored shape (a reader never trusts the document).
 */
export function narrativeOf(assessment: Pick<ApplicationAssessment, "narrative">): AssessmentNarrative | null {
  const n = (assessment as { narrative?: unknown }).narrative;
  if (!n || typeof n !== "object") return null;
  const { paragraphs, conclusion, nextSteps } = n as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!strings(paragraphs) || paragraphs.length === 0 || typeof conclusion !== "string" || !strings(nextSteps)) return null;
  return { paragraphs: [...paragraphs], conclusion, nextSteps: [...nextSteps] };
}

/**
 * (#384) The blocking rule as served: a fresh object with exactly its five
 * keys, or null. A document stored before #384 has no `blockingRule` key, so
 * it is derived from `refusalGrounds` at read time (the same copy the job
 * makes when it stores a result).
 */
export function blockingRuleFor(assessment: Pick<ApplicationAssessment, "blockingRule" | "refusalGrounds">): BlockingRule | null {
  const stored = (assessment as { blockingRule?: unknown }).blockingRule;
  if (stored === undefined) return blockingRuleOf(assessment.refusalGrounds);
  if (!stored || typeof stored !== "object") return null;
  const b = stored as BlockingRule;
  return { criterionId: b.criterionId, title: b.title, ruleRef: b.ruleRef ?? null, sourceQuote: b.sourceQuote, sourceUrl: b.sourceUrl };
}

/**
 * (#384) The READING `data`: what a client caller on the full tier gets
 * WITHOUT the working. Exactly these keys (`countryContext` only when a note
 * is stored), built from a whitelist like `serializeFree`: never by deleting
 * keys, so a field added to the document later cannot leak through.
 */
export interface ReadingAssessmentData {
  readiness: ReadinessBand | null;
  hasBlockingRule: boolean;
  blockingRule: BlockingRule | null;
  topIssues: Array<{ criterionId: string; title: string }>;
  narrative: AssessmentNarrative | null;
  countryContext?: AvailableCountryContext;
}

/** Build the reading `data` from the whitelist (#384). */
export function serializeReading(assessment: ApplicationAssessment): ReadingAssessmentData {
  return {
    readiness: assessment.readiness,
    // `=== true`: a document written before this field existed reads as false.
    hasBlockingRule: assessment.hasBlockingRule === true,
    blockingRule: blockingRuleFor(assessment),
    topIssues: assessment.topIssues.map((i) => ({ criterionId: i.criterionId, title: i.title })),
    narrative: narrativeOf(assessment),
    // Published outcome statistics, built in code (no rule text, no finding).
    ...(assessment.countryContext ? { countryContext: assessment.countryContext } : {}),
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

/** Roles that may see who asked for a review (agent-side only; never an applicant). */
const REQUESTER_VISIBLE_ROLES: readonly string[] = [ROLES.AGENT, ROLES.OWNER, ROLES.ADMIN];

/**
 * The full `data`: the stored document, without operational fields, and without
 * `internalCall` for client-role callers.
 *
 * `requestedByName` (#43): a display string for who asked, for staff roles only.
 * It is resolved by the controller (never the uid, which stays stripped with the
 * rest of `requestedBy`) and added here only when the caller is staff, so an
 * applicant's body never carries the key at all.
 */
export function serializeFull(assessment: ApplicationAssessment, role: string | undefined, requestedByName?: string | null): unknown {
  const visible: Record<string, unknown> = { ...(assessment as unknown as Record<string, unknown>) };
  for (const f of OPERATIONAL_FIELDS) delete visible[f];
  // (#384) Always the two keys, normalised: a document stored before #384 has
  // neither, and serves `narrative: null` and a blocking rule derived from
  // `refusalGrounds` at read time.
  visible.narrative = narrativeOf(assessment);
  visible.blockingRule = blockingRuleFor(assessment);
  if (role && REQUESTER_VISIBLE_ROLES.includes(role) && requestedByName) visible.requestedByName = requestedByName;
  // (#418) What the review read in each upload (`documentsRead`) is for staff
  // only. Removed for every other caller, a client or a missing role alike
  // (fail closed). The free and reading bodies are whitelists, so it never
  // reaches them in the first place.
  // (#444) `measuredOn` (the date the dated checks were measured against) likewise.
  if (!role || !STAFF_ROLES.includes(role)) {
    delete visible.documentsRead;
    delete visible.measuredOn;
  }
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

/**
 * The envelope: `meta` and `data`.
 *
 * (#384) `working` is the caller's working decision (`workingFor`). When it is
 * left out it defaults to the staff rule alone (full tier and a staff role),
 * so a caller that forgets it can never hand a client the working.
 */
export function envelope(
  assessment: ApplicationAssessment,
  tier: AssessmentTier,
  role: string | undefined,
  staleReason: StaleReason | null,
  requestedByName?: string | null,
  working: boolean = tier === "full" && !!role && STAFF_ROLES.includes(role)
): { meta: AssessmentMeta; data: FreeAssessmentData | ReadingAssessmentData | unknown | null } {
  // The working is only ever on the full tier.
  const withWorking = tier === "full" && working;
  const meta: AssessmentMeta = {
    assessmentId: assessment.id,
    status: assessment.status,
    tier,
    working: false,
    rubricVersion: assessment.rubricVersion,
    staleReason,
    stale: staleReason !== null,
    startedAt: isoOf(assessment.startedAt),
    finishedAt: isoOf(assessment.finishedAt),
    error: assessment.error,
  };
  if (assessment.status !== "succeeded") return { meta, data: null };
  if (tier === "free") return { meta, data: serializeFree(assessment) };
  // (#384) Full tier without the working: the whitelisted reading body.
  if (!withWorking) return { meta, data: serializeReading(assessment) };
  return { meta: { ...meta, working: true }, data: serializeFull(assessment, role, requestedByName) };
}
