// ============================================
// WHICH COUNTRY DO I APPLY THROUGH (issue #235, P6 of #228)
// ============================================
//
// A SHARED route (a visa defined once by a bloc or treaty, inherited by each
// member country's own visa record, P2) is applied for THROUGH one member
// country. Choosing it decides which record the application runs on, and so
// which agencies and prices apply (prices are keyed by the member's own
// record). This service helps the applicant choose, and records the choice.
//
//   resolveCompetence(stack, answers, facts)   PURE: the shared rulebook's
//       competence steps (types/rubric.ts `CompetenceStep`) applied to the
//       applicant's answers -> a country, a question to ask, or "unknown".
//   competenceService.propose(...)             GET/POST /shared-routes/:id/apply-through
//       the member countries that can be offered, the questions, the proposal.
//   competenceService.resolveForCreate(...)    POST /applications with a shared route:
//       checks the confirmed country, finds its inheriting record, builds the
//       record of the choice (`Application.throughCountry`).
//   competenceService.changeThroughCountry(...) PUT /applications/:id/through-country
//       before submission: new record, new `routeStack`, answers kept or set aside.
//
// THE RULES (from the issue, each one enforced here):
//  - NEVER GUESSED. A shared rulebook with no competence rule has no
//    `competence` block: the result is "unknown" and the applicant simply
//    picks. No country is ever worked out from dates, lengths of stay or
//    anything other than an answer naming it (F1: "length or purpose of stay"
//    is the applicant's to say, so the rulebook asks; code never decides).
//  - PROPOSED, NEVER FORCED. The result is a proposal the applicant confirms;
//    they may pick another member, and the line "The rule says X; you chose Y"
//    is shown and stored with the choice.
//  - DATA, NOT CODE. The countries offered come from membership data on the
//    day of asking (`expandDestinations` through `destinationsOn`) and from
//    the member records that inherit the route; no country is typed in code.
//  - TODAY'S MEMBERS ONLY. A confirmed country that is not a destination of
//    the route today is refused (422). A member whose record is not usable
//    (draft, pending, rejected, inactive, or another agency's agency-only
//    visa: `canStartCaseOnVisa`) is not offered and cannot be chosen.
//  - NO LEAK ACROSS AGENCIES. Which records are offered is decided by the
//    same rule as case creation (`canStartCaseOnVisa`) for the agency the
//    case belongs to; an agency-only record of another agency is never listed.
//
// Nothing here names a country, a bloc or a route.

import { Timestamp } from "firebase-admin/firestore";
import { collections, subcollections } from "../utils/firebase";
import { isCountryCode, todayUtc } from "../authorities/authority-ids";
import { sharedRouteService } from "../shared-routes/shared-route.service";
import { sharedRulebookKey } from "../shared-routes/shared-route-rules";
import { resolveRouteStackFor, routeStackKeys } from "../shared-routes/route-stack";
import type { SharedRoute } from "../types/shared-route";
import { canStartCaseOnVisa } from "../agency-visas/agency-visa-access";
import { rubricStore, sharedLayerView } from "../scrapers";
import type { CompetenceBlock, IntakeQuestion, VisaRubric } from "../types/rubric";
import type { ApplicantFacts } from "../types/applicant-facts";
import type { Application, ThroughCountryChoice, VisaType } from "../types";
import { cleanAnswers, conditionHolds, INTAKE_EDITABLE_STATUSES, intakeService } from "./intake.service";
import { destinationOptions, routeDestinationReader, withDestinationOptions } from "./route-destinations";
import { visaService } from "./visa.service";
import { applicationService } from "./application.service";

// ============================================
// Errors
// ============================================

/** A refusal with an HTTP status, a stable code and a plain-words message (the controllers send these as they are). */
export class CompetenceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "CompetenceError";
  }
}

/** Plain-words messages, in one place so the app shows the same words everywhere. */
export const COMPETENCE_MESSAGES = {
  noOffer: "We can't offer this route yet",
  notDestination: (name: string) => `${name} is not part of this route today, so you can't apply through it.`,
  notOffered: (name: string) => `We can't offer applying through ${name} yet. Choose another country on this route.`,
  noRule: "The rules for this route don't say which country to apply through. Choose the country you'll apply through.",
  noStep: "Your answers don't point to one country under the rules. Choose the country you'll apply through.",
  notMember: (name: string) => `${name} is not part of this route today. Check your answers, or choose the country you'll apply through.`,
  differs: (rule: string, chosen: string) => `The rule says ${rule}; you chose ${chosen}.`,
} as const;

// ============================================
// The resolver (pure)
// ============================================

/** What the resolver reads: the (served, scoped) competence block and today's member codes. */
export interface CompetenceStack {
  competence?: CompetenceBlock;
  // The member countries of the route ON THE DAY (membership data). An answer naming any other code is not usable.
  destinations: readonly string[];
}

/** Why the resolver could not name a country. */
export type CompetenceUnknownReason = "NO_COMPETENCE_RULE" | "NO_STEP_APPLIES" | "NOT_A_MEMBER";

/** The resolver's answer. */
export type CompetenceResult =
  | { status: "country"; countryCode: string; stepIndex: number; restsOn: string; quote: string; url: string }
  | { status: "ask"; questionId: string }
  | { status: "unknown"; reason: CompetenceUnknownReason; why: string; countryCode?: string };

/** True when an answer counts as not given. */
function unanswered(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

/** The country codes an answer names (a single choice or a multiple choice); non-country options are ignored. */
function codesIn(answer: unknown): string[] {
  const values = Array.isArray(answer) ? answer : [answer];
  return [...new Set(values.filter((v): v is string => isCountryCode(v)))];
}

/**
 * Apply the competence steps to the applicant's answers.
 *
 * Steps are tried IN ORDER. For each step:
 *  1. its `when` conditions must ALL hold; a condition on a question not yet
 *     answered means that question must be asked first (`ask`), because the
 *     step cannot be skipped or applied without it;
 *  2. its question must be answered (`ask` otherwise);
 *  3. the answer names member countries: a code that is not a destination of
 *     the route today makes the result `unknown` (`NOT_A_MEMBER`, never a
 *     different country); exactly ONE member decides (`country`, with the
 *     step's quote and URL); none (for example "I can't say") or several means
 *     this step does not decide, and the next step is tried.
 * No block: `unknown` `NO_COMPETENCE_RULE` (the applicant picks). No step
 * decides: `unknown` `NO_STEP_APPLIES`.
 *
 * `facts` (the applicant's holdings) is accepted so a caller passes the whole
 * context, but no step reads it today: a step's result comes from an answer
 * only (`resultFrom: "answer"`), so nothing is inferred from a nationality, a
 * residence or a held document.
 */
export function resolveCompetence(stack: CompetenceStack, answers: Record<string, unknown>, facts?: ApplicantFacts | null): CompetenceResult {
  void facts; // never used to decide (see above)
  const steps = stack.competence?.steps ?? [];
  if (steps.length === 0) return { status: "unknown", reason: "NO_COMPETENCE_RULE", why: COMPETENCE_MESSAGES.noRule };
  const members = new Set(stack.destinations);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // ---- 1. the step's conditions ----
    let applies = true;
    for (const cond of step.when ?? []) {
      if (unanswered(answers[cond.questionId])) return { status: "ask", questionId: cond.questionId };
      if (!conditionHolds(cond, answers)) {
        applies = false;
        break;
      }
    }
    if (!applies) continue;
    // ---- 2. the answer ----
    const answer = answers[step.questionId];
    if (unanswered(answer)) return { status: "ask", questionId: step.questionId };
    // ---- 3. the countries it names ----
    const codes = codesIn(answer);
    const outside = codes.find((c) => !members.has(c));
    if (outside) return { status: "unknown", reason: "NOT_A_MEMBER", why: COMPETENCE_MESSAGES.notMember(outside), countryCode: outside };
    if (codes.length === 1) {
      return { status: "country", countryCode: codes[0], stepIndex: i, restsOn: step.restsOn, quote: step.source.quote, url: step.source.url };
    }
    // None or several: this step does not decide; the next one may.
  }
  return { status: "unknown", reason: "NO_STEP_APPLIES", why: COMPETENCE_MESSAGES.noStep };
}

/**
 * The questions the steps read (their own and their conditions'), plus every
 * question those depend on through `showWhen`, in rulebook order. Pure.
 */
export function competenceQuestions(block: CompetenceBlock | undefined, questions: readonly IntakeQuestion[]): IntakeQuestion[] {
  if (!block) return [];
  const byId = new Map(questions.map((q) => [q.id, q]));
  const wanted = new Set<string>();
  const add = (id: string) => {
    if (wanted.has(id) || !byId.has(id)) return;
    wanted.add(id);
    for (const cond of byId.get(id)?.showWhen?.anyOf ?? []) add(cond.questionId);
  };
  for (const s of block.steps) {
    add(s.questionId);
    for (const cond of s.when ?? []) add(cond.questionId);
  }
  return questions.filter((q) => wanted.has(q.id));
}

// ============================================
// The service
// ============================================

/** One member country that can be offered: its own inheriting record. */
export interface MemberOption {
  countryCode: string;
  countryName: string;
  visaTypeId: string;
  visaTypeName: string;
  // The member record's own price (prices are keyed by the member's record).
  baseCostUsd: number | null;
}

/** What the "apply through" step returns to the app. */
export interface ApplyThroughView {
  sharedRoute: { id: string; name: string; category: string };
  // The day membership was read for ("YYYY-MM-DD", UTC).
  on: string;
  // False when no member can be offered (`message` then says so).
  available: boolean;
  message: string | null;
  options: MemberOption[];
  // The questions that feed the steps (scoped ids, country options filled).
  questions: IntakeQuestion[];
  // The steps as the app shows them ("the rule"), or null when the rulebook has none.
  competence: { steps: { questionId: string; restsOn: string; quote: string; url: string }[] } | null;
  result: CompetenceResult;
  // The proposal, when the answers point to a country; `offered` false when that country cannot be offered.
  proposal: { countryCode: string; countryName: string; stepIndex: number; restsOn: string; quote: string; url: string; offered: boolean } | null;
  // The answers as validated (scoped ids).
  answers: Record<string, unknown>;
  rulebookKey: string;
  rulebookVersion: number | null;
}

/** What creation needs once the confirmed country is checked. */
export interface ResolvedThroughCountry {
  countryCode: string;
  visaTypeId: string;
  visaType: VisaType;
  choice: ThroughCountryChoice;
  // The validated answers to the competence questions (scoped ids), to seed the intake with.
  answers: Record<string, unknown>;
}

/** Who is acting (for the record of the choice). */
export interface CompetenceActor {
  uid: string;
  role?: string;
}

/** What a country change did. */
export interface ChangeThroughCountryResult {
  changed: boolean;
  application: Application;
  answersKept: number;
  answersSetAside: number;
}

class CompetenceService {
  /** Clock in epoch ms (tests fix it). */
  clock: () => number = Date.now;

  /**
   * The shared layer's approved rulebook (the store's approved read: all its
   * guarantees, exclusions applied, competence served only when it passes).
   * Swappable by tests.
   */
  readSharedLayer: (rulebookKey: string) => Promise<VisaRubric | null> = (key) => rubricStore.getApprovedRubricByKey(key);

  /**
   * The visa records of `countryCode` that inherit `sharedRouteId`, sorted by
   * id. One single-field `array-contains` query on that country's records.
   */
  async inheritingRecords(countryCode: string, sharedRouteId: string): Promise<VisaType[]> {
    const snap = await subcollections.visaTypes(countryCode).where("inheritsFrom", "array-contains", { sharedRouteId }).get();
    return snap.docs
      .map((d) => ({ ...(d.data() as VisaType), id: (d.data() as VisaType).id ?? d.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The route, or 404; a retired route is refused like an unknown one (it is offered to nobody). */
  private async activeRoute(sharedRouteId: unknown): Promise<SharedRoute> {
    const route = typeof sharedRouteId === "string" ? await sharedRouteService.get(sharedRouteId) : undefined;
    if (!route || route.status !== "active") throw new CompetenceError("NOT_FOUND", 404, "There is no such route");
    return route;
  }

  /**
   * The member record a case may use in `countryCode` (the first, by id, that
   * `canStartCaseOnVisa` allows for the case's agency), or null.
   * Several usable records in one country inheriting the same route is not
   * expected; the first by id is used so the choice is stable.
   */
  private async usableRecord(countryCode: string, route: SharedRoute, caseAgencyId: string | null | undefined): Promise<VisaType | null> {
    for (const v of await this.inheritingRecords(countryCode, route.id)) if (canStartCaseOnVisa(v, caseAgencyId)) return v;
    return null;
  }

  /** Every member that can be offered today (in member-code order), with its record. */
  async memberOptions(route: SharedRoute, on: string, caseAgencyId: string | null | undefined): Promise<{ destinations: string[]; options: MemberOption[] }> {
    const destinations = await routeDestinationReader.destinationsOf(route.id, on);
    const options: MemberOption[] = [];
    const labels = await destinationOptions(destinations);
    for (let i = 0; i < destinations.length; i++) {
      const record = await this.usableRecord(destinations[i], route, caseAgencyId);
      if (!record) continue; // no visible record (draft, pending, another agency's): not offered
      options.push({
        countryCode: destinations[i],
        countryName: labels[i].label,
        visaTypeId: record.id,
        visaTypeName: record.name,
        baseCostUsd: typeof record.baseCostUsd === "number" ? record.baseCostUsd : null,
      });
    }
    return { destinations, options };
  }

  /**
   * The shared layer's competence block and the questions that feed it, with
   * ids scoped as the application's intake will store them.
   */
  private async sharedRules(route: SharedRoute, on: string): Promise<{ key: string; version: number | null; block?: CompetenceBlock; questions: IntakeQuestion[] }> {
    const key = sharedRulebookKey(route.issuingAuthorityId, route.id);
    const rubric = await this.readSharedLayer(key);
    if (!rubric) return { key, version: null, questions: [] };
    const view = sharedLayerView(key, route.issuingAuthorityId, rubric);
    const questions = await withDestinationOptions(competenceQuestions(view.competence, view.intakeQuestions ?? []), key, on);
    return { key, version: rubric.version, block: view.competence, questions };
  }

  /**
   * The "apply through" step for a shared route: what can be offered, the
   * questions, and (with answers) the proposal. Never writes anything.
   *
   * @param rawAnswers answers to the returned questions (scoped ids), or undefined
   * @param caseAgencyId the agency the case will belong to (from its agent), or none
   */
  async propose(sharedRouteId: unknown, rawAnswers: unknown, caseAgencyId: string | null | undefined): Promise<ApplyThroughView> {
    const route = await this.activeRoute(sharedRouteId);
    const on = todayUtc(this.clock());
    const [{ destinations, options }, rules] = await Promise.all([this.memberOptions(route, on, caseAgencyId), this.sharedRules(route, on)]);
    // Same validation as the intake (unknown ids refused, hidden dropped, per type).
    const answers = rawAnswers === undefined || rawAnswers === null ? {} : cleanAnswers(rules.questions, rawAnswers);
    const result = resolveCompetence({ competence: rules.block, destinations }, answers);
    let proposal: ApplyThroughView["proposal"] = null;
    if (result.status === "country") {
      const offered = options.find((o) => o.countryCode === result.countryCode);
      const name = offered?.countryName ?? (await routeDestinationReader.countryName(result.countryCode));
      proposal = { countryCode: result.countryCode, countryName: name, stepIndex: result.stepIndex, restsOn: result.restsOn, quote: result.quote, url: result.url, offered: offered !== undefined };
    }
    return {
      sharedRoute: { id: route.id, name: route.name, category: route.category },
      on,
      available: options.length > 0,
      message: options.length > 0 ? null : COMPETENCE_MESSAGES.noOffer,
      options,
      questions: rules.questions,
      competence: rules.block ? { steps: rules.block.steps.map((s) => ({ questionId: s.questionId, restsOn: s.restsOn, quote: s.source.quote, url: s.source.url })) } : null,
      result,
      proposal,
      answers,
      rulebookKey: rules.key,
      rulebookVersion: rules.version,
    };
  }

  /**
   * Check a CONFIRMED country for a shared route and build the record of the
   * choice. Refused: an unknown / retired route (404); a malformed code (400);
   * a country that is not a destination of the route today (422
   * COUNTRY_NOT_A_DESTINATION); a member with no record this case may use
   * (422 COUNTRY_NOT_OFFERED). The proposal is worked out again HERE from the
   * answers (a client's claim of what was proposed is never trusted).
   */
  async resolveForCreate(
    input: { sharedRouteId: unknown; throughCountryCode: unknown; answers?: unknown },
    caseAgencyId: string | null | undefined,
    actor: CompetenceActor
  ): Promise<ResolvedThroughCountry> {
    if (!isCountryCode(input.throughCountryCode)) throw new CompetenceError("VALIDATION_ERROR", 400, "throughCountryCode must be a two-letter country code in capitals");
    const view = await this.propose(input.sharedRouteId, input.answers, caseAgencyId);
    return this.choose(view, input.throughCountryCode, actor);
  }

  /** The checks and the record of the choice, shared by create and change. */
  private async choose(view: ApplyThroughView, countryCode: string, actor: CompetenceActor): Promise<ResolvedThroughCountry> {
    const destinations = await routeDestinationReader.destinationsOf(view.sharedRoute.id, view.on);
    const name = await routeDestinationReader.countryName(countryCode);
    if (!destinations.includes(countryCode)) throw new CompetenceError("COUNTRY_NOT_A_DESTINATION", 422, COMPETENCE_MESSAGES.notDestination(name));
    const option = view.options.find((o) => o.countryCode === countryCode);
    if (!option) throw new CompetenceError("COUNTRY_NOT_OFFERED", 422, COMPETENCE_MESSAGES.notOffered(name));
    const visaType = await visaService.getVisaType(countryCode, option.visaTypeId);
    if (!visaType) throw new CompetenceError("COUNTRY_NOT_OFFERED", 422, COMPETENCE_MESSAGES.notOffered(name));

    const p = view.proposal;
    const followed = p ? p.countryCode === countryCode : null;
    const choice: ThroughCountryChoice = {
      sharedRouteId: view.sharedRoute.id,
      countryCode,
      chosenByUid: actor.uid,
      ...(actor.role ? { chosenByRole: actor.role } : {}),
      confirmedAt: Timestamp.fromMillis(this.clock()),
      proposal: p ? { countryCode: p.countryCode, stepIndex: p.stepIndex, restsOn: p.restsOn, quote: p.quote, url: p.url } : null,
      answers: view.answers,
      ...(view.result.status === "unknown" ? { noProposalReason: view.result.reason } : {}),
      followedProposal: followed,
      ...(p && followed === false ? { reasonShown: COMPETENCE_MESSAGES.differs(p.countryName, name) } : {}),
      rulebookKey: view.rulebookKey,
      ...(view.rulebookVersion !== null ? { rulebookVersion: view.rulebookVersion } : {}),
    };
    return { countryCode, visaTypeId: option.visaTypeId, visaType: { ...visaType, id: visaType.id ?? option.visaTypeId }, choice, answers: view.answers };
  }

  /**
   * Change the confirmed country of a shared-route application BEFORE
   * submission (statuses in which the intake is still editable, and nothing
   * paid yet). Recomputes the record (`countryCode`, `visaTypeId`, names,
   * price, documents count), the `routeStack` and the record of the choice,
   * and rebuilds the intake: answers whose question is still in the new
   * stack are kept, the others are moved to `intake.orphanedAnswers` (never
   * deleted). The same country again changes nothing.
   *
   * Refused: not a shared-route application (409 NOT_SHARED_ROUTE); submitted
   * (409 NOT_EDITABLE); already paid (409 ALREADY_PAID); plus the checks of
   * creation (404 / 400 / 422).
   */
  async changeThroughCountry(application: Application, rawCountry: unknown, actor: CompetenceActor): Promise<ChangeThroughCountryResult> {
    const current = application.throughCountry;
    if (!current || !application.throughCountryCode) {
      throw new CompetenceError("NOT_SHARED_ROUTE", 409, "This application is not on a route you apply for through a member country");
    }
    if (!INTAKE_EDITABLE_STATUSES.includes(application.status)) {
      throw new CompetenceError("NOT_EDITABLE", 409, "This application has been submitted, so the country you apply through can't be changed.");
    }
    if ((application.amountPaid ?? 0) > 0) {
      throw new CompetenceError("ALREADY_PAID", 409, "You've already paid for this application, so the country you apply through can't be changed here. Contact support to change it.");
    }
    if (!isCountryCode(rawCountry)) throw new CompetenceError("VALIDATION_ERROR", 400, "throughCountryCode must be a two-letter country code in capitals");
    if (rawCountry === application.throughCountryCode) return { changed: false, application, answersKept: Object.keys(application.intake?.answers ?? {}).length, answersSetAside: 0 };

    // The steps read the application's saved answers to the shared layer's
    // questions (same scoped ids). Only those questions' answers are passed.
    const route = await this.activeRoute(current.sharedRouteId);
    const on = todayUtc(this.clock());
    const rules = await this.sharedRules(route, on);
    const saved = application.intake?.answers ?? {};
    const ids = new Set(rules.questions.map((q) => q.id));
    const competenceAnswers = Object.fromEntries(Object.entries(saved).filter(([id]) => ids.has(id)));
    // The case's agency decides which records may be used, exactly as at creation.
    const view = await this.propose(route.id, competenceAnswers, application.agencyId ?? null);
    const resolved = await this.choose(view, rawCountry, actor);

    // ---- the new record, stack and intake ----
    const visa = resolved.visaType;
    const routeStack = routeStackKeys(await resolveRouteStackFor(resolved.countryCode, resolved.visaTypeId, visa.inheritsFrom));
    const now = Timestamp.fromMillis(this.clock());
    const rebuilt = await intakeService.rebuildIntake(
      { countryCode: resolved.countryCode, visaTypeId: resolved.visaTypeId, routeStack },
      { answers: saved, routeKey: application.intake?.routeKey, rubricVersion: application.intake?.rubricVersion, orphanedAnswers: application.intake?.orphanedAnswers },
      now
    );
    const [requirements, country] = await Promise.all([visaService.getRequirements(resolved.countryCode, resolved.visaTypeId), visaService.getCountryByCode(resolved.countryCode)]);
    const documentsRequired = requirements.reduce((sum, r) => sum + (r.requiredDocuments?.length || 0), 0);

    const update: Partial<Application> = {
      countryCode: resolved.countryCode,
      visaTypeId: resolved.visaTypeId,
      visaTypeName: visa.name,
      countryName: country?.name || resolved.countryCode,
      // The member record's own price, as at creation (cents).
      totalCost: visa.baseCostUsd * 100,
      documentsRequired,
      routeStack,
      throughCountryCode: resolved.countryCode,
      throughCountry: resolved.choice,
      ...(rebuilt.intake ? { intake: rebuilt.intake } : {}),
      lastUpdated: now,
      updatedAt: now,
    };
    await collections.applications.doc(application.id).update(update as Record<string, unknown>);
    // The same timeline entry shape as every other application event.
    await applicationService.addTimelineEntry(application.id, {
      title: "Country changed",
      description: `You now apply through ${country?.name || resolved.countryCode}`,
      status: "completed",
      responsibility: "user",
    });
    return { changed: true, application: { ...application, ...update }, answersKept: rebuilt.kept, answersSetAside: rebuilt.setAside };
  }
}

export const competenceService = new CompetenceService();
