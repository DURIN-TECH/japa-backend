import { FEATURES, hasFeature, type Entitlements } from "@durin-tech/authz";
import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import type { Application } from "../types";
import type { ApplicationAssessment, AssessmentErrorCode } from "../types/assessment";
import { aiCaseOfficerService } from "./ai-case-officer.service";
import { readAiSettings } from "./ai/ai-settings";
import { notificationService } from "./notification.service";

// ============================================
// AGENT PRE-REVIEW AUTO-RUN (issue #117)
// ============================================
//
// When a document is added to or replaced on an application, the assigned agent
// should find the AI's findings waiting. This module ONLY decides WHEN and FOR
// WHOM to start a run, and tells the agent afterwards. It is not a second
// engine: every run goes through `aiCaseOfficerService.requestAssessment` (#42),
// so the inputHash short-circuit, the in-flight reuse and the per-assessment and
// per-day spend caps all apply unchanged.
//
// Flow:
//   1. `recordDocumentChange` (Firestore trigger on `documents`) writes ONE
//      marker `assessmentDebounce/{applicationId}` with `dueAt = now + window`.
//      The doc id is the application id, so N rapid uploads rewrite one marker.
//   2. `sweep` (scheduled, every 5 minutes) takes markers whose `dueAt` has
//      passed, deletes each, and requests ONE assessment for its application.
//   3. `retryFailed` (same sweep) re-queues a failed auto-run once, for
//      transient causes only.
//   4. `notifyIfNew` (called by the worker after a successful auto-run) tells
//      the assigned agent, once, when the findings differ from the previous run.
//
// SPEND SAFETY: a model call can only happen inside the #42 worker, which runs
// only for a `queued` assessment document. This module creates one only after
// `canAutoRun` passes. `canAutoRun` is fail-closed: it needs an assigned agent,
// an open status, the AI switch on, and an entitlements document that EXISTS and
// explicitly includes `ai.case_officer` with an access-granting status. It reads
// the `entitlements` cache directly. It never goes through `requireFeature`, and
// never recomputes or falls back to a default plan, so "no plan resolved" is a
// refusal, not a pass.
//
// The applicant is never notified by anything here.

/**
 * Quiet period after the LAST document change before a run starts. A burst of
 * uploads inside this window produces one run, because every change pushes the
 * same single marker's `dueAt` out. Ten minutes covers a client uploading a
 * checklist's worth of files one after another.
 */
export const AUTO_RUN_DEBOUNCE_MINUTES = 10;

/** Markers handled per sweep. A bigger backlog drains over the next sweeps. */
const SWEEP_BATCH = 50;

/**
 * Total attempts for one auto-run (the first try plus ONE automatic retry).
 * After this the failed state is left visible and nothing retries it again.
 */
export const AUTO_RUN_MAX_ATTEMPTS = 2;

/**
 * Failure codes worth one automatic retry: transient provider or runtime
 * problems. Caps, a disabled switch, unreadable settings and changed inputs or
 * rules are deliberate stops, so they are never retried (no spend past a cap).
 */
const RETRYABLE_CODES: ReadonlySet<AssessmentErrorCode> = new Set<AssessmentErrorCode>([
  "provider_error",
  "provider_stopped",
  "timed_out",
  "invalid_model_output",
  "internal_error",
]);

/** Same exclusion set as the bulk re-assessment (#37): a closed case is never auto-run. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["approved", "rejected", "withdrawn", "expired", "draft"]);

/** The finding groups the notification counts, and the signature compares. */
type FindingGroups = Pick<ApplicationAssessment, "refusalGrounds" | "credibilityFlags" | "insufficientInformation">;

/** Stable identity of a finding set: criterion ids per group, sorted. No text. */
export function findingSignature(a: FindingGroups): string {
  const ids = (xs: Array<{ criterionId: string }> | undefined, tag: string) =>
    (xs ?? []).map((x) => `${tag}:${x.criterionId}`);
  return [...ids(a.refusalGrounds, "g"), ...ids(a.credibilityFlags, "c"), ...ids(a.insufficientInformation, "i")]
    .sort()
    .join("|");
}

/** The application with its id, or null. */
async function loadApplication(id: string): Promise<Application | null> {
  const snap = await collections.applications.doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Application) : null;
}

/**
 * True only when the assigned agent's plan EXPLICITLY includes the case-officer
 * feature. Subscriber is the agency's, or the agent's own when independent (same
 * rule as `entitlementService.resolveSubscriber`). Fail-closed on every doubt.
 */
export async function hasExplicitCaseOfficerEntitlement(app: Pick<Application, "agentId" | "agencyId">): Promise<boolean> {
  const subscriberId = app.agencyId || app.agentId;
  if (!subscriberId) return false;
  try {
    const snap = await collections.entitlements.doc(subscriberId).get();
    if (!snap.exists) return false; // unresolved or absent: no auto-run
    // `hasFeature` is false for an unpaid/expired status as well as for a missing key.
    return hasFeature(snap.data() as Entitlements, FEATURES.AI_CASE_OFFICER);
  } catch {
    return false; // a failed read is not a pass
  }
}

/** Every gate an automatic run needs. Fail-closed. */
async function canAutoRun(app: Application): Promise<boolean> {
  // Self-service applications (no assigned agent) do not trigger the agent flow.
  if (!app.agentId) return false;
  if (CLOSED_STATUSES.has(app.status)) return false;
  const settings = await readAiSettings();
  if (!settings.ok || !settings.settings.enabled) return false;
  return hasExplicitCaseOfficerEntitlement(app);
}

export class AssessmentAutoRunService {
  /**
   * Firestore trigger body for `documents/{id}`. Records (or pushes out) the
   * debounce marker. Makes no model call and never throws. Cheap pre-checks
   * avoid markers for applications that could never run.
   */
  async recordDocumentChange(applicationId: string | undefined): Promise<void> {
    try {
      if (!applicationId) return;
      const app = await loadApplication(applicationId);
      if (!app || !app.agentId || CLOSED_STATUSES.has(app.status)) return;
      const now = Date.now();
      await collections.assessmentDebounce.doc(applicationId).set({
        dueAt: Timestamp.fromMillis(now + AUTO_RUN_DEBOUNCE_MINUTES * 60_000),
        lastChangeAt: Timestamp.fromMillis(now),
        // Copied so a marker can be traced to its agency without a join.
        agencyId: app.agencyId ?? null,
      });
    } catch (err) {
      console.error(`[auto-run] could not record change for ${applicationId}: ${(err as Error).name}`);
    }
  }

  /**
   * Scheduled body. Starts at most one assessment per due application, then
   * re-queues eligible failed auto-runs. Never throws.
   */
  async sweep(now: Date = new Date()): Promise<{ due: number; requested: number; skipped: number; retried: number }> {
    const out = { due: 0, requested: 0, skipped: 0, retried: 0 };
    try {
      const due = await collections.assessmentDebounce
        .where("dueAt", "<=", Timestamp.fromDate(now))
        .orderBy("dueAt", "asc")
        .limit(SWEEP_BATCH)
        .get();
      out.due = due.size;
      for (const marker of due.docs) {
        const applicationId = marker.id;
        // Claim: delete only if still due. A change that landed after the query
        // pushed `dueAt` forward, and that newer marker must survive.
        const claimed = await collections.assessmentDebounce.firestore.runTransaction(async (tx) => {
          const fresh = await tx.get(marker.ref);
          const dueAt = fresh.exists ? (fresh.data()?.dueAt as Timestamp | undefined) : undefined;
          if (!dueAt || dueAt.toMillis() > now.getTime()) return false;
          tx.delete(marker.ref);
          return true;
        });
        if (!claimed) continue;
        try {
          const app = await loadApplication(applicationId);
          if (!app || !(await canAutoRun(app))) {
            out.skipped++;
            continue;
          }
          // The #42 entry point: hash short-circuit, in-flight reuse and caps all live behind it.
          const outcome = await aiCaseOfficerService.requestAssessment(app, {
            tier: "full",
            trigger: "documents_changed",
            requestedBy: "system",
            maxAttempts: AUTO_RUN_MAX_ATTEMPTS,
          });
          if (outcome.kind === "created" || outcome.kind === "queued") out.requested++;
          else out.skipped++;
        } catch (err) {
          out.skipped++;
          console.error(`[auto-run] sweep failed for ${applicationId}: ${(err as Error).name}`);
        }
      }
      out.retried = await this.retryFailed();
    } catch (err) {
      console.error(`[auto-run] sweep failed: ${(err as Error).name}`);
    }
    return out;
  }

  /**
   * One automatic retry for a failed auto-run (attempt 1, transient cause).
   * `requestAssessment` re-queues the same document with attempt 2; with
   * `maxAttempts` it refuses a third. Entitlement is checked again first.
   */
  private async retryFailed(): Promise<number> {
    let retried = 0;
    const failed = await collections.applicationAssessments
      .where("status", "==", "failed")
      .where("trigger", "==", "documents_changed")
      .where("attempt", "==", 1)
      .limit(SWEEP_BATCH)
      .get();
    for (const doc of failed.docs) {
      const a = doc.data() as ApplicationAssessment;
      if (a.requestedBy !== "system" || !a.error || !RETRYABLE_CODES.has(a.error.code)) continue;
      try {
        const app = await loadApplication(a.applicationId);
        if (!app || !(await canAutoRun(app))) continue;
        const outcome = await aiCaseOfficerService.requestAssessment(app, {
          tier: "full",
          trigger: "documents_changed",
          requestedBy: "system",
          maxAttempts: AUTO_RUN_MAX_ATTEMPTS,
        });
        // A retry only counts when it re-queued THIS failed document.
        if (outcome.kind === "queued" && outcome.assessmentId === a.id) retried++;
      } catch (err) {
        console.error(`[auto-run] retry failed for ${a.applicationId}: ${(err as Error).name}`);
      }
    }
    return retried;
  }

  /**
   * After the worker finished a job: tell the assigned agent once if this was an
   * auto-run that succeeded with findings that differ from the previous run.
   * Never throws. The body is neutral: a count per group, no finding text, no
   * internal call, nothing from a document.
   */
  async notifyIfNew(assessmentId: string): Promise<void> {
    try {
      const cur = await aiCaseOfficerService.getById(assessmentId);
      if (!cur || cur.status !== "succeeded" || cur.trigger !== "documents_changed") return;
      const app = await loadApplication(cur.applicationId);
      // No assigned agent: nothing to notify. The assessment stays stored and visible to the agency.
      if (!app || !app.agentId) return;
      // Defence in depth: the recipient must belong to the same agency the assessment was made for.
      if ((cur.agencyId ?? null) !== (app.agencyId ?? null)) return;

      const total = cur.refusalGrounds.length + cur.credibilityFlags.length + cur.insufficientInformation.length;
      if (total === 0) return;

      // Identical finding set to the previous completed run: say nothing a second time.
      const previous = await this.previousSucceeded(cur);
      if (previous && findingSignature(previous) === findingSignature(cur)) return;

      // One claim per assessment: `create()` fails if a duplicate delivery got here first.
      try {
        await collections.assessmentNotifications.doc(assessmentId).create({
          applicationId: cur.applicationId,
          agentId: app.agentId,
          createdAt: Timestamp.now(),
        });
      } catch {
        return;
      }

      const rules = cur.refusalGrounds.filter((g) => g.kind !== "judgement").length;
      const probe = cur.credibilityFlags.length + (cur.refusalGrounds.length - rules);
      const caseRef = app.id.slice(0, 8).toUpperCase();
      await notificationService.notifyUser({
        userId: app.agentId,
        type: "assessment_insights",
        title: "New insights on a case",
        body: `New insights on case ${caseRef}: ${total} items for your review (${rules} rule, ${probe} to probe, ${cur.insufficientInformation.length} need information).`,
        actionUrl: `/case-management/${app.id}`,
        relatedEntityType: "application",
        relatedEntityId: app.id,
      });
    } catch (err) {
      console.error(`[auto-run] notify failed for ${assessmentId}: ${(err as Error).name}`);
    }
  }

  /** The newest succeeded assessment for the same application, other than `cur`. */
  private async previousSucceeded(cur: ApplicationAssessment): Promise<ApplicationAssessment | null> {
    const snap = await collections.applicationAssessments
      .where("applicationId", "==", cur.applicationId)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();
    for (const d of snap.docs) {
      const a = d.data() as ApplicationAssessment;
      if (a.id !== cur.id && a.status === "succeeded" && a.createdAt.toMillis() < cur.createdAt.toMillis()) return a;
    }
    return null;
  }
}

export const assessmentAutoRunService = new AssessmentAutoRunService();
