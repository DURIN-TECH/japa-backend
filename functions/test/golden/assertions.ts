// ============================================
// Golden set — the gate assertions (issue #35)
// ============================================
//
// Pure functions over ONE fixture's stored assessment. Each returns a list of
// `Violation`s; every violation names the FIXTURE and the ASSERTION, so a red CI
// run is diagnosable without rerunning anything by hand:
//
//     fixture sv-03-sponsor: c-judgement-containment: refusal ground crit_... is a judgement criterion
//
// Which assertions block:
//   a to g   STRUCTURAL. Blocking for EVERY fixture, whoever labelled it. They
//            say nothing about immigration law; they say the engine kept its own
//            promises (no invented ids, every ground cited, the model never
//            decides an objective rule, no outcome wording reaches an applicant).
//   h        BAND-WITHIN-ONE. Blocking ONLY for fixtures whose label source is
//            `expert`. A draft label is an engineer's guess; blocking a PR on a
//            guess would make the gate noise. For draft fixtures the comparison
//            is reported (bandRow) and never fails the run.
//
// The gate imports the engine's own functions (criterion lookup, objective
// evaluation, serializers, banned-wording list) rather than copying them, so it
// cannot drift from the code it checks.

import { ROLES } from "@durin-tech/authz";
import {
  criterionById,
  deriveHolderFact,
  documentFieldsFor,
  evaluateObjective,
  extractionIsSuspicious,
  mandatoryBarHits,
  parseExtraction,
  type DocumentExtraction,
  type Facts,
} from "../../src/services/ai/assessment-engine";
import { findBannedWording } from "../../src/services/ai/prompt-safety";
import { envelope, serializeFree, serializeFull } from "../../src/services/ai/tier-serializer";
import { READINESS_BANDS, type ApplicationAssessment, type ReadinessBand } from "../../src/types/assessment";
import type { VisaRubric } from "../../src/types/rubric";
import { BAND_MAX_DISTANCE, type GateAssertionId, type GoldenFixture, type Violation } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What the assertions read about one run. */
export interface GateInput {
  fixture: GoldenFixture;
  rubric: VisaRubric;
  assessment: ApplicationAssessment;
  // Answers the provider gave to the extraction requests, in call order.
  extractionAnswers: Array<{ text: string; stopReason: string | null }>;
  // The ISO date the engine checked mandatory bars against (the harness clock).
  barDate: string;
}

/** Shorthand to build a violation for the fixture in `input`. */
const v = (input: GateInput, assertion: GateAssertionId, message: string): Violation => ({ fixtureId: input.fixture.id, assertion, message });

/** Every value stored under a key named `key`, at any depth. */
function valuesOfKey(tree: unknown, key: string, acc: unknown[] = []): unknown[] {
  if (Array.isArray(tree)) tree.forEach((t) => valuesOfKey(t, key, acc));
  else if (tree && typeof tree === "object") {
    for (const [k, val] of Object.entries(tree as Record<string, unknown>)) {
      if (k === key) acc.push(val);
      valuesOfKey(val, key, acc);
    }
  }
  return acc;
}

/** Every key at any depth (for the `internalCall` search). */
function allKeys(tree: unknown, acc: string[] = []): string[] {
  if (Array.isArray(tree)) tree.forEach((t) => allKeys(t, acc));
  else if (tree && typeof tree === "object") {
    for (const [k, val] of Object.entries(tree as Record<string, unknown>)) {
      acc.push(k);
      allKeys(val, acc);
    }
  }
  return acc;
}

/** The run must have produced a stored, succeeded assessment, or nothing else means anything. */
function succeeded(input: GateInput): Violation[] {
  const a = input.assessment;
  return a.status === "succeeded"
    ? []
    : [v(input, "x-fixture-data", `the job did not succeed: status ${a.status}, error ${a.error ? `${a.error.code}: ${a.error.message}` : "none"}`)];
}

// ============================================
// (a) zero fabricated criterionId
// ============================================

/**
 * Every `criterionId` anywhere in the stored output (grounds, flags, strengths,
 * statement findings, insufficient items, top issues, proposed-action sources)
 * must resolve to a criterion of the rubric version that was used.
 */
export function checkNoFabricatedCriterionId(input: GateInput): Violation[] {
  const out: Violation[] = [];
  const ids = valuesOfKey(input.assessment, "criterionId");
  for (const id of ids) {
    if (typeof id !== "string" || !criterionById(input.rubric, id)) {
      out.push(v(input, "a-no-fabricated-criterion-id", `criterionId ${JSON.stringify(id)} does not resolve in rubric v${input.rubric.version} (${input.rubric.routeKey})`));
    }
  }
  // The version recorded on the output must be the version the gate resolved against.
  if (input.assessment.rubricVersion !== input.rubric.version) {
    out.push(v(input, "a-no-fabricated-criterion-id", `output records rubric v${input.assessment.rubricVersion} but the fixture rubric is v${input.rubric.version}`));
  }
  return out;
}

// ============================================
// (b) zero uncited refusal ground
// ============================================

/**
 * Each refusal ground must carry the rubric criterion's `ruleRef` (when the
 * rubric has one), a `sourceUrl`, and a `sourceQuote` EQUAL to the criterion's
 * quote. Equality with the rubric is the check: the rubric's own validator
 * (#40) proved the quote appears verbatim in the stored source snapshot when
 * the rubric was extracted, and the snapshot's hash travels with it, so a quote
 * that equals the rubric's is a quote that was verified against the source.
 * (The fixture holds the snapshot HASH, not the snapshot text.)
 *
 * Applied to credibility flags and statement findings too: they cite the same way.
 */
export function checkCitedGrounds(input: GateInput): Violation[] {
  const out: Violation[] = [];
  const groups: Array<[string, Array<Record<string, any>>]> = [
    ["refusal ground", input.assessment.refusalGrounds as any[]],
    ["credibility flag", input.assessment.credibilityFlags as any[]],
    ["statement finding", input.assessment.statementFindings as any[]],
  ];
  for (const [what, items] of groups) {
    for (const g of items) {
      const c = criterionById(input.rubric, g.criterionId);
      if (!c) continue; // reported by (a)
      const tag = `${what} ${g.criterionId}`;
      if (!g.sourceUrl) out.push(v(input, "b-cited-refusal-ground", `${tag} has no sourceUrl`));
      else if (g.sourceUrl !== c.source.url) out.push(v(input, "b-cited-refusal-ground", `${tag} sourceUrl differs from the rubric criterion's`));
      if (!g.sourceQuote) out.push(v(input, "b-cited-refusal-ground", `${tag} has no sourceQuote`));
      else if (g.sourceQuote !== c.source.quote) out.push(v(input, "b-cited-refusal-ground", `${tag} sourceQuote is not equal to the rubric criterion's quote`));
      // ruleRef: required wherever the rubric has one, and never invented where it has none.
      if (c.ruleRef) {
        if (g.ruleRef !== c.ruleRef) out.push(v(input, "b-cited-refusal-ground", `${tag} has ruleRef ${JSON.stringify(g.ruleRef)}, rubric has ${JSON.stringify(c.ruleRef)}`));
      } else if (g.ruleRef !== null && g.ruleRef !== undefined) {
        out.push(v(input, "b-cited-refusal-ground", `${tag} has ruleRef ${JSON.stringify(g.ruleRef)} but the rubric criterion has none`));
      }
    }
  }
  return out;
}

// ============================================
// (c) judgement containment; no objective outcome decided by the model
// ============================================

/**
 * Rebuild what stage 2 saw from the recorded extraction answers, exactly as the
 * job does (parse, injection check), so the objective outcomes can be derived a
 * second time here, by the engine's own evaluator, independently of the stored
 * output.
 */
function rederiveExtractions(input: GateInput): DocumentExtraction[] {
  const fields = documentFieldsFor(input.rubric);
  return input.extractionAnswers.map((ans, i): DocumentExtraction => {
    const base = { documentId: `d${i}`, label: "document", mediaType: "application/pdf" };
    if (ans.stopReason === "refusal") return { ...base, readable: false, values: [], failed: true, failure: "refused", suspicious: false };
    const parsed = parseExtraction(ans.text, fields);
    if (!parsed.ok) return { ...base, readable: false, values: [], failed: true, failure: parsed.reason, suspicious: false };
    return { ...base, readable: parsed.readable, values: parsed.values, failed: false, failure: null, suspicious: extractionIsSuspicious(parsed.values) };
  });
}

/**
 * The containment invariants:
 *  1. no refusal ground names a judgement criterion; each is an objective check
 *     or a mandatory bar, and its `kind` field says so;
 *  2. no flag, strength or statement finding is attached to an objective or bar
 *     criterion (a model cannot add to, or override, a code-decided rule);
 *  3. the set of objective refusal grounds and insufficient items equals what the
 *     engine's own evaluator derives from the recorded extraction answers, and
 *     the mandatory-bar grounds equal the bars that apply to the nationality:
 *     nothing in the output came from the judgement answer or from model text.
 */
export function checkContainment(input: GateInput): Violation[] {
  const out: Violation[] = [];
  const a = input.assessment;
  for (const g of a.refusalGrounds) {
    const c = criterionById(input.rubric, g.criterionId);
    if (!c) continue;
    if (c.kind === "judgement") out.push(v(input, "c-judgement-containment", `refusal ground ${g.criterionId} is a judgement criterion`));
    if (g.kind !== c.kind) out.push(v(input, "c-judgement-containment", `refusal ground ${g.criterionId} says kind ${g.kind}, rubric says ${c.kind}`));
  }
  const nonJudgementUsed: Array<[string, string]> = [
    ...a.credibilityFlags.map((f): [string, string] => ["credibility flag", f.criterionId]),
    ...a.strengths.map((s): [string, string] => ["strength", s.criterionId]),
    ...a.statementFindings.map((s): [string, string] => ["statement finding", s.criterionId]),
  ];
  for (const [what, id] of nonJudgementUsed) {
    const c = criterionById(input.rubric, id);
    if (c && c.kind !== "judgement") out.push(v(input, "c-judgement-containment", `${what} is attached to ${c.kind} criterion ${id}; model output may only concern judgement criteria`));
  }

  // ---- 3. re-derive the code-decided outcomes ----
  const barHit = a.stageOutcomes.mandatoryBar === "hit";
  const expectedBars = mandatoryBarHits(input.rubric, input.fixture.applicant.nationality, input.barDate).map((c) => c.criterionId).sort();
  const actualBars = a.refusalGrounds.filter((g) => g.kind === "mandatory_bar").map((g) => g.criterionId).sort();
  if (JSON.stringify(expectedBars) !== JSON.stringify(actualBars)) {
    out.push(v(input, "c-judgement-containment", `mandatory-bar grounds [${actualBars}] differ from the bars that apply to nationality ${input.fixture.applicant.nationality} [${expectedBars}]`));
  }
  const hasStatement = (input.fixture.statement?.paragraphs ?? []).some((p) => p.trim().length > 0);
  const nothingToRead = input.fixture.documents.length === 0 && !hasStatement;
  if (!barHit && !nothingToRead) {
    const docs = rederiveExtractions(input);
    if (docs.length !== input.fixture.documents.length) {
      out.push(v(input, "c-judgement-containment", `${docs.length} extraction answers for ${input.fixture.documents.length} documents; cannot re-derive the objective outcomes`));
    } else {
      const facts: Facts = {
        ...Object.fromEntries(Object.entries(input.fixture.intake).map(([k, val]) => [`intake.${k}`, val as Facts[string]])),
        ...deriveHolderFact(`${input.fixture.applicant.firstName} ${input.fixture.applicant.lastName}`.trim(), docs),
      };
      const derived = evaluateObjective(input.rubric, facts, docs);
      const want = (outcome: string) => derived.filter((r) => r.outcome === outcome).map((r) => r.criterionId).sort();
      const gotFail = a.refusalGrounds.filter((g) => g.kind === "objective").map((g) => g.criterionId).sort();
      const objectiveIds = new Set(input.rubric.criteria.filter((c) => c.kind === "objective").map((c) => c.criterionId));
      const gotInsufficient = a.insufficientInformation.filter((i) => objectiveIds.has(i.criterionId)).map((i) => i.criterionId).sort();
      if (JSON.stringify(want("fail")) !== JSON.stringify(gotFail)) {
        out.push(v(input, "c-judgement-containment", `objective refusal grounds [${gotFail}] differ from what code derives from the extracted values [${want("fail")}]`));
      }
      if (JSON.stringify(want("insufficient")) !== JSON.stringify(gotInsufficient)) {
        out.push(v(input, "c-judgement-containment", `objective insufficient items [${gotInsufficient}] differ from what code derives [${want("insufficient")}]`));
      }
    }
  }
  return out;
}

// ============================================
// (d) intent-polarity invariant (from #42's tests)
// ============================================

/**
 * A concern on an intention criterion becomes a credibility flag ONLY under the
 * rubric's declared polarity `immigrant_intent_penalised`. Under any other
 * polarity (dual intent permitted, not assessed, undecided) no flag may name a
 * criterion that concerns intention.
 */
export function checkIntentPolarity(input: GateInput): Violation[] {
  if (input.rubric.intentPolarity === "immigrant_intent_penalised") return [];
  const out: Violation[] = [];
  for (const f of input.assessment.credibilityFlags) {
    const c = criterionById(input.rubric, f.criterionId);
    if (c?.concernsIntent) {
      out.push(v(input, "d-intent-polarity", `credibility flag ${f.criterionId} concerns intention but the rubric polarity is ${JSON.stringify(input.rubric.intentPolarity)}`));
    }
  }
  return out;
}

// ============================================
// (e) internalCall never reaches a client or the free tier; free keys exact
// ============================================

/** The free payload's keys, exactly. */
export const FREE_PAYLOAD_KEYS = ["hasBlockingRule", "readiness", "topIssues"] as const;

/**
 * Serialise the stored output every way an applicant could receive it and check:
 *  - the free payload has exactly `readiness`, `topIssues`, `hasBlockingRule`;
 *  - `internalCall` appears at no depth in the free payload, in the full payload
 *    for the CLIENT role, or in the envelope either of those travels in.
 */
export function checkInternalCallStripped(input: GateInput): Violation[] {
  const out: Violation[] = [];
  const a = input.assessment;
  const free = serializeFree(a);
  const keys = Object.keys(free).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...FREE_PAYLOAD_KEYS])) {
    out.push(v(input, "e-internal-call-stripped", `free payload keys are [${keys}], expected exactly [${FREE_PAYLOAD_KEYS}]`));
  }
  const surfaces: Array<[string, unknown]> = [
    ["free payload", free],
    ["free envelope", envelope(a, "free", ROLES.CLIENT, null)],
    ["full payload for the client role", serializeFull(a, ROLES.CLIENT)],
    ["full envelope for the client role", envelope(a, "full", ROLES.CLIENT, null)],
  ];
  for (const [name, body] of surfaces) {
    if (allKeys(body).includes("internalCall")) out.push(v(input, "e-internal-call-stripped", `internalCall is present in the ${name}`));
  }
  return out;
}

// ============================================
// (f) no banned outcome / likelihood wording in applicant-visible text
// ============================================

/** Keys whose values are the RULE's own words or machine ids, not applicant-facing prose. */
const NOT_PROSE_KEYS = new Set(["sourceQuote", "sourceUrl", "ruleRef", "criterionId", "id", "applicationId", "userId", "agencyId", "countryCode", "visaTypeId", "kind", "stage", "severity", "status", "readiness", "confidence", "tier"]);

/** One string an applicant could read, with where it is and the criterion it belongs to. */
export interface VisibleString {
  path: string;
  text: string;
  criterionId: string | null;
}

/** Every string an applicant could read in a serialisation. */
export function applicantVisibleStrings(tree: unknown, path = "", acc: VisibleString[] = [], criterionId: string | null = null): VisibleString[] {
  if (typeof tree === "string") {
    acc.push({ path, text: tree, criterionId });
  } else if (Array.isArray(tree)) {
    tree.forEach((t, i) => applicantVisibleStrings(t, `${path}[${i}]`, acc, criterionId));
  } else if (tree && typeof tree === "object") {
    const obj = tree as Record<string, unknown>;
    // An item that names a criterion carries that id down to its strings, so (g) can find the rule's quote.
    const own = typeof obj.criterionId === "string" ? obj.criterionId : criterionId;
    for (const [k, val] of Object.entries(obj)) {
      if (NOT_PROSE_KEYS.has(k)) continue;
      applicantVisibleStrings(val, path ? `${path}.${k}` : k, acc, own);
    }
  }
  return acc;
}

/** The applicant-visible strings: the free payload and the client-role full payload. */
function visibleToApplicant(input: GateInput): VisibleString[] {
  return [
    ...applicantVisibleStrings(serializeFree(input.assessment), "free"),
    ...applicantVisibleStrings(serializeFull(input.assessment, ROLES.CLIENT), "full"),
  ];
}

/**
 * None of the applicant-visible text may contain the banned outcome / likelihood
 * wording (the engine's own list: refusal prediction, approval, likelihood, odds).
 * Rubric titles are checked too (they are shown); the rule's quote is not (it is
 * the law's own words, shown as a citation).
 */
export function checkNoBannedWording(input: GateInput): Violation[] {
  const out: Violation[] = [];
  for (const s of visibleToApplicant(input)) {
    if (findBannedWording(s.text)) out.push(v(input, "f-no-banned-wording", `banned wording at ${s.path}: ${JSON.stringify(s.text.slice(0, 120))}`));
  }
  return out;
}

// ============================================
// (g) no numeric funds threshold for a rule that states none
// ============================================

/** "at least / minimum / must hold ... GBP 3,000": an asserted amount threshold. The number is group 2. */
const AMOUNT_THRESHOLD = /\b(at least|minimum(?: of)?|no less than|not less than|must (?:have|hold|show)|required|threshold|needs? (?:to have|at least))\b[^.;\n]{0,40}?(?:£|\$|€|₦|GBP|USD|EUR|NGN)\s?(\d[\d,]*(?:\.\d+)?)/gi;
/** "funds held for 28 days": an asserted holding period. The number is group 2 or 3. */
const HOLDING_PERIOD = /\b(held|hold|holding|kept|in (?:your|the) account)\b[^.;\n]{0,40}?\b(\d+)\s*(?:consecutive\s+)?(?:days?|weeks?|months?)\b|\b(\d+)\s*(?:consecutive\s+)?(?:days?|weeks?|months?)\b[^.;\n]{0,30}?\b(?:held|holding|in (?:your|the) account)\b/gi;

/** Numbers (digits, commas removed) a piece of text contains. */
function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "")));
}

/**
 * The funds rule (V 4.2(e)) has no fixed amount and no holding period, and the
 * product must never invent one. A threshold or holding period asserted in
 * applicant-visible text must use a number that is IN THE QUOTE of the criterion
 * the text belongs to (so "within 31 days" on the criterion whose quote says 31
 * days is fine; "at least GBP 3,000" on a criterion whose quote has no such
 * number is a violation). Text with no criterion has no quote to borrow from.
 */
export function checkNoInventedFundsThreshold(input: GateInput): Violation[] {
  const out: Violation[] = [];
  for (const s of visibleToApplicant(input)) {
    const quote = s.criterionId ? criterionById(input.rubric, s.criterionId)?.source.quote ?? "" : "";
    const allowed = numbersIn(quote);
    const found: string[] = [];
    for (const m of s.text.matchAll(AMOUNT_THRESHOLD)) found.push(m[2].replace(/,/g, ""));
    for (const m of s.text.matchAll(HOLDING_PERIOD)) found.push(m[2] ?? m[3]);
    for (const n of found) {
      if (!allowed.has(n)) out.push(v(input, "g-no-invented-funds-threshold", `${s.path} asserts the number ${n} as a threshold or holding period, which the cited rule does not state: ${JSON.stringify(s.text.slice(0, 120))}`));
    }
  }
  return out;
}

// ============================================
// (h) band within one
// ============================================

/** Distance in bands between two readiness bands (0..3). */
export function bandDistance(a: ReadinessBand, b: ReadinessBand): number {
  return Math.abs(READINESS_BANDS.indexOf(a) - READINESS_BANDS.indexOf(b));
}

/** True when the band comparison of this fixture blocks (only an expert label does). */
export function bandIsBlocking(fixture: GoldenFixture): boolean {
  return fixture.label.labelSource === "expert";
}

/** Band-within-one for ONE fixture, as a violation list. Empty for a draft label (reported, not enforced). */
export function checkBandWithinOne(input: GateInput): Violation[] {
  if (!bandIsBlocking(input.fixture)) return [];
  const got = input.assessment.readiness;
  const want = input.fixture.label.expectedBand;
  if (!got) return [v(input, "h-band-within-one", `no readiness band was produced, expected ${want}`)];
  const d = bandDistance(got, want);
  return d > BAND_MAX_DISTANCE ? [v(input, "h-band-within-one", `band ${got} is ${d} bands from the expert label ${want} (allowed ${BAND_MAX_DISTANCE})`)] : [];
}

/** One row of the band table (printed for every fixture; blocking only for expert labels). */
export interface BandRow {
  fixtureId: string;
  labelSource: string;
  expected: ReadinessBand;
  recorded: ReadinessBand | null;
  distance: number | null;
  withinOne: boolean;
  blocking: boolean;
  expectedGrounds: string[];
  recordedGrounds: string[];
}

/** The band comparison of one run. */
export function bandRow(input: GateInput): BandRow {
  const recorded = input.assessment.readiness;
  const distance = recorded ? bandDistance(recorded, input.fixture.label.expectedBand) : null;
  return {
    fixtureId: input.fixture.id,
    labelSource: input.fixture.label.labelSource,
    expected: input.fixture.label.expectedBand,
    recorded,
    distance,
    withinOne: distance !== null && distance <= BAND_MAX_DISTANCE,
    blocking: bandIsBlocking(input.fixture),
    expectedGrounds: [...input.fixture.label.expectedGrounds].sort(),
    recordedGrounds: input.assessment.refusalGrounds.map((g) => g.criterionId).sort(),
  };
}

// ============================================
// Everything per fixture, and the corpus-level checks
// ============================================

/** All STRUCTURAL assertions (a to g) plus (h) for one fixture, in a fixed order. */
export function checkFixture(input: GateInput): Violation[] {
  return [
    ...succeeded(input),
    ...checkNoFabricatedCriterionId(input),
    ...checkCitedGrounds(input),
    ...checkContainment(input),
    ...checkIntentPolarity(input),
    ...checkInternalCallStripped(input),
    ...checkNoBannedWording(input),
    ...checkNoInventedFundsThreshold(input),
    ...checkBandWithinOne(input),
  ];
}

/**
 * Corpus data checks that do not need a run: unique ids, a label on every
 * fixture, expected grounds that exist in the rubric and are not judgement
 * criteria, and fixtures of one `group` carrying the same expected band.
 */
export function checkFixtureData(fixtures: GoldenFixture[], rubricFor: (f: GoldenFixture) => VisaRubric): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const f of fixtures) {
    const bad = (message: string) => out.push({ fixtureId: f.id, assertion: "x-fixture-data", message });
    if (seen.has(f.id)) bad("duplicate fixture id");
    seen.add(f.id);
    if (!/^delivered\+[a-z0-9-]+@resend\.dev$/.test(f.applicant.email)) bad(`applicant email ${f.applicant.email} is not a delivered+<name>@resend.dev address`);
    if (!READINESS_BANDS.includes(f.label.expectedBand)) bad(`unknown expectedBand ${f.label.expectedBand}`);
    if (f.label.labelSource !== "draft-unreviewed" && f.label.labelSource !== "expert") bad(`unknown labelSource ${f.label.labelSource}`);
    if (f.label.labelSource === "expert" && (!f.label.reviewedBy || !f.label.reviewedOn)) bad("an expert label must name reviewedBy and reviewedOn");
    if (!f.label.rationale.trim() || f.label.paragraphs.length === 0) bad("label needs a rationale and the paragraph(s) it exercises");
    const rubric = rubricFor(f);
    for (const id of f.label.expectedGrounds) {
      const c = criterionById(rubric, id);
      if (!c) bad(`expected ground ${id} is not in the rubric`);
      else if (c.kind === "judgement") bad(`expected ground ${id} is a judgement criterion; only objective checks and mandatory bars can be refusal grounds`);
    }
  }
  const groups = new Map<string, GoldenFixture[]>();
  for (const f of fixtures) if (f.group) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  for (const [group, members] of groups) {
    const bands = new Set(members.map((m) => m.label.expectedBand));
    if (bands.size > 1) out.push({ fixtureId: members[0].id, assertion: "x-fixture-data", message: `group ${group}: identical facts must carry the same expected band, found ${[...bands]}` });
  }
  return out;
}

/**
 * Nationality invariance: fixtures of one group have identical facts and differ
 * only by nationality, so their RECORDED bands must be identical. Blocking for
 * every fixture, label source irrelevant: nationality must never move a band.
 * (A nationality may still change the outcome through a mandatory bar that
 * lists it; the group fixtures are chosen so that none does.)
 */
export function checkNationalityInvariance(rows: BandRow[], fixtures: GoldenFixture[]): Violation[] {
  const out: Violation[] = [];
  const groups = new Map<string, GoldenFixture[]>();
  for (const f of fixtures) if (f.group) groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  for (const [group, members] of groups) {
    const recorded = members.map((m) => ({ id: m.id, nat: m.applicant.nationality, band: rows.find((r) => r.fixtureId === m.id)?.recorded ?? null }));
    if (new Set(recorded.map((r) => r.band)).size > 1) {
      out.push({
        fixtureId: members[0].id,
        assertion: "x-nationality-invariance",
        message: `group ${group}: identical facts, different bands: ${recorded.map((r) => `${r.nat}=${r.band}`).join(", ")}`,
      });
    }
  }
  return out;
}

/** Corpus-level band-within-one share over the EXPERT-labelled fixtures. Null when there are none. */
export function expertBandShare(rows: BandRow[]): { share: number | null; expertCount: number } {
  const expert = rows.filter((r) => r.blocking);
  if (expert.length === 0) return { share: null, expertCount: 0 };
  return { share: expert.filter((r) => r.withinOne).length / expert.length, expertCount: expert.length };
}
