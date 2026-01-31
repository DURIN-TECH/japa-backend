/**
 * Seed data for Irish visas - for testing
 *
 * Structure:
 * - countries/{countryCode} - Country document
 * - countries/{countryCode}/visaTypes/{visaId} - Visa types as subcollection
 * - countries/{countryCode}/visaTypes/{visaId}/requirements/{reqId} - Requirements as subcollection
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";

const db = getFirestore();

export async function seedIrelandVisaData() {
  const now = Timestamp.now();

  // 1. Create Ireland as a country
  const irelandData = {
    code: "IE",
    name: "Ireland",
    flagUrl: "https://flagcdn.com/w320/ie.png",
    isSupported: true,
    visaTypesCount: 1,
    minProcessingDays: 56,
    minCostUsd: 60,
    popularityRank: 5,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("countries").doc("IE").set(irelandData);
  console.log("✅ Created Ireland country");

  // 2. Create Short Stay C Visa (Tourist/Visit) as subcollection under countries/IE
  const visaTypesRef = db.collection("countries").doc("IE").collection("visaTypes");
  const shortStayRef = visaTypesRef.doc(); // Generate ID
  console.log(`[SEED] Writing visa to path: ${shortStayRef.path}`);

  const shortStayVisa = {
    id: shortStayRef.id,
    countryCode: "IE",
    name: "Short Stay 'C' Visa",
    code: "SHORT-STAY-C",
    description: "For visits up to 90 days including tourism, business meetings, conferences, or visiting family/friends.",
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
    applicationInstructions: "Complete your online application through AVATS (Automated Visa Application Tracking System). You will receive a summary sheet to print and submit with your documents.",
    isActive: true,
    agentIds: [],
    createdAt: now,
    updatedAt: now,
  };

  await shortStayRef.set(shortStayVisa);
  console.log(`✅ Created Short Stay C Visa (ID: ${shortStayRef.id})`);

  // 3. Create requirements as subcollection under the visa type
  const requirementsRef = shortStayRef.collection("requirements");

  const requirements = [
    {
      visaTypeId: shortStayRef.id,
      title: "Application Form",
      description: "Complete the online application via AVATS (Automated Visa Application Tracking System)",
      estimatedTime: "30 minutes",
      orderIndex: 1,
      requiredDocuments: [
        {
          id: "app-summary",
          name: "Application Summary Sheet",
          description: "Printed summary from AVATS after completing online application",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: true,
        },
      ],
      isOptional: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      visaTypeId: shortStayRef.id,
      title: "Passport",
      description: "Valid passport with at least 6 months validity beyond your intended stay",
      estimatedTime: "N/A",
      orderIndex: 2,
      requiredDocuments: [
        {
          id: "passport-bio",
          name: "Passport Bio Page",
          description: "Clear copy of the photo/information page of your passport",
          acceptedFormats: ["pdf", "jpg", "png"],
          maxSizeMb: 5,
          isRequired: true,
        },
        {
          id: "passport-stamps",
          name: "Previous Visa Stamps",
          description: "Copies of any previous visa stamps or immigration stamps",
          acceptedFormats: ["pdf", "jpg", "png"],
          maxSizeMb: 10,
          isRequired: false,
        },
      ],
      isOptional: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      visaTypeId: shortStayRef.id,
      title: "Photographs",
      description: "Recent passport-sized photographs meeting Irish visa requirements",
      estimatedTime: "1 day",
      orderIndex: 3,
      requiredDocuments: [
        {
          id: "photo",
          name: "Passport Photo",
          description: "2 recent passport photos (35mm x 45mm, white background)",
          acceptedFormats: ["jpg", "png"],
          maxSizeMb: 2,
          isRequired: true,
        },
      ],
      isOptional: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      visaTypeId: shortStayRef.id,
      title: "Financial Evidence",
      description: "Proof that you can support yourself during your stay",
      estimatedTime: "1-2 weeks",
      orderIndex: 4,
      requiredDocuments: [
        {
          id: "bank-statement",
          name: "Bank Statements",
          description: "6 months of bank statements showing sufficient funds (€60-100/day)",
          acceptedFormats: ["pdf"],
          maxSizeMb: 10,
          isRequired: true,
        },
        {
          id: "employment-letter",
          name: "Employment Letter",
          description: "Letter from employer confirming position, salary, and approved leave",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: false,
        },
        {
          id: "sponsor-letter",
          name: "Sponsor Letter (if applicable)",
          description: "Letter from sponsor taking financial responsibility, with their bank statements",
          acceptedFormats: ["pdf"],
          maxSizeMb: 10,
          isRequired: false,
        },
      ],
      isOptional: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      visaTypeId: shortStayRef.id,
      title: "Travel Itinerary",
      description: "Details of your planned trip to Ireland",
      estimatedTime: "1-2 days",
      orderIndex: 5,
      requiredDocuments: [
        {
          id: "flight-booking",
          name: "Flight Reservation",
          description: "Return flight booking or itinerary",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: true,
        },
        {
          id: "accommodation",
          name: "Accommodation Proof",
          description: "Hotel booking, Airbnb confirmation, or invitation letter from host",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: true,
        },
        {
          id: "travel-insurance",
          name: "Travel Insurance",
          description: "Insurance policy covering medical expenses (€30,000 minimum)",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: false,
        },
      ],
      isOptional: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      visaTypeId: shortStayRef.id,
      title: "Ties to Home Country",
      description: "Evidence that you will return to Nigeria after your visit",
      estimatedTime: "1 week",
      orderIndex: 6,
      requiredDocuments: [
        {
          id: "employment-proof",
          name: "Proof of Employment/Business",
          description: "Employment contract, business registration, or letter from employer",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: true,
        },
        {
          id: "property-docs",
          name: "Property Documents (if applicable)",
          description: "Land/property ownership documents",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: false,
        },
        {
          id: "family-ties",
          name: "Family Ties Evidence",
          description: "Marriage certificate, children's birth certificates, etc.",
          acceptedFormats: ["pdf"],
          maxSizeMb: 5,
          isRequired: false,
        },
      ],
      isOptional: false,
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (const req of requirements) {
    const reqDocRef = requirementsRef.doc();
    await reqDocRef.set({
      id: reqDocRef.id,
      ...req,
    });
  }
  console.log(`✅ Created ${requirements.length} requirements`);

  return {
    countryCreated: true,
    visaId: shortStayRef.id,
    requirementsCreated: requirements.length,
  };
}
