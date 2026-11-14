// ============================================
// Entry requirements (issue #236, P7 of #228) — the pure answer
// ============================================
//
// Covers, with made-up codes only: a nationality list rule, a travel
// authorisation (not a visa only when the source says so), a holder-of-permit
// exemption, an expired permit, a missing pair, a stale rule, a missing fact,
// several matching rules (stricter first), stay and purpose limits, and that
// an `unknown` answer never says "you need a visa" or "you don't".

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { answerEntryRequirements, strictnessRank, type EntryAnswerContext, type EntryQuery } from "../../src/entry-requirements/entry-requirements-answer";
import { NO_FACTS, type FactsForRules } from "../../src/services/ai/applicant-groups";
import { ENTRY_OUTCOME_STRICTNESS, type EntryRule } from "../../src/types/entry-requirements";
import { BLOC, DEST, ON_DATE, rule } from "./fixtures";

/** A context where every rule is fresh and there is an official page. */
function ctx(over: Partial<EntryAnswerContext> = {}): EntryAnswerContext {
  return {
    onDate: ON_DATE,
    membership: {},
    isFresh: () => true,
    feeView: () => null,
    destinationAuthorityPage: "https://www.gov.example.org/visit",
    ...over,
  };
}

/** A query for DEST. */
function q(facts: Partial<FactsForRules>, over: Partial<EntryQuery> = {}): EntryQuery {
  return { destination: DEST, facts: { ...NO_FACTS, ...facts }, ...over };
}

/** Text that would be a claim without a source. */
const CLAIM_RE = /you need a visa|you don't need|you do not need|without a visa|visa free/i;

// ---- fixture rules ----

/** Annex-style list: XB, XC, XD need a visa (one line per nationality). */
const listRule = rule("r-list", {
  group: {
    members: [
      { kind: "nationality", code: "XB", asWritten: "Xbland" },
      { kind: "nationality", code: "XC", asWritten: "Xcland" },
      { kind: "nationality", code: "XD", asWritten: "Xdland" },
    ],
    uncoded: ["Territory of Nowhere"],
  },
  listItems: ["Xbland", "Xcland", "Xdland", "Territory of Nowhere"],
});

/** Visa free for XE, 90 days in 180, tourism or business only. */
const freeRule = rule("r-free", {
  outcome: "visa_free",
  group: { members: [{ kind: "nationality", code: "XE", asWritten: "Xeland" }], uncoded: [] },
  maxStayDays: 90,
  stayPeriodDays: 180,
  purposes: ["tourism", "business"],
  quote: "Nationals of Xeland are exempt for stays of no more than 90 days in any 180-day period.",
});

/** Holders of a valid residence permit issued by XA need no visa. */
const permitRule = rule("r-permit", {
  outcome: "visa_free",
  group: { members: [{ kind: "holds", document: "residence_permit", issuer: DEST, asWritten: "a valid residence permit" }], uncoded: [] },
  quote: "Travellers who hold a valid residence permit do not need a visa.",
});

/** XF needs a travel authorisation; the source says it is not a visa. */
const taRule = rule("r-ta", {
  outcome: "travel_authorisation",
  group: { members: [{ kind: "nationality", code: "XF", asWritten: "Xfland" }], uncoded: [] },
  authorisationName: "Electronic Entry Permission",
  notAVisa: { quote: "The Electronic Entry Permission is not a visa.", url: "https://www.gov.example.org/eep" },
  applyUrl: "https://apply.gov.example.org/eep",
  quote: "Nationals of Xfland need an Electronic Entry Permission before they travel.",
});

describe("strictness", () => {
  test("a visa is stricter than an authorisation, which is stricter than nothing", () => {
    assert.ok(strictnessRank("visa_required") < strictnessRank("travel_authorisation"));
    assert.ok(strictnessRank("travel_authorisation") < strictnessRank("visa_free"));
    assert.equal(ENTRY_OUTCOME_STRICTNESS.length, 6);
  });
});

describe("answers from a sourced rule", () => {
  test("a nationality named in the list gets the list's outcome, with the quote, URL and list lines", () => {
    const a = answerEntryRequirements([listRule, freeRule], q({ nationalities: ["XC"] }), ctx());
    assert.equal(a.status, "answer");
    if (a.status !== "answer") return;
    assert.equal(a.outcome, "visa_required");
    assert.match(a.message, /^The official source says/);
    assert.deepEqual(a.sources, [{ quote: listRule.quote, url: listRule.url, fetchedAt: listRule.fetchedAt, listItems: listRule.listItems }]);
    assert.equal(a.disagree, false);
  });

  test("several nationalities: any one in the group matches", () => {
    const a = answerEntryRequirements([listRule], q({ nationalities: ["XZ", "XD"] }), ctx());
    assert.equal(a.status, "answer");
  });

  test("an uncoded list name is never decided by code (no traveller matches it)", () => {
    const a = answerEntryRequirements([listRule], q({ nationalities: ["XY"] }), ctx());
    assert.equal(a.status, "unknown");
  });

  test("visa free carries the stay limit and purposes as conditions", () => {
    const a = answerEntryRequirements([freeRule], q({ nationalities: ["XE"] }, { purpose: "tourism" }), ctx());
    assert.equal(a.status, "answer");
    if (a.status !== "answer") return;
    assert.equal(a.outcome, "visa_free");
    assert.deepEqual(a.stay, { maxDays: 90, periodDays: 180 });
    assert.deepEqual(a.conditions.map((c) => c.kind), ["max_stay", "purposes"]);
    assert.match(a.message, /The official source says you can enter without a visa for up to 90 days/);
  });

  test("a travel authorisation says it is not a visa only because the source does, and links out (Seli does not apply)", () => {
    const a = answerEntryRequirements([taRule], q({ nationalities: ["XF"] }), ctx());
    assert.equal(a.status, "answer");
    if (a.status !== "answer") return;
    assert.equal(a.outcome, "travel_authorisation");
    assert.deepEqual(a.authorisation, {
      name: "Electronic Entry Permission",
      notAVisa: { quote: "The Electronic Entry Permission is not a visa.", url: "https://www.gov.example.org/eep" },
      applyUrl: "https://apply.gov.example.org/eep",
      seliApplies: false,
    });
    assert.match(a.message, /The source says it is not a visa\./);
    // Without the source's statement, no such wording and the rule's own page is the link.
    const plain: EntryRule = { ...taRule, notAVisa: undefined, applyUrl: undefined };
    const b = answerEntryRequirements([plain], q({ nationalities: ["XF"] }), ctx());
    assert.equal(b.status, "answer");
    if (b.status !== "answer") return;
    assert.equal(b.authorisation?.notAVisa, null);
    assert.equal(b.authorisation?.applyUrl, plain.url);
    assert.doesNotMatch(b.message, /not a visa/);
  });
});

describe("holdings: a holder-of-permit exemption", () => {
  test("a VALID permit matches: visa free beside the nationality rule, which is stricter and listed first", () => {
    const facts = { nationalities: ["XB"], heldDocuments: [{ kind: "residence_permit" as const, issuerCountryCode: DEST, validUntil: "2027-06-30" }] };
    const a = answerEntryRequirements([listRule, permitRule], q(facts), ctx());
    assert.equal(a.status, "answer");
    if (a.status !== "answer") return;
    // Both rules match; they disagree; the stricter decides and both are listed.
    assert.equal(a.outcome, "visa_required");
    assert.equal(a.disagree, true);
    assert.deepEqual(a.rules.map((r) => r.ruleId), ["r-list", "r-permit"]);
    assert.ok(a.rules[1].conditions.some((c) => c.kind === "holds"));
  });

  test("the permit alone (no nationality rule matching) gives visa free", () => {
    const facts = { nationalities: ["XZ"], heldDocuments: [{ kind: "residence_permit" as const, issuerCountryCode: DEST, validUntil: "2027-06-30" }] };
    const a = answerEntryRequirements([listRule, permitRule], q(facts), ctx());
    assert.equal(a.status, "answer");
    if (a.status === "answer") assert.equal(a.outcome, "visa_free");
  });

  test("an EXPIRED permit never matches", () => {
    const facts = { nationalities: ["XZ"], heldDocuments: [{ kind: "residence_permit" as const, issuerCountryCode: DEST, validUntil: "2026-01-01" }] };
    const a = answerEntryRequirements([permitRule], q(facts), ctx());
    assert.equal(a.status, "unknown");
    if (a.status === "unknown") assert.equal(a.code, "no_rule");
  });

  test("holdings not stated: a less strict permit rule is listed as 'might also apply' beside the sourced answer", () => {
    const a = answerEntryRequirements([listRule, permitRule], q({ nationalities: ["XB"] }), ctx());
    assert.equal(a.status, "answer");
    if (a.status !== "answer") return;
    assert.equal(a.outcome, "visa_required");
    assert.deepEqual(a.mightAlsoApply.map((p) => [p.ruleId, p.needs]), [["r-permit", "which visas or permits you hold"]]);
  });

  test("holdings not stated and only the permit rule could apply: unknown, asking for the fact", () => {
    const a = answerEntryRequirements([permitRule], q({ nationalities: ["XZ"] }), ctx());
    assert.equal(a.status, "unknown");
    if (a.status !== "unknown") return;
    assert.equal(a.code, "missing_fact");
    assert.match(a.reason, /which visas or permits you hold/);
    assert.equal(a.mightApply?.[0].ruleId, "r-permit");
  });

  test("a STRICTER rule that needs a missing fact blocks a looser answer (never 'no visa needed' on a guess)", () => {
    const strictHolds = rule("r-strict", { group: { members: [{ kind: "holds", document: "visa", issuer: "XQ", asWritten: "a visa of Xqland" }], uncoded: [] } });
    const a = answerEntryRequirements([freeRule, strictHolds], q({ nationalities: ["XE"] }, { purpose: "tourism" }), ctx());
    assert.equal(a.status, "unknown");
    if (a.status === "unknown") assert.equal(a.code, "missing_fact");
  });

  test("members_of: decided from recorded membership; no recorded members is 'we need to know', never 'nobody'", () => {
    const blocRule = rule("r-bloc", { outcome: "visa_free", group: { members: [{ kind: "members_of", authorityId: BLOC, fact: "nationality", asWritten: "citizens of the Union" }], uncoded: [] } });
    const yes = answerEntryRequirements([blocRule], q({ nationalities: ["XM"] }), ctx({ membership: { [BLOC]: ["XM", "XN"] } }));
    assert.equal(yes.status, "answer");
    const unknownMembers = answerEntryRequirements([blocRule], q({ nationalities: ["XM"] }), ctx({ membership: {} }));
    assert.equal(unknownMembers.status, "unknown");
    if (unknownMembers.status === "unknown") assert.equal(unknownMembers.code, "missing_fact");
  });
});

describe("unknown: never guess", () => {
  test("a missing pair is unknown, with the destination authority's page, and makes no claim", () => {
    const a = answerEntryRequirements([listRule, freeRule], q({ nationalities: ["XZ"] }), ctx());
    assert.equal(a.status, "unknown");
    if (a.status !== "unknown") return;
    assert.equal(a.code, "no_rule");
    assert.equal(a.destinationAuthorityPage, "https://www.gov.example.org/visit");
    assert.doesNotMatch(a.reason, CLAIM_RE);
  });

  test("no rules at all, no registered page: unknown with no link (never a guessed one)", () => {
    const a = answerEntryRequirements([], q({ nationalities: ["XB"] }), ctx({ destinationAuthorityPage: undefined }));
    assert.deepEqual(a, { status: "unknown", destination: DEST, code: "no_rule", reason: "We don't have an official source for this yet." });
  });

  test("nationality not given: unknown, asking for it", () => {
    const a = answerEntryRequirements([listRule], q({}), ctx());
    assert.equal(a.status, "unknown");
    if (a.status === "unknown") {
      assert.equal(a.code, "missing_fact");
      assert.match(a.reason, /your nationality/);
    }
  });

  test("a stale rule gives unknown, not its outcome", () => {
    const a = answerEntryRequirements([listRule], q({ nationalities: ["XB"] }), ctx({ isFresh: (r) => r.id !== "r-list" }));
    assert.equal(a.status, "unknown");
    if (a.status !== "unknown") return;
    assert.equal(a.code, "stale");
    assert.doesNotMatch(a.reason, CLAIM_RE);
  });

  test("a stay longer than the rule allows is not covered by it", () => {
    const a = answerEntryRequirements([freeRule], q({ nationalities: ["XE"] }, { stayDays: 120, purpose: "tourism" }), ctx());
    assert.equal(a.status, "unknown");
    if (a.status === "unknown") assert.equal(a.code, "stay_not_covered");
  });

  test("a purpose outside the rule's list is not covered by it", () => {
    const a = answerEntryRequirements([freeRule], q({ nationalities: ["XE"] }, { purpose: "work" }), ctx());
    assert.equal(a.status, "unknown");
    if (a.status === "unknown") assert.equal(a.code, "purpose_not_covered");
  });

  test("transit outcomes answer a transit only", () => {
    const transit = rule("r-transit", { outcome: "transit_free", group: { members: [{ kind: "nationality", code: "XB", asWritten: "Xbland" }], uncoded: [] } });
    assert.equal(answerEntryRequirements([transit], q({ nationalities: ["XB"] }), ctx()).status, "unknown");
    const t = answerEntryRequirements([transit], q({ nationalities: ["XB"] }, { purpose: "transit" }), ctx());
    assert.equal(t.status, "answer");
    if (t.status === "answer") assert.equal(t.outcome, "transit_free");
  });
});
