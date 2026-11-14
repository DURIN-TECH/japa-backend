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

/** The two renditions of the Skilled Worker caseworker guidance (issue #260). */
const SKILLED_WORKER_GUIDANCE_RENDITIONS = ["gb-skilled-worker-guidance-html", "gb-skilled-worker-guidance-pdf"];

/** The two renditions of the Student and Child Student caseworker guidance (issue #260). */
const STUDENT_GUIDANCE_RENDITIONS = ["gb-student-guidance-html", "gb-student-guidance-pdf"];

/** The two renditions of the Graduate caseworker guidance (issue #260). */
const GRADUATE_GUIDANCE_RENDITIONS = ["gb-graduate-guidance-html", "gb-graduate-guidance-pdf"];

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

  // ============================================
  // SKILLED WORKER (route key "skilled-worker-visa"; issue #260)
  // ============================================
  // Copied on 2026-11-14 from the text retrieved that day, and checked against
  // it with the seed script's matcher before commit (as for Family above).

  // ---- The route's rules (Appendix Skilled Worker) ----
  {
    id: "appendix-sw-2-1-suitability",
    label: "SW 2.1",
    // The rule that makes Part Suitability (gb-part-suitability) apply here.
    passage: "SW 2.1. The applicant must not fall for refusal under Part Suitability.",
    sourceIds: ["gb-appendix-skilled-worker"],
  },
  {
    id: "appendix-sw-4-1-fifty-points",
    label: "SW 4.1",
    passage: "SW 4.1. The applicant must be awarded all 50 points in the table below.",
    sourceIds: ["gb-appendix-skilled-worker"],
  },
  {
    id: "appendix-sw-5-1-certificate",
    label: "SW 5.1",
    passage:
      "SW 5.1. The applicant must have a valid Certificate of Sponsorship for the job they are planning to do; which to be valid must:",
    sourceIds: ["gb-appendix-skilled-worker"],
  },
  {
    id: "appendix-sw-7-2-english",
    label: "SW 7.2",
    // The reference that makes Appendix English Language apply here.
    passage: "SW 7.2. The applicant must show they meet the English language requirement as specified in Appendix English Language.",
    sourceIds: ["gb-appendix-skilled-worker"],
  },
  {
    id: "appendix-sw-15-3-finance",
    label: "SW 15.3",
    // The reference that makes Appendix Finance (gb-appendix-finance) apply here.
    passage:
      "SW 15.3. If SW 15.2.(a) applies, the applicant must show that they have held the required funds for a 28-day period and as specified in Appendix Finance.",
    sourceIds: ["gb-appendix-skilled-worker"],
  },

  // ---- The appendices the Skilled Worker rules refer to (identity checks) ----
  {
    id: "appendix-english-language-opening",
    label: "Opening",
    passage: "This Appendix sets out how the English language requirement is met.",
    sourceIds: ["gb-appendix-english-language"],
  },
  {
    id: "appendix-skilled-occupations-heading",
    label: "Opening heading",
    passage: "Eligible SOC 2020 occupation codes and going rates for Skilled Worker, Global Business Mobility and Scale-up routes",
    sourceIds: ["gb-appendix-skilled-occupations"],
  },
  {
    id: "appendix-immigration-salary-list-opening",
    label: "Opening",
    passage: "Occupations where a reduced skills and salary threshold applies in the Skilled Worker route.",
    sourceIds: ["gb-appendix-immigration-salary-list"],
  },

  // ---- The Skilled Worker caseworker guidance: web version and PDF must agree ----
  {
    id: "skilled-worker-guidance-1-alongside-rules",
    label: "1. About this guidance",
    passage: "This guidance is designed to be used alongside Appendix Skilled Worker of the Immigration Rules.",
    sourceIds: SKILLED_WORKER_GUIDANCE_RENDITIONS,
  },
  {
    id: "skilled-worker-guidance-8-sponsorship",
    label: "8. Sponsorship",
    passage:
      "The applicant must score 20 points for sponsorship. To award these points, you must be satisfied the application meets the requirements in paragraphs SW 5.1. to SW 5.7.",
    sourceIds: SKILLED_WORKER_GUIDANCE_RENDITIONS,
  },
  {
    id: "skilled-worker-guidance-9-skill-level",
    label: "9. Job at an appropriate skill level",
    passage:
      "The applicant must score 20 points for a job at the appropriate skill level. To award these points, you must be satisfied the applicant is being sponsored in an eligible occupation code.",
    sourceIds: SKILLED_WORKER_GUIDANCE_RENDITIONS,
  },

  // ============================================
  // STUDENT (route key "student-visa"; issue #260)
  // ============================================
  // Copied on 2026-11-14 from the text retrieved that day, and checked against
  // it with the seed script's matcher before commit (as for Family above).

  // ---- The route's rules (Appendix Student) ----
  {
    id: "appendix-st-2-1-suitability",
    label: "ST 2.1",
    passage: "ST 2.1. The applicant must not fall for refusal under Part Suitability.",
    sourceIds: ["gb-appendix-student"],
  },
  {
    id: "appendix-st-5-1-genuine-student",
    label: "ST 5.1",
    passage: "ST 5.1. The applicant must be a genuine student.",
    sourceIds: ["gb-appendix-student"],
  },
  {
    id: "appendix-st-8-4-atas",
    label: "ST 8.4",
    // The reference that makes Appendix ATAS apply here.
    passage:
      "ST 8.4. If the Academic Technology Approval Scheme (ATAS) requirement in Appendix ATAS applies, the applicant must have a valid ATAS certificate and provide it with the application.",
    sourceIds: ["gb-appendix-student"],
  },
  {
    id: "appendix-st-12-6-finance",
    label: "ST 12.6",
    // The reference that makes Appendix Finance apply here (the sentence goes on).
    passage:
      "ST 12.6. The applicant must show that they have held the required level of funds for a 28-day period and as specified in Appendix Finance",
    sourceIds: ["gb-appendix-student"],
  },
  {
    id: "appendix-st-13-2-english",
    label: "ST 13.2",
    // The reference that makes Appendix English Language apply here.
    passage: "ST 13.2. The applicant must show they meet the English language requirement as specified in Appendix English Language.",
    sourceIds: ["gb-appendix-student"],
  },

  // ---- Appendix ATAS (identity check) ----
  {
    id: "appendix-atas-requirement",
    label: "Opening, second paragraph",
    passage: "The ATAS requirement means the applicant must obtain a valid ATAS certificate, issued by the Counter-Proliferation and Arms Control Centre",
    sourceIds: ["gb-appendix-atas"],
  },

  // ---- The Student and Child Student caseworker guidance: web version and PDF must agree ----
  {
    id: "student-guidance-about-based-on",
    label: "About this guidance",
    passage:
      "This guidance is based on Appendix Student, Appendix Child Student, Appendix English Language, Appendix Finance and Appendix ATAS of the Immigration Rules.",
    sourceIds: STUDENT_GUIDANCE_RENDITIONS,
  },
  {
    id: "student-guidance-genuine-balance-of-probability",
    label: "Genuine student rule",
    passage:
      "For an applicant to qualify as a Student, or as a Child Student who is 16 or 17 years old, the caseworker must be satisfied on the balance of probability that the applicant is a genuine student.",
    sourceIds: STUDENT_GUIDANCE_RENDITIONS,
  },
  {
    id: "student-guidance-genuine-credibility",
    label: "Genuine student rule",
    // Typographic apostrophe in "applicant’s", as published.
    passage:
      "To assess an applicant’s credibility, the caseworker must consider all of the information provided in the application and, if applicable, in the credibility interview.",
    sourceIds: STUDENT_GUIDANCE_RENDITIONS,
  },

  // ============================================
  // GRADUATE (route key "graduate-visa"; issue #260)
  // ============================================
  // Copied on 2026-11-14 from the text retrieved that day, and checked against
  // it with the seed script's matcher before commit (as for Family above).

  // ---- The route's rules (Appendix Graduate) ----
  {
    id: "appendix-gr-1-3-student-permission",
    label: "GR 1.3",
    passage: "GR 1.3. The applicant must have, or have last had, permission as a Student.",
    sourceIds: ["gb-appendix-graduate"],
  },
  {
    id: "appendix-gr-2-1-suitability",
    label: "GR 2.1",
    passage: "GR 2.1. The applicant must not fall for refusal under Part Suitability.",
    sourceIds: ["gb-appendix-graduate"],
  },
  {
    id: "appendix-gr-3-1-seventy-points",
    label: "GR 3.1",
    passage: "GR 3.1. The applicant must be awarded all 70 points in the table below.",
    sourceIds: ["gb-appendix-graduate"],
  },
  {
    id: "appendix-gr-4-3-sponsor-notification",
    label: "GR 4.3",
    passage:
      "GR 4.3. The student sponsor must have notified the Home Office, by the date of application, that the applicant has successfully completed the course of study in GR 4.2.",
    sourceIds: ["gb-appendix-graduate"],
  },
  {
    id: "appendix-gr-8-2-d-atas",
    label: "GR 8.2(d)",
    // The reference that makes Appendix ATAS (gb-appendix-atas) apply here.
    passage: "(d) study is subject to the ATAS condition in Appendix ATAS.",
    sourceIds: ["gb-appendix-graduate"],
  },

  // ---- The Graduate caseworker guidance: web version and PDF must agree ----
  {
    id: "graduate-guidance-about-based-on",
    label: "About this guidance",
    passage: "This guidance is based on Appendix Graduate and Appendix ATAS of the Immigration Rules.",
    sourceIds: GRADUATE_GUIDANCE_RENDITIONS,
  },
  {
    id: "graduate-guidance-sponsor-notification",
    label: "Eligibility requirements: sponsor notification",
    passage:
      "The Student Sponsor must have notified the Home Office, by the date of application, that the applicant has successfully completed the course of study.",
    sourceIds: GRADUATE_GUIDANCE_RENDITIONS,
  },
  {
    id: "graduate-guidance-no-notification-no-refusal",
    label: "Eligibility requirements: sponsor notification",
    passage:
      "If a notification has not been received from the Student Sponsor, but the CAS shows that the applicant had been studying a qualifying qualification, the caseworker must not refuse the application if it would otherwise be granted.",
    sourceIds: GRADUATE_GUIDANCE_RENDITIONS,
  },
];
