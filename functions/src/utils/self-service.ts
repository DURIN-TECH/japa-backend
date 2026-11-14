import type { Application } from "../types";

/**
 * Self-service application test (issue #266). True only when the applicant runs
 * the application alone: `mode` is "self" AND no agent AND no agency is attached.
 *
 * Applicant-facing notices (readiness review, document checks, and the refusal
 * letter notice in #268) gate on this. An agent case keeps its agent-side
 * notices; the applicant of an agent case is never sent these.
 *
 * Takes a minimal shape so callers can pass a partial doc. A missing `mode`
 * is NOT self-service (fail closed: say nothing rather than the wrong thing).
 */
export function isSelfServiceApplication(
  app: Pick<Application, "mode" | "agentId" | "agencyId"> | null | undefined
): boolean {
  if (!app) return false;
  return app.mode === "self" && !app.agentId && !app.agencyId;
}
