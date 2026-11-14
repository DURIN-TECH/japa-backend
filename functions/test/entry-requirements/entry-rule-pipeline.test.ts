// ============================================
// Entry requirements (issue #236, P7 of #228) — drafting checks and the run
// ============================================
//
// Hermetic: a FAKE model (scripted answers, no network, no paid call), an
// in-memory store, and a fixture page. Covers:
//   - code checks of a drafted rule against the stored page (quote verbatim,
//     numbers in the quote, names in the quote, "not a visa" only from the
//     page, an application address only when printed, codes never invented);
//   - a LONG list (an annex of 200 nationalities) read in full by code: no line
//     dropped or capped, a line with no code kept in `uncoded`;
//   - the run: publish when every safeguard passes (head switched), hold when
//     the publish mode is manual, the check does not confirm, or too many rules
//     are lost; the kill switch and the daily cap stop it before any spend.
// Made-up codes (user-assigned ranges) and ids only.

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotQuoteIndex, resolvePublishSettings } from "../../src/scrapers";
import type { GuidanceSnapshotContent } from "../../src/scrapers/types";
import { checkDraftedRule, readBoundedList, type DraftSource } from "../../src/entry-requirements/entry-rule-draft";
import { ENTRY_CHECK_SYSTEM_PROMPT, ENTRY_CODING_SYSTEM_PROMPT, ENTRY_DRAFT_SYSTEM_PROMPT, type RawEntryRule } from "../../src/entry-requirements/entry-rule-prompt";
import { runEntryRuleDrafting, type PipelineDeps } from "../../src/entry-requirements/entry-rule-pipeline";
import type { EntryRuleStore } from "../../src/entry-requirements/entry-rule.store";
import { entryRuleProblems } from "../../src/entry-requirements/entry-rule-validate";
import { emptyLlmUsage, type LlmProvider, type LlmRequest, type LlmResponse } from "../../src/services/ai/llm-provider";
import type { EntryRule, EntryRuleHead, EntryRuleRun } from "../../src/types/entry-requirements";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixture page
// ============================================

/** User-assigned code pool (never a real country). */
const POOL = ["AA", ...Array.from({ length: 14 }, (_, i) => `Q${String.fromCharCode(77 + i)}`), ...Array.from({ length: 26 }, (_, i) => `X${String.fromCharCode(65 + i)}`), "ZZ"];
/** 200 annex lines, plus one entity that is not a country. */
const ANNEX = [...Array.from({ length: 200 }, (_, i) => `Republic of Testland ${String(i + 1).padStart(3, "0")}`), "Territory of Nowhere"];
/** The code the fake coder gives each annex line (none for the territory). */
const codeOfLine = (line: string): string => {
  const i = ANNEX.indexOf(line);
  return i < 0 || line === "Territory of Nowhere" ? "none" : POOL[i % POOL.length];
};

const URL = "https://www.gov.example.org/entry";
const LINES = [
  "Entry to Xaland",
  "Nationals of the countries listed in Annex 1 shall be required to hold a visa when crossing the border.",
  "Nationals of Xeland are exempt from the visa requirement for stays of no more than 90 days in any 180-day period.",
  "Nationals of Xfland need an Electronic Entry Permission before they travel.",
  "The Electronic Entry Permission is not a visa.",
  "Apply at https://apply.gov.example.org/eep",
  "Travellers who hold a valid residence permit do not need a visa.",
  "Annex 1",
  ...ANNEX,
  "End of annex",
];
const SNAPSHOT: GuidanceSnapshotContent = {
  schemaVersion: 1,
  sourceId: "xa-entry",
  contentHash: "hash-1",
  docType: "html",
  url: URL,
  finalUrl: URL,
  fetchedAt: "2026-11-10T00:00:00.000Z",
  text: LINES.join("\n"),
  pages: null,
};
const SOURCE: DraftSource = { sourceId: "xa-entry", url: URL, contentHash: "hash-1", fetchedAt: SNAPSHOT.fetchedAt, index: new SnapshotQuoteIndex(SNAPSHOT) };

/** The drafter's (fake) answer for the page. */
const DRAFT: RawEntryRule[] = [
  { quote: LINES[1], outcome: "visa_required", members: [], uncoded: [], list: { first: ANNEX[0], last: ANNEX[ANNEX.length - 1], fact: "nationality" }, conditions: [] },
  { quote: LINES[2], outcome: "visa_free", members: [{ kind: "nationality", asWritten: "Xeland", code: "XE" }], uncoded: [], maxStayDays: 90, stayPeriodDays: 180, conditions: [] },
  {
    quote: LINES[3],
    outcome: "travel_authorisation",
    members: [{ kind: "nationality", asWritten: "Xfland", code: "XF" }],
    uncoded: [],
    authorisationName: "Electronic Entry Permission",
    notAVisaQuote: LINES[4],
    applyUrl: "https://apply.gov.example.org/eep",
    conditions: [],
  },
  { quote: LINES[6], outcome: "visa_free", members: [{ kind: "holds", asWritten: "a valid residence permit", document: "residence_permit", issuer: "XA" }], uncoded: [], conditions: [] },
];

const raw = (over: Partial<RawEntryRule>): RawEntryRule => ({ quote: LINES[2], outcome: "visa_free", members: [{ kind: "nationality", asWritten: "Xeland", code: "XE" }], uncoded: [], conditions: [], ...over });
const ctx = { authorityIds: new Set(["test-bloc"]) };

// ============================================
// Code checks of one drafted rule
// ============================================

describe("checkDraftedRule", () => {
  test("a quote that is not in the page is refused", () => {
    const r = checkDraftedRule(raw({ quote: "Nationals of Xeland may stay for ever and ever." }), SOURCE, ctx);
    assert.deepEqual(r, { ok: false, reason: "quote_not_found" });
  });

  test("a stay limit not printed in the quote is refused", () => {
    assert.deepEqual(checkDraftedRule(raw({ maxStayDays: 30 }), SOURCE, ctx), { ok: false, reason: "stay_not_in_quote" });
    assert.equal(checkDraftedRule(raw({ maxStayDays: 90, stayPeriodDays: 180 }), SOURCE, ctx).ok, true);
  });

  test("a group name not in the quote is refused; a code that is not a code goes to uncoded with its words", () => {
    assert.deepEqual(checkDraftedRule(raw({ members: [{ kind: "nationality", asWritten: "Xqland", code: "XQ" }] }), SOURCE, ctx), { ok: false, reason: "member_not_in_source" });
    const r = checkDraftedRule(raw({ members: [{ kind: "nationality", asWritten: "Xeland", code: "not-a-code" }] }), SOURCE, ctx);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.rule.members, []);
      assert.deepEqual(r.rule.uncoded, ["Xeland"]);
    }
  });

  test("a members_of id that is not a known bloc is never invented: uncoded instead", () => {
    const r = checkDraftedRule(raw({ quote: LINES[6], members: [{ kind: "members_of", asWritten: "a valid residence permit", authorityId: "made-up-bloc", fact: "nationality" }] }), SOURCE, ctx);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.rule.uncoded, ["a valid residence permit"]);
  });

  test("'not a visa' only from a passage of the page, and only on a travel authorisation", () => {
    const ok = checkDraftedRule(DRAFT[2], SOURCE, ctx);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.rule.notAVisa, { quote: LINES[4], url: URL });
    assert.deepEqual(checkDraftedRule({ ...DRAFT[2], notAVisaQuote: "This permission is definitely not a visa." }, SOURCE, ctx), { ok: false, reason: "not_a_visa_not_found" });
    assert.deepEqual(checkDraftedRule({ ...DRAFT[1], notAVisaQuote: LINES[4] }, SOURCE, ctx), { ok: false, reason: "not_a_visa_on_other_outcome" });
  });

  test("an application address is kept only when the page prints it", () => {
    const r = checkDraftedRule({ ...DRAFT[2], applyUrl: "https://apply.gov.example.org/somewhere-else" }, SOURCE, ctx);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.rule.applyUrl, undefined);
      assert.deepEqual(r.rule.notes, ["apply_url_not_printed_on_page"]);
    }
  });

  test("a fee must be printed in the quote and in an ISO currency", () => {
    assert.deepEqual(checkDraftedRule(raw({ fee: { amount: 12, currency: "EUR" } }), SOURCE, ctx), { ok: false, reason: "fee_not_in_quote" });
  });

  test("a condition that is not verbatim refuses the whole rule (a dropped condition could loosen it)", () => {
    assert.deepEqual(checkDraftedRule(raw({ conditions: ["They must also hold a return ticket home."] }), SOURCE, ctx), { ok: false, reason: "condition_not_found" });
  });
});

describe("long lists are read in full", () => {
  test("every line from the first to the last is read, in order, none dropped or capped", () => {
    const r = readBoundedList(SOURCE.index, ANNEX[0], ANNEX[ANNEX.length - 1]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.lines.length, 201);
      assert.deepEqual(r.lines, ANNEX);
    }
  });

  test("bounds that are not whole lines of the page are refused by name", () => {
    assert.deepEqual(readBoundedList(SOURCE.index, "Republic of Testland", ANNEX[5]), { ok: false, reason: "list_first_line_not_found" });
    assert.deepEqual(readBoundedList(SOURCE.index, ANNEX[5], "Republic of Testland 999"), { ok: false, reason: "list_last_line_not_found" });
  });

  test("a list on a PDF is refused (its line layout is lost)", () => {
    const pdf = new SnapshotQuoteIndex({ ...SNAPSHOT, docType: "pdf", pages: [{ page: 1, text: SNAPSHOT.text }] } as GuidanceSnapshotContent);
    assert.deepEqual(readBoundedList(pdf, ANNEX[0], ANNEX[1]), { ok: false, reason: "list_not_readable:pdf_layout_lost" });
  });
});

// ============================================
// The run, with a fake model
// ============================================

/** Scripted fake model: answers by which prompt it is sent. */
class FakeModel implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  /** Rule ids (r1, r2...) the check answers "unsure" on outcome_right. */
  unsureRules = new Set<string>();
  /** Annex lines whose proposed code the check does not confirm. */
  unsureLines = new Set<string>();
  draft: RawEntryRule[] = DRAFT;

  modelFor(role: string): string {
    return `fake-${role}`;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const ok = (text: string): LlmResponse => ({ text, stopReason: "end_turn", usage: { ...emptyLlmUsage(), inputTokens: 100, outputTokens: 50 }, model: "fake" });
    if (request.system === ENTRY_DRAFT_SYSTEM_PROMPT) return ok(JSON.stringify({ rules: this.draft.map(toWire) }));
    if (request.system === ENTRY_CODING_SYSTEM_PROMPT) {
      const lines = [...request.user.matchAll(/\{"id":"(l\d+)","line":"([^"]*)"\}/g)].map((m) => ({ id: m[1], line: m[2] }));
      return ok(JSON.stringify({ answers: lines.map((l) => ({ id: l.id, code: codeOfLine(l.line) })) }));
    }
    if (request.system === ENTRY_CHECK_SYSTEM_PROMPT) {
      const rulesBlock = request.user.split("Codes to confirm:")[0];
      const ruleIds = [...rulesBlock.matchAll(/"id":"(r\d+)"/g)].map((m) => m[1]);
      const codes = [...request.user.matchAll(/\{"id":"(l\d+)","line":"([^"]*)","code":"[A-Z]{2}"\}/g)].map((m) => ({ id: m[1], line: m[2] }));
      const all = (id: string) => ({
        id,
        outcome_right: this.unsureRules.has(id) ? "unsure" : "yes",
        group_right: "yes",
        details_right: "yes",
        nothing_missing: "yes",
        not_a_visa_right: "yes",
        list_complete: "yes",
      });
      return ok(JSON.stringify({ rules: ruleIds.map(all), codes: codes.map((c) => ({ id: c.id, verdict: this.unsureLines.has(c.line) ? "unsure" : "yes" })) }));
    }
    throw new Error("unexpected request");
  }
}

/** The drafter's wire format (snake case, as the schema has it). */
function toWire(r: RawEntryRule): Record<string, unknown> {
  return {
    quote: r.quote,
    outcome: r.outcome,
    members: r.members.map((m) => ({ kind: m.kind, as_written: m.asWritten, ...(m.code ? { code: m.code } : {}), ...(m.document ? { document: m.document } : {}), ...(m.issuer ? { issuer: m.issuer } : {}), ...(m.authorityId ? { authority_id: m.authorityId } : {}), ...(m.fact ? { fact: m.fact } : {}) })),
    uncoded: r.uncoded,
    ...(r.list ? { list: r.list } : {}),
    ...(r.maxStayDays !== undefined ? { max_stay_days: r.maxStayDays } : {}),
    ...(r.stayPeriodDays !== undefined ? { stay_period_days: r.stayPeriodDays } : {}),
    ...(r.authorisationName ? { authorisation_name: r.authorisationName } : {}),
    ...(r.notAVisaQuote ? { not_a_visa_quote: r.notAVisaQuote } : {}),
    ...(r.applyUrl ? { apply_url: r.applyUrl } : {}),
    conditions: r.conditions,
  };
}

/** In-memory store. */
class MemStore implements EntryRuleStore {
  rules = new Map<string, EntryRule>();
  runs: EntryRuleRun[] = [];
  head: EntryRuleHead | null = null;
  runsToday = 0;
  async publishedForCountry(): Promise<EntryRule[]> {
    return [];
  }
  async publishedMembersOfScopes(): Promise<EntryRule[]> {
    return [];
  }
  async heads(): Promise<Map<string, EntryRuleHead>> {
    return new Map(this.head ? [[this.head.authorityId, this.head]] : []);
  }
  async runsStartedOn(): Promise<number> {
    return this.runsToday;
  }
  async servedCount(): Promise<number> {
    return this.head?.publishedRunId ? this.head.publishedRuleCount : 0;
  }
  async saveRun(run: EntryRuleRun, rules: EntryRule[], opts: { publish: boolean; sourceUrls: string[] }): Promise<void> {
    // The real store's validation runs on every rule.
    for (const r of rules) assert.deepEqual(entryRuleProblems(r), [], r.id);
    for (const r of rules) this.rules.set(r.id, r);
    this.runs.push(run);
    if (opts.publish) this.head = { authorityId: run.authorityId, publishedRunId: run.id, publishedAt: null, publishedRuleCount: rules.filter((r) => r.status === "published").length, lastRunId: run.id, lastRunStatus: run.status, sourceUrls: opts.sourceUrls, updatedAt: null as any };
  }
  async listRules(): Promise<EntryRule[]> {
    return [...this.rules.values()];
  }
  async listRuns(): Promise<EntryRuleRun[]> {
    return this.runs;
  }
}

let model: FakeModel;
let store: MemStore;
let publishRaw: Record<string, unknown>;
let extractionEnabled: boolean;

/** Pipeline deps over the fakes. */
function deps(): PipelineDeps {
  return {
    provider: model,
    store,
    readAuthority: async () => undefined,
    listBlocs: async () => [{ id: "test-bloc", name: "Test Bloc" }],
    loadSources: async () => ({ sources: [{ sourceId: "xa-entry", url: URL, language: "en", snapshot: SNAPSHOT }], problems: [] }),
    extractionSettings: async () => ({
      settings: { enabled: extractionEnabled, maxChunkChars: 24_000, maxRequestsPerRun: 40, maxInputCharsPerRun: 600_000, maxOutputTokensPerRequest: 48_000, requestTimeoutMs: 240_000, maxRunsPerDay: 20, stepAttemptsMax: 3, invocationBudgetMs: 450_000, leaseMs: 600_000, jobMaxAgeMs: 21_600_000, jobIdleMs: 120_000 },
    }),
    publishSettings: async () => ({ ...resolvePublishSettings(publishRaw), exists: true }),
    supportedLanguages: async () => ({ languages: ["en"] }),
    now: () => Date.parse("2026-11-14T12:00:00Z"),
    newRunId: () => "run0001",
  };
}

beforeEach(() => {
  model = new FakeModel();
  store = new MemStore();
  publishRaw = { mode: "auto" };
  extractionEnabled = true;
});

/** Run quietly (the pipeline logs one summary line). */
async function run(dryRun = false) {
  const saved = console.log;
  console.log = () => undefined;
  try {
    return await runEntryRuleDrafting({ authorityId: "XA", sourceIds: ["xa-entry"], dryRun, trigger: "test" }, deps());
  } finally {
    console.log = saved;
  }
}

describe("runEntryRuleDrafting", () => {
  test("every safeguard passes: published, head switched, the 201-line annex in full", async () => {
    const { run: r, rules } = await run();
    assert.equal(r.status, "published", JSON.stringify(r.reasons));
    assert.equal(store.head?.publishedRunId, r.id);
    assert.equal(rules.length, 4);
    assert.ok(rules.every((x) => x.status === "published" && x.quote && x.url === URL));
    const annex = rules.find((x) => x.listItems)!;
    // Nothing dropped or capped: 200 coded lines + 1 uncoded = the whole list.
    assert.equal(annex.listItems!.length, 201);
    assert.equal(annex.group.members.length, 200);
    assert.deepEqual(annex.group.uncoded, ["Territory of Nowhere"]);
    assert.equal(r.counts.listLines, 201);
    // The travel authorisation keeps the source's own "not a visa" passage.
    const ta = rules.find((x) => x.outcome === "travel_authorisation")!;
    assert.deepEqual(ta.notAVisa, { quote: LINES[4], url: URL });
    // Spend recorded: one draft call, two coding calls (150 + 51 lines), check calls.
    assert.deepEqual(r.requests, { drafting: 1, coding: 2, check: 2 });
    // The model roles: drafting and coding on the drafter's role, check on the independent one.
    assert.deepEqual([...new Set(model.requests.map((q) => q.role))].sort(), ["judgement", "verification"]);
  });

  test("a code the check does not confirm is kept as written (uncoded), never dropped", async () => {
    model.unsureLines.add(ANNEX[7]);
    const { rules } = await run();
    const annex = rules.find((x) => x.listItems)!;
    assert.equal(annex.group.members.length, 199);
    assert.deepEqual(annex.group.uncoded.sort(), [ANNEX[7], "Territory of Nowhere"].sort());
  });

  test("publish mode manual: HELD (stored for the admin, nothing served)", async () => {
    publishRaw = { mode: "manual" };
    const { run: r, rules } = await run();
    assert.equal(r.status, "held");
    assert.ok(r.reasons.includes("publish_mode_auto"));
    assert.equal(store.head, null);
    assert.ok(rules.every((x) => x.status === "held"));
  });

  test("a rule the check does not confirm is left out; too many lost holds the run", async () => {
    model.unsureRules.add("r2");
    publishRaw = { mode: "auto", maxLeftOutShare: 0.5 };
    const one = await run();
    assert.equal(one.run.status, "published");
    assert.equal(one.rules.filter((x) => x.status === "left_out").length, 1);
    assert.match(one.rules.find((x) => x.status === "left_out")!.leftOutReason!, /checker:outcome_right/);
    // Default budget (0.15): 1 of 4 lost is over it.
    model = new FakeModel();
    model.unsureRules.add("r2");
    store = new MemStore();
    publishRaw = { mode: "auto" };
    const two = await run();
    assert.equal(two.run.status, "held");
    assert.ok(two.run.reasons.includes("leave_out_budget"));
  });

  test("route allowlist without the entry key: held", async () => {
    publishRaw = { mode: "auto", routeAllowlist: ["XA_some-visa"] };
    const { run: r } = await run();
    assert.equal(r.status, "held");
    assert.ok(r.reasons.includes("route_allowed"));
  });

  test("the kill switch and the daily cap stop the run before any model call", async () => {
    extractionEnabled = false;
    const a = await run();
    assert.equal(a.run.status, "failed");
    assert.deepEqual(a.run.reasons, ["kill_switch"]);
    extractionEnabled = true;
    store.runsToday = 20;
    const b = await run();
    assert.deepEqual(b.run.reasons, ["daily_run_cap"]);
    assert.equal(model.requests.length, 0);
  });

  test("a dry run spends but writes nothing", async () => {
    const { run: r } = await run(true);
    assert.equal(r.status, "dry_run");
    assert.equal(store.runs.length, 0);
    assert.equal(store.head, null);
  });

  test("a malformed drafting answer fails the run and stores no rule", async () => {
    model.complete = async () => ({ text: "not json", stopReason: "end_turn", usage: emptyLlmUsage(), model: "fake" });
    const { run: r, rules } = await run();
    assert.equal(r.status, "failed");
    assert.deepEqual(r.reasons, ["drafting:output_invalid"]);
    assert.deepEqual(rules, []);
  });
});
