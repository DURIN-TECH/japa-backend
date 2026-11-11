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
];
