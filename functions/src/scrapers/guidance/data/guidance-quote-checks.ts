import type { GuidanceQuoteCheck } from "../guidance-quote-check";

// ============================================
// GUIDANCE — QUOTE INTEGRITY CHECKS: THE PASSAGES (issue #111)
// ============================================
//
// DATA for guidance-quote-check.ts: passages that must appear VERBATIM in
// the latest stored snapshot of the registry entries they name. The seed
// script runs them after a crawl (and on `--check-quotes`) and exits
// non-zero when any is missing.
//
// RULES FOR THIS FILE
//  - A passage is copied character for character from the PUBLISHED source,
//    by someone looking at that source. Never typed from memory, never from
//    a summary, never "tidied". If the publisher re-words a passage, the
//    check fails; that is the point. Re-read the source and update the row.
//  - A passage listed against two entries (two renditions of one document)
//    asserts that the renditions agree on it.
//  - Typographic apostrophes are written as the escape ’ so that an
//    editor or formatter cannot silently swap them for a straight one. The
//    match is exact about punctuation: only whitespace is normalised.
//
// Every passage below was copied on 2026-11-11 from the text retrieved that
// day through the shared fetch service (see the entries' verification notes
// in seed-guidance-sources.ts).

/** Registry ids used below (the two renditions of the caseworker guidance). */
const GUIDANCE_RENDITIONS = ["gb-visit-guidance-html", "gb-visit-guidance-pdf"];

/** The two renditions of the UK Family caseworker guidance (issue #260). */
const FAMILY_GUIDANCE_RENDITIONS = ["gb-family-life-guidance-html", "gb-family-life-guidance-pdf"];

export const GUIDANCE_QUOTE_CHECKS: GuidanceQuoteCheck[] = [
  // ---- The visitor rules ----
  {
    id: "appendix-v-3-1-suitability",
    label: "V 3.1",
    passage: "The applicant must not fall for refusal under Part Suitability.",
    sourceIds: ["gb-appendix-v-visitor"],
  },
  {
    id: "appendix-v-4-2-genuine-visitor",
    label: "V 4.2",
    passage: "The applicant must satisfy the decision maker that they are a genuine visitor, which means the applicant:",
    sourceIds: ["gb-appendix-v-visitor"],
  },
  {
    id: "appendix-v-4-2-e-funds",
    label: "V 4.2(e)",
    passage:
      "must have sufficient funds to cover all reasonable costs in relation to their visit without working or accessing public funds",
    sourceIds: ["gb-appendix-v-visitor"],
  },
  {
    id: "appendix-v-4-2-e-institution",
    label: "V 4.2(e), last sentence",
    passage:
      "The applicant must show that any funds they rely upon are held in a financial institution permitted under FIN 2.1 in Appendix Finance.",
    sourceIds: ["gb-appendix-v-visitor"],
  },
  {
    id: "appendix-v-4-3-c-third-party",
    label: "V 4.3(c)",
    // Typographic apostrophe in "applicant’s", as published.
    passage:
      "(c) can and will provide support to the applicant for the intended duration of the applicant’s stay as a Visitor.",
    sourceIds: ["gb-appendix-v-visitor"],
  },

  // ---- The suitability rules the visitor rules refer to (V 3.1) ----
  // An identity check: a sentence from the document's opening, so the stored
  // snapshot is known to be this document.
  {
    id: "part-suitability-opening",
    label: "Opening, second paragraph",
    passage:
      "If an applicant is refused under this Part, they will not meet the suitability requirements of the route on which they are applying.",
    sourceIds: ["gb-part-suitability"],
  },

  // ---- The finance appendix the visitor rules refer to ----
  {
    id: "appendix-finance-2-1",
    label: "FIN 2.1",
    passage: "Funds will not be considered if they are held in a financial institution where any of the following apply:",
    sourceIds: ["gb-appendix-finance"],
  },

  // ---- The caseworker guidance: web version and PDF must agree ----
  // Section numbers are the web version's; the PDF prints the same headings
  // without numbers.
  {
    id: "visit-guidance-7-2-personal-circumstances",
    label: "7.2 Assessing an applicant’s personal circumstances",
    passage: "The following factors will help you assess if an applicant is a genuine visitor:",
    sourceIds: GUIDANCE_RENDITIONS,
  },
  {
    id: "visit-guidance-7-2-ties",
    label: "7.2 Assessing an applicant’s personal circumstances",
    passage: "their personal and economic ties to their country of residence",
    sourceIds: GUIDANCE_RENDITIONS,
  },
  {
    id: "visit-guidance-7-3-travel-history",
    label: "7.3 Travel / immigration history",
    passage:
      "Travel history should not be the only consideration in deciding whether you are satisfied an applicant is a genuine visitor.",
    sourceIds: GUIDANCE_RENDITIONS,
  },
  {
    id: "visit-guidance-7-3-first-time",
    label: "7.3 Travel / immigration history",
    passage:
      "Where the applicant is a first-time traveller, you will need to rely on other evidence to satisfy you they are a genuine visitor.",
    sourceIds: GUIDANCE_RENDITIONS,
  },
  {
    id: "visit-guidance-7-4-successive-visits",
    label: "7.4 Frequent or successive visits",
    passage:
      "You must assess if they are, in effect, living in the UK through frequent or successive visits or making the UK their main home.",
    sourceIds: GUIDANCE_RENDITIONS,
  },
  {
    id: "visit-guidance-8-2-third-party",
    label: "8.2 Maintenance and accommodation provided by a third party",
    // Typographic apostrophe in "visitor’s", as published.
    passage:
      "If the third party is in the UK, they must not be in breach of immigration law at the time of the decision on the visitor’s application or their entry to the UK.",
    sourceIds: GUIDANCE_RENDITIONS,
  },
  {
    id: "visit-guidance-8-2-refuse",
    label: "8.2 Maintenance and accommodation provided by a third party",
    passage:
      "Where you believe it is more likely than not that the third party will be unable to provide this support, you may refuse the application.",
    sourceIds: GUIDANCE_RENDITIONS,
  },

  // ============================================
  // UK FAMILY (route key "uk-family-visa"; issue #260)
  // ============================================
  // Every passage below was copied on 2026-11-14 from the text retrieved that
  // day through the shared fetch service (see the entries' verification notes
  // in seed-guidance-sources.ts), and checked against that same text with the
  // matcher the seed script uses (findPassage) before it was committed.

  // ---- The family rules (Appendix FM) ----
  {
    id: "appendix-fm-s-ec-1-1-suitability",
    label: "S-EC.1.1",
    // The rule that makes Part Suitability (gb-part-suitability) apply here.
    passage: "S-EC.1.1. The applicant must not fall for refusal under Part Suitability.",
    sourceIds: ["gb-appendix-fm-family-members"],
  },
  {
    id: "appendix-fm-e-ecp-2-6-genuine-relationship",
    label: "E-ECP.2.6",
    passage: "E-ECP.2.6. The relationship between the applicant and their partner must be genuine and subsisting.",
    sourceIds: ["gb-appendix-fm-family-members"],
  },
  {
    id: "appendix-fm-e-ecp-2-10-live-together",
    label: "E-ECP.2.10",
    passage: "E-ECP.2.10. The applicant and partner must intend to live together permanently in the UK.",
    sourceIds: ["gb-appendix-fm-family-members"],
  },
  {
    id: "appendix-fm-e-ecp-3-1-a-income",
    label: "E-ECP.3.1(a)",
    // Pinned so a change to the published figure fails the check loudly.
    passage: "(a) a specified gross annual income of at least £29,000",
    sourceIds: ["gb-appendix-fm-family-members"],
  },

  // ---- The specified evidence appendix (Appendix FM-SE) ----
  {
    id: "appendix-fm-se-a-opening",
    label: "Paragraph A",
    // An identity check from the opening.
    passage:
      "A. This Appendix sets out the specified evidence applicants need to provide to meet the requirements of rules contained in Appendix FM",
    sourceIds: ["gb-appendix-fm-se-specified-evidence"],
  },
  {
    id: "appendix-fm-se-1-a-i-finance",
    label: "Paragraph 1(a)(i)",
    // The reference that makes Appendix Finance (gb-appendix-finance) apply here.
    passage: "(i) be from a financial institution to which Appendix Finance applies.",
    sourceIds: ["gb-appendix-fm-se-specified-evidence"],
  },

  // ---- The Family Policy caseworker guidance: web version and PDF must agree ----
  {
    id: "family-guidance-1-about",
    label: "1. About this guidance",
    passage:
      "This guidance tells decision makers how to decide applications or claims for leave to enter or remain on the basis of family life as a partner or parent or exceptional circumstances",
    sourceIds: FAMILY_GUIDANCE_RENDITIONS,
  },
  {
    id: "family-guidance-5-1-suitability",
    label: "5.1 Suitability",
    // Typographic apostrophe in "person’s", as published.
    passage:
      "In considering all applications on the basis of a person’s family life as a partner or parent, you must consider whether the suitability requirements under Part Suitability of the Immigration rules are met.",
    sourceIds: FAMILY_GUIDANCE_RENDITIONS,
  },
  {
    id: "family-guidance-7-2-under-two-years",
    label: "7.2 Eligibility (relationship)",
    passage:
      "Where the definition of partner is not met because a couple who are in a genuine and subsisting relationship have been together for less than 2 years, the requirements of Appendix FM cannot be satisfied other than on the basis of exceptional circumstances.",
    sourceIds: FAMILY_GUIDANCE_RENDITIONS,
  },
  {
    id: "family-guidance-7-2-genuine-subsisting",
    label: "7.2 Eligibility (genuine and subsisting)",
    passage:
      "When considering paragraph E-ECP.2.6. and paragraph E-LTRP.1.7., you must be satisfied that the relationship between the applicant and their partner is genuine and subsisting.",
    sourceIds: FAMILY_GUIDANCE_RENDITIONS,
  },

  // ---- The minimum income requirement guidance (PDF only) ----
  {
    id: "family-financial-guidance-form",
    label: "Who needs to meet the financial requirement",
    passage: "Unless exempt, the applicant must meet the financial requirement in the form of a minimum income requirement.",
    sourceIds: ["gb-family-financial-requirement-pdf"],
  },
  {
    id: "family-financial-guidance-no-child-variation",
    label: "Financial requirement for a first application on or after 11 April 2024",
    passage: "Unlike the previous threshold, this amount does not vary where there are dependent children within the family.",
    sourceIds: ["gb-family-financial-requirement-pdf"],
  },
];
