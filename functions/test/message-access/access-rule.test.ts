// ============================================
// Unit tests: the message access rule as a table (issue #172)
// ============================================
//
// The pure rule (no I/O). Every qualification case, plus the owner's
// account-wide ("all chats") setting (2026-11-13) for EACH person. There is no
// per-chat switch any more (retired in #209), so the only way a chat is off is
// one of the two account-wide settings.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decideMessageAccess, type AccessParty } from "../../src/services/message-access/access-rule";

/** Build a party: A = approved, P = plan, W = account-wide off. */
const party = (flags: { A?: boolean; P?: boolean; W?: boolean } = {}): AccessParty => ({
  approved: !!flags.A,
  hasAiPlan: !!flags.P,
  accountWideOff: !!flags.W,
});

interface Row {
  name: string;
  applicant: AccessParty;
  agent: AccessParty;
  /** Expected: [applicant released, agent released]. */
  expect: [boolean, boolean];
}

const TABLE: Row[] = [
  { name: "approval only (both)", applicant: party({ A: true }), agent: party({ A: true }), expect: [true, true] },
  { name: "plan only (both)", applicant: party({ P: true }), agent: party({ P: true }), expect: [true, true] },
  { name: "approval and plan", applicant: party({ A: true, P: true }), agent: party({ A: true, P: true }), expect: [true, true] },
  { name: "neither", applicant: party(), agent: party(), expect: [false, false] },
  { name: "lapsed plan = no plan, no approval", applicant: party({ P: false }), agent: party({ P: true }), expect: [false, true] },
  { name: "revoked approval = not approved", applicant: party({ A: false }), agent: party({ A: true }), expect: [false, true] },
  { name: "only the applicant qualifies: agent's messages stay out", applicant: party({ A: true }), agent: party(), expect: [true, false] },
  { name: "only the agent qualifies: applicant's messages stay out", applicant: party(), agent: party({ P: true }), expect: [false, true] },
  // Account-wide setting (owner decision 2026-11-13).
  { name: "plan + account-wide off: nothing", applicant: party({ P: true, W: true }), agent: party({ P: true }), expect: [false, false] },
  { name: "approval + account-wide off: nothing", applicant: party({ A: true, W: true }), agent: party({ A: true }), expect: [false, false] },
  { name: "account-wide off of the OTHER person blocks the whole chat", applicant: party({ A: true }), agent: party({ A: true, W: true }), expect: [false, false] },
  { name: "account-wide turned back on (off=false): released again", applicant: party({ A: true, W: false }), agent: party({ A: true }), expect: [true, true] },
  { name: "agent's account-wide off with a plan: nothing", applicant: party({ A: true }), agent: party({ P: true, W: true }), expect: [false, false] },
  { name: "agent's account-wide off with approval: nothing", applicant: party({ A: true }), agent: party({ A: true, W: true }), expect: [false, false] },
  { name: "agent's account-wide off with neither approval nor plan: nothing", applicant: party({ A: true }), agent: party({ W: true }), expect: [false, false] },
  { name: "both people's account-wide off: nothing", applicant: party({ A: true, W: true }), agent: party({ A: true, W: true }), expect: [false, false] },
  { name: "agent's account-wide back on: released again", applicant: party({ A: true }), agent: party({ A: true, W: false }), expect: [true, true] },
  { name: "account-wide off with neither approval nor plan: nothing", applicant: party({ W: true }), agent: party({ A: true }), expect: [false, false] },
];

describe("decideMessageAccess table", () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const d = decideMessageAccess({
        applicant: row.applicant,
        agent: row.agent,
      });
      assert.deepEqual([d.applicantReleased, d.agentReleased], row.expect);
      // A chat that is off releases nothing for either side.
      if (d.chatOff) assert.deepEqual(row.expect, [false, false]);
    });
  }
});
