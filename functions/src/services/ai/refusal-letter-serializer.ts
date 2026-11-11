import type { RefusalAnalysis, RefusalOutcome } from "../../types/refusal-letter";

// ============================================
// REFUSAL-LETTER RESPONSE — whitelist serializer (issue #122)
// ============================================
//
// The only path from a stored `refusalAnalyses` document to a response body. It
// BUILDS a new object from named fields, never deletes keys from the stored
// document, so a field added to the document later cannot leak by accident.
// Never serialized: `suspiciousContent` (a flag for operators; the AI does not
// accuse the applicant), `usage`, `model`, `requestedBy`, any internal id or score.
//
// All applicant-facing copy that is not the letter's own wording or a rubric
// quote is fixed text written here. None of it predicts an outcome, and none of
// it advises leaving anything out.

/**
 * The disclosure notice (acceptance criterion: shown after extraction, even when
 * nothing could be mapped and when there is no rubric).
 *
 * SOURCE (fetched 2026-11-10, per the issue): Immigration Rules Part Suitability,
 * SUI 9.1(b), https://www.gov.uk/guidance/immigration-rules/immigration-rules-part-suitability
 * The quote below is the rule's own wording. The copy does NOT claim that any
 * particular application-form question exists, and does NOT say disclosure
 * guarantees an outcome: the issue has no quote for either. HUMAN SIGN-OFF
 * REQUIRED on this copy before release (attached to the PR).
 *
 * NOTE FOR REVIEWERS: this is the one route-specific item in the feature. It is
 * data (a fixed notice), not branching: the mapping code never reads it. A route
 * with its own published disclosure rule needs its own entry, and a human to
 * supply the quote.
 */
export const DISCLOSURE_NOTICE = {
  title: "Be open about an earlier refusal",
  body: "If you have been refused a visa before, deal with that openly on your next application.",
  rule: {
    ruleRef: "SUI 9.1(b)",
    quote: "not disclosing relevant facts in relation to the application",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-part-suitability",
    context: "This is one of the two ways the published rule on deception (SUI 9.1) describes it.",
  },
  help: "If you are not sure what to say about it, ask a qualified adviser or an agent.",
} as const;

/** Fixed copy for each warning code. A warning is never a block. */
const WARNING_COPY: Record<string, string> = {
  name_mismatch: "The name on this letter does not match the name on your profile. Check that it is your letter.",
  dob_mismatch: "The date of birth on this letter does not match your profile. Check that it is your letter.",
};

/** Shown when the route has no approved rubric. No mapping, no advice. */
const NO_RUBRIC_COPY =
  "We do not have approved guidance for this route yet, so we cannot match the reasons in your letter to published rules. Here is what your letter says.";

/** Shown in place of a fix list for a deception ground. */
const ADVISER_COPY =
  "This reason is about honesty in an application. We cannot give you a list of things to fix for it. Please speak to a qualified adviser or an agent.";

/** Shown for a judgement criterion: something to strengthen, not a restated refusal. */
const STRENGTHEN_COPY = "This is a point where a decision maker weighs the whole picture. You can strengthen your next application on it.";

/** Fixed explanations for the states that carry no reasons. */
const STATE_COPY: Record<RefusalOutcome, string> = {
  analysed: "",
  unreadable: "We could not read this letter. Try a clearer photo or the PDF itself.",
  not_a_refusal_letter: "This does not look like a refusal decision letter, so we have not analysed it.",
};

/** The serialized body of one analysis. */
export function serializeRefusalData(a: RefusalAnalysis) {
  const outcome = a.outcome ?? "unreadable";
  const analysed = outcome === "analysed";
  return {
    outcome,
    stateMessage: analysed ? null : STATE_COPY[outcome],
    extracted: analysed ? { decisionDate: a.decisionDate, visaTypeNamed: a.visaTypeNamed } : null,
    // No approved rubric: reasons stay verbatim, with the reason stated.
    noRubricMessage: analysed && a.rubricVersion === null ? NO_RUBRIC_COPY : null,
    reasons: analysed
      ? a.reasons.map((r) => ({
        reasonId: r.reasonId,
        // The letter's own words, quoted.
        letterQuote: r.letterQuote,
        citedRefs: [...r.citedRefs],
        page: r.page,
        // "matched" shows the rubric's own rule; "not_matched" shows only the letter's words.
        status: r.matches.length > 0 ? ("matched" as const) : ("not_matched" as const),
        rules: r.matches.map((m) => ({
          criterionId: m.criterionId,
          title: m.title,
          ruleRef: m.ruleRef,
          sourceQuote: m.sourceQuote,
          sourceUrl: m.sourceUrl,
          framing: m.framing,
          note: m.framing === "strengthen" ? STRENGTHEN_COPY : null,
        })),
        // A deception ground carries a pointer to a human, and no fix list.
        adviserNote: r.deception ? ADVISER_COPY : null,
      }))
      : [],
    checklist: analysed
      ? {
        state: a.checklist.state,
        emptyReason: a.checklist.emptyReason ?? null,
        items: a.checklist.items.map((i) => ({
          checklistItemId: i.checklistItemId,
          title: i.title,
          holder: i.holder,
          required: i.required,
          reason: i.reason,
          citation: { quote: i.citation.quote, url: i.citation.url, ruleRef: i.citation.ruleRef ?? null },
          addressesCriterionIds: [...i.addressesCriterionIds],
        })),
      }
      : { state: "not_built" as const, emptyReason: null, items: [] },
    warnings: a.warnings.map((w) => ({ code: w.code, message: WARNING_COPY[w.code] ?? "" })),
    // Shown in every finished state: unreadable, unmatched and no-rubric included.
    disclosureNotice: DISCLOSURE_NOTICE,
  };
}

/** Job metadata, beside `data`. */
export function refusalMeta(a: RefusalAnalysis) {
  return {
    analysisId: a.id,
    applicationId: a.applicationId,
    status: a.status,
    rubricVersion: a.rubricVersion,
    error: a.error ? { code: a.error.code, message: a.error.message } : null,
    startedAt: a.startedAt ? a.startedAt.toDate().toISOString() : null,
    finishedAt: a.finishedAt ? a.finishedAt.toDate().toISOString() : null,
  };
}

/** The envelope: `data` is null until the job has finished. */
export function refusalEnvelope(a: RefusalAnalysis) {
  return {
    meta: refusalMeta(a),
    data: a.status === "succeeded" ? serializeRefusalData(a) : null,
  };
}
