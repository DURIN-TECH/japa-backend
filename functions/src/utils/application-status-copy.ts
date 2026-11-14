import type { ApplicationStatus } from "../types";

/**
 * Applicant-facing wording for an application status change (issue #268).
 *
 * `onApplicationUpdated` sends this as the body of the `application_update`
 * notice. Kept as a pure function so every status can be unit-tested without
 * the trigger.
 *
 * Rules:
 *   - the five statuses that already had copy keep it word for word for agent
 *     applications (`under_review`, `submitted_to_embassy`, `interview_scheduled`,
 *     `approved`, `rejected`);
 *   - every other real status has its own sentence, for agent and self-service
 *     applications alike (`draft`, `pending_documents`, `pending_payment`,
 *     `withdrawn`, `expired`);
 *   - a self-service applicant (see `isSelfServiceApplication`) gets two
 *     different sentences: `under_review` (their submission landed and a
 *     readiness review follows) and `withdrawn` (a short confirmation);
 *   - the humanised fallback survives only as a last resort for a value that is
 *     not an `ApplicationStatus`;
 *   - the word "case" is for agents and is never used here, and the raw word
 *     "submitted" is never printed as a status (it is not an `ApplicationStatus`).
 * Curly apostrophes, per the design system's content rules.
 */

/** Copy shared by agent and self-service applications. */
const SHARED_COPY: Record<ApplicationStatus, string> = {
  // Unchanged copy (agent wording; self-service overrides `under_review` below).
  under_review: "Your application is now under review.",
  submitted_to_embassy: "Your application has been submitted to the embassy.",
  interview_scheduled: "Your interview has been scheduled.",
  approved: "Congratulations! Your visa has been approved.",
  rejected: "Unfortunately, your visa application was not approved.",
  // New in #268.
  draft: "Your application is saved as a draft. Pick it up whenever you’re ready.",
  pending_documents: "We need a few documents from you. Open the Seli app to see what to add next.",
  pending_payment: "A payment is waiting for your application. Open the Seli app to complete it.",
  withdrawn: "Your application has been withdrawn.",
  expired: "Your application has expired. You can start a new application whenever you’re ready.",
};

/** Self-service-only overrides (the applicant is the only person involved). */
const SELF_SERVICE_COPY: Partial<Record<ApplicationStatus, string>> = {
  under_review: "Your application is in. A readiness review is the next step.",
  withdrawn: "You’ve withdrawn your application. You can start a new one whenever you like.",
};

/**
 * The notice body for a status change.
 * @param status      the application's new status (may be an unknown string)
 * @param selfService true when `isSelfServiceApplication(app)` holds
 */
export function applicationStatusMessage(status: string, selfService: boolean): string {
  if (selfService) {
    const own = SELF_SERVICE_COPY[status as ApplicationStatus];
    if (own) return own;
  }
  const shared = SHARED_COPY[status as ApplicationStatus];
  if (shared) return shared;
  // Last resort for an unknown value only.
  return `Your application status is now: ${String(status).replace(/_/g, " ")}`;
}
