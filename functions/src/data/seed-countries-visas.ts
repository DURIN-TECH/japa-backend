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
  processingTime: string;
  processingDaysMin: number;
  processingDaysMax: number;
  baseCostUsd: number;
  validityPeriod: string;
  isExtendable: boolean;
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
    name: "Short Stay Schengen Visa",
    code: "SCHEN",
    description:
      "For tourism, business visits, or family visits to the Netherlands (and Schengen area) for up to 90 days.",
    category: "tourist",
    processingTime: "2-4 weeks",
    processingDaysMin: 14,
    processingDaysMax: 28,
    baseCostUsd: 90,
    validityPeriod: "Up to 90 days within 180-day period",
    isExtendable: false,
    eligibilityCriteria: [
      "Valid passport (3+ months beyond planned stay)",
      "Travel health insurance (€30,000 coverage)",
      "Proof of accommodation",
      "Sufficient funds for stay",
      "Return travel booking",
      "Purpose of visit documentation",
    ],
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

export async function seedCountriesAndVisas(): Promise<{
  countries: number;
  visaTypes: number;
}> {
  const now = Timestamp.now();

  // Group visa types by country for stats computation
  const visasByCountry: Record<string, SeedVisaType[]> = {};
  for (const visa of VISA_TYPES) {
    if (!visasByCountry[visa.countryCode]) {
      visasByCountry[visa.countryCode] = [];
    }
    visasByCountry[visa.countryCode].push(visa);
  }

  // Seed countries
  const countryBatch = db.batch();
  for (const country of COUNTRIES) {
    const visas = visasByCountry[country.code] || [];
    const minProcessingDays =
      visas.length > 0
        ? Math.min(...visas.map((v) => v.processingDaysMin))
        : 0;
    const minCostUsd =
      visas.length > 0 ? Math.min(...visas.map((v) => v.baseCostUsd)) : 0;

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
  console.log(`✅ Seeded ${COUNTRIES.length} countries`);

  // Seed visa types (batch per country since subcollections differ)
  let totalVisas = 0;
  for (const [countryCode, visas] of Object.entries(visasByCountry)) {
    const visaBatch = db.batch();
    for (const visa of visas) {
      const ref = db
        .collection("countries")
        .doc(countryCode)
        .collection("visaTypes")
        .doc(visa.id);

      visaBatch.set(ref, {
        id: visa.id,
        countryCode: visa.countryCode,
        name: visa.name,
        code: visa.code,
        description: visa.description,
        category: visa.category,
        processingTime: visa.processingTime,
        processingDaysMin: visa.processingDaysMin,
        processingDaysMax: visa.processingDaysMax,
        baseCostUsd: visa.baseCostUsd,
        validityPeriod: visa.validityPeriod,
        isExtendable: visa.isExtendable,
        ...(visa.maxExtensions !== undefined && {
          maxExtensions: visa.maxExtensions,
        }),
        eligibilityCriteria: visa.eligibilityCriteria,
        ...(visa.applicationUrl && { applicationUrl: visa.applicationUrl }),
        ...(visa.applicationInstructions && {
          applicationInstructions: visa.applicationInstructions,
        }),
        isActive: true,
        agentIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    await visaBatch.commit();
    totalVisas += visas.length;
  }
  console.log(`✅ Seeded ${totalVisas} visa types across ${Object.keys(visasByCountry).length} countries`);

  return { countries: COUNTRIES.length, visaTypes: totalVisas };
}
