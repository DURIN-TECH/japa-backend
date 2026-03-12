import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { EligibilityQuestion, VisaExemption } from "../types/eligibility";

const db = getFirestore();

/**
 * Seed eligibility questions for Nigeria → Ireland route
 * Covers:
 * - Common questions (all visas)
 * - Ireland-specific questions (country:IE)
 * - Nigeria-specific questions (nationality:NG)
 * - Nigeria → Ireland questions (nationality:NG:IE)
 * - Tourist/Short Stay C visa questions (category:tourist)
 * - Work visa questions (category:work)
 * - Student visa questions (category:student)
 */

type QuestionSeed = Omit<EligibilityQuestion, "id" | "createdAt" | "updatedAt">;

// ============================================
// COMMON QUESTIONS (All visas)
// ============================================
const commonQuestions: QuestionSeed[] = [
  {
    scope: "common",
    question: "Do you have a valid passport?",
    description: "Your passport must be valid for at least 6 months beyond your intended stay in Ireland.",
    helpText: "If your passport expires soon, consider renewing it before applying.",
    type: "boolean",
    weight: 20,
    correctAnswers: ["true"],
    failRecommendation: "A valid passport is required for all Irish visa applications. Apply for or renew your passport first.",
    orderIndex: 1,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "common",
    question: "How many months until your passport expires?",
    description: "Ireland requires at least 6 months validity beyond your planned stay.",
    type: "number",
    weight: 10,
    minValue: 0,
    maxValue: 120,
    idealMin: 6,
    idealMax: 120,
    unit: "months",
    failRecommendation: "Your passport validity may be insufficient. Consider renewing before applying.",
    orderIndex: 2,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "common",
    question: "Have you ever been refused a visa to any country?",
    description: "This includes refusals from Ireland, UK, USA, Schengen countries, or any other nation.",
    helpText: "Be honest - previous refusals don't automatically disqualify you but must be disclosed.",
    type: "boolean",
    weight: 15,
    correctAnswers: ["false"],
    failRecommendation: "Previous visa refusals require additional explanation. Prepare documentation explaining the circumstances and what has changed.",
    orderIndex: 3,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "common",
    question: "Do you have any criminal convictions?",
    description: "Include any convictions, pending charges, or deportation orders from any country.",
    type: "boolean",
    weight: 15,
    correctAnswers: ["false"],
    failRecommendation: "Criminal history may affect your application. Consider consulting with an immigration lawyer for guidance.",
    orderIndex: 4,
    isRequired: true,
    isActive: true,
  },
];

// ============================================
// IRELAND-SPECIFIC QUESTIONS (country:IE)
// ============================================
const irelandQuestions: QuestionSeed[] = [
  {
    scope: "country:IE",
    question: "Can you provide proof of accommodation in Ireland?",
    description: "Hotel bookings, Airbnb confirmation, or invitation letter from a host.",
    helpText: "For tourist visas, showing confirmed accommodation significantly strengthens your application.",
    type: "boolean",
    weight: 10,
    correctAnswers: ["true"],
    failRecommendation: "Book accommodation or obtain an invitation letter from your Irish host with their proof of residence.",
    orderIndex: 10,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "country:IE",
    question: "Do you have comprehensive travel insurance?",
    description: "Insurance should cover medical expenses of at least €30,000 and the entire duration of your stay.",
    helpText: "While not mandatory for all Irish visas, travel insurance is strongly recommended.",
    type: "boolean",
    weight: 5,
    correctAnswers: ["true"],
    failRecommendation: "Consider purchasing travel insurance that covers medical emergencies, trip cancellation, and repatriation.",
    orderIndex: 11,
    isRequired: false,
    isActive: true,
  },
];

// ============================================
// NIGERIA-SPECIFIC QUESTIONS (nationality:NG)
// ============================================
const nigeriaQuestions: QuestionSeed[] = [
  {
    scope: "nationality:NG",
    question: "Have you traveled internationally in the past 5 years?",
    description: "Previous travel history, especially to UK/EU/US, strengthens your application.",
    helpText: "If you have traveled and returned as planned, this demonstrates compliance with visa conditions.",
    type: "boolean",
    weight: 10,
    correctAnswers: ["true"],
    partialAnswers: ["false"],
    failRecommendation: "Limited travel history isn't disqualifying but you may need to provide stronger ties to Nigeria.",
    orderIndex: 20,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "nationality:NG",
    question: "What financial documentation can you provide?",
    description: "Irish visa applications require proof of funds. If using a sponsor, they must provide their documents.",
    helpText: "Your own statements showing regular activity are strongest. Sponsor statements are acceptable with a formal undertaking letter.",
    type: "single",
    options: [
      "Own bank statements (6+ months history)",
      "Own bank statements (less than 6 months)",
      "Sponsor's bank statements + undertaking letter",
      "Combination of own funds + sponsor",
      "Employer letter confirming trip sponsorship",
    ],
    weight: 10,
    correctAnswers: [
      "Own bank statements (6+ months history)",
      "Sponsor's bank statements + undertaking letter",
      "Combination of own funds + sponsor",
      "Employer letter confirming trip sponsorship",
    ],
    partialAnswers: [
      "Own bank statements (less than 6 months)",
    ],
    failRecommendation: "You need financial documentation - either your own bank statements (ideally 6+ months) or a sponsor's statements with a formal undertaking letter.",
    orderIndex: 21,
    isRequired: true,
    isActive: true,
  },
];

// ============================================
// NIGERIA → IRELAND SPECIFIC (nationality:NG:IE)
// ============================================
const nigeriaToIrelandQuestions: QuestionSeed[] = [
  {
    scope: "nationality:NG:IE",
    question: "Are you aware that Nigerian applicants must apply online through the AVATS system?",
    description: "Ireland uses the Automated Visa Application Tracking System (AVATS) for Nigerian applications.",
    helpText: "Visit https://www.visas.inis.gov.ie to create an account and submit your application.",
    type: "boolean",
    weight: 5,
    correctAnswers: ["true"],
    failRecommendation: "Familiarize yourself with the AVATS online system before starting your application.",
    orderIndex: 30,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "nationality:NG:IE",
    question: "Do you have access to the VFS Global visa application centre in Nigeria?",
    description: "After online submission, you must submit documents and biometrics at a VFS centre (Lagos or Abuja).",
    helpText: "VFS centres are located in Lagos and Abuja. Plan your visit in advance.",
    type: "boolean",
    weight: 5,
    correctAnswers: ["true"],
    failRecommendation: "Locate your nearest VFS Global centre and schedule an appointment for document submission.",
    orderIndex: 31,
    isRequired: true,
    isActive: true,
  },
];

// ============================================
// TOURIST/SHORT STAY QUESTIONS (category:tourist)
// ============================================
const touristQuestions: QuestionSeed[] = [
  {
    scope: "category:tourist",
    question: "Can you demonstrate strong ties to Nigeria that ensure your return?",
    description: "Employment, property ownership, family responsibilities, or business interests.",
    helpText: "Evidence of ties includes: employment letter, property deeds, children's school records, business registration.",
    type: "boolean",
    weight: 20,
    correctAnswers: ["true"],
    failRecommendation: "Gather evidence of your ties to Nigeria: employment letter, property documents, family obligations, or business records.",
    orderIndex: 40,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:tourist",
    question: "How will you fund your stay in Ireland?",
    description: "Generally €60-100 per day plus accommodation and flight costs. Multiple funding sources are acceptable.",
    helpText: "If using a sponsor, they must provide their bank statements, employment letter, and a formal invitation/undertaking letter.",
    type: "single",
    options: [
      "Personal savings (own bank statements)",
      "Sponsor in Ireland (host covering expenses)",
      "Sponsor in Nigeria (family/friend funding trip)",
      "Employer sponsorship (business trip)",
      "Pre-paid travel package (tour/accommodation included)",
      "Combination of personal funds and sponsor",
    ],
    weight: 15,
    correctAnswers: [
      "Personal savings (own bank statements)",
      "Sponsor in Ireland (host covering expenses)",
      "Sponsor in Nigeria (family/friend funding trip)",
      "Employer sponsorship (business trip)",
      "Pre-paid travel package (tour/accommodation included)",
      "Combination of personal funds and sponsor",
    ],
    failRecommendation: "You need to demonstrate how your trip will be funded. Options include personal savings, a sponsor, or employer coverage.",
    orderIndex: 41,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:tourist",
    question: "Do you have a confirmed return flight or proof of onward travel?",
    description: "Booked return ticket or itinerary showing you will leave Ireland.",
    type: "boolean",
    weight: 10,
    correctAnswers: ["true"],
    failRecommendation: "Book a return flight or obtain a refundable booking as proof of return travel.",
    orderIndex: 42,
    isRequired: true,
    isActive: true,
  },
];

// ============================================
// WORK VISA QUESTIONS (category:work)
// ============================================
const workQuestions: QuestionSeed[] = [
  {
    scope: "category:work",
    question: "Do you have a valid job offer from an Irish employer?",
    description: "The job offer should be for a position on the Critical Skills or eligible occupations list.",
    helpText: "Your employer should provide a formal offer letter with salary, job title, and start date.",
    type: "boolean",
    weight: 25,
    correctAnswers: ["true"],
    failRecommendation: "A valid job offer is essential for work permits. Focus on securing employment before applying.",
    orderIndex: 50,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:work",
    question: "What is your highest level of education?",
    description: "Higher qualifications may qualify you for Critical Skills Employment Permit.",
    type: "single",
    options: ["High School", "Bachelor's Degree", "Master's Degree", "PhD", "Professional Certification"],
    weight: 10,
    correctAnswers: ["Bachelor's Degree", "Master's Degree", "PhD", "Professional Certification"],
    partialAnswers: ["High School"],
    failRecommendation: "Consider obtaining relevant qualifications or professional certifications to strengthen your application.",
    orderIndex: 51,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:work",
    question: "How many years of relevant work experience do you have?",
    description: "Experience in the field related to your job offer in Ireland.",
    type: "number",
    weight: 10,
    minValue: 0,
    maxValue: 50,
    idealMin: 2,
    idealMax: 50,
    unit: "years",
    failRecommendation: "Limited experience may affect your application. Highlight any relevant skills or training.",
    orderIndex: 52,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:work",
    question: "Is your offered salary at least €32,000 per year?",
    description: "General Employment Permit requires minimum €32,000. Critical Skills requires €64,000 (or €32,000 for certain occupations).",
    helpText: "Higher salaries above €64,000 may qualify you for the more favorable Critical Skills permit.",
    type: "boolean",
    weight: 15,
    correctAnswers: ["true"],
    failRecommendation: "The job offer may not meet minimum salary requirements. Negotiate with employer or seek different opportunities.",
    orderIndex: 53,
    isRequired: true,
    isActive: true,
  },
];

// ============================================
// STUDENT VISA QUESTIONS (category:student)
// ============================================
const studentQuestions: QuestionSeed[] = [
  {
    scope: "category:student",
    question: "Do you have an acceptance letter from an Irish educational institution?",
    description: "The institution must be on the ILEP (Interim List of Eligible Programmes) list.",
    helpText: "Check that your course and institution are on the approved ILEP list before applying.",
    type: "boolean",
    weight: 25,
    correctAnswers: ["true"],
    failRecommendation: "Secure admission to an ILEP-approved course before applying for a student visa.",
    orderIndex: 60,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:student",
    question: "How will you fund your tuition fees?",
    description: "Evidence of payment or ability to pay full tuition for your first year.",
    helpText: "Scholarships and sponsor letters must clearly state the amount covered.",
    type: "single",
    options: [
      "Personal/Family savings",
      "Full scholarship from institution",
      "Partial scholarship + personal funds",
      "Government scholarship/grant",
      "Education loan (with approval letter)",
      "Sponsor (with formal undertaking)",
    ],
    weight: 15,
    correctAnswers: [
      "Personal/Family savings",
      "Full scholarship from institution",
      "Partial scholarship + personal funds",
      "Government scholarship/grant",
      "Education loan (with approval letter)",
      "Sponsor (with formal undertaking)",
    ],
    failRecommendation: "Arrange funding through savings, scholarships, loans, or a financial sponsor before applying.",
    orderIndex: 61,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:student",
    question: "How will you cover living expenses (€10,000/year required)?",
    description: "Ireland requires proof of at least €10,000 per year for living costs, separate from tuition.",
    helpText: "Bank statements should show funds have been available for some time, not just recently deposited.",
    type: "single",
    options: [
      "Personal/Family savings",
      "Scholarship includes living stipend",
      "Sponsor in Ireland",
      "Sponsor in Nigeria",
      "Part savings + part sponsor",
      "Student loan covers living expenses",
    ],
    weight: 15,
    correctAnswers: [
      "Personal/Family savings",
      "Scholarship includes living stipend",
      "Sponsor in Ireland",
      "Sponsor in Nigeria",
      "Part savings + part sponsor",
      "Student loan covers living expenses",
    ],
    failRecommendation: "Ensure you can demonstrate access to at least €10,000 for living expenses through savings, scholarship, or sponsorship.",
    orderIndex: 62,
    isRequired: true,
    isActive: true,
  },
  {
    scope: "category:student",
    question: "Do you have English language proficiency proof (if required)?",
    description: "IELTS, TOEFL, or other accepted English test scores for English-medium courses.",
    helpText: "Requirements vary by institution. Check your specific course requirements.",
    type: "boolean",
    weight: 10,
    correctAnswers: ["true"],
    failRecommendation: "Take an approved English test if required by your institution.",
    orderIndex: 63,
    isRequired: false,
    isActive: true,
  },
];

// ============================================
// VISA EXEMPTION DATA
// ============================================
const visaExemption: Omit<VisaExemption, "id" | "createdAt" | "updatedAt"> = {
  nationality: "NG",
  destinationCountry: "IE",
  requirementType: "visa_required",
  workPermitRequired: true,
  studyPermitRequired: true,
  conditions: [
    "Nigerian citizens require a visa for all visits to Ireland",
    "Apply online through AVATS system",
    "Submit documents at VFS Global centre",
    "Processing typically takes 8-12 weeks",
  ],
  source: "Irish Naturalisation and Immigration Service (INIS)",
  lastVerified: Timestamp.now(),
};

// ============================================
// SEED FUNCTION
// ============================================
export async function seedNigeriaIrelandEligibility(): Promise<{
  questionsSeeded: number;
  exemptionsSeeded: number;
}> {
  const questionsCollection = db.collection("eligibilityQuestions");
  const exemptionsCollection = db.collection("visaExemptions");

  const now = Timestamp.now();

  // Combine all questions
  const allQuestions: QuestionSeed[] = [
    ...commonQuestions,
    ...irelandQuestions,
    ...nigeriaQuestions,
    ...nigeriaToIrelandQuestions,
    ...touristQuestions,
    ...workQuestions,
    ...studentQuestions,
  ];

  // Batch write questions
  const batch = db.batch();
  let questionCount = 0;

  for (const question of allQuestions) {
    const docRef = questionsCollection.doc();
    batch.set(docRef, {
      ...question,
      createdAt: now,
      updatedAt: now,
    });
    questionCount++;
  }

  // Add visa exemption
  const exemptionRef = exemptionsCollection.doc();
  batch.set(exemptionRef, {
    ...visaExemption,
    createdAt: now,
    updatedAt: now,
  });

  await batch.commit();

  return {
    questionsSeeded: questionCount,
    exemptionsSeeded: 1,
  };
}

// Export questions for testing/preview
export const nigeriaIrelandQuestions = {
  common: commonQuestions,
  ireland: irelandQuestions,
  nigeria: nigeriaQuestions,
  nigeriaToIreland: nigeriaToIrelandQuestions,
  tourist: touristQuestions,
  work: workQuestions,
  student: studentQuestions,
};

export const nigeriaIrelandExemption = visaExemption;
