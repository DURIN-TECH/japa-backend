// ============================================
// AI message access: the rule itself (issue #172)
// ============================================
//
// A pure function, no I/O, so the whole rule is one table test. The I/O
// (reading approvals, entitlements, switches) lives in message-access.service.ts.
//
// THE RULE. A message is released for AI use only when BOTH hold at READ time:
//   1. its sender qualifies: they have an active express approval, OR their
//      resolved entitlements include `ai.case_officer` (an AI plan; false for a
//      lapsed or unpaid plan), AND
//   2. the chat is not switched off: neither participant has switched this chat
//      off, and neither participant has the account-wide "off" setting on. An
//      account-wide off counts as that person having switched EVERY chat off, so
//      it blocks the whole chat, including the other person's messages.
//
// Nothing here is cached or stored per message: evaluating at read time is what
// makes a revoked approval, a lapsed plan or a switch take effect on the very
// next call, and what makes older messages follow today's state (not the state
// they were sent under).

/** What the rule needs to know about one participant. */
export interface AccessParty {
  /** The person's approval is on file and not revoked. */
  approved: boolean;
  /** The person's resolved plan includes AI (`hasFeature(..., AI_CASE_OFFICER)`). */
  hasAiPlan: boolean;
  /** The person's account-wide "off" setting. */
  accountWideOff: boolean;
}

/** Inputs to the rule: both sides' chat switches and both parties' status. */
export interface AccessInput {
  /** Applicant side has switched THIS chat off (`Conversation.aiAccessOffUser`). */
  switchOffUser: boolean;
  /** Agent side has switched THIS chat off (`Conversation.aiAccessOffAgent`). */
  switchOffAgent: boolean;
  applicant: AccessParty;
  agent: AccessParty;
}

/** What the rule decides. */
export interface AccessDecision {
  /** True when nothing from this chat may be released, whoever sent it. */
  chatOff: boolean;
  /** Messages sent by the applicant may be released. */
  applicantReleased: boolean;
  /** Messages sent by the agent may be released. */
  agentReleased: boolean;
}

/** True when this party qualifies on their own (approval or AI plan), ignoring switches. */
export function partyQualifies(p: AccessParty): boolean {
  return p.approved || p.hasAiPlan;
}

/** Apply the rule. See the header for the full statement. */
export function decideMessageAccess(input: AccessInput): AccessDecision {
  const chatOff =
    input.switchOffUser ||
    input.switchOffAgent ||
    input.applicant.accountWideOff ||
    input.agent.accountWideOff;
  return {
    chatOff,
    applicantReleased: !chatOff && partyQualifies(input.applicant),
    agentReleased: !chatOff && partyQualifies(input.agent),
  };
}
