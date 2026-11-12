import type { VisaRubric } from "../../types/rubric";
import type { DisclosureNotice } from "../../types/refusal-letter";
import { normaliseRuleRef } from "./refusal-letter-logic";

// ============================================
// DISCLOSURE NOTICE — per-destination data (issue #122)
// ============================================
//
// The notice that an earlier refusal must be dealt with openly is only ever
// built from a PUBLISHED rule of the destination the application is for.
//
//  - The table below is keyed by the application's destination `countryCode`.
//    A destination with no entry gets NO notice (null): never another country's
//    rule, and never generic wording about what must be declared.
//  - When the approved rubric for the route already holds a criterion with the
//    entry's `ruleRef`, the quote and URL are read from that criterion, so the
//    text stays tied to the approved, quote-checked source. The table's own quote
//    is only the fallback.
//
// GB entry SOURCE: Immigration Rules Part Suitability, SUI 9.1(b),
// https://www.gov.uk/guidance/immigration-rules/immigration-rules-part-suitability
// The issue (#122) gives the quote, fetched by the PM on 2026-11-10. It was
// re-checked against the live page on 2026-11-11 (the phrase appears verbatim).
// The copy claims no form question and no outcome. HUMAN SIGN-OFF REQUIRED.

interface NoticeEntry {
  title: string;
  body: string;
  ruleRef: string;
  quote: string;
  url: string;
  context: string;
  help: string;
}

/** Destination countryCode (upper case) -> notice entry. Add a row only with a human-supplied quote. */
const NOTICE_TABLE: Readonly<Record<string, NoticeEntry>> = {
  GB: {
    title: "Be open about an earlier refusal",
    body: "If you have been refused a visa before, deal with that openly on your next application.",
    ruleRef: "SUI 9.1(b)",
    quote: "not disclosing relevant facts in relation to the application",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-part-suitability",
    context: "This is one of the two ways the published rule on deception (SUI 9.1) describes it.",
    help: "If you are not sure what to say about it, ask a qualified adviser or an agent.",
  },
};

/** The notice for a destination, or null when it has no entry. */
export function resolveDisclosureNotice(countryCode: string, rubric: Pick<VisaRubric, "criteria"> | null): DisclosureNotice | null {
  const entry = NOTICE_TABLE[(countryCode ?? "").toUpperCase()];
  if (!entry) return null;

  // Prefer the approved rubric's own criterion for the same ruleRef.
  const want = normaliseRuleRef(entry.ruleRef);
  const fromRubric = rubric?.criteria.find(
    (c) => c.ruleRef && normaliseRuleRef(c.ruleRef) === want && c.source?.quote?.trim() && c.source.url
  );
  return {
    title: entry.title,
    body: entry.body,
    rule: {
      ruleRef: fromRubric?.ruleRef ?? entry.ruleRef,
      quote: fromRubric ? fromRubric.source.quote : entry.quote,
      url: fromRubric ? fromRubric.source.url : entry.url,
      context: entry.context,
    },
    help: entry.help,
  };
}
