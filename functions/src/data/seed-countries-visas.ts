/**
 * Seed data for countries and their visa types
 *
 * Structure:
 * - countries/{countryCode} - Country document (doc ID = ISO alpha-2 code)
 * - countries/{countryCode}/visaTypes/{visaId} - Visa types as subcollection
 *
 * Visa type IDs are deterministic so seed applications can reference them.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { buildVisaTypeDoc } from "./seed-visa-doc";
// #239: which shared routes a record inherits comes from the DATA FILE, never from this seed.
import { inheritsFromFor, loadSharedVisaData, routeFactsFor, routeFeesFor } from "./shared-visa-data-format";
// #299: the fee of a shared route, converted with the stored rate (pure rules in seed-sourced-fee.ts).
import { effectiveSeedCost, planSourcedFee, seedFeeProblems, sourcedFeeFields, type SourcedFeeDecision } from "./seed-sourced-fee";
// #339: the processing time and stay limit of a shared route (pure rules in seed-route-facts.ts).
import { planRouteFacts, routeFactFields, seedRouteFactProblems, type RouteFactsDecision } from "./seed-route-facts";
import type { FxRatesDoc } from "../types";

const db = getFirestore();

interface SeedCountry {
  code: string;
  name: string;
  flagUrl: string;
  isSupported: boolean;
  popularityRank: number;
}

interface SeedVisaType {
  id: string;
  countryCode: string;
  name: string;
  code: string;
  description: string;
  category: string;
  // #306: all three optional. An entry with no official source on record for
  // the processing time omits them (the short-stay records of the bloc's
  // members added in #306 state none). buildVisaTypeDoc then leaves the keys
  // out of the stored doc, exactly like a scraped visa whose page states no
  // processing time, and the country's `minProcessingDays` skips the entry.
  processingTime?: string;
  processingDaysMin?: number;
  processingDaysMax?: number;
  // #239: both optional. An entry with no official source on record for the
  // fee / validity omits it, so what applicants see comes from the rulebook
  // and the scrape, not from seed text nobody can trace to a page.
  baseCostUsd?: number;
  validityPeriod?: string;
  // #306: optional for the same reason. With no official source on record for
  // whether the visa can be extended, the entry says nothing (never `false`).
  isExtendable?: boolean;
  maxExtensions?: number;
  eligibilityCriteria: string[];
  applicationUrl?: string;
  applicationInstructions?: string;
}

// ============================================
// COUNTRIES
// ============================================

const COUNTRIES: SeedCountry[] = [
  {
    code: "IE",
    name: "Ireland",
    flagUrl: "https://flagcdn.com/w320/ie.png",
    isSupported: true,
    popularityRank: 1,
  },
  {
    code: "GB",
    name: "United Kingdom",
    flagUrl: "https://flagcdn.com/w320/gb.png",
    isSupported: true,
    popularityRank: 2,
  },
  {
    code: "US",
    name: "United States",
    flagUrl: "https://flagcdn.com/w320/us.png",
    isSupported: true,
    popularityRank: 3,
  },
  {
    code: "CA",
    name: "Canada",
    flagUrl: "https://flagcdn.com/w320/ca.png",
    isSupported: true,
    popularityRank: 4,
  },
  {
    code: "AU",
    name: "Australia",
    flagUrl: "https://flagcdn.com/w320/au.png",
    isSupported: true,
    popularityRank: 5,
  },
  {
    code: "DE",
    name: "Germany",
    flagUrl: "https://flagcdn.com/w320/de.png",
    isSupported: true,
    popularityRank: 6,
  },
  {
    code: "NL",
    name: "Netherlands",
    flagUrl: "https://flagcdn.com/w320/nl.png",
    isSupported: true,
    popularityRank: 7,
  },
  {
    code: "AE",
    name: "United Arab Emirates",
    flagUrl: "https://flagcdn.com/w320/ae.png",
    isSupported: true,
    popularityRank: 8,
  },
  {
    code: "ZA",
    name: "South Africa",
    flagUrl: "https://flagcdn.com/w320/za.png",
    isSupported: true,
    popularityRank: 9,
  },
  {
    code: "NG",
    name: "Nigeria",
    flagUrl: "https://flagcdn.com/w320/ng.png",
    isSupported: false,
    popularityRank: 99,
  },
  {
    code: "GH",
    name: "Ghana",
    flagUrl: "https://flagcdn.com/w320/gh.png",
    isSupported: false,
    popularityRank: 100,
  },
  {
    code: "KE",
    name: "Kenya",
    flagUrl: "https://flagcdn.com/w320/ke.png",
    isSupported: false,
    popularityRank: 101,
  },

  // ---- #306: the other first members of the bloc NL belongs to ----
  // The membership itself (and its official source) is recorded in the data
  // file (shared-visa-data.ts), not here. These entries are only the country
  // records the app needs to list each one: a name and a flag (not legal
  // facts). Ranks 10-14 sit after the existing supported countries and before
  // the unsupported ones (99+), so no existing country's rank changes.
  {
    code: "BE",
    name: "Belgium",
    flagUrl: "https://flagcdn.com/w320/be.png",
    isSupported: true,
    popularityRank: 10,
  },
  {
    code: "FR",
    name: "France",
    flagUrl: "https://flagcdn.com/w320/fr.png",
    isSupported: true,
    popularityRank: 11,
  },
  {
    code: "LU",
    name: "Luxembourg",
    flagUrl: "https://flagcdn.com/w320/lu.png",
    isSupported: true,
    popularityRank: 12,
  },
  {
    code: "ES",
    name: "Spain",
    flagUrl: "https://flagcdn.com/w320/es.png",
    isSupported: true,
    popularityRank: 13,
  },
  {
    code: "PT",
    name: "Portugal",
    flagUrl: "https://flagcdn.com/w320/pt.png",
    isSupported: true,
    popularityRank: 14,
  },
  // ---- #322: the twenty other members of the bloc NL belongs to (no IT, no AT) ----
  // Same rule as the #306 entries above: the membership and its official
  // sources are recorded in the data file (shared-visa-data.ts), not here;
  // these are only the country records the app needs to list each one (a
  // name and a flag, not legal facts). Ranks 15-34, in the issue's order,
  // after #306's 10-14 and before the unsupported ones (99+), so no existing
  // country's rank changes. Generated by script from issue #322.
  {
    code: "GR",
    name: "Greece",
    flagUrl: "https://flagcdn.com/w320/gr.png",
    isSupported: true,
    popularityRank: 15,
  },
  {
    code: "DK",
    name: "Denmark",
    flagUrl: "https://flagcdn.com/w320/dk.png",
    isSupported: true,
    popularityRank: 16,
  },
  {
    code: "FI",
    name: "Finland",
    flagUrl: "https://flagcdn.com/w320/fi.png",
    isSupported: true,
    popularityRank: 17,
  },
  {
    code: "SE",
    name: "Sweden",
    flagUrl: "https://flagcdn.com/w320/se.png",
    isSupported: true,
    popularityRank: 18,
  },
  {
    code: "IS",
    name: "Iceland",
    flagUrl: "https://flagcdn.com/w320/is.png",
    isSupported: true,
    popularityRank: 19,
  },
  {
    code: "NO",
    name: "Norway",
    flagUrl: "https://flagcdn.com/w320/no.png",
    isSupported: true,
    popularityRank: 20,
  },
  {
    code: "CZ",
    name: "Czechia",
    flagUrl: "https://flagcdn.com/w320/cz.png",
    isSupported: true,
    popularityRank: 21,
  },
  {
    code: "EE",
    name: "Estonia",
    flagUrl: "https://flagcdn.com/w320/ee.png",
    isSupported: true,
    popularityRank: 22,
  },
  {
    code: "LV",
    name: "Latvia",
    flagUrl: "https://flagcdn.com/w320/lv.png",
    isSupported: true,
    popularityRank: 23,
  },
  {
    code: "LT",
    name: "Lithuania",
    flagUrl: "https://flagcdn.com/w320/lt.png",
    isSupported: true,
    popularityRank: 24,
  },
  {
    code: "HU",
    name: "Hungary",
    flagUrl: "https://flagcdn.com/w320/hu.png",
    isSupported: true,
    popularityRank: 25,
  },
  {
    code: "MT",
    name: "Malta",
    flagUrl: "https://flagcdn.com/w320/mt.png",
    isSupported: true,
    popularityRank: 26,
  },
  {
    code: "PL",
    name: "Poland",
    flagUrl: "https://flagcdn.com/w320/pl.png",
    isSupported: true,
    popularityRank: 27,
  },
  {
    code: "SI",
    name: "Slovenia",
    flagUrl: "https://flagcdn.com/w320/si.png",
    isSupported: true,
    popularityRank: 28,
  },
  {
    code: "SK",
    name: "Slovakia",
    flagUrl: "https://flagcdn.com/w320/sk.png",
    isSupported: true,
    popularityRank: 29,
  },
  {
    code: "CH",
    name: "Switzerland",
    flagUrl: "https://flagcdn.com/w320/ch.png",
    isSupported: true,
    popularityRank: 30,
  },
  {
    code: "LI",
    name: "Liechtenstein",
    flagUrl: "https://flagcdn.com/w320/li.png",
    isSupported: true,
    popularityRank: 31,
  },
  {
    code: "HR",
    name: "Croatia",
    flagUrl: "https://flagcdn.com/w320/hr.png",
    isSupported: true,
    popularityRank: 32,
  },
  {
    code: "BG",
    name: "Bulgaria",
    flagUrl: "https://flagcdn.com/w320/bg.png",
    isSupported: true,
    popularityRank: 33,
  },
  {
    code: "RO",
    name: "Romania",
    flagUrl: "https://flagcdn.com/w320/ro.png",
    isSupported: true,
    popularityRank: 34,
  },
  // ---- #331: Italy and Austria, the last two members of the bloc NL belongs to ----
  // Same rule as the #306 and #322 entries above: the membership and its
  // official source are recorded in the data file (shared-visa-data.ts), not
  // here; these are only the country records the app needs to list each one
  // (a name and a flag, not legal facts). Ranks 35 and 36, after #322's 15-34
  // and before the unsupported ones (99+), so no existing country's rank changes.
  {
    code: "IT",
    name: "Italy",
    flagUrl: "https://flagcdn.com/w320/it.png",
    isSupported: true,
    popularityRank: 35,
  },
  {
    code: "AT",
    name: "Austria",
    flagUrl: "https://flagcdn.com/w320/at.png",
    isSupported: true,
    popularityRank: 36,
  },
];

// ============================================
// VISA TYPES (grouped by country)
// ============================================

const VISA_TYPES: SeedVisaType[] = [
  // ---- IRELAND ----
  {
    id: "short-stay-c",
    countryCode: "IE",
    name: "Short Stay 'C' Visa",
    code: "SHORT-STAY-C",
    description:
      "For visits up to 90 days including tourism, business meetings, conferences, or visiting family/friends.",
    category: "tourist",
    processingTime: "8-12 weeks",
    processingDaysMin: 56,
    processingDaysMax: 84,
    baseCostUsd: 60,
    validityPeriod: "Up to 90 days",
    isExtendable: false,
    eligibilityCriteria: [
      "Valid passport (6+ months validity)",
      "Proof of accommodation in Ireland",
      "Proof of sufficient funds for stay",
      "Travel insurance recommended",
      "Evidence of ties to home country",
      "Return flight booking",
    ],
    applicationUrl: "https://www.visas.inis.gov.ie/avats/OnlineHome.aspx",
    applicationInstructions:
      "Complete your online application through AVATS. You will receive a summary sheet to print and submit with your documents.",
  },
  {
    id: "work-permit-general",
    countryCode: "IE",
    name: "General Employment Permit",
    code: "GEP",
    description:
      "For non-EEA nationals who have been offered employment in Ireland with an annual salary of at least €30,000.",
    category: "work",
    processingTime: "8-12 weeks",
    processingDaysMin: 56,
    processingDaysMax: 84,
    baseCostUsd: 1000,
    validityPeriod: "2 years",
    isExtendable: true,
    maxExtensions: 3,
    eligibilityCriteria: [
      "Job offer from an Irish employer",
      "Minimum salary of €30,000 per annum",
      "Occupation not on the ineligible list",
      "Labour market needs test (in most cases)",
      "Valid passport",
      "Employer must be registered in Ireland",
    ],
  },
  {
    id: "study-visa",
    countryCode: "IE",
    name: "Student Visa (D)",
    code: "STUDY-D",
    description:
      "For non-EEA nationals enrolled in a full-time course at a recognised Irish educational institution.",
    category: "student",
    processingTime: "4-8 weeks",
    processingDaysMin: 28,
    processingDaysMax: 56,
    baseCostUsd: 60,
    validityPeriod: "Duration of course",
    isExtendable: true,
    eligibilityCriteria: [
      "Acceptance letter from a recognised Irish institution",
      "Evidence of tuition fees paid or secured",
      "Proof of sufficient funds (€7,000 minimum)",
      "Private medical insurance",
      "Valid passport",
      "Evidence of English language proficiency",
    ],
  },
  {
    id: "critical-skills",
    countryCode: "IE",
    name: "Critical Skills Employment Permit",
    code: "CSEP",
    description:
      "For highly skilled workers in occupations experiencing a shortage in Ireland, with a salary of at least €32,000.",
    category: "work",
    processingTime: "6-8 weeks",
    processingDaysMin: 42,
    processingDaysMax: 56,
    baseCostUsd: 1000,
    validityPeriod: "2 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Job offer in a critical skills occupation",
      "Minimum salary of €32,000 (€64,000 for non-critical list roles)",
      "Relevant qualifications or experience",
      "Valid passport",
      "Employer registered in Ireland",
    ],
  },

  // ---- UNITED KINGDOM ----
  {
    id: "uk-skilled-worker",
    countryCode: "GB",
    name: "Skilled Worker Visa",
    code: "SWV",
    description:
      "For workers who have a job offer from a UK employer that holds a valid sponsor licence.",
    category: "work",
    processingTime: "3-8 weeks",
    processingDaysMin: 21,
    processingDaysMax: 56,
    baseCostUsd: 719,
    validityPeriod: "Up to 5 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Certificate of Sponsorship from a licensed employer",
      "Job at required skill level (RQF Level 3+)",
      "Minimum salary threshold (usually £26,200 or going rate)",
      "English language requirement (CEFR B1)",
      "Maintenance funds (£1,270 for 28 days)",
      "Valid passport",
    ],
  },
  {
    id: "uk-student",
    countryCode: "GB",
    name: "Student Visa",
    code: "TIER4",
    description:
      "For international students who have been offered a place on a course at a licensed student sponsor in the UK.",
    category: "student",
    processingTime: "3-6 weeks",
    processingDaysMin: 21,
    processingDaysMax: 42,
    baseCostUsd: 490,
    validityPeriod: "Duration of course + wrap-up period",
    isExtendable: true,
    eligibilityCriteria: [
      "Confirmation of Acceptance for Studies (CAS) from a licensed sponsor",
      "Proof of financial support",
      "English language proficiency (CEFR B2 for degree level)",
      "Valid passport",
      "TB test certificate (if from listed country)",
    ],
  },
  {
    id: "uk-visitor",
    countryCode: "GB",
    name: "Standard Visitor Visa",
    code: "SVV",
    description:
      "For tourism, visiting family, attending business meetings, or short courses up to 6 months.",
    category: "tourist",
    processingTime: "3-6 weeks",
    processingDaysMin: 21,
    processingDaysMax: 42,
    baseCostUsd: 130,
    validityPeriod: "Up to 6 months",
    isExtendable: false,
    eligibilityCriteria: [
      "Valid passport",
      "Proof of accommodation",
      "Evidence of sufficient funds",
      "Evidence of ties to home country",
      "Return travel arrangements",
    ],
  },
  {
    id: "uk-family",
    countryCode: "GB",
    name: "Family Visa",
    code: "FAM",
    description:
      "For joining a partner, parent, or child who is a British citizen or settled in the UK.",
    category: "family",
    processingTime: "12-24 weeks",
    processingDaysMin: 84,
    processingDaysMax: 168,
    baseCostUsd: 1846,
    validityPeriod: "2 years 9 months",
    isExtendable: true,
    eligibilityCriteria: [
      "Genuine relationship with sponsor",
      "Minimum income requirement (£29,000)",
      "English language requirement (CEFR A1/A2)",
      "Suitable accommodation",
      "Valid passport",
    ],
  },

  // ---- UNITED STATES ----
  {
    id: "us-b1b2",
    countryCode: "US",
    name: "B-1/B-2 Visitor Visa",
    code: "B1B2",
    description:
      "For temporary business visitors (B-1) and tourists, medical treatment, or social visits (B-2).",
    category: "tourist",
    processingTime: "2-8 weeks",
    processingDaysMin: 14,
    processingDaysMax: 56,
    baseCostUsd: 185,
    validityPeriod: "Up to 10 years (multiple entry)",
    isExtendable: true,
    eligibilityCriteria: [
      "Demonstrate non-immigrant intent",
      "Proof of ties to home country",
      "Financial ability to cover trip costs",
      "Valid passport (6+ months)",
      "DS-160 online application",
      "Consular interview required",
    ],
  },
  {
    id: "us-f1",
    countryCode: "US",
    name: "F-1 Student Visa",
    code: "F1",
    description:
      "For international students attending an accredited US academic institution or English language program.",
    category: "student",
    processingTime: "3-8 weeks",
    processingDaysMin: 21,
    processingDaysMax: 56,
    baseCostUsd: 185,
    validityPeriod: "Duration of studies + 60-day grace period",
    isExtendable: true,
    eligibilityCriteria: [
      "I-20 form from SEVP-certified institution",
      "SEVIS fee payment ($350)",
      "Proof of financial support for first year",
      "English language proficiency",
      "Demonstrate non-immigrant intent",
      "Valid passport (6+ months)",
    ],
  },
  {
    id: "us-h1b",
    countryCode: "US",
    name: "H-1B Work Visa",
    code: "H1B",
    description:
      "For specialty occupation workers who hold at least a bachelor's degree or equivalent.",
    category: "work",
    processingTime: "3-6 months",
    processingDaysMin: 90,
    processingDaysMax: 180,
    baseCostUsd: 1710,
    validityPeriod: "3 years",
    isExtendable: true,
    maxExtensions: 1,
    eligibilityCriteria: [
      "US employer sponsor with approved Labor Condition Application",
      "Specialty occupation requiring a bachelor's degree minimum",
      "Relevant degree or equivalent work experience",
      "Subject to annual cap (lottery system applies)",
      "Valid passport",
    ],
  },
  {
    id: "us-eb2",
    countryCode: "US",
    name: "EB-2 Immigrant Visa",
    code: "EB2",
    description:
      "Employment-based green card for professionals with advanced degrees or exceptional ability.",
    category: "work",
    processingTime: "12-36 months",
    processingDaysMin: 365,
    processingDaysMax: 1095,
    baseCostUsd: 3500,
    validityPeriod: "Permanent",
    isExtendable: false,
    eligibilityCriteria: [
      "Advanced degree (master's or higher) or exceptional ability",
      "Labor certification (PERM) or National Interest Waiver",
      "Job offer from US employer (unless NIW)",
      "Valid passport",
    ],
  },

  // ---- CANADA ----
  {
    id: "ca-visitor",
    countryCode: "CA",
    name: "Temporary Resident Visa (Visitor)",
    code: "TRV",
    description:
      "For tourism, visiting family or friends, or short business trips to Canada.",
    category: "tourist",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 75,
    validityPeriod: "Up to 6 months per entry",
    isExtendable: true,
    eligibilityCriteria: [
      "Valid passport",
      "Proof of sufficient funds",
      "Ties to home country",
      "Letter of invitation (if visiting someone)",
      "Medical exam (if required)",
      "No criminal inadmissibility",
    ],
  },
  {
    id: "ca-study-permit",
    countryCode: "CA",
    name: "Study Permit",
    code: "SP",
    description:
      "For international students accepted at a designated learning institution (DLI) in Canada.",
    category: "student",
    processingTime: "4-16 weeks",
    processingDaysMin: 28,
    processingDaysMax: 112,
    baseCostUsd: 115,
    validityPeriod: "Duration of program + 90 days",
    isExtendable: true,
    eligibilityCriteria: [
      "Letter of acceptance from a DLI",
      "Proof of sufficient funds (CAD $20,635/year + tuition)",
      "Valid passport",
      "Medical exam (if required)",
      "Police certificate",
      "Provincial attestation letter (PAL)",
    ],
  },
  {
    id: "ca-express-entry",
    countryCode: "CA",
    name: "Express Entry (Federal Skilled Worker)",
    code: "FSW",
    description:
      "Points-based immigration pathway for skilled workers to obtain Canadian permanent residency.",
    category: "work",
    processingTime: "6-8 months",
    processingDaysMin: 180,
    processingDaysMax: 240,
    baseCostUsd: 1325,
    validityPeriod: "Permanent",
    isExtendable: false,
    eligibilityCriteria: [
      "Minimum 1 year continuous skilled work experience",
      "Language proficiency (CLB 7 minimum in English or French)",
      "Education credential assessment (ECA)",
      "Sufficient Comprehensive Ranking System (CRS) score",
      "No criminal or medical inadmissibility",
      "Proof of settlement funds",
    ],
  },
  {
    id: "ca-work-permit",
    countryCode: "CA",
    name: "Work Permit (LMIA-based)",
    code: "WP",
    description:
      "For workers with a job offer from a Canadian employer who has obtained a positive LMIA.",
    category: "work",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 155,
    validityPeriod: "Up to 3 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Valid job offer from Canadian employer",
      "Positive Labour Market Impact Assessment (LMIA)",
      "Relevant qualifications or experience",
      "Valid passport",
      "Medical exam (if required)",
      "No criminal inadmissibility",
    ],
  },

  // ---- AUSTRALIA ----
  {
    id: "au-visitor",
    countryCode: "AU",
    name: "Visitor Visa (Subclass 600)",
    code: "SC600",
    description:
      "For tourism, visiting family, or short-term business activities in Australia.",
    category: "tourist",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 110,
    validityPeriod: "Up to 12 months",
    isExtendable: true,
    eligibilityCriteria: [
      "Valid passport",
      "Proof of sufficient funds",
      "Health and character requirements",
      "Genuine intention to visit temporarily",
      "Health insurance recommended",
    ],
  },
  {
    id: "au-student",
    countryCode: "AU",
    name: "Student Visa (Subclass 500)",
    code: "SC500",
    description:
      "For international students enrolled in a registered course in Australia.",
    category: "student",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 450,
    validityPeriod: "Duration of course + 2 months",
    isExtendable: true,
    eligibilityCriteria: [
      "Confirmation of Enrolment (CoE) from a registered institution",
      "Genuine Temporary Entrant (GTE) requirement",
      "Proof of financial capacity",
      "English language proficiency (IELTS 5.5+)",
      "Overseas Student Health Cover (OSHC)",
      "Health and character clearances",
    ],
  },
  {
    id: "au-skilled-worker",
    countryCode: "AU",
    name: "Skilled Worker Visa (Subclass 482)",
    code: "SC482",
    description:
      "Temporary Skill Shortage visa for workers sponsored by an approved Australian employer.",
    category: "work",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 1330,
    validityPeriod: "Up to 4 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Nomination by an approved sponsor",
      "Occupation on eligible skilled occupation list",
      "Relevant skills and qualifications",
      "Minimum 2 years work experience in the occupation",
      "English language proficiency (IELTS 5.0+)",
      "Health and character clearances",
    ],
  },
  {
    id: "au-pr-skilled",
    countryCode: "AU",
    name: "Skilled Independent Visa (Subclass 189)",
    code: "SC189",
    description:
      "Points-based permanent residence visa for skilled workers not sponsored by an employer or state.",
    category: "work",
    processingTime: "6-18 months",
    processingDaysMin: 180,
    processingDaysMax: 540,
    baseCostUsd: 3070,
    validityPeriod: "Permanent",
    isExtendable: false,
    eligibilityCriteria: [
      "Occupation on the relevant skilled occupation list",
      "Positive skills assessment",
      "Points test score of 65+",
      "Age under 45",
      "English language proficiency (competent level)",
      "Health and character clearances",
    ],
  },

  // ---- GERMANY ----
  {
    id: "de-jobseeker",
    countryCode: "DE",
    name: "Job Seeker Visa",
    code: "JSV",
    description:
      "For qualified professionals to enter Germany and search for employment for up to 6 months.",
    category: "work",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 80,
    validityPeriod: "6 months",
    isExtendable: false,
    eligibilityCriteria: [
      "Recognised university degree or equivalent qualification",
      "Proof of financial resources (approx. €11,208 in blocked account)",
      "Health insurance coverage",
      "Valid passport",
      "CV and motivation letter",
    ],
  },
  {
    id: "de-work-visa",
    countryCode: "DE",
    name: "Employment Visa (EU Blue Card)",
    code: "BLUE",
    description:
      "For highly qualified non-EU workers with a job offer in Germany meeting minimum salary requirements.",
    category: "work",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 80,
    validityPeriod: "Up to 4 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Recognised university degree",
      "Job offer with minimum gross annual salary (€45,300 for shortage occupations)",
      "Employment contract or binding job offer",
      "Valid passport",
      "Health insurance",
    ],
  },
  {
    id: "de-student",
    countryCode: "DE",
    name: "Student Visa",
    code: "STUD",
    description:
      "For international students admitted to a German university or preparatory course.",
    category: "student",
    processingTime: "4-12 weeks",
    processingDaysMin: 28,
    processingDaysMax: 84,
    baseCostUsd: 80,
    validityPeriod: "Duration of studies",
    isExtendable: true,
    eligibilityCriteria: [
      "Admission letter from a German university",
      "Proof of financial resources (€11,208/year in blocked account)",
      "Health insurance",
      "Academic qualifications recognised in Germany",
      "Valid passport",
      "Language proficiency (German or English depending on course)",
    ],
  },
  // #306: the short-stay record that inherits the shared route (data file,
  // `inheritedBy`). Same shape as the BE/FR/LU/ES/PT records below: see the
  // "#306 SHORT-STAY RECORDS" note there for why it states so little.
  {
    id: "de-visitor",
    countryCode: "DE",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Germany.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- NETHERLANDS ----
  {
    id: "nl-hsm",
    countryCode: "NL",
    name: "Highly Skilled Migrant Visa",
    code: "HSM",
    description:
      "For highly skilled workers offered employment by a recognised Dutch sponsor.",
    category: "work",
    processingTime: "2-4 weeks",
    processingDaysMin: 14,
    processingDaysMax: 28,
    baseCostUsd: 210,
    validityPeriod: "Duration of contract (max 5 years)",
    isExtendable: true,
    eligibilityCriteria: [
      "Job offer from a recognised IND sponsor",
      "Minimum salary threshold (age-dependent)",
      "Valid passport",
      "TB screening (if required)",
    ],
  },
  {
    id: "nl-student",
    countryCode: "NL",
    name: "Student Residence Permit",
    code: "MVV-STUD",
    description:
      "For non-EU students enrolled in a full-time study program at a Dutch educational institution.",
    category: "student",
    processingTime: "4-8 weeks",
    processingDaysMin: 28,
    processingDaysMax: 56,
    baseCostUsd: 210,
    validityPeriod: "Duration of course + preparation",
    isExtendable: true,
    eligibilityCriteria: [
      "Acceptance letter from a recognised Dutch institution",
      "Proof of sufficient funds (approx. €13,000/year)",
      "Valid passport",
      "TB screening (if required)",
      "Health insurance",
    ],
  },
  {
    id: "nl-visitor",
    countryCode: "NL",
    // #239: no bloc is named in the seed. The shared route this record
    // inherits (its name, members and sources) comes from the data file
    // (shared-visa-data.ts) and is attached below through `inheritsFromFor`.
    // The old name, the old code and the description's bloc mention and
    // "up to 90 days" were removed: they named a bloc and stated a duration
    // with no official source on record.
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description:
      "For tourism, business visits, or family visits to the Netherlands for a short stay.",
    category: "tourist",
    // #339 REMOVED (no official source on record): processingTime "2-4 weeks",
    //   processingDaysMin 14, processingDaysMax 28. The processing time and the
    //   stay limit now come from the shared route this record inherits (the
    //   data file's `processing` / `validity` blocks, each with its verbatim
    //   quote), written by the seed through seed-route-facts.ts. Setting them
    //   here again would be refused as a second source (seedRouteFactProblems).
    // #239 REMOVED (no official source on record): baseCostUsd: 90.
    // #239 REMOVED (no official source on record): validityPeriod:
    //   "Up to 90 days within 180-day period".
    // #339 REMOVED (no official source on record): isExtendable: false. Whether
    //   and when the visa can be extended is left to #344; until then the
    //   record says nothing (never `false`).
    // #339 REMOVED six unsourced eligibility lines (passport validity, health
    //   insurance, accommodation, funds, return booking, purpose of visit):
    //   requirements come from the published shared rulebook, as for the 28
    //   other short-stay records.
    eligibilityCriteria: [],
  },

  // ============================================
  // #306 SHORT-STAY RECORDS (BE, FR, LU, ES, PT; DE's is in its own section)
  // ============================================
  // One record per country the data file (shared-visa-data.ts) lists under
  // the shared route's `inheritedBy`. The record states NOTHING that would be
  // a legal or immigration fact without an official source on record here:
  //   - no `baseCostUsd`: the price is the route's sourced fee, which the seed
  //     converts and writes (#299); a fee of its own would be refused as a
  //     second fee source (seedFeeProblems),
  //   - no `validityPeriod` or processing time (`processingTime`,
  //     `processingDaysMin`, `processingDaysMax`): since #339 these come from
  //     the route's sourced `processing` / `validity` blocks, which the seed
  //     writes (seed-route-facts.ts); one of its own would be refused as a
  //     second source (seedRouteFactProblems),
  //   - no `maxExtensions`, `isExtendable`, `applicationUrl` or
  //     `applicationInstructions`: all optional since #239 / #306, and left
  //     out of the stored doc,
  //   - `eligibilityCriteria: []`: requirements come from the published
  //     shared rulebook the record inherits, not from seed text,
  //   - the description only names the visa and the country.
  // The bloc is not named in this file: the route's name, members and sources
  // come from the data file through `inheritsFromFor`.

  // ---- BELGIUM ----
  {
    id: "be-visitor",
    countryCode: "BE",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Belgium.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- FRANCE ----
  {
    id: "fr-visitor",
    countryCode: "FR",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for France.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- LUXEMBOURG ----
  {
    id: "lu-visitor",
    countryCode: "LU",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Luxembourg.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- SPAIN ----
  {
    id: "es-visitor",
    countryCode: "ES",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Spain.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- PORTUGAL ----
  {
    id: "pt-visitor",
    countryCode: "PT",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Portugal.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ============================================
  // #322 SHORT-STAY RECORDS (the twenty members added in #322)
  // ============================================
  // Exactly the shape of the #306 records above (see the "#306 SHORT-STAY
  // RECORDS" note for why each states so little): no fee, validity,
  // extensions, processing time, application address or instructions,
  // `eligibilityCriteria: []`, and a description that only names the visa and
  // the country. Each one is listed under the shared route's `inheritedBy` in
  // the data file and takes its price from the route's sourced fee.
  // Generated by script from issue #322, in the issue's order.

  // ---- GREECE ----
  {
    id: "gr-visitor",
    countryCode: "GR",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Greece.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- DENMARK ----
  {
    id: "dk-visitor",
    countryCode: "DK",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Denmark.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- FINLAND ----
  {
    id: "fi-visitor",
    countryCode: "FI",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Finland.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- SWEDEN ----
  {
    id: "se-visitor",
    countryCode: "SE",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Sweden.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- ICELAND ----
  {
    id: "is-visitor",
    countryCode: "IS",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Iceland.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- NORWAY ----
  {
    id: "no-visitor",
    countryCode: "NO",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Norway.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- CZECHIA ----
  {
    id: "cz-visitor",
    countryCode: "CZ",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Czechia.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- ESTONIA ----
  {
    id: "ee-visitor",
    countryCode: "EE",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Estonia.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- LATVIA ----
  {
    id: "lv-visitor",
    countryCode: "LV",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Latvia.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- LITHUANIA ----
  {
    id: "lt-visitor",
    countryCode: "LT",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Lithuania.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- HUNGARY ----
  {
    id: "hu-visitor",
    countryCode: "HU",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Hungary.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- MALTA ----
  {
    id: "mt-visitor",
    countryCode: "MT",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Malta.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- POLAND ----
  {
    id: "pl-visitor",
    countryCode: "PL",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Poland.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- SLOVENIA ----
  {
    id: "si-visitor",
    countryCode: "SI",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Slovenia.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- SLOVAKIA ----
  {
    id: "sk-visitor",
    countryCode: "SK",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Slovakia.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- SWITZERLAND ----
  {
    id: "ch-visitor",
    countryCode: "CH",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Switzerland.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- LIECHTENSTEIN ----
  {
    id: "li-visitor",
    countryCode: "LI",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Liechtenstein.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- CROATIA ----
  {
    id: "hr-visitor",
    countryCode: "HR",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Croatia.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- BULGARIA ----
  {
    id: "bg-visitor",
    countryCode: "BG",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Bulgaria.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- ROMANIA ----
  {
    id: "ro-visitor",
    countryCode: "RO",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Romania.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ============================================
  // #331 SHORT-STAY RECORDS (Italy and Austria)
  // ============================================
  // Exactly the shape of the #306 and #322 records above (see the "#306
  // SHORT-STAY RECORDS" note for why each states so little). Each one is listed
  // under the shared route's `inheritedBy` in the data file and takes its price
  // from the route's sourced fee.

  // ---- ITALY ----
  {
    id: "it-visitor",
    countryCode: "IT",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Italy.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- AUSTRIA ----
  {
    id: "at-visitor",
    countryCode: "AT",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "Short stay visa for Austria.",
    category: "tourist",
    eligibilityCriteria: [],
  },

  // ---- UAE ----
  {
    id: "ae-tourist",
    countryCode: "AE",
    name: "Tourist Visa",
    code: "VISIT",
    description:
      "For tourists visiting the UAE for leisure, family visits, or short business trips.",
    category: "tourist",
    processingTime: "3-5 days",
    processingDaysMin: 3,
    processingDaysMax: 5,
    baseCostUsd: 100,
    validityPeriod: "30 or 90 days",
    isExtendable: true,
    eligibilityCriteria: [
      "Valid passport (6+ months)",
      "Passport-sized photograph",
      "Confirmed hotel booking or host details",
      "Return flight ticket",
      "Proof of financial means",
    ],
  },
  {
    id: "ae-work",
    countryCode: "AE",
    name: "Employment Visa",
    code: "EMP",
    description:
      "For foreign workers who have secured employment with a UAE-based company acting as their sponsor.",
    category: "work",
    processingTime: "2-4 weeks",
    processingDaysMin: 14,
    processingDaysMax: 28,
    baseCostUsd: 350,
    validityPeriod: "2-3 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Job offer from a UAE employer",
      "Employer sponsorship",
      "Medical fitness test",
      "Emirates ID application",
      "Valid passport (6+ months)",
      "Attested educational certificates",
    ],
  },
  {
    id: "ae-golden",
    countryCode: "AE",
    name: "Golden Visa",
    code: "GOLD",
    description:
      "Long-term residence visa for investors, entrepreneurs, exceptional talents, and outstanding students.",
    category: "investor",
    processingTime: "2-4 weeks",
    processingDaysMin: 14,
    processingDaysMax: 28,
    baseCostUsd: 650,
    validityPeriod: "5-10 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Investment of AED 2M+ in property or business",
      "OR exceptional talent/specialisation",
      "OR outstanding academic achievement (GPA 3.8+)",
      "Valid passport (6+ months)",
      "Medical fitness test",
      "No criminal record",
    ],
  },

  // ---- SOUTH AFRICA ----
  {
    id: "za-visitor",
    countryCode: "ZA",
    name: "Visitor Visa",
    code: "VIS",
    description:
      "For tourism, visiting family or friends, or attending conferences in South Africa.",
    category: "tourist",
    processingTime: "4-8 weeks",
    processingDaysMin: 28,
    processingDaysMax: 56,
    baseCostUsd: 40,
    validityPeriod: "Up to 90 days",
    isExtendable: true,
    eligibilityCriteria: [
      "Valid passport (30+ days beyond intended departure)",
      "Two blank pages in passport",
      "Proof of sufficient funds",
      "Return or onward travel arrangements",
      "Yellow fever certificate (if from endemic country)",
    ],
  },
  {
    id: "za-work",
    countryCode: "ZA",
    name: "General Work Visa",
    code: "GWV",
    description:
      "For foreign nationals who have a confirmed job offer from a South African employer.",
    category: "work",
    processingTime: "8-12 weeks",
    processingDaysMin: 56,
    processingDaysMax: 84,
    baseCostUsd: 50,
    validityPeriod: "Up to 5 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Job offer from a South African employer",
      "Certificate from Department of Labour confirming no suitable local candidate",
      "SAQA evaluation of qualifications",
      "Proof of professional registration (if applicable)",
      "Police clearance certificate",
      "Medical and radiological reports",
    ],
  },
  {
    id: "za-study",
    countryCode: "ZA",
    name: "Study Visa",
    code: "STUDY",
    description:
      "For international students accepted at a recognised educational institution in South Africa.",
    category: "student",
    processingTime: "4-8 weeks",
    processingDaysMin: 28,
    processingDaysMax: 56,
    baseCostUsd: 40,
    validityPeriod: "Duration of studies",
    isExtendable: true,
    eligibilityCriteria: [
      "Acceptance letter from a South African institution",
      "Proof of sufficient financial means or scholarship",
      "Medical and radiological reports",
      "Police clearance certificate",
      "Valid passport",
      "Medical/hospital cover in South Africa",
    ],
  },
];

// ============================================
// SEED FUNCTION
// ============================================

/**
 * What a caller may replace (issue #299). The deploy seed passes nothing and
 * gets the lists above and the repo's data file. The emulator tests pass
 * made-up countries, visas and data, so no real bloc or fee appears in a test.
 */
export interface SeedCountriesAndVisasOptions {
  countries?: SeedCountry[];
  visaTypes?: SeedVisaType[];
  /** A raw shared visa data file (validated like the repo's own). */
  sharedVisaData?: unknown;
  /** The seed's clock (rate freshness, createdAt / updatedAt). Default: now. */
  now?: Timestamp;
}

export type { SeedCountry, SeedVisaType };
// #306: the shipped lists, read by the unit tests to check that every member
// country and every inheriting record in the data file exists in the seed.
export { COUNTRIES as SEED_COUNTRIES, VISA_TYPES as SEED_VISA_TYPES };

export async function seedCountriesAndVisas(options: SeedCountriesAndVisasOptions = {}): Promise<{
  countries: number;
  visaTypes: number;
}> {
  const now = options.now ?? Timestamp.now();
  const countries = options.countries ?? COUNTRIES;
  const visaTypes = options.visaTypes ?? VISA_TYPES;
  // #239: validated up front; an invalid data file stops the seed with a list of problems.
  const sharedVisaData = loadSharedVisaData(options.sharedVisaData);

  // #299: a record cannot have two fee sources. Checked before ANY write, so a
  // conflicting seed entry stops the run with every problem listed.
  const feeProblems = seedFeeProblems(visaTypes, sharedVisaData);
  if (feeProblems.length > 0) {
    throw new Error(`The seed's visa fees conflict with the shared visa data file:\n - ${feeProblems.join("\n - ")}`);
  }
  // #339: the same two-sources rule for the route's processing time and stay
  // limit, also before ANY write.
  const factProblems = seedRouteFactProblems(visaTypes, sharedVisaData);
  if (factProblems.length > 0) {
    throw new Error(`The seed's visa facts conflict with the shared visa data file:\n - ${factProblems.join("\n - ")}`);
  }

  // Group visa types by country for stats computation
  const visasByCountry: Record<string, SeedVisaType[]> = {};
  for (const visa of visaTypes) {
    if (!visasByCountry[visa.countryCode]) {
      visasByCountry[visa.countryCode] = [];
    }
    visasByCountry[visa.countryCode].push(visa);
  }

  // ============================================
  // READS (before any write)
  // ============================================

  // Issue #191: read the docs that already exist BEFORE writing, so a re-seed
  // (it runs on every dev deploy) can keep the fields that admins and scripts
  // own: isActive (e.g. the deactivate:uk-seeds script from #175), agentIds
  // and createdAt. One getAll per country. Since #299 this happens up front
  // (it used to sit in the write loop): the stored fee of a record decides
  // what the seed writes for it, and the country's minimum cost needs that.
  const visaRef = (visa: SeedVisaType) => db.collection("countries").doc(visa.countryCode).collection("visaTypes").doc(visa.id);
  /** Stored visa docs, keyed "<countryCode>/<visaId>". */
  const existingByKey = new Map<string, Record<string, unknown>>();
  const keyOf = (visa: SeedVisaType) => `${visa.countryCode}/${visa.id}`;
  for (const visas of Object.values(visasByCountry)) {
    if (visas.length === 0) continue;
    const snaps = await db.getAll(...visas.map(visaRef));
    snaps.forEach((snap, i) => {
      if (snap.exists) existingByKey.set(keyOf(visas[i]), snap.data() as Record<string, unknown>);
    });
  }

  // ---- #299: the sourced fee of every record the data file gives one ----
  // Only records listed under a route's `inheritedBy` with a `fee` are
  // looked at; for every other record nothing below runs and its fee is
  // exactly what the seed entry says.
  const feeDecisions = new Map<string, SourcedFeeDecision>();
  const visasWithRouteFee = visaTypes.filter((v) => routeFeesFor(sharedVisaData, v.countryCode, v.id).length > 0);
  if (visasWithRouteFee.length > 0) {
    // The stored exchange rates (`appConfig/fx`, refreshed by the visa-catalog
    // crawl). READ ONLY here: the seed never fetches or writes a rate.
    const fxSnap = await db.collection("appConfig").doc("fx").get();
    const fx = fxSnap.exists ? (fxSnap.data() as FxRatesDoc) : undefined;
    // Which of the official sources the fees cite are on record.
    const sourceIds = [...new Set(visasWithRouteFee.flatMap((v) => routeFeesFor(sharedVisaData, v.countryCode, v.id).map((r) => r.fee.guidanceSourceId)))];
    const sourceSnaps = await db.getAll(...sourceIds.map((id) => db.collection("guidanceSources").doc(id)));
    const sourcesOnRecord = new Set(sourceSnaps.filter((snap) => snap.exists).map((snap) => snap.id));

    for (const visa of visasWithRouteFee) {
      const decision = planSourcedFee({
        routeFees: routeFeesFor(sharedVisaData, visa.countryCode, visa.id),
        existing: existingByKey.get(keyOf(visa)),
        fx,
        now,
        guidanceSourceExists: (id) => sourcesOnRecord.has(id),
      });
      feeDecisions.set(keyOf(visa), decision);
      // Every outcome is logged, so a deploy log says why a price is or is not there.
      if (decision.action === "write") {
        console.log(`[seed] ${keyOf(visa)}: sourced fee written, baseCostUsd ${decision.baseCostUsd} (rate date ${decision.sourcedFee.fee.fxDate ?? "n/a"})`);
      } else if (decision.action === "keep") {
        console.log(`[seed] ${keyOf(visa)}: sourced fee NOT re-converted, baseCostUsd ${decision.baseCostUsd} kept: ${decision.reason}`);
      } else if (decision.action === "omit") {
        console.log(`[seed] ${keyOf(visa)}: NO sourced fee written (no baseCostUsd, no sourcedFee): ${decision.reason}`);
      }
    }
  }

  // ---- #339: the sourced processing time and stay limit ----
  // Only records listed under a route's `inheritedBy` with a `processing` or
  // `validity` block are looked at; every other record is written exactly
  // as its seed entry says.
  const factDecisions = new Map<string, RouteFactsDecision>();
  const visasWithRouteFacts = visaTypes.filter((v) => routeFactsFor(sharedVisaData, v.countryCode, v.id).length > 0);
  if (visasWithRouteFacts.length > 0) {
    // Which of the official sources the facts cite are on record (READ ONLY).
    const factSourceIds = [
      ...new Set(
        visasWithRouteFacts.flatMap((v) =>
          routeFactsFor(sharedVisaData, v.countryCode, v.id).flatMap((r) => [r.processing?.guidanceSourceId, r.validity?.guidanceSourceId].filter((id): id is string => !!id))
        )
      ),
    ];
    const factSourceSnaps = factSourceIds.length > 0 ? await db.getAll(...factSourceIds.map((id) => db.collection("guidanceSources").doc(id))) : [];
    const factSourcesOnRecord = new Set(factSourceSnaps.filter((snap) => snap.exists).map((snap) => snap.id));

    for (const visa of visasWithRouteFacts) {
      const decision = planRouteFacts({
        routeFacts: routeFactsFor(sharedVisaData, visa.countryCode, visa.id),
        existing: existingByKey.get(keyOf(visa)),
        guidanceSourceExists: (id) => factSourcesOnRecord.has(id),
      });
      factDecisions.set(keyOf(visa), decision);
      // Every outcome is logged, so a deploy log says why a fact is or is not there.
      if (decision.action === "write") {
        const written = Object.keys(decision.fields.sourcedFacts).join(", ");
        const skipped = decision.skipped.length > 0 ? `; NOT written: ${decision.skipped.join("; ")}` : "";
        console.log(`[seed] ${keyOf(visa)}: sourced route facts written (${written})${skipped}`);
      } else if (decision.action === "omit") {
        console.log(`[seed] ${keyOf(visa)}: NO sourced route facts written: ${decision.reason}`);
      }
    }
  }

  // ============================================
  // WRITES
  // ============================================

  // Seed countries
  const countryBatch = db.batch();
  for (const country of countries) {
    const visas = visasByCountry[country.code] || [];
    // #306: only visas that state a processing time count (an entry may omit
    // it). With none, the minimum is 0 as for a country with no visas: never
    // NaN (Math.min of `undefined`) and never Infinity (Math.min of nothing).
    // #339: a route's sourced minimum counts like an entry's own one; a route
    // that states no minimum adds nothing (no made-up 0 enters the minimum).
    const processingMins = visas
      .map((v) => {
        const facts = factDecisions.get(keyOf(v));
        return (facts && routeFactFields(facts)?.processingDaysMin) ?? v.processingDaysMin;
      })
      .filter((d): d is number => typeof d === "number");
    const minProcessingDays = processingMins.length > 0 ? Math.min(...processingMins) : 0;
    // #239: a visa with no recorded fee does not count towards the minimum.
    // #299: a sourced fee counts exactly like a seed entry's own fee.
    const costs = visas.map((v) => effectiveSeedCost(v, feeDecisions.get(keyOf(v)))).filter((c): c is number => c !== undefined);
    const minCostUsd = costs.length > 0 ? Math.min(...costs) : 0;

    countryBatch.set(db.collection("countries").doc(country.code), {
      code: country.code,
      name: country.name,
      flagUrl: country.flagUrl,
      isSupported: country.isSupported,
      visaTypesCount: visas.length,
      minProcessingDays,
      minCostUsd,
      popularityRank: country.popularityRank,
      createdAt: now,
      updatedAt: now,
    });
  }
  await countryBatch.commit();
  console.log(`✅ Seeded ${countries.length} countries`);

  // Seed visa types (batch per country since subcollections differ)
  let totalVisas = 0;
  for (const visas of Object.values(visasByCountry)) {
    const visaBatch = db.batch();

    for (const visa of visas) {
      const existing = existingByKey.get(keyOf(visa));
      const decision = feeDecisions.get(keyOf(visa));

      // #239: built by a pure function (seed-visa-doc.ts). It keeps the stored
      // `inheritsFrom` (this is a whole-document set, which would drop it) and
      // adds the data file's shared routes to a record that has none.
      // #299: plus the record's sourced fee, when the decision carries one.
      // #339: and its sourced route facts, when that decision carries any.
      visaBatch.set(
        visaRef(visa),
        buildVisaTypeDoc(
          visa,
          existing,
          now,
          inheritsFromFor(sharedVisaData, visa.countryCode, visa.id),
          decision ? sourcedFeeFields(decision) : undefined,
          // #339: plus the route's processing time and stay limit, when the decision carries them.
          factDecisions.has(keyOf(visa)) ? routeFactFields(factDecisions.get(keyOf(visa))!) : undefined
        )
      );
    }
    await visaBatch.commit();
    totalVisas += visas.length;
  }
  console.log(`✅ Seeded ${totalVisas} visa types across ${Object.keys(visasByCountry).length} countries`);

  return { countries: countries.length, visaTypes: totalVisas };
}
