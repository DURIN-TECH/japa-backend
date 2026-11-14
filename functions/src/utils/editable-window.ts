// ============================================
// Applicant edit window (issues #43, #187)
// ============================================
//
// The statuses in which an applicant may still create/edit free-text material
// on their application (the statement, the answers to information items).
// From `under_review` onward, and for terminal states, it is read-only. ONE
// rule shared by the statement (409 STATEMENT_LOCKED) and the answers
// (409 ANSWERS_LOCKED), so the two can never drift apart.

/** Statuses in which the applicant may still edit. */
export const APPLICANT_EDITABLE_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "pending_payment",
  "pending_documents",
]);

/** True while the application is inside the editable window. */
export function isWithinApplicantEditWindow(status: string): boolean {
  return APPLICANT_EDITABLE_STATUSES.has(status);
}
