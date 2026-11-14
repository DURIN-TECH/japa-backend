import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  EligibilityQuestion,
  EligibilityCheck,
  EligibilityCheckInput,
  EligibilityResult,
  EligibilityAnswer,
  VisaPreCheckInput,
  VisaPreCheckResult,
  VisaRequirementType,
} from "../types/eligibility";
// Issue #236: "do you need a visa at all" is answered from sourced entry rules.
import { entryRequirementsService } from "../entry-requirements/entry-requirements.service";
import type { EntryRequirementResult } from "../types/entry-requirements";
import { VisaCategory, VisaType } from "../types";
// The ONE place visa types live: `countries/{code}/visaTypes` (see the
// CANONICAL VISA TYPE PATH note below). Both helpers come from utils/firebase
// so unit tests can swap them for in-memory fakes.
import { collectionGroups, subcollections } from "../utils/firebase";
// The public visibility rule (issue #99). Called, never re-implemented here.
import { isVisaPubliclyVisible } from "./visa.service";

const db = getFirestore();

// ============================================
// CANONICAL VISA TYPE PATH (issue #27)
// ============================================
//
// Visa types live in exactly ONE place: `countries/{countryCode}/visaTypes/{id}`.
// That is where every writer puts them (the seed scripts, the admin
// `POST /countries/:code/visas`, the visa-catalog scraper and the agency visa
// endpoints), and where every other reader looks (visa.service).
//
// There is NO top-level `visaTypes` collection. Eligibility used to read one
// straight off the database root, which nothing ever wrote, so it never found a
// visa: recommendations were always empty and questions never saw the visa's
// category. Do NOT bring that path back, here or anywhere else:
//  - one country       -> `subcollections.visaTypes(countryCode)`
//  - country not known -> `collectionGroups.visaTypes()` (collection group)
//
// Everything this service shows a PUBLIC user also goes through
// `isVisaPubliclyVisible()`, so a pending / rejected scraped visa, an
// agency-only visa or an inactive one is never recommended or scored.

/**
 * Travel purpose (from the pre-check form) -> the visa categories that fit it.
 * A purpose that is not listed ("other") matches no category, so it gets no
 * recommendation. Unchanged from before issue #27 (only moved out of the loop).
 */
const PURPOSE_TO_CATEGORIES: Record<string, string[]> = {
  tourism: ["tourist", "visitor"],
  business: ["business", "visitor"],
  work: ["work"],
  study: ["student"],
  family: ["family"],
  transit: ["transit"],
};

/** Most visa types one pre-check recommends (unchanged). */
const MAX_RECOMMENDED_VISAS = 3;

/**
 * Whether a caller-supplied value is safe to use as ONE Firestore path
 * segment (a country code or a visa type id). Both come straight from a
 * public request (body, query string or URL param), and `doc("")` or an id
 * holding a "/" makes the Firestore client throw, which would turn a bad
 * input into a 500. An unsafe value is treated as "no such visa" instead.
 *
 * Ids of the form `__…__` are also refused: Firestore reserves them and
 * rejects the read on the server, which would be a 500 too.
 */
function isSafeDocId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    // Reserved by Firestore (`__name__`, `__anything__`).
    !/^__.*__$/.test(value)
  );
}

/**
 * gRPC status code Firestore answers with when a query needs an index that
 * does not exist (or is still building): 9 = FAILED_PRECONDITION.
 */
const GRPC_FAILED_PRECONDITION = 9;

/** Whether an error thrown by a Firestore query is the missing-index one. */
function isMissingIndexError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === GRPC_FAILED_PRECONDITION;
}

/** One `countries/{countryCode}/visaTypes/{id}` document found by id. */
interface VisaTypeCopy {
  /** The country the copy lives under (its grandparent document id). */
  countryCode: string;
  /** The visa document. */
  data: VisaType;
}

/**
 * What eligibility knows about a visa type id:
 *  - `visible`: the visa exists and may be shown to a public user. Carries
 *    the two fields question selection needs (category + its country).
 *  - `hidden`: the visa exists but is NOT publicly visible (pending,
 *    rejected, agency-only or inactive). Nothing about it may be used.
 *    This is decided across ALL countries, not only the one the caller
 *    named: an id whose every copy is non-public is `hidden` whatever
 *    country (or none) the request carries.
 *  - `missing`: the lookup succeeded and there is no such visa for this
 *    request: no document with that id anywhere, or the only copies are
 *    PUBLIC ones under a country other than the one asked for (or the id
 *    cannot be a document id at all).
 *  - `unknown`: the cross-country lookup could not run (its index is missing
 *    or still building), so a hidden visa cannot be ruled out. Handled like
 *    `hidden` (fail closed).
 */
type ResolvedVisaType =
  | { kind: "visible"; countryCode: string; category?: VisaCategory }
  | { kind: "hidden" }
  | { kind: "missing" }
  | { kind: "unknown" };

export class EligibilityService {
  private questionsCollection = db.collection("eligibilityQuestions");
  private checksCollection = db.collection("eligibilityChecks");

  /**
   * Pre-check: does the user need a visa at all? (Issue #236.)
   *
   * Answered ONLY from sourced entry rules (`entryRequirementsService`, the
   * same lookup as GET /entry-requirements): every "you need a visa" / "you
   * don't" rests on an official quote and URL. With no rule for the pair, a
   * stale source, or a missing fact, the answer is `status: "unknown"` with
   * `visaRequired: null` and the reason, plus the destination authority's
   * official page when one is registered. The old fallback ("no exemption
   * found - assume visa required") is gone: it was a guess.
   *
   * The visa types available for the travel purpose are still listed
   * (`recommendedVisaTypes`) whenever the answer is not "no visa needed": they
   * are the destination's published visas for that purpose, not a claim that
   * one is required.
   */
  async preCheck(input: VisaPreCheckInput): Promise<VisaPreCheckResult> {
    const { nationality, destinationCountry, travelPurpose, intendedStayDays } = input;
    // Codes are compared upper-case. A value that is not a two-letter code
    // matches no rule (the lookup answers `unknown`), never an error.
    const destination = typeof destinationCountry === "string" ? destinationCountry.trim().toUpperCase() : "";
    const nat = typeof nationality === "string" ? nationality.trim().toUpperCase() : "";
    const stay = typeof intendedStayDays === "number" && Number.isInteger(intendedStayDays) && intendedStayDays > 0 ? intendedStayDays : undefined;

    const entry: EntryRequirementResult = /^[A-Z]{2}$/.test(destination)
      ? await entryRequirementsService.lookup({
        destination,
        nationalities: /^[A-Z]{2}$/.test(nat) ? [nat] : [],
        purpose: travelPurpose,
        stayDays: stay,
      })
      : { status: "unknown", destination, code: "no_rule", reason: "We don't have an official source for this yet." };

    return this.preCheckResultOf(entry, destinationCountry, travelPurpose);
  }

  /**
   * Map a sourced entry answer onto the pre-check response (#236). Pure apart
   * from the visa-type read. `visaRequired` is true / false ONLY when an
   * official rule says so; `null` for `unknown`.
   */
  private async preCheckResultOf(entry: EntryRequirementResult, destinationCountry: string, travelPurpose: string): Promise<VisaPreCheckResult> {
    if (entry.status === "unknown") {
      // No source: no claim either way. The visas for the purpose are still
      // listed, as what the destination publishes (never as "you need one").
      const listed = await this.getVisaRequiredResult(destinationCountry, travelPurpose);
      return {
        visaRequired: null,
        requirementType: "unknown",
        status: "unknown",
        entryRequirement: entry,
        recommendedVisaTypes: listed.recommendedVisaTypes,
        nextSteps: [
          entry.reason,
          ...(entry.destinationAuthorityPage ? [`Official page: ${entry.destinationAuthorityPage}`] : []),
        ],
      };
    }
    // Sourced answer: the STRICTEST matching rule decides.
    const needsVisa = entry.outcome === "visa_required" || entry.outcome === "transit_visa";
    const requirementType: VisaRequirementType =
      entry.outcome === "travel_authorisation" ? "eta" :
        entry.outcome === "visa_on_arrival" ? "visa_on_arrival" :
          needsVisa ? "visa_required" : "visa_free";
    const conditions = entry.conditions.map((c) => c.text);
    if (needsVisa) {
      const listed = await this.getVisaRequiredResult(destinationCountry, travelPurpose);
      return {
        ...listed,
        visaRequired: true,
        requirementType,
        status: "answer",
        entryRequirement: entry,
        conditions,
        nextSteps: [entry.message, ...listed.nextSteps],
      };
    }
    return {
      visaRequired: false,
      requirementType,
      status: "answer",
      entryRequirement: entry,
      maxStayDays: entry.stay?.maxDays,
      conditions,
      nextSteps: [entry.message, ...(entry.authorisation ? [`Official page: ${entry.authorisation.applyUrl}`] : [])],
    };
  }

  /**
   * Build the "visa required" pre-check answer, with up to
   * MAX_RECOMMENDED_VISAS recommended visa types for the travel purpose.
   *
   * Reads ONE country's visas: `countries/{destinationCountry}/visaTypes`
   * where `isActive == true` (single-field equality, so no composite index
   * and no cross-country scan), then:
   *  1. keeps only publicly visible visas (isVisaPubliclyVisible), so a
   *     pending / rejected scraped visa or an agency-only visa is never
   *     recommended, even one wrongly stored with `isActive: true`;
   *  2. keeps only the categories that fit the travel purpose.
   *
   * An unknown or unusable destination gives an empty recommendation list,
   * never an error.
   *
   * @param destinationCountry destination country code (any case)
   * @param travelPurpose purpose from the pre-check form
   * @param warnings warnings collected by preCheck, passed through
   */
  private async getVisaRequiredResult(
    destinationCountry: string,
    travelPurpose: string,
    warnings?: string[]
  ): Promise<Pick<VisaPreCheckResult, "warnings" | "recommendedVisaTypes" | "nextSteps">> {
    // Categories that fit this purpose (none for an unlisted purpose).
    const matchingCategories = PURPOSE_TO_CATEGORIES[travelPurpose] || [];

    // Per-country read on the canonical path. Country doc ids are upper-case
    // codes, as in visa.service. Skipped for an unusable code (see isSafeDocId).
    const visaDocs = isSafeDocId(destinationCountry) ?
      (await subcollections
        .visaTypes(destinationCountry.toUpperCase())
        .where("isActive", "==", true)
        .get()).docs :
      [];

    const recommendedVisas = visaDocs
      // Firestore data is untyped: these docs are VisaType documents.
      .map((doc) => ({ id: doc.id, data: doc.data() as VisaType }))
      // ---- Public visibility rule (issue #99), then purpose match ----
      .filter(({ data }) => isVisaPubliclyVisible(data))
      .filter(({ data }) => matchingCategories.includes(data.category))
      .slice(0, MAX_RECOMMENDED_VISAS)
      // Same five fields as before: the response shape is unchanged.
      .map(({ id, data }) => ({
        id,
        name: data.name,
        description: data.description,
        processingTime: data.processingTime,
        baseCostUsd: data.baseCostUsd,
      })) as VisaPreCheckResult["recommendedVisaTypes"];

    // (#236) Only the visa list and the generic steps: whether a visa is
    // required is decided by the sourced entry answer (preCheckResultOf).
    return {
      ...(warnings ? { warnings } : {}),
      recommendedVisaTypes: recommendedVisas,
      nextSteps: [
        "Review the recommended visa types below.",
        "Check your eligibility before applying.",
        "Gather required documents.",
        "Submit your application online or through an agent.",
      ],
    };
  }

  /**
   * Every copy of a visa type id, across all countries.
   *
   * A COLLECTION-GROUP query over every `countries/{code}/visaTypes`
   * subcollection, `where("id", "==", visaTypeId)`. Visa docs store their own
   * id in the `id` field (a collection-group query cannot filter on a bare
   * document id). Needs the single-field COLLECTION_GROUP index on
   * `visaTypes.id` (firestore.indexes.json, `fieldOverrides`). The country of
   * each match is its parent document: `doc.ref.parent.parent.id`.
   *
   * Errors:
   *  - missing index (FAILED_PRECONDITION, e.g. still building right after a
   *    deploy): logged at error level on every call, so an index that never
   *    gets deployed is not silent, and `null` is returned. The caller must
   *    then fail closed (see resolveVisaType, kind `unknown`);
   *  - anything else (Firestore down, permissions…): logged and rethrown, like
   *    every other failed read in this service. Never swallowed.
   *
   * @param visaTypeId a visa type id that passed isSafeDocId
   * @returns the copies (possibly none), or `null` when the index is missing
   */
  private async findVisaTypeCopies(visaTypeId: string): Promise<VisaTypeCopy[] | null> {
    try {
      const snapshot = await collectionGroups.visaTypes().where("id", "==", visaTypeId).get();
      return snapshot.docs
        .map((doc) => ({
          // `countries/{CC}/visaTypes/{id}`: the country is the grandparent.
          countryCode: doc.ref.parent.parent?.id,
          data: doc.data() as VisaType,
        }))
        // A top-level `visaTypes` doc (no parent document) is not a real
        // visa type: there must be none, and one must never be scored.
        .filter((m): m is VisaTypeCopy => !!m.countryCode);
    } catch (error) {
      if (isMissingIndexError(error)) {
        console.error(
          "Eligibility: the visaTypes.id COLLECTION_GROUP index is missing or still building " +
            "(deploy firestore.indexes.json). Visa-specific and category questions are withheld " +
            "until it exists:",
          error
        );
        return null;
      }
      console.error("Eligibility: visaTypes collection-group lookup failed:", error);
      throw error;
    }
  }

  /**
   * Find a visa type by id on the canonical path (see CANONICAL VISA TYPE
   * PATH at the top of this file) and apply the public visibility rule.
   *
   * Step 1, only when the caller names a usable country
   * (`POST /eligibility/check` always sends one;
   * `GET /eligibility/questions/:visaTypeId?destinationCountry=…` may): one
   * document read, `countries/{CC}/visaTypes/{visaTypeId}`. A document found
   * there decides: `visible` or `hidden`. The same id under another country
   * is never used in its place.
   *
   * Step 2, when step 1 found nothing or there is no usable country
   * (`GET /eligibility/questions/:visaTypeId` with no `destinationCountry` is
   * what the mobile app sends today): every copy of the id across all
   * countries (findVisaTypeCopies, a collection-group query).
   *  - index missing          -> `unknown` (fail closed);
   *  - no copy anywhere       -> `missing`;
   *  - copies, none public    -> `hidden`. This is what stops a caller from
   *    reaching a hidden visa's questions by naming a different country;
   *  - public copies, and the caller named a country (which holds none of
   *    them) -> `missing`: the country decides, nothing to hide;
   *  - public copies, no country -> `visible`, deterministically: the lowest
   *    country code (plain string order). Callers that know the country
   *    should send it.
   *
   * Never throws for an unknown / unusable id or country. A Firestore failure
   * other than the missing index propagates.
   *
   * @param visaTypeId visa type document id
   * @param countryCode destination country code when the caller knows it
   */
  private async resolveVisaType(
    visaTypeId: string,
    countryCode?: string
  ): Promise<ResolvedVisaType> {
    // An id that cannot be a document id cannot match anything, anywhere.
    if (!isSafeDocId(visaTypeId)) return { kind: "missing" };

    // Whether the caller named a country at all (usable or not).
    const countryGiven = countryCode !== undefined && countryCode !== "";

    // ---- Step 1. Usable country: one document read under that country ----
    if (countryGiven && isSafeDocId(countryCode)) {
      const cc = countryCode.toUpperCase();
      const doc = await subcollections.visaTypes(cc).doc(visaTypeId).get();
      // Untyped Firestore data: a VisaType document (undefined when missing).
      const data = doc.data() as VisaType | undefined;
      if (doc.exists && data) {
        if (!isVisaPubliclyVisible(data)) return { kind: "hidden" };
        return { kind: "visible", countryCode: cc, category: data.category };
      }
      // Not under that country: it may still be a hidden visa elsewhere.
    }

    // ---- Step 2. Every copy of the id, across all countries ----
    const copies = await this.findVisaTypeCopies(visaTypeId);
    // Could not look: a hidden visa cannot be ruled out.
    if (copies === null) return { kind: "unknown" };
    if (copies.length === 0) return { kind: "missing" };

    // Publicly visible copies only, lowest country code first.
    const visible = copies
      .filter((m) => isVisaPubliclyVisible(m.data))
      .sort((a, b) => (a.countryCode < b.countryCode ? -1 : a.countryCode > b.countryCode ? 1 : 0));
    // The id exists but no copy is public: hidden, whatever country was sent.
    if (visible.length === 0) return { kind: "hidden" };
    // Public elsewhere, but not under the country the caller named.
    if (countryGiven) return { kind: "missing" };

    if (visible.length > 1) {
      // Not an error, but worth seeing: the caller should send the country.
      console.warn(
        `Eligibility: visa type id "${visaTypeId}" exists under ${visible.length} countries ` +
          `(${visible.map((m) => m.countryCode).join(", ")}); using ${visible[0].countryCode}. ` +
          "Pass destinationCountry to pick one."
      );
    }
    return {
      kind: "visible",
      countryCode: visible[0].countryCode,
      category: visible[0].data.category,
    };
  }

  /**
   * Get eligibility questions for a visa type
   * Combines: common + category + country + nationality + visa-specific questions
   * Filters by nationality if provided
   *
   * The visa type is read from `countries/{code}/visaTypes` (resolveVisaType):
   *  - visible visa: its category and country pick the question scopes, and
   *    its `visa:{id}` questions are served;
   *  - missing visa: no category, generic questions (never throws). The
   *    `visa:{id}` scope is still read, as before issue #27, so questions
   *    seeded for an id that has no visa document keep working;
   *  - hidden visa (pending / rejected / agency-only / inactive): no
   *    category and NO `visa:{id}` questions;
   *  - unknown (the cross-country lookup had no index): same as hidden.
   *
   * What is guaranteed. For a visa type id whose EVERY copy (under any
   * country) is non-public, this method never serves, and submitCheck never
   * scores, that id's `visa:{id}` questions or its category questions:
   *  - whatever `destinationCountry` / `countryCode` the caller sends (the
   *    visa's own country, another one, an unusable one, or none);
   *  - and while the visaTypes.id index is missing or still building.
   * Such a request gets the generic questions an unknown id gets.
   *
   * Not covered, on purpose: an id that is public under one country and
   * non-public under another. `visa:{id}` questions are keyed by the id
   * alone, so they are the public visa's questions too; they are withheld
   * only when the caller names the country of the non-public copy.
   *
   * The cost of failing closed: until the visaTypes.id index exists, a
   * request that needs the cross-country lookup (no country sent, or the id
   * is not under the country sent) gets the generic questions only, even for
   * a public visa or for questions seeded under an id with no visa document.
   *
   * @param visaTypeId visa type document id
   * @param nationality applicant nationality, filters nationality-scoped questions
   * @param destinationCountry destination country code; when given, the visa is
   *   looked up under that country only
   */
  async getQuestions(
    visaTypeId: string,
    nationality?: string,
    destinationCountry?: string
  ): Promise<EligibilityQuestion[]> {
    // Get the visa type to know its category and country
    const resolved = await this.resolveVisaType(visaTypeId, destinationCountry);
    const category = resolved.kind === "visible" ? resolved.category : undefined;
    // The caller's country wins (unchanged); else the visa's own country.
    const countryCode = destinationCountry ||
      (resolved.kind === "visible" ? resolved.countryCode : undefined);

    // Build list of scopes to query
    const scopes: string[] = [
      "common",
    ];

    if (category) {
      scopes.push(`category:${category}`);
    }

    if (countryCode) {
      scopes.push(`country:${countryCode}`);
    }

    if (nationality) {
      scopes.push(`nationality:${nationality}`);
      if (countryCode) {
        scopes.push(`nationality:${nationality}:${countryCode}`);
      }
    }

    // Visa-specific questions: only when the lookup succeeded and did not
    // find a non-public-only id (allow-list, so a new kind fails closed).
    if (resolved.kind === "visible" || resolved.kind === "missing") {
      scopes.push(`visa:${visaTypeId}`);
    }

    // Fetch all applicable questions in parallel
    const questionPromises = scopes.map((scope) => this.getQuestionsByScope(scope));
    const questionArrays = await Promise.all(questionPromises);

    // Flatten and deduplicate by ID
    const questionMap = new Map<string, EligibilityQuestion>();
    for (const questions of questionArrays) {
      for (const q of questions) {
        // Apply nationality filters if question has them
        if (q.applicableNationalities && q.applicableNationalities.length > 0) {
          if (!nationality || !q.applicableNationalities.includes(nationality)) {
            continue; // Skip this question - not for this nationality
          }
        }
        if (q.excludedNationalities && q.excludedNationalities.length > 0) {
          if (nationality && q.excludedNationalities.includes(nationality)) {
            continue; // Skip this question - excluded for this nationality
          }
        }
        questionMap.set(q.id, q);
      }
    }

    const allQuestions = Array.from(questionMap.values());

    // If no questions found at all, return defaults
    if (allQuestions.length === 0) {
      return this.getDefaultQuestions(visaTypeId, category);
    }

    // Sort by orderIndex and limit to reasonable number (5-8)
    const sorted = allQuestions.sort((a, b) => a.orderIndex - b.orderIndex);

    // Take top questions, prioritizing required ones
    const required = sorted.filter((q) => q.isRequired);
    const optional = sorted.filter((q) => !q.isRequired);

    // Return up to 8 questions, prioritizing required
    const maxQuestions = 8;
    if (required.length >= maxQuestions) {
      return required.slice(0, maxQuestions);
    }

    return [...required, ...optional.slice(0, maxQuestions - required.length)];
  }

  /**
   * Get questions by scope (common, category:work, visa:xyz)
   */
  private async getQuestionsByScope(scope: string): Promise<EligibilityQuestion[]> {
    const snapshot = await this.questionsCollection
      .where("scope", "==", scope)
      .where("isActive", "==", true)
      .orderBy("orderIndex", "asc")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as EligibilityQuestion[];
  }

  /**
   * Default questions based on visa category
   */
  private getDefaultQuestions(
    visaTypeId: string,
    category?: VisaCategory
  ): EligibilityQuestion[] {
    const now = Timestamp.now();
    const questions: EligibilityQuestion[] = [];

    // Common questions for all visas
    questions.push(
      {
        id: "passport",
        visaTypeId,
        scope: "common",
        question: "Do you have a valid passport?",
        description: "Your passport should be valid for at least 6 months beyond your intended stay.",
        type: "boolean",
        weight: 15,
        correctAnswers: ["true"],
        orderIndex: 1,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "passport_validity",
        visaTypeId,
        scope: "common",
        question: "How many months until your passport expires?",
        type: "number",
        weight: 10,
        minValue: 0,
        maxValue: 120,
        idealMin: 6,
        idealMax: 120,
        orderIndex: 2,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "visa_denial",
        visaTypeId,
        scope: "common",
        question: "Have you ever been denied a visa to any country?",
        type: "boolean",
        weight: 15,
        correctAnswers: ["false"],
        orderIndex: 3,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "criminal_record",
        visaTypeId,
        scope: "common",
        question: "Do you have any criminal convictions?",
        type: "boolean",
        weight: 15,
        correctAnswers: ["false"],
        orderIndex: 4,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }
    );

    // Category-specific questions
    switch (category) {
    case "work":
      questions.push(
        {
          id: "job_offer",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you have a job offer from an employer in the destination country?",
          type: "boolean",
          weight: 20,
          correctAnswers: ["true"],
          orderIndex: 10,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "work_experience",
          visaTypeId,
          scope: `category:${category}`,
          question: "How many years of relevant work experience do you have?",
          type: "number",
          weight: 10,
          minValue: 0,
          maxValue: 50,
          idealMin: 2,
          idealMax: 50,
          orderIndex: 11,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "qualifications",
          visaTypeId,
          scope: `category:${category}`,
          question: "What is your highest level of education?",
          type: "single",
          options: ["High School", "Bachelor's Degree", "Master's Degree", "PhD", "Professional Certification"],
          weight: 10,
          correctAnswers: ["Bachelor's Degree", "Master's Degree", "PhD", "Professional Certification"],
          orderIndex: 12,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
      );
      break;

    case "student":
      questions.push(
        {
          id: "admission",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you have an admission letter from a recognized institution?",
          type: "boolean",
          weight: 25,
          correctAnswers: ["true"],
          orderIndex: 10,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "tuition_funds",
          visaTypeId,
          scope: `category:${category}`,
          question: "Can you prove you have funds to cover tuition fees?",
          type: "boolean",
          weight: 15,
          correctAnswers: ["true"],
          orderIndex: 11,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "english_proficiency",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you have English language proficiency certification (IELTS/TOEFL)?",
          description: "Required for English-speaking countries.",
          type: "boolean",
          weight: 10,
          correctAnswers: ["true"],
          orderIndex: 12,
          isRequired: false,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
      );
      break;

    case "tourist":
      questions.push(
        {
          id: "return_ticket",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you have proof of return or onward travel?",
          type: "boolean",
          weight: 15,
          correctAnswers: ["true"],
          orderIndex: 10,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "accommodation",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you have accommodation bookings for your stay?",
          type: "boolean",
          weight: 10,
          correctAnswers: ["true"],
          orderIndex: 11,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "travel_insurance",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you have travel insurance covering your trip?",
          type: "boolean",
          weight: 10,
          correctAnswers: ["true"],
          orderIndex: 12,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "ties_to_home",
          visaTypeId,
          scope: `category:${category}`,
          question: "Can you demonstrate strong ties to your home country?",
          description: "Employment, property, family, or business ties that show you will return.",
          type: "boolean",
          weight: 15,
          correctAnswers: ["true"],
          orderIndex: 13,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
      );
      break;

    case "business":
      questions.push(
        {
          id: "business_invitation",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you have an invitation letter from a business in the destination country?",
          type: "boolean",
          weight: 20,
          correctAnswers: ["true"],
          orderIndex: 10,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "business_ownership",
          visaTypeId,
          scope: `category:${category}`,
          question: "Do you own or represent a registered business?",
          type: "boolean",
          weight: 15,
          correctAnswers: ["true"],
          orderIndex: 11,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
      );
      break;

    case "family":
      questions.push(
        {
          id: "sponsor_status",
          visaTypeId,
          scope: `category:${category}`,
          question: "Does your sponsor have legal residency/citizenship in the destination country?",
          type: "boolean",
          weight: 25,
          correctAnswers: ["true"],
          orderIndex: 10,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "relationship_proof",
          visaTypeId,
          scope: `category:${category}`,
          question: "Can you provide proof of your relationship to the sponsor?",
          description: "Marriage certificate, birth certificate, etc.",
          type: "boolean",
          weight: 20,
          correctAnswers: ["true"],
          orderIndex: 11,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
      );
      break;

    default:
      // General financial question for other categories
      questions.push({
        id: "financial_proof",
        visaTypeId,
        scope: "common",
        question: "Can you provide proof of sufficient funds for your stay?",
        description: "Bank statements, employment letter, or sponsor letter.",
        type: "boolean",
        weight: 15,
        correctAnswers: ["true"],
        orderIndex: 10,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    return questions.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Create visa-specific questions (admin function)
   */
  async createQuestion(
    question: Omit<EligibilityQuestion, "id" | "createdAt" | "updatedAt">
  ): Promise<EligibilityQuestion> {
    const now = Timestamp.now();
    const docRef = this.questionsCollection.doc();

    const data = {
      ...question,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(data);

    return {
      id: docRef.id,
      ...data,
    } as EligibilityQuestion;
  }

  /**
   * Seed questions for a specific visa (e.g., Irish Short Stay C)
   */
  async seedVisaQuestions(
    visaTypeId: string,
    questions: Array<{
      question: string;
      description?: string;
      type: EligibilityQuestion["type"];
      options?: string[];
      weight: number;
      correctAnswers?: string[];
      idealMin?: number;
      idealMax?: number;
      orderIndex: number;
      isRequired: boolean;
    }>
  ): Promise<void> {
    const batch = db.batch();
    const now = Timestamp.now();

    for (const q of questions) {
      const docRef = this.questionsCollection.doc();
      batch.set(docRef, {
        ...q,
        visaTypeId,
        scope: `visa:${visaTypeId}`,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    await batch.commit();
  }

  /**
   * Submit eligibility check and calculate score
   */
  async submitCheck(
    userId: string,
    input: EligibilityCheckInput
  ): Promise<EligibilityCheck> {
    const { visaTypeId, countryCode, nationality, travelPurpose, answers } = input;

    // First, do a pre-check to see if visa is required
    const preCheckResult = await this.preCheck({
      nationality,
      destinationCountry: countryCode,
      travelPurpose: travelPurpose || "tourism",
    });

    // Get questions for this visa type, filtered by nationality
    const questions = await this.getQuestions(visaTypeId, nationality, countryCode);

    // Calculate score and build breakdown
    const result = this.calculateScore(questions, answers);

    // Determine suggested path
    let suggestedPath: "self_service" | "agent_assisted" | "not_eligible" | "visa_free";
    // (#236) Only a SOURCED "no visa needed" (false) leads to visa_free. An
    // unknown answer (null) is never read as "no visa needed": the score decides.
    const sourcedVisaFree = preCheckResult.visaRequired === false;
    if (sourcedVisaFree) {
      suggestedPath = "visa_free";
    } else if (result.eligibilityLevel === "high") {
      suggestedPath = "self_service";
    } else if (result.eligibilityLevel === "medium") {
      suggestedPath = "agent_assisted";
    } else {
      suggestedPath = "not_eligible";
    }

    // Save the check
    const now = Timestamp.now();
    const checkRef = this.checksCollection.doc();

    const check: Omit<EligibilityCheck, "id"> = {
      userId,
      visaTypeId,
      countryCode,
      nationality,
      visaRequired: preCheckResult.visaRequired,
      visaRequirementType: preCheckResult.requirementType,
      exemptionDetails: sourcedVisaFree ? {
        maxStayDays: preCheckResult.maxStayDays,
        conditions: preCheckResult.conditions,
      } : undefined,
      score: result.score,
      eligibilityLevel: sourcedVisaFree ? "not_applicable" : result.eligibilityLevel,
      answers,
      breakdown: result.breakdown,
      recommendations: sourcedVisaFree ? preCheckResult.nextSteps : result.recommendations,
      missingRequirements: result.missingRequirements,
      suggestedPath,
      createdAt: now,
    };

    await checkRef.set(check);

    return {
      id: checkRef.id,
      ...check,
    };
  }

  /**
   * Calculate eligibility score from answers
   */
  private calculateScore(
    questions: EligibilityQuestion[],
    answers: EligibilityAnswer[]
  ): EligibilityResult {
    const breakdown: EligibilityResult["breakdown"] = [];
    const recommendations: string[] = [];
    const missingRequirements: string[] = [];

    let totalPoints = 0;
    let maxPoints = 0;

    for (const question of questions) {
      const answer = answers.find((a) => a.questionId === question.id);
      const answerValue = answer?.answer;
      const answerString = this.formatAnswer(answerValue);

      let points = 0;
      let passed = false;
      let recommendation: string | undefined;

      maxPoints += question.weight;

      if (answerValue === undefined || answerValue === null) {
        if (question.isRequired) {
          missingRequirements.push(question.question);
        }
      } else {
        // Evaluate the answer
        switch (question.type) {
        case "boolean":
          passed = question.correctAnswers?.includes(String(answerValue)) ?? false;
          if (passed) {
            points = question.weight;
          } else {
            recommendation = this.getRecommendation(question, answerValue);
          }
          break;

        case "number": {
          const numValue = Number(answerValue);
          if (
            question.idealMin !== undefined &&
              question.idealMax !== undefined
          ) {
            if (numValue >= question.idealMin && numValue <= question.idealMax) {
              passed = true;
              points = question.weight;
            } else if (numValue < question.idealMin) {
              const ratio = numValue / question.idealMin;
              points = Math.floor(question.weight * Math.min(ratio, 0.5));
              recommendation = this.getRecommendation(question, answerValue);
            }
          } else {
            // No ideal range, give full points if answered
            passed = true;
            points = question.weight;
          }
          break;
        }
        case "single":
          passed = question.correctAnswers?.includes(String(answerValue)) ?? false;
          if (passed) {
            points = question.weight;
          } else {
            // Partial credit for answering
            points = Math.floor(question.weight * 0.3);
          }
          break;

        case "multiple": {
          const selectedOptions = answerValue as string[];
          const correctCount = selectedOptions.filter(
            (opt) => question.correctAnswers?.includes(opt)
          ).length;
          const totalCorrect = question.correctAnswers?.length ?? 1;
          points = Math.floor(question.weight * (correctCount / totalCorrect));
          passed = correctCount === totalCorrect;
          break;
        }

        case "date":
          // For date questions, give full points if answered
          points = question.weight;
          passed = true;
          break;
        }
      }

      totalPoints += points;

      breakdown.push({
        questionId: question.id,
        question: question.question,
        answer: answerString,
        passed,
        points,
        maxPoints: question.weight,
        recommendation,
      });

      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    // Calculate final score as percentage
    const score = maxPoints > 0 ? Math.round((totalPoints / maxPoints) * 100) : 0;

    // Determine eligibility level
    let eligibilityLevel: "high" | "medium" | "low";
    if (score >= 75) {
      eligibilityLevel = "high";
    } else if (score >= 50) {
      eligibilityLevel = "medium";
    } else {
      eligibilityLevel = "low";
    }

    // Add summary recommendations based on level
    if (eligibilityLevel === "low") {
      recommendations.unshift(
        "Your eligibility score is low. We recommend consulting with an immigration agent before applying."
      );
    } else if (eligibilityLevel === "medium") {
      recommendations.unshift(
        "You may be eligible, but address the items below to strengthen your application."
      );
    } else {
      recommendations.unshift(
        "You have a strong eligibility profile for this visa!"
      );
    }

    // Determine suggested path based on eligibility level
    let suggestedPath: "self_service" | "agent_assisted" | "not_eligible" | "visa_free";
    if (eligibilityLevel === "high") {
      suggestedPath = "self_service";
    } else if (eligibilityLevel === "medium") {
      suggestedPath = "agent_assisted";
    } else {
      suggestedPath = "not_eligible";
    }

    return {
      visaRequired: true,
      visaRequirementType: "visa_required" as VisaRequirementType,
      score,
      eligibilityLevel,
      breakdown,
      recommendations,
      missingRequirements,
      suggestedPath,
    };
  }

  private formatAnswer(value: unknown): string {
    if (value === undefined || value === null) return "Not answered";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  private getRecommendation(
    question: EligibilityQuestion,
    answer: unknown
  ): string {
    // Check for custom recommendation in question description
    if (question.description) {
      return question.description;
    }

    // Generate based on question ID patterns
    const id = question.id.toLowerCase();

    if (id.includes("passport")) {
      if (id.includes("validity")) {
        return `Passport validity of ${answer} months may not be sufficient. Most countries require at least 6 months validity.`;
      }
      return "A valid passport is required for all visa applications.";
    }

    if (id.includes("denial") || id.includes("denied")) {
      return "Previous visa denials may affect your application. Be prepared to explain the circumstances and provide additional documentation.";
    }

    if (id.includes("criminal")) {
      return "Criminal history may affect eligibility. Consider consulting an immigration lawyer for guidance.";
    }

    if (id.includes("job") || id.includes("offer")) {
      return "A valid job offer is typically required for work visas. Consider securing employment before applying.";
    }

    if (id.includes("admission") || id.includes("enrollment")) {
      return "An admission letter from a recognized institution is required for student visas.";
    }

    if (id.includes("fund") || id.includes("financial")) {
      return "Prepare bank statements or sponsorship documents to demonstrate financial capability.";
    }

    if (id.includes("ties")) {
      return "Strong ties to your home country (employment, property, family) help demonstrate intent to return.";
    }

    return "This requirement may need additional attention before applying.";
  }

  /**
   * Get user's eligibility check history
   */
  async getUserChecks(userId: string): Promise<EligibilityCheck[]> {
    const snapshot = await this.checksCollection
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as EligibilityCheck[];
  }

  /**
   * Get a specific eligibility check
   */
  async getCheckById(checkId: string): Promise<EligibilityCheck | null> {
    const doc = await this.checksCollection.doc(checkId).get();
    if (!doc.exists) return null;

    return {
      id: doc.id,
      ...doc.data(),
    } as EligibilityCheck;
  }

  /**
   * Get latest check for a user and visa type
   */
  async getLatestCheck(
    userId: string,
    visaTypeId: string
  ): Promise<EligibilityCheck | null> {
    const snapshot = await this.checksCollection
      .where("userId", "==", userId)
      .where("visaTypeId", "==", visaTypeId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    return {
      id: doc.id,
      ...doc.data(),
    } as EligibilityCheck;
  }

  /**
   * Seed Nigeria → Ireland eligibility questions
   * Admin function to populate the database with initial data
   */
  async seedNigeriaIreland(): Promise<{ questionsSeeded: number }> {
    const { seedNigeriaIrelandEligibility } = await import("../data/eligibility-seed-nigeria-ireland");
    return seedNigeriaIrelandEligibility();
  }

  /**
   * Get all questions (for admin listing)
   */
  async getAllQuestions(options?: {
    scope?: string;
    isActive?: boolean;
    limit?: number;
  }): Promise<EligibilityQuestion[]> {
    let query = this.questionsCollection.orderBy("orderIndex", "asc");

    if (options?.scope) {
      query = query.where("scope", "==", options.scope) as typeof query;
    }

    if (options?.isActive !== undefined) {
      query = query.where("isActive", "==", options.isActive) as typeof query;
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const snapshot = await query.get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as EligibilityQuestion[];
  }

  /**
   * Update a question (admin)
   */
  async updateQuestion(
    questionId: string,
    updates: Partial<Omit<EligibilityQuestion, "id" | "createdAt">>
  ): Promise<EligibilityQuestion | null> {
    const docRef = this.questionsCollection.doc(questionId);
    const doc = await docRef.get();

    if (!doc.exists) return null;

    const updateData = {
      ...updates,
      updatedAt: Timestamp.now(),
    };

    await docRef.update(updateData);

    return {
      id: doc.id,
      ...doc.data(),
      ...updateData,
    } as EligibilityQuestion;
  }

  /**
   * Delete a question (admin)
   */
  async deleteQuestion(questionId: string): Promise<boolean> {
    const docRef = this.questionsCollection.doc(questionId);
    const doc = await docRef.get();

    if (!doc.exists) return false;

    await docRef.delete();
    return true;
  }
}

export const eligibilityService = new EligibilityService();
