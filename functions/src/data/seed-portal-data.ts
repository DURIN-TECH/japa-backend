/**
 * Seed data for portal integration testing
 *
 * Creates: users, agents, an agency, applications (with timeline, documents, notes),
 * and links everything together so the portal pages render with realistic data.
 *
 * All IDs are deterministic so the seed is idempotent (safe to re-run).
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const db = getFirestore();

// ============================================
// DETERMINISTIC IDS
// ============================================
const IDS = {
  // Users
  admin1User: "seed-user-admin-001",
  admin2User: "seed-user-admin-002",
  ownerUser: "seed-user-owner-001",
  agent1User: "seed-user-agent-001",
  agent2User: "seed-user-agent-002",
  client1User: "seed-user-client-001",
  client2User: "seed-user-client-002",
  client3User: "seed-user-client-003",
  client4User: "seed-user-client-004",
  client5User: "seed-user-client-005",
  client6User: "seed-user-client-006",
  client7User: "seed-user-client-007",
  client8User: "seed-user-client-008",
  client9User: "seed-user-client-009",
  client10User: "seed-user-client-010",

  // Agents
  ownerAgent: "seed-agent-owner-001",
  agent1: "seed-agent-001",
  agent2: "seed-agent-002",

  // Agency
  agency: "seed-agency-001",

  // Applications
  app1: "seed-app-001",
  app2: "seed-app-002",
  app3: "seed-app-003",
  app4: "seed-app-004",
  app5: "seed-app-005",
  app6: "seed-app-006",
  app7: "seed-app-007",
  app8: "seed-app-008",
  app9: "seed-app-009",
  app10: "seed-app-010",

  // Self-service applications (no agent assigned)
  ssApp1: "seed-ss-app-001",
  ssApp2: "seed-ss-app-002",
  ssApp3: "seed-ss-app-003",
  ssApp4: "seed-ss-app-004",
};

// ============================================
// HELPERS
// ============================================
function daysAgo(days: number): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() - days * 86400000));
}

function daysFromNow(days: number): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() + days * 86400000));
}

// ============================================
// AUTH USERS (Firebase Auth accounts for login)
// ============================================

const AUTH_USERS = [
  { uid: IDS.admin1User, email: "admin@japatest.com", displayName: "Olu Adeyemi" },
  { uid: IDS.admin2User, email: "admin2@japatest.com", displayName: "Ngozi Ibe" },
  { uid: IDS.ownerUser, email: "owner@japatest.com", displayName: "Adaeze Okonkwo" },
  { uid: IDS.agent1User, email: "agent1@japatest.com", displayName: "Chinedu Eze" },
  { uid: IDS.agent2User, email: "agent2@japatest.com", displayName: "Fatima Bello" },
  { uid: IDS.client1User, email: "john.doe@example.com", displayName: "John Doe" },
  { uid: IDS.client2User, email: "jane.smith@example.com", displayName: "Jane Smith" },
  { uid: IDS.client3User, email: "ahmed.ali@example.com", displayName: "Ahmed Ali" },
  { uid: IDS.client4User, email: "lisa.wong@example.com", displayName: "Lisa Wong" },
  { uid: IDS.client5User, email: "tunde.bakare@example.com", displayName: "Tunde Bakare" },
  { uid: IDS.client6User, email: "kwame.asante@example.com", displayName: "Kwame Asante" },
  { uid: IDS.client7User, email: "wanjiku.mwangi@example.com", displayName: "Wanjiku Mwangi" },
  { uid: IDS.client8User, email: "sipho.ndlovu@example.com", displayName: "Sipho Ndlovu" },
  { uid: IDS.client9User, email: "priya.sharma@example.com", displayName: "Priya Sharma" },
  { uid: IDS.client10User, email: "miguel.santos@example.com", displayName: "Miguel Santos" },
];

const SEED_PASSWORD = "password123";

async function seedAuthUsers(): Promise<number> {
  const auth = getAuth();
  let created = 0;

  for (const user of AUTH_USERS) {
    try {
      // Try to get existing user first (idempotent)
      await auth.getUser(user.uid);
    } catch {
      // User doesn't exist, create it
      await auth.createUser({
        uid: user.uid,
        email: user.email,
        password: SEED_PASSWORD,
        displayName: user.displayName,
        emailVerified: true,
      });
      created++;
    }
  }

  console.log(`✅ Seeded ${AUTH_USERS.length} auth users (${created} new, ${AUTH_USERS.length - created} existing)`);
  return AUTH_USERS.length;
}

// ============================================
// SEED FUNCTIONS
// ============================================

async function seedUsers() {
  const now = Timestamp.now();

  const users = [
    {
      id: IDS.admin1User,
      email: "admin@japatest.com",
      firstName: "Olu",
      lastName: "Adeyemi",
      phone: "+2348001111111",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(120),
      hasPassport: true,
      passportCountry: "NG",
      admin: true,
      createdAt: daysAgo(120),
      updatedAt: now,
    },
    {
      id: IDS.admin2User,
      email: "admin2@japatest.com",
      firstName: "Ngozi",
      lastName: "Ibe",
      phone: "+2348002222222",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(100),
      hasPassport: true,
      passportCountry: "NG",
      admin: true,
      createdAt: daysAgo(100),
      updatedAt: now,
    },
    {
      id: IDS.ownerUser,
      email: "owner@japatest.com",
      firstName: "Adaeze",
      lastName: "Okonkwo",
      phone: "+2348012345678",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(90),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(90),
      updatedAt: now,
    },
    {
      id: IDS.agent1User,
      email: "agent1@japatest.com",
      firstName: "Chinedu",
      lastName: "Eze",
      phone: "+2348023456789",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(60),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(60),
      updatedAt: now,
    },
    {
      id: IDS.agent2User,
      email: "agent2@japatest.com",
      firstName: "Fatima",
      lastName: "Bello",
      phone: "+2348034567890",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(30),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(30),
      updatedAt: now,
    },
    {
      id: IDS.client1User,
      email: "john.doe@example.com",
      firstName: "John",
      lastName: "Doe",
      phone: "+2348045678901",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(45),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(45),
      updatedAt: now,
    },
    {
      id: IDS.client2User,
      email: "jane.smith@example.com",
      firstName: "Jane",
      lastName: "Smith",
      phone: "+2348056789012",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(40),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(40),
      updatedAt: now,
    },
    {
      id: IDS.client3User,
      email: "ahmed.ali@example.com",
      firstName: "Ahmed",
      lastName: "Ali",
      phone: "+2348067890123",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(35),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(35),
      updatedAt: now,
    },
    {
      id: IDS.client4User,
      email: "lisa.wong@example.com",
      firstName: "Lisa",
      lastName: "Wong",
      phone: "+2348078901234",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(20),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(20),
      updatedAt: now,
    },
    {
      id: IDS.client5User,
      email: "tunde.bakare@example.com",
      firstName: "Tunde",
      lastName: "Bakare",
      phone: "+2348089012345",
      residentialCountry: "NG",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(10),
      hasPassport: true,
      passportCountry: "NG",
      createdAt: daysAgo(10),
      updatedAt: now,
    },
    {
      id: IDS.client6User,
      email: "kwame.asante@example.com",
      firstName: "Kwame",
      lastName: "Asante",
      phone: "+233201234567",
      residentialCountry: "GH",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(25),
      hasPassport: true,
      passportCountry: "GH",
      address: {
        street: "14 Independence Avenue",
        city: "Accra",
        state: "Greater Accra",
        postalCode: "GA-100",
        country: "GH",
      },
      createdAt: daysAgo(25),
      updatedAt: now,
    },
    {
      id: IDS.client7User,
      email: "wanjiku.mwangi@example.com",
      firstName: "Wanjiku",
      lastName: "Mwangi",
      phone: "+254712345678",
      residentialCountry: "KE",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(42),
      hasPassport: true,
      passportCountry: "KE",
      createdAt: daysAgo(42),
      updatedAt: now,
    },
    {
      id: IDS.client8User,
      email: "sipho.ndlovu@example.com",
      firstName: "Sipho",
      lastName: "Ndlovu",
      phone: "+27821234567",
      residentialCountry: "ZA",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(38),
      hasPassport: true,
      passportCountry: "ZA",
      address: {
        street: "23 Nelson Mandela Drive",
        city: "Johannesburg",
        state: "Gauteng",
        postalCode: "2001",
        country: "ZA",
      },
      createdAt: daysAgo(38),
      updatedAt: now,
    },
    {
      id: IDS.client9User,
      email: "priya.sharma@example.com",
      firstName: "Priya",
      lastName: "Sharma",
      phone: "+919876543210",
      residentialCountry: "IN",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(55),
      hasPassport: true,
      passportCountry: "IN",
      createdAt: daysAgo(55),
      updatedAt: now,
    },
    {
      id: IDS.client10User,
      email: "miguel.santos@example.com",
      firstName: "Miguel",
      lastName: "Santos",
      phone: "+639171234567",
      residentialCountry: "PH",
      onboardingCompleted: true,
      onboardingCompletedAt: daysAgo(100),
      hasPassport: true,
      passportCountry: "PH",
      createdAt: daysAgo(100),
      updatedAt: now,
    },
  ];

  const batch = db.batch();
  for (const user of users) {
    batch.set(db.collection("users").doc(user.id), user);
  }
  await batch.commit();
  console.log(`✅ Seeded ${users.length} users`);
  return users.length;
}

async function seedAgency() {
  const now = Timestamp.now();

  const agency = {
    id: IDS.agency,
    name: "Japa Immigration Services",
    ownerId: IDS.ownerUser,
    ownerName: "Adaeze Okonkwo",
    address: "12 Victoria Island, Lagos",
    state: "Lagos",
    description:
      "Premier immigration consulting agency specializing in Irish, UK, and Canadian visas for Nigerian applicants.",
    consultationFee: 5000_00, // ₦50,000 in cents
    services: [
      { id: "svc-1", name: "Visa Application Processing", price: 15000_00 },
      { id: "svc-2", name: "Document Review & Verification", price: 5000_00 },
      { id: "svc-3", name: "Interview Preparation", price: 8000_00 },
      { id: "svc-4", name: "Embassy Submission Support", price: 10000_00 },
    ],
    totalAgents: 2,
    totalCases: 10,
    activeCases: 5,
    createdAt: daysAgo(90),
    updatedAt: now,
  };

  await db.collection("agencies").doc(IDS.agency).set(agency);
  console.log("✅ Seeded agency");
  return 1;
}

async function seedAgents() {
  const now = Timestamp.now();

  const agents = [
    {
      id: IDS.ownerAgent,
      userId: IDS.ownerUser,
      agencyId: IDS.agency,
      agencyRole: "owner",
      displayName: "Adaeze Okonkwo",
      bio: "Senior immigration consultant with 10+ years experience in Irish and UK visa applications.",
      yearsOfExperience: 10,
      specializations: ["Study Visa", "Work Permit", "Permanent Residency"],
      languages: ["English", "Igbo", "Yoruba"],
      featuredVisas: [],
      verificationStatus: "verified",
      verifiedAt: daysAgo(85),
      rating: 4.8,
      totalReviews: 42,
      totalApplications: 156,
      successRate: 92,
      responseTime: "2-4 hours",
      consultationFee: 5000_00,
      serviceFees: {},
      isAvailable: true,
      availableSlots: [
        { dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
        { dayOfWeek: 2, startTime: "09:00", endTime: "17:00" },
        { dayOfWeek: 3, startTime: "09:00", endTime: "17:00" },
        { dayOfWeek: 4, startTime: "09:00", endTime: "17:00" },
        { dayOfWeek: 5, startTime: "09:00", endTime: "14:00" },
      ],
      createdAt: daysAgo(90),
      updatedAt: now,
    },
    {
      id: IDS.agent1,
      userId: IDS.agent1User,
      agencyId: IDS.agency,
      agencyRole: "agent",
      displayName: "Chinedu Eze",
      bio: "Immigration specialist focused on student visas and work permits for Ireland and Canada.",
      yearsOfExperience: 5,
      specializations: ["Study Visa", "Work Permit"],
      languages: ["English", "Igbo"],
      featuredVisas: [],
      verificationStatus: "verified",
      verifiedAt: daysAgo(55),
      rating: 4.5,
      totalReviews: 18,
      totalApplications: 63,
      successRate: 87,
      responseTime: "4-8 hours",
      consultationFee: 3000_00,
      serviceFees: {},
      isAvailable: true,
      availableSlots: [
        { dayOfWeek: 1, startTime: "10:00", endTime: "18:00" },
        { dayOfWeek: 2, startTime: "10:00", endTime: "18:00" },
        { dayOfWeek: 3, startTime: "10:00", endTime: "18:00" },
        { dayOfWeek: 4, startTime: "10:00", endTime: "18:00" },
        { dayOfWeek: 5, startTime: "10:00", endTime: "16:00" },
      ],
      createdAt: daysAgo(60),
      updatedAt: now,
    },
    {
      id: IDS.agent2,
      userId: IDS.agent2User,
      agencyId: IDS.agency,
      agencyRole: "agent",
      displayName: "Fatima Bello",
      bio: "Experienced visa consultant specializing in family reunion and tourist visas.",
      yearsOfExperience: 3,
      specializations: ["Tourist Visa", "Family Visa"],
      languages: ["English", "Hausa", "Arabic"],
      featuredVisas: [],
      verificationStatus: "verified",
      verifiedAt: daysAgo(25),
      rating: 4.3,
      totalReviews: 9,
      totalApplications: 28,
      successRate: 85,
      responseTime: "6-12 hours",
      consultationFee: 2500_00,
      serviceFees: {},
      isAvailable: true,
      availableSlots: [
        { dayOfWeek: 1, startTime: "09:00", endTime: "15:00" },
        { dayOfWeek: 2, startTime: "09:00", endTime: "15:00" },
        { dayOfWeek: 3, startTime: "09:00", endTime: "15:00" },
        { dayOfWeek: 4, startTime: "09:00", endTime: "15:00" },
      ],
      createdAt: daysAgo(30),
      updatedAt: now,
    },
  ];

  const batch = db.batch();
  for (const agent of agents) {
    batch.set(db.collection("agents").doc(agent.id), agent);
  }
  await batch.commit();
  console.log(`✅ Seeded ${agents.length} agents`);
  return agents.length;
}

async function seedApplications() {
  const applications = [
    {
      id: IDS.app1,
      userId: IDS.client1User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      status: "under_review",
      progress: 65,
      currentStep: "Document verification",
      nextStep: "Embassy submission",
      startDate: daysAgo(30),
      lastUpdated: daysAgo(1),
      documentsRequired: 6,
      documentsUploaded: 5,
      documentsVerified: 4,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 15000_00,
      paymentStatus: "partial",
      clientName: "John Doe",
      clientEmail: "john.doe@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      agentNotes: "Client documents mostly in order. Awaiting updated bank statement.",
      createdAt: daysAgo(30),
      updatedAt: daysAgo(1),
    },
    {
      id: IDS.app2,
      userId: IDS.client2User,
      visaTypeId: "work-permit-general",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      status: "pending_documents",
      progress: 35,
      currentStep: "Gathering documents",
      nextStep: "Document review",
      startDate: daysAgo(14),
      lastUpdated: daysAgo(2),
      documentsRequired: 8,
      documentsUploaded: 3,
      documentsVerified: 2,
      documentsRejected: 1,
      totalCost: 35000_00,
      amountPaid: 35000_00,
      paymentStatus: "paid",
      clientName: "Jane Smith",
      clientEmail: "jane.smith@example.com",
      visaTypeName: "General Employment Permit",
      countryName: "Ireland",
      userNotes: "My employer will send the contract by next week.",
      createdAt: daysAgo(14),
      updatedAt: daysAgo(2),
    },
    {
      id: IDS.app3,
      userId: IDS.client3User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent2User,
      agencyId: IDS.agency,
      status: "approved",
      progress: 100,
      currentStep: "Completed",
      startDate: daysAgo(60),
      lastUpdated: daysAgo(5),
      submittedAt: daysAgo(40),
      completedAt: daysAgo(5),
      documentsRequired: 6,
      documentsUploaded: 6,
      documentsVerified: 6,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 25000_00,
      paymentStatus: "paid",
      clientName: "Ahmed Ali",
      clientEmail: "ahmed.ali@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      createdAt: daysAgo(60),
      updatedAt: daysAgo(5),
    },
    {
      id: IDS.app4,
      userId: IDS.client4User,
      visaTypeId: "study-visa",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      status: "rejected",
      progress: 80,
      currentStep: "Application rejected",
      startDate: daysAgo(50),
      lastUpdated: daysAgo(10),
      submittedAt: daysAgo(30),
      completedAt: daysAgo(10),
      documentsRequired: 7,
      documentsUploaded: 7,
      documentsVerified: 5,
      documentsRejected: 2,
      totalCost: 30000_00,
      amountPaid: 30000_00,
      paymentStatus: "paid",
      rejectionReason: "Insufficient proof of funds and weak ties to home country.",
      clientName: "Lisa Wong",
      clientEmail: "lisa.wong@example.com",
      visaTypeName: "Student Visa (D)",
      countryName: "Ireland",
      createdAt: daysAgo(50),
      updatedAt: daysAgo(10),
    },
    {
      id: IDS.app5,
      userId: IDS.client5User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      status: "pending_payment",
      progress: 10,
      currentStep: "Awaiting payment",
      nextStep: "Document collection",
      startDate: daysAgo(3),
      lastUpdated: daysAgo(1),
      documentsRequired: 6,
      documentsUploaded: 0,
      documentsVerified: 0,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 0,
      paymentStatus: "pending",
      clientName: "Tunde Bakare",
      clientEmail: "tunde.bakare@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      createdAt: daysAgo(3),
      updatedAt: daysAgo(1),
    },
    {
      id: IDS.app6,
      userId: IDS.client6User,
      visaTypeId: "study-visa",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      status: "draft",
      progress: 5,
      currentStep: "Application started",
      nextStep: "Complete personal details",
      startDate: daysAgo(2),
      lastUpdated: daysAgo(1),
      documentsRequired: 7,
      documentsUploaded: 0,
      documentsVerified: 0,
      documentsRejected: 0,
      totalCost: 30000_00,
      amountPaid: 0,
      paymentStatus: "pending",
      clientName: "Kwame Asante",
      clientEmail: "kwame.asante@example.com",
      visaTypeName: "Student Visa (D)",
      countryName: "Ireland",
      userNotes: "Planning to study MSc Computer Science at Trinity College Dublin.",
      createdAt: daysAgo(2),
      updatedAt: daysAgo(1),
    },
    {
      id: IDS.app7,
      userId: IDS.client7User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent2User,
      agencyId: IDS.agency,
      status: "submitted_to_embassy",
      progress: 80,
      currentStep: "Awaiting embassy decision",
      startDate: daysAgo(45),
      lastUpdated: daysAgo(3),
      submittedAt: daysAgo(7),
      documentsRequired: 6,
      documentsUploaded: 6,
      documentsVerified: 6,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 25000_00,
      paymentStatus: "paid",
      clientName: "Wanjiku Mwangi",
      clientEmail: "wanjiku.mwangi@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      agentNotes: "Strong application — well-documented travel history to UK and Schengen.",
      createdAt: daysAgo(45),
      updatedAt: daysAgo(3),
    },
    {
      id: IDS.app8,
      userId: IDS.client8User,
      visaTypeId: "work-permit-general",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      status: "interview_scheduled",
      progress: 75,
      currentStep: "Interview preparation",
      nextStep: "Attend embassy interview",
      startDate: daysAgo(40),
      lastUpdated: daysAgo(2),
      submittedAt: daysAgo(15),
      interviewDate: daysFromNow(5),
      documentsRequired: 8,
      documentsUploaded: 7,
      documentsVerified: 6,
      documentsRejected: 0,
      totalCost: 35000_00,
      amountPaid: 35000_00,
      paymentStatus: "paid",
      clientName: "Sipho Ndlovu",
      clientEmail: "sipho.ndlovu@example.com",
      visaTypeName: "General Employment Permit",
      countryName: "Ireland",
      agentNotes: "Interview scheduled for next week. Client is well-prepared.",
      createdAt: daysAgo(40),
      updatedAt: daysAgo(2),
    },
    {
      id: IDS.app9,
      userId: IDS.client9User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent2User,
      agencyId: IDS.agency,
      status: "withdrawn",
      progress: 40,
      currentStep: "Application withdrawn",
      startDate: daysAgo(70),
      lastUpdated: daysAgo(20),
      completedAt: daysAgo(20),
      documentsRequired: 6,
      documentsUploaded: 3,
      documentsVerified: 2,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 15000_00,
      paymentStatus: "partial",
      clientName: "Priya Sharma",
      clientEmail: "priya.sharma@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      userNotes: "Travel plans changed, no longer need visa for this period.",
      createdAt: daysAgo(70),
      updatedAt: daysAgo(20),
    },
    {
      id: IDS.app10,
      userId: IDS.client10User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "agent",
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      status: "expired",
      progress: 50,
      currentStep: "Application expired",
      startDate: daysAgo(180),
      lastUpdated: daysAgo(90),
      completedAt: daysAgo(90),
      documentsRequired: 6,
      documentsUploaded: 4,
      documentsVerified: 3,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 25000_00,
      paymentStatus: "paid",
      clientName: "Miguel Santos",
      clientEmail: "miguel.santos@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      agentNotes: "Client became unresponsive. Missing documents never provided. Application expired after 90 days.",
      createdAt: daysAgo(180),
      updatedAt: daysAgo(90),
    },

    // ============================================
    // SELF-SERVICE APPLICATIONS (mode: "self", no agent)
    // ============================================
    {
      id: IDS.ssApp1,
      userId: IDS.client6User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "self",
      status: "pending_documents",
      progress: 40,
      currentStep: "Uploading documents",
      nextStep: "Document review",
      startDate: daysAgo(10),
      lastUpdated: daysAgo(1),
      documentsRequired: 6,
      documentsUploaded: 3,
      documentsVerified: 0,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 0,
      paymentStatus: "pending",
      clientName: "Kwame Asante",
      clientEmail: "kwame.asante@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      createdAt: daysAgo(10),
      updatedAt: daysAgo(1),
    },
    {
      id: IDS.ssApp2,
      userId: IDS.client7User,
      visaTypeId: "work-permit-general",
      countryCode: "IE",
      mode: "self",
      status: "draft",
      progress: 15,
      currentStep: "Filling personal info",
      startDate: daysAgo(5),
      lastUpdated: daysAgo(2),
      documentsRequired: 8,
      documentsUploaded: 0,
      documentsVerified: 0,
      documentsRejected: 0,
      totalCost: 35000_00,
      amountPaid: 0,
      paymentStatus: "pending",
      clientName: "Wanjiku Mwangi",
      clientEmail: "wanjiku.mwangi@example.com",
      visaTypeName: "Work Permit (General)",
      countryName: "Ireland",
      createdAt: daysAgo(5),
      updatedAt: daysAgo(2),
    },
    {
      id: IDS.ssApp3,
      userId: IDS.client8User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "self",
      status: "draft",
      progress: 10,
      currentStep: "Filling personal info",
      startDate: daysAgo(25),
      lastUpdated: daysAgo(20),
      documentsRequired: 6,
      documentsUploaded: 0,
      documentsVerified: 0,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 0,
      paymentStatus: "pending",
      clientName: "Sipho Ndlovu",
      clientEmail: "sipho.ndlovu@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      userNotes: "Started but got busy with work",
      createdAt: daysAgo(25),
      updatedAt: daysAgo(20),
    },
    {
      id: IDS.ssApp4,
      userId: IDS.client9User,
      visaTypeId: "short-stay-c",
      countryCode: "IE",
      mode: "self",
      status: "approved",
      progress: 100,
      currentStep: "Visa approved",
      startDate: daysAgo(60),
      lastUpdated: daysAgo(5),
      completedAt: daysAgo(5),
      documentsRequired: 6,
      documentsUploaded: 6,
      documentsVerified: 6,
      documentsRejected: 0,
      totalCost: 25000_00,
      amountPaid: 25000_00,
      paymentStatus: "paid",
      clientName: "Priya Sharma",
      clientEmail: "priya.sharma@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      countryName: "Ireland",
      createdAt: daysAgo(60),
      updatedAt: daysAgo(5),
    },
  ];

  const batch = db.batch();
  for (const app of applications) {
    batch.set(db.collection("applications").doc(app.id), app);
  }
  await batch.commit();
  console.log(`✅ Seeded ${applications.length} applications`);
  return applications.length;
}

async function seedTimelines() {
  const now = Timestamp.now();

  // Timeline entries for app1 (under_review — most interesting to view)
  const app1Timeline = [
    {
      applicationId: IDS.app1,
      title: "Application created",
      description: "Client started a Short Stay 'C' Visa application for Ireland.",
      status: "completed",
      date: daysAgo(30),
      completedAt: daysAgo(30),
      responsibility: "system",
      createdAt: daysAgo(30),
    },
    {
      applicationId: IDS.app1,
      title: "Payment received",
      description: "Initial payment of ₦150,000 received. Remaining balance: ₦100,000.",
      status: "completed",
      date: daysAgo(28),
      completedAt: daysAgo(28),
      responsibility: "user",
      createdAt: daysAgo(28),
    },
    {
      applicationId: IDS.app1,
      title: "Document collection started",
      description: "Agent began collecting required documents from client.",
      status: "completed",
      date: daysAgo(25),
      completedAt: daysAgo(25),
      responsibility: "agent",
      createdAt: daysAgo(25),
    },
    {
      applicationId: IDS.app1,
      title: "Passport copy uploaded",
      description: "Client uploaded passport bio page and previous stamps.",
      status: "completed",
      date: daysAgo(22),
      completedAt: daysAgo(22),
      responsibility: "user",
      createdAt: daysAgo(22),
    },
    {
      applicationId: IDS.app1,
      title: "Financial documents uploaded",
      description: "Bank statements and employment letter submitted for review.",
      status: "completed",
      date: daysAgo(18),
      completedAt: daysAgo(18),
      responsibility: "user",
      createdAt: daysAgo(18),
    },
    {
      applicationId: IDS.app1,
      title: "Document review in progress",
      description: "Agent is reviewing all submitted documents for completeness and accuracy.",
      status: "current",
      date: daysAgo(5),
      responsibility: "agent",
      createdAt: daysAgo(5),
    },
    {
      applicationId: IDS.app1,
      title: "Submit to embassy",
      description: "Submit completed application package to the Irish embassy via VFS Global.",
      status: "upcoming",
      date: daysFromNow(7),
      responsibility: "agent",
      createdAt: now,
    },
    {
      applicationId: IDS.app1,
      title: "Embassy decision",
      description: "Await visa decision from the Irish Naturalisation and Immigration Service.",
      status: "upcoming",
      date: daysFromNow(60),
      responsibility: "embassy",
      createdAt: now,
    },
  ];

  // Timeline for app3 (approved — complete journey)
  const app3Timeline = [
    {
      applicationId: IDS.app3,
      title: "Application created",
      description: "Client started a Short Stay 'C' Visa application for Ireland.",
      status: "completed",
      date: daysAgo(60),
      completedAt: daysAgo(60),
      responsibility: "system",
      createdAt: daysAgo(60),
    },
    {
      applicationId: IDS.app3,
      title: "Full payment received",
      description: "Payment of ₦250,000 received in full.",
      status: "completed",
      date: daysAgo(58),
      completedAt: daysAgo(58),
      responsibility: "user",
      createdAt: daysAgo(58),
    },
    {
      applicationId: IDS.app3,
      title: "All documents collected",
      description: "All 6 required documents uploaded and verified.",
      status: "completed",
      date: daysAgo(45),
      completedAt: daysAgo(45),
      responsibility: "user",
      createdAt: daysAgo(45),
    },
    {
      applicationId: IDS.app3,
      title: "Submitted to embassy",
      description: "Application package submitted to the Irish embassy via VFS Global Lagos.",
      status: "completed",
      date: daysAgo(40),
      completedAt: daysAgo(40),
      responsibility: "agent",
      createdAt: daysAgo(40),
    },
    {
      applicationId: IDS.app3,
      title: "Visa approved",
      description: "Short Stay 'C' Visa approved. Valid for 90 days.",
      status: "completed",
      date: daysAgo(5),
      completedAt: daysAgo(5),
      responsibility: "embassy",
      createdAt: daysAgo(5),
    },
  ];

  // Timeline for app2 (pending_documents — early stage)
  const app2Timeline = [
    {
      applicationId: IDS.app2,
      title: "Application created",
      description: "Client started a General Employment Permit application for Ireland.",
      status: "completed",
      date: daysAgo(14),
      completedAt: daysAgo(14),
      responsibility: "system",
      createdAt: daysAgo(14),
    },
    {
      applicationId: IDS.app2,
      title: "Full payment received",
      description: "Payment of ₦350,000 received in full.",
      status: "completed",
      date: daysAgo(13),
      completedAt: daysAgo(13),
      responsibility: "user",
      createdAt: daysAgo(13),
    },
    {
      applicationId: IDS.app2,
      title: "Document collection in progress",
      description: "Collecting employment contract, qualifications, and supporting documents.",
      status: "current",
      date: daysAgo(10),
      responsibility: "user",
      createdAt: daysAgo(10),
    },
  ];

  // Timeline for app4 (rejected — full journey to rejection)
  const app4Timeline = [
    {
      applicationId: IDS.app4,
      title: "Application created",
      description: "Client started a Student Visa (D) application for Ireland.",
      status: "completed",
      date: daysAgo(50),
      completedAt: daysAgo(50),
      responsibility: "system",
      createdAt: daysAgo(50),
    },
    {
      applicationId: IDS.app4,
      title: "Full payment received",
      description: "Payment of ₦300,000 received in full.",
      status: "completed",
      date: daysAgo(48),
      completedAt: daysAgo(48),
      responsibility: "user",
      createdAt: daysAgo(48),
    },
    {
      applicationId: IDS.app4,
      title: "All documents collected",
      description: "All 7 required documents uploaded.",
      status: "completed",
      date: daysAgo(35),
      completedAt: daysAgo(35),
      responsibility: "user",
      createdAt: daysAgo(35),
    },
    {
      applicationId: IDS.app4,
      title: "Submitted to embassy",
      description: "Application submitted to Irish embassy via VFS Global.",
      status: "completed",
      date: daysAgo(30),
      completedAt: daysAgo(30),
      responsibility: "agent",
      createdAt: daysAgo(30),
    },
    {
      applicationId: IDS.app4,
      title: "Visa rejected",
      description: "Application rejected: insufficient proof of funds and weak ties to home country.",
      status: "completed",
      date: daysAgo(10),
      completedAt: daysAgo(10),
      responsibility: "embassy",
      createdAt: daysAgo(10),
    },
  ];

  // Timeline for app5 (pending_payment — just created)
  const app5Timeline = [
    {
      applicationId: IDS.app5,
      title: "Application created",
      description: "Client started a Short Stay 'C' Visa application for Ireland. Awaiting payment.",
      status: "completed",
      date: daysAgo(3),
      completedAt: daysAgo(3),
      responsibility: "system",
      createdAt: daysAgo(3),
    },
  ];

  // Timeline for app7 (submitted_to_embassy)
  const app7Timeline = [
    {
      applicationId: IDS.app7,
      title: "Application created",
      description: "Client started a Short Stay 'C' Visa application for Ireland.",
      status: "completed",
      date: daysAgo(45),
      completedAt: daysAgo(45),
      responsibility: "system",
      createdAt: daysAgo(45),
    },
    {
      applicationId: IDS.app7,
      title: "Full payment received",
      description: "Payment of ₦250,000 received in full.",
      status: "completed",
      date: daysAgo(43),
      completedAt: daysAgo(43),
      responsibility: "user",
      createdAt: daysAgo(43),
    },
    {
      applicationId: IDS.app7,
      title: "All documents collected and verified",
      description: "All 6 required documents uploaded and verified by agent.",
      status: "completed",
      date: daysAgo(20),
      completedAt: daysAgo(20),
      responsibility: "user",
      createdAt: daysAgo(20),
    },
    {
      applicationId: IDS.app7,
      title: "Submitted to embassy",
      description: "Complete application package submitted to Irish embassy via VFS Global Nairobi.",
      status: "completed",
      date: daysAgo(7),
      completedAt: daysAgo(7),
      responsibility: "agent",
      createdAt: daysAgo(7),
    },
    {
      applicationId: IDS.app7,
      title: "Embassy decision",
      description: "Awaiting visa decision from the Irish Naturalisation and Immigration Service.",
      status: "current",
      date: daysAgo(3),
      responsibility: "embassy",
      createdAt: daysAgo(3),
    },
  ];

  // Timeline for app8 (interview_scheduled)
  const app8Timeline = [
    {
      applicationId: IDS.app8,
      title: "Application created",
      description: "Client started a General Employment Permit application for Ireland.",
      status: "completed",
      date: daysAgo(40),
      completedAt: daysAgo(40),
      responsibility: "system",
      createdAt: daysAgo(40),
    },
    {
      applicationId: IDS.app8,
      title: "Full payment received",
      description: "Payment of ₦350,000 received in full.",
      status: "completed",
      date: daysAgo(38),
      completedAt: daysAgo(38),
      responsibility: "user",
      createdAt: daysAgo(38),
    },
    {
      applicationId: IDS.app8,
      title: "Documents collected",
      description: "Employment contract, qualifications, and supporting documents uploaded.",
      status: "completed",
      date: daysAgo(25),
      completedAt: daysAgo(25),
      responsibility: "user",
      createdAt: daysAgo(25),
    },
    {
      applicationId: IDS.app8,
      title: "Submitted to embassy",
      description: "Application submitted to Irish embassy via VFS Global Pretoria.",
      status: "completed",
      date: daysAgo(15),
      completedAt: daysAgo(15),
      responsibility: "agent",
      createdAt: daysAgo(15),
    },
    {
      applicationId: IDS.app8,
      title: "Interview scheduled",
      description: "Embassy has scheduled an in-person interview at the Dublin consulate.",
      status: "current",
      date: daysAgo(5),
      responsibility: "embassy",
      createdAt: daysAgo(5),
    },
    {
      applicationId: IDS.app8,
      title: "Attend embassy interview",
      description: "Client to attend interview. Agent has provided preparation materials.",
      status: "upcoming",
      date: daysFromNow(5),
      responsibility: "user",
      createdAt: now,
    },
  ];

  const allTimelines = [
    ...app1Timeline,
    ...app2Timeline,
    ...app3Timeline,
    ...app4Timeline,
    ...app5Timeline,
    ...app7Timeline,
    ...app8Timeline,
  ];

  const batch = db.batch();
  for (const entry of allTimelines) {
    const ref = db
      .collection("applications")
      .doc(entry.applicationId)
      .collection("timeline")
      .doc();
    batch.set(ref, { id: ref.id, ...entry });
  }
  await batch.commit();
  console.log(`✅ Seeded ${allTimelines.length} timeline entries`);
  return allTimelines.length;
}

async function seedDocuments() {
  // Documents for app1 (under_review — 5 uploaded, 4 verified)
  const app1Docs = [
    {
      applicationId: IDS.app1,
      requirementId: "req-passport",
      userId: IDS.client1User,
      fileName: "passport_bio_page.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.2,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-001/passport.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(20),
      resubmissionCount: 0,
      uploadedAt: daysAgo(22),
      updatedAt: daysAgo(20),
    },
    {
      applicationId: IDS.app1,
      requirementId: "req-photo",
      userId: IDS.client1User,
      fileName: "passport_photo.jpg",
      fileType: "image/jpeg",
      fileSizeMb: 0.8,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-001/photo.jpg",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(20),
      resubmissionCount: 0,
      uploadedAt: daysAgo(22),
      updatedAt: daysAgo(20),
    },
    {
      applicationId: IDS.app1,
      requirementId: "req-bank-statement",
      userId: IDS.client1User,
      fileName: "bank_statement_6months.pdf",
      fileType: "application/pdf",
      fileSizeMb: 3.4,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-001/bank.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(15),
      resubmissionCount: 0,
      uploadedAt: daysAgo(18),
      updatedAt: daysAgo(15),
    },
    {
      applicationId: IDS.app1,
      requirementId: "req-employment",
      userId: IDS.client1User,
      fileName: "employment_letter.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.5,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-001/employment.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(15),
      resubmissionCount: 0,
      uploadedAt: daysAgo(18),
      updatedAt: daysAgo(15),
    },
    {
      applicationId: IDS.app1,
      requirementId: "req-flight",
      userId: IDS.client1User,
      fileName: "flight_reservation.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.3,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-001/flight.pdf",
      status: "under_review",
      resubmissionCount: 0,
      uploadedAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
  ];

  // Documents for app2 (pending_documents — 3 uploaded, 1 rejected)
  const app2Docs = [
    {
      applicationId: IDS.app2,
      requirementId: "req-passport",
      userId: IDS.client2User,
      fileName: "passport_scan.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.5,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-002/passport.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(10),
      resubmissionCount: 0,
      uploadedAt: daysAgo(12),
      updatedAt: daysAgo(10),
    },
    {
      applicationId: IDS.app2,
      requirementId: "req-job-offer",
      userId: IDS.client2User,
      fileName: "job_offer_letter.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.7,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-002/job_offer.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(8),
      resubmissionCount: 0,
      uploadedAt: daysAgo(10),
      updatedAt: daysAgo(8),
    },
    {
      applicationId: IDS.app2,
      requirementId: "req-qualifications",
      userId: IDS.client2User,
      fileName: "degree_certificate.pdf",
      fileType: "application/pdf",
      fileSizeMb: 2.1,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-002/degree.pdf",
      status: "rejected",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(7),
      rejectionReason: "Document is blurry and text is not legible. Please upload a clearer scan.",
      resubmissionCount: 0,
      uploadedAt: daysAgo(10),
      updatedAt: daysAgo(7),
    },
  ];

  // Documents for app3 (approved — all 6 verified)
  const app3Docs = [
    {
      applicationId: IDS.app3,
      requirementId: "req-passport",
      userId: IDS.client3User,
      fileName: "passport_ahmed_ali.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.3,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-003/passport.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(50),
      resubmissionCount: 0,
      uploadedAt: daysAgo(52),
      updatedAt: daysAgo(50),
    },
    {
      applicationId: IDS.app3,
      requirementId: "req-photo",
      userId: IDS.client3User,
      fileName: "passport_photo.jpg",
      fileType: "image/jpeg",
      fileSizeMb: 0.6,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-003/photo.jpg",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(50),
      resubmissionCount: 0,
      uploadedAt: daysAgo(52),
      updatedAt: daysAgo(50),
    },
    {
      applicationId: IDS.app3,
      requirementId: "req-bank-statement",
      userId: IDS.client3User,
      fileName: "bank_statement.pdf",
      fileType: "application/pdf",
      fileSizeMb: 2.8,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-003/bank.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(48),
      resubmissionCount: 0,
      uploadedAt: daysAgo(50),
      updatedAt: daysAgo(48),
    },
    {
      applicationId: IDS.app3,
      requirementId: "req-employment",
      userId: IDS.client3User,
      fileName: "employment_letter.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.4,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-003/employment.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(48),
      resubmissionCount: 0,
      uploadedAt: daysAgo(50),
      updatedAt: daysAgo(48),
    },
    {
      applicationId: IDS.app3,
      requirementId: "req-flight",
      userId: IDS.client3User,
      fileName: "flight_booking.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.3,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-003/flight.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(46),
      resubmissionCount: 0,
      uploadedAt: daysAgo(48),
      updatedAt: daysAgo(46),
    },
    {
      applicationId: IDS.app3,
      requirementId: "req-accommodation",
      userId: IDS.client3User,
      fileName: "hotel_reservation.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.5,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-003/hotel.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(46),
      resubmissionCount: 0,
      uploadedAt: daysAgo(48),
      updatedAt: daysAgo(46),
    },
  ];

  // Documents for app4 (rejected — 7 docs, 5 verified + 2 rejected)
  const app4Docs = [
    {
      applicationId: IDS.app4,
      requirementId: "req-passport",
      userId: IDS.client4User,
      fileName: "passport_lisa_wong.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.4,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-004/passport.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(40),
      resubmissionCount: 0,
      uploadedAt: daysAgo(42),
      updatedAt: daysAgo(40),
    },
    {
      applicationId: IDS.app4,
      requirementId: "req-photo",
      userId: IDS.client4User,
      fileName: "passport_photo.jpg",
      fileType: "image/jpeg",
      fileSizeMb: 0.7,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-004/photo.jpg",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(40),
      resubmissionCount: 0,
      uploadedAt: daysAgo(42),
      updatedAt: daysAgo(40),
    },
    {
      applicationId: IDS.app4,
      requirementId: "req-acceptance-letter",
      userId: IDS.client4User,
      fileName: "university_acceptance.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.9,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-004/acceptance.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(38),
      resubmissionCount: 0,
      uploadedAt: daysAgo(40),
      updatedAt: daysAgo(38),
    },
    {
      applicationId: IDS.app4,
      requirementId: "req-bank-statement",
      userId: IDS.client4User,
      fileName: "bank_statement.pdf",
      fileType: "application/pdf",
      fileSizeMb: 2.5,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-004/bank.pdf",
      status: "rejected",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(36),
      rejectionReason: "Large unexplained deposit 2 weeks before application. Embassy will likely flag this.",
      agentComments: "Advised client to provide source-of-funds letter but was not obtained in time.",
      resubmissionCount: 0,
      uploadedAt: daysAgo(38),
      updatedAt: daysAgo(36),
    },
    {
      applicationId: IDS.app4,
      requirementId: "req-tuition-receipt",
      userId: IDS.client4User,
      fileName: "tuition_payment_receipt.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.3,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-004/tuition.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(37),
      resubmissionCount: 0,
      uploadedAt: daysAgo(39),
      updatedAt: daysAgo(37),
    },
    {
      applicationId: IDS.app4,
      requirementId: "req-medical",
      userId: IDS.client4User,
      fileName: "medical_insurance.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.1,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-004/medical.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(37),
      resubmissionCount: 0,
      uploadedAt: daysAgo(39),
      updatedAt: daysAgo(37),
    },
    {
      applicationId: IDS.app4,
      requirementId: "req-ties-letter",
      userId: IDS.client4User,
      fileName: "ties_to_home_country.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.4,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-004/ties.pdf",
      status: "rejected",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(36),
      rejectionReason: "Letter lacks specificity. Needs concrete evidence of property ownership or family obligations.",
      resubmissionCount: 0,
      uploadedAt: daysAgo(38),
      updatedAt: daysAgo(36),
    },
  ];

  // Documents for app7 (submitted_to_embassy — all 6 verified)
  const app7Docs = [
    {
      applicationId: IDS.app7,
      requirementId: "req-passport",
      userId: IDS.client7User,
      fileName: "passport_wanjiku.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.6,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-007/passport.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(30),
      resubmissionCount: 0,
      uploadedAt: daysAgo(35),
      updatedAt: daysAgo(30),
    },
    {
      applicationId: IDS.app7,
      requirementId: "req-photo",
      userId: IDS.client7User,
      fileName: "passport_photo.jpg",
      fileType: "image/jpeg",
      fileSizeMb: 0.5,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-007/photo.jpg",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(30),
      resubmissionCount: 0,
      uploadedAt: daysAgo(35),
      updatedAt: daysAgo(30),
    },
    {
      applicationId: IDS.app7,
      requirementId: "req-bank-statement",
      userId: IDS.client7User,
      fileName: "bank_statement_6months.pdf",
      fileType: "application/pdf",
      fileSizeMb: 3.1,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-007/bank.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(25),
      resubmissionCount: 0,
      uploadedAt: daysAgo(30),
      updatedAt: daysAgo(25),
    },
    {
      applicationId: IDS.app7,
      requirementId: "req-employment",
      userId: IDS.client7User,
      fileName: "employment_letter.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.6,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-007/employment.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(25),
      resubmissionCount: 0,
      uploadedAt: daysAgo(30),
      updatedAt: daysAgo(25),
    },
    {
      applicationId: IDS.app7,
      requirementId: "req-flight",
      userId: IDS.client7User,
      fileName: "flight_itinerary.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.4,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-007/flight.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(22),
      resubmissionCount: 0,
      uploadedAt: daysAgo(25),
      updatedAt: daysAgo(22),
    },
    {
      applicationId: IDS.app7,
      requirementId: "req-accommodation",
      userId: IDS.client7User,
      fileName: "accommodation_booking.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.3,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-007/accommodation.pdf",
      status: "verified",
      reviewedBy: IDS.agent2User,
      reviewedAt: daysAgo(22),
      resubmissionCount: 0,
      uploadedAt: daysAgo(25),
      updatedAt: daysAgo(22),
    },
  ];

  // Documents for app8 (interview_scheduled — 7 docs, 6 verified + 1 under review)
  const app8Docs = [
    {
      applicationId: IDS.app8,
      requirementId: "req-passport",
      userId: IDS.client8User,
      fileName: "passport_sipho.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.5,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-008/passport.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(30),
      resubmissionCount: 0,
      uploadedAt: daysAgo(33),
      updatedAt: daysAgo(30),
    },
    {
      applicationId: IDS.app8,
      requirementId: "req-photo",
      userId: IDS.client8User,
      fileName: "passport_photo.jpg",
      fileType: "image/jpeg",
      fileSizeMb: 0.7,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-008/photo.jpg",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(30),
      resubmissionCount: 0,
      uploadedAt: daysAgo(33),
      updatedAt: daysAgo(30),
    },
    {
      applicationId: IDS.app8,
      requirementId: "req-job-offer",
      userId: IDS.client8User,
      fileName: "employment_contract.pdf",
      fileType: "application/pdf",
      fileSizeMb: 1.2,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-008/contract.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(28),
      resubmissionCount: 0,
      uploadedAt: daysAgo(30),
      updatedAt: daysAgo(28),
    },
    {
      applicationId: IDS.app8,
      requirementId: "req-qualifications",
      userId: IDS.client8User,
      fileName: "engineering_degree.pdf",
      fileType: "application/pdf",
      fileSizeMb: 2.3,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-008/degree.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(28),
      resubmissionCount: 0,
      uploadedAt: daysAgo(30),
      updatedAt: daysAgo(28),
    },
    {
      applicationId: IDS.app8,
      requirementId: "req-bank-statement",
      userId: IDS.client8User,
      fileName: "bank_statements.pdf",
      fileType: "application/pdf",
      fileSizeMb: 4.2,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-008/bank.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(26),
      resubmissionCount: 0,
      uploadedAt: daysAgo(28),
      updatedAt: daysAgo(26),
    },
    {
      applicationId: IDS.app8,
      requirementId: "req-cv",
      userId: IDS.client8User,
      fileName: "professional_cv.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.8,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-008/cv.pdf",
      status: "verified",
      reviewedBy: IDS.agent1User,
      reviewedAt: daysAgo(26),
      resubmissionCount: 0,
      uploadedAt: daysAgo(28),
      updatedAt: daysAgo(26),
    },
    {
      applicationId: IDS.app8,
      requirementId: "req-references",
      userId: IDS.client8User,
      fileName: "professional_references.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.6,
      storageUrl: "gs://japa-platform.appspot.com/documents/seed-app-008/references.pdf",
      status: "under_review",
      resubmissionCount: 0,
      uploadedAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
  ];

  const allDocs = [...app1Docs, ...app2Docs, ...app3Docs, ...app4Docs, ...app7Docs, ...app8Docs];

  const batch = db.batch();
  for (const doc of allDocs) {
    const ref = db
      .collection("applications")
      .doc(doc.applicationId)
      .collection("documents")
      .doc();
    batch.set(ref, { id: ref.id, ...doc });
  }
  await batch.commit();
  console.log(`✅ Seeded ${allDocs.length} documents`);
  return allDocs.length;
}

async function seedNotes() {
  const notes = [
    // Notes on app1
    {
      applicationId: IDS.app1,
      authorId: IDS.agent1User,
      authorName: "Chinedu Eze",
      authorRole: "agent",
      content:
        "Client has strong financials. Bank statement shows consistent salary deposits over 12 months. Employment letter confirms 3 years at current role.",
      createdAt: daysAgo(15),
      updatedAt: daysAgo(15),
    },
    {
      applicationId: IDS.app1,
      authorId: IDS.agent1User,
      authorName: "Chinedu Eze",
      authorRole: "agent",
      content:
        "Requested updated bank statement covering last 30 days. Client will provide by end of week.",
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
    {
      applicationId: IDS.app1,
      authorId: IDS.ownerUser,
      authorName: "Adaeze Okonkwo",
      authorRole: "owner",
      content:
        "Reviewed this case — looks promising. Make sure flight booking aligns with the accommodation dates before submitting.",
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
    // Notes on app2
    {
      applicationId: IDS.app2,
      authorId: IDS.agent1User,
      authorName: "Chinedu Eze",
      authorRole: "agent",
      content:
        "Client's employer is sending the updated contract with correct salary figure (€38,000/yr). Should meet General Employment Permit threshold.",
      createdAt: daysAgo(7),
      updatedAt: daysAgo(7),
    },
    // Notes on app3
    {
      applicationId: IDS.app3,
      authorId: IDS.agent2User,
      authorName: "Fatima Bello",
      authorRole: "agent",
      content:
        "Visa approved! Client is very happy. Strong application — good financials, clear travel purpose, and previous UK travel history helped. Passport returned with visa sticker.",
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    },
    // Notes on app4
    {
      applicationId: IDS.app4,
      authorId: IDS.agent1User,
      authorName: "Chinedu Eze",
      authorRole: "agent",
      content:
        "Unfortunately rejected due to insufficient funds evidence. The bank statement showed a large lump-sum deposit just before application which raised red flags. Will advise client on reapplication strategy.",
      createdAt: daysAgo(10),
      updatedAt: daysAgo(10),
    },
    {
      applicationId: IDS.app4,
      authorId: IDS.ownerUser,
      authorName: "Adaeze Okonkwo",
      authorRole: "owner",
      content:
        "Discussed with Chinedu — client can reapply in 6 months with improved financial documentation. Recommend building a savings history without large unexplained deposits.",
      createdAt: daysAgo(9),
      updatedAt: daysAgo(9),
    },
    // Notes on app5
    {
      applicationId: IDS.app5,
      authorId: IDS.agent1User,
      authorName: "Chinedu Eze",
      authorRole: "agent",
      content:
        "Sent payment reminder to client. Follow up again in 48 hours if no response.",
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
    },
    // Notes on app7
    {
      applicationId: IDS.app7,
      authorId: IDS.agent2User,
      authorName: "Fatima Bello",
      authorRole: "agent",
      content:
        "Application submitted via VFS Global Nairobi. Tracking number provided to client. Expected processing time is 4-8 weeks.",
      createdAt: daysAgo(7),
      updatedAt: daysAgo(7),
    },
    {
      applicationId: IDS.app7,
      authorId: IDS.agent2User,
      authorName: "Fatima Bello",
      authorRole: "agent",
      content:
        "Client has previous Schengen and UK visas which strengthens the application significantly. Confident about approval.",
      createdAt: daysAgo(8),
      updatedAt: daysAgo(8),
    },
    // Notes on app8
    {
      applicationId: IDS.app8,
      authorId: IDS.agent1User,
      authorName: "Chinedu Eze",
      authorRole: "agent",
      content:
        "Interview scheduled for next week. Sent client the interview prep guide and scheduled a mock interview session for this Friday. Employer has confirmed they will provide a support letter.",
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    },
  ];

  const batch = db.batch();
  for (const note of notes) {
    const ref = db
      .collection("applications")
      .doc(note.applicationId)
      .collection("notes")
      .doc();
    batch.set(ref, { id: ref.id, ...note });
  }
  await batch.commit();
  console.log(`✅ Seeded ${notes.length} notes`);
  return notes.length;
}

async function seedReviews() {
  const reviews = [
    // Reviews for agent1 (Chinedu Eze)
    {
      agentId: IDS.agent1,
      userId: IDS.client1User,
      applicationId: IDS.app1,
      rating: 5,
      title: "Excellent guidance throughout",
      comment:
        "Chinedu has been incredibly helpful with my visa application. Very responsive and knowledgeable about the entire process. Highly recommend!",
      createdAt: daysAgo(8),
      isVerifiedClient: true,
    },
    {
      agentId: IDS.agent1,
      userId: IDS.client4User,
      applicationId: IDS.app4,
      rating: 3,
      title: "Good effort, unfortunate outcome",
      comment:
        "My application was rejected but I don't blame the agent. He advised me about the financial documentation issues early on. Will try again with his help.",
      createdAt: daysAgo(9),
      isVerifiedClient: true,
    },
    // Reviews for agent2 (Fatima Bello)
    {
      agentId: IDS.agent2,
      userId: IDS.client3User,
      applicationId: IDS.app3,
      rating: 5,
      title: "Got my visa approved!",
      comment:
        "Fatima was amazing. She guided me through every step and my visa was approved on the first try. Very professional and thorough.",
      createdAt: daysAgo(4),
      isVerifiedClient: true,
    },
    {
      agentId: IDS.agent2,
      userId: IDS.client7User,
      applicationId: IDS.app7,
      rating: 4,
      title: "Very organised and responsive",
      comment:
        "Still waiting for my visa decision but the application process was very smooth. Fatima kept me informed at every stage. Documents were verified quickly.",
      createdAt: daysAgo(6),
      isVerifiedClient: true,
    },
  ];

  const batch = db.batch();
  for (const review of reviews) {
    const ref = db
      .collection("agents")
      .doc(review.agentId)
      .collection("reviews")
      .doc();
    batch.set(ref, { id: ref.id, ...review });
  }
  await batch.commit();
  console.log(`✅ Seeded ${reviews.length} agent reviews`);
  return reviews.length;
}

// ============================================
// SEED TRANSACTIONS
// ============================================

async function seedTransactions(): Promise<number> {
  const transactions = [
    {
      id: "seed-txn-001",
      userId: IDS.client1User,
      agentId: IDS.agent1User,
      applicationId: IDS.app1,
      type: "consultation_fee",
      amount: 500000, // ₦5,000
      currency: "NGN",
      status: "completed",
      isEscrow: false,
      paymentProvider: "stripe",
      description: "Initial consultation fee for Short Stay C Visa",
      clientName: "John Doe",
      clientEmail: "john.doe@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      createdAt: daysAgo(25),
      updatedAt: daysAgo(25),
    },
    {
      id: "seed-txn-002",
      userId: IDS.client1User,
      agentId: IDS.agent1User,
      applicationId: IDS.app1,
      type: "service_fee",
      amount: 4500000, // ₦45,000
      currency: "NGN",
      status: "completed",
      isEscrow: false,
      paymentProvider: "stripe",
      description: "Visa application service fee",
      clientName: "John Doe",
      clientEmail: "john.doe@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      createdAt: daysAgo(20),
      updatedAt: daysAgo(20),
    },
    {
      id: "seed-txn-003",
      userId: IDS.client2User,
      agentId: IDS.agent1User,
      applicationId: IDS.app2,
      type: "consultation_fee",
      amount: 500000, // ₦5,000
      currency: "NGN",
      status: "completed",
      isEscrow: false,
      paymentProvider: "stripe",
      description: "Consultation fee for Employment Permit",
      clientName: "Jane Smith",
      clientEmail: "jane.smith@example.com",
      visaTypeName: "General Employment Permit",
      createdAt: daysAgo(18),
      updatedAt: daysAgo(18),
    },
    {
      id: "seed-txn-004",
      userId: IDS.client2User,
      agentId: IDS.agent1User,
      applicationId: IDS.app2,
      type: "service_fee",
      amount: 7500000, // ₦75,000
      currency: "NGN",
      status: "pending",
      isEscrow: true,
      escrowReleaseCondition: "Application approval",
      paymentProvider: "stripe",
      description: "Employment Permit service fee (held in escrow)",
      clientName: "Jane Smith",
      clientEmail: "jane.smith@example.com",
      visaTypeName: "General Employment Permit",
      createdAt: daysAgo(15),
      updatedAt: daysAgo(15),
    },
    {
      id: "seed-txn-005",
      userId: IDS.client3User,
      agentId: IDS.agent2User,
      applicationId: IDS.app3,
      type: "service_fee",
      amount: 3500000, // ₦35,000
      currency: "NGN",
      status: "completed",
      isEscrow: false,
      paymentProvider: "paypal",
      description: "Short Stay C Visa processing fee",
      clientName: "Ahmed Ali",
      clientEmail: "ahmed.ali@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      createdAt: daysAgo(30),
      updatedAt: daysAgo(30),
    },
    {
      id: "seed-txn-006",
      userId: IDS.client4User,
      agentId: IDS.agent1User,
      applicationId: IDS.app4,
      type: "consultation_fee",
      amount: 500000, // ₦5,000
      currency: "NGN",
      status: "refunded",
      isEscrow: false,
      paymentProvider: "stripe",
      description: "Consultation fee refunded (application rejected)",
      clientName: "Lisa Wong",
      clientEmail: "lisa.wong@example.com",
      visaTypeName: "Student Visa (D)",
      createdAt: daysAgo(35),
      updatedAt: daysAgo(10),
    },
    {
      id: "seed-txn-007",
      userId: IDS.client7User,
      agentId: IDS.agent2User,
      applicationId: IDS.app7,
      type: "government_fee",
      amount: 9000000, // ₦90,000
      currency: "NGN",
      status: "completed",
      isEscrow: false,
      paymentProvider: "manual",
      description: "Embassy application fee for Short Stay C Visa",
      clientName: "Wanjiku Mwangi",
      clientEmail: "wanjiku.mwangi@example.com",
      visaTypeName: "Short Stay 'C' Visa",
      createdAt: daysAgo(12),
      updatedAt: daysAgo(12),
    },
    {
      id: "seed-txn-008",
      userId: IDS.client8User,
      agentId: IDS.agent1User,
      applicationId: IDS.app8,
      type: "service_fee",
      amount: 6000000, // ₦60,000
      currency: "NGN",
      status: "held_in_escrow",
      isEscrow: true,
      escrowReleaseCondition: "Interview completion",
      paymentProvider: "stripe",
      description: "Employment Permit service fee (pending interview)",
      clientName: "Sipho Ndlovu",
      clientEmail: "sipho.ndlovu@example.com",
      visaTypeName: "General Employment Permit",
      createdAt: daysAgo(8),
      updatedAt: daysAgo(8),
    },
  ];

  const batch = db.batch();
  for (const txn of transactions) {
    const ref = db.collection("transactions").doc(txn.id);
    batch.set(ref, txn);
  }
  await batch.commit();
  console.log(`✅ Seeded ${transactions.length} transactions`);
  return transactions.length;
}

// ============================================
// SEED CONSULTATIONS
// ============================================

async function seedConsultations(): Promise<number> {
  const consultations = [
    {
      id: "seed-consult-001",
      userId: IDS.client1User,
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      applicationId: IDS.app1,
      clientName: "John Doe",
      clientEmail: "john.doe@example.com",
      agentName: "Chinedu Eze",
      type: "initial",
      scheduledDate: daysAgo(20),
      scheduledTime: "10:00",
      durationMinutes: 30,
      timezone: "Africa/Lagos",
      status: "completed",
      fee: 500000,
      paymentStatus: "paid",
      meetingPlatform: "zoom",
      summary: "Discussed visa requirements and document checklist. Client has strong financials.",
      createdAt: daysAgo(22),
      updatedAt: daysAgo(20),
    },
    {
      id: "seed-consult-002",
      userId: IDS.client2User,
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      applicationId: IDS.app2,
      clientName: "Jane Smith",
      clientEmail: "jane.smith@example.com",
      agentName: "Chinedu Eze",
      type: "document_review",
      scheduledDate: daysAgo(5),
      scheduledTime: "14:00",
      durationMinutes: 45,
      timezone: "Africa/Lagos",
      status: "completed",
      fee: 300000,
      paymentStatus: "paid",
      meetingPlatform: "google_meet",
      summary: "Reviewed employment contract and qualification documents. Degree certificate needs re-scan.",
      createdAt: daysAgo(7),
      updatedAt: daysAgo(5),
    },
    {
      id: "seed-consult-003",
      userId: IDS.client8User,
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      applicationId: IDS.app8,
      clientName: "Sipho Ndlovu",
      clientEmail: "sipho.ndlovu@example.com",
      agentName: "Chinedu Eze",
      type: "interview_prep",
      scheduledDate: daysFromNow(3),
      scheduledTime: "11:00",
      durationMinutes: 60,
      timezone: "Africa/Lagos",
      status: "confirmed",
      fee: 800000,
      paymentStatus: "paid",
      meetingPlatform: "zoom",
      meetingLink: "https://zoom.us/j/1234567890",
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
    {
      id: "seed-consult-004",
      userId: IDS.client7User,
      agentId: IDS.agent2User,
      agencyId: IDS.agency,
      applicationId: IDS.app7,
      clientName: "Wanjiku Mwangi",
      clientEmail: "wanjiku.mwangi@example.com",
      agentName: "Fatima Bello",
      type: "follow_up",
      scheduledDate: daysFromNow(7),
      scheduledTime: "09:30",
      durationMinutes: 30,
      timezone: "Africa/Lagos",
      status: "scheduled",
      fee: 0,
      paymentStatus: "paid",
      meetingPlatform: "google_meet",
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
    },
    {
      id: "seed-consult-005",
      userId: IDS.client3User,
      agentId: IDS.agent2User,
      agencyId: IDS.agency,
      applicationId: IDS.app3,
      clientName: "Ahmed Ali",
      clientEmail: "ahmed.ali@example.com",
      agentName: "Fatima Bello",
      type: "initial",
      scheduledDate: daysAgo(55),
      scheduledTime: "15:00",
      durationMinutes: 30,
      timezone: "Africa/Lagos",
      status: "completed",
      fee: 250000,
      paymentStatus: "paid",
      summary: "Initial consultation for Short Stay C Visa. Discussed travel history and documentation plan.",
      createdAt: daysAgo(57),
      updatedAt: daysAgo(55),
    },
    {
      id: "seed-consult-006",
      userId: IDS.client9User,
      agentId: IDS.agent2User,
      agencyId: IDS.agency,
      applicationId: IDS.app9,
      clientName: "Priya Sharma",
      clientEmail: "priya.sharma@example.com",
      agentName: "Fatima Bello",
      type: "general",
      scheduledDate: daysAgo(25),
      scheduledTime: "10:00",
      durationMinutes: 30,
      timezone: "Asia/Kolkata",
      status: "cancelled",
      fee: 250000,
      paymentStatus: "refunded",
      cancelledAt: daysAgo(26),
      cancelledBy: IDS.client9User,
      cancellationReason: "Travel plans changed, no longer need visa.",
      createdAt: daysAgo(30),
      updatedAt: daysAgo(25),
    },
    {
      id: "seed-consult-007",
      userId: IDS.client6User,
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      applicationId: IDS.app6,
      clientName: "Kwame Asante",
      clientEmail: "kwame.asante@example.com",
      agentName: "Chinedu Eze",
      type: "initial",
      scheduledDate: daysFromNow(1),
      scheduledTime: "16:00",
      durationMinutes: 30,
      timezone: "Africa/Accra",
      status: "confirmed",
      fee: 500000,
      paymentStatus: "paid",
      meetingPlatform: "zoom",
      meetingLink: "https://zoom.us/j/9876543210",
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    },
    {
      id: "seed-consult-008",
      userId: IDS.client4User,
      agentId: IDS.agent1User,
      agencyId: IDS.agency,
      applicationId: IDS.app4,
      clientName: "Lisa Wong",
      clientEmail: "lisa.wong@example.com",
      agentName: "Chinedu Eze",
      type: "follow_up",
      scheduledDate: daysAgo(12),
      scheduledTime: "13:00",
      durationMinutes: 30,
      timezone: "Africa/Lagos",
      status: "no_show",
      fee: 0,
      paymentStatus: "paid",
      createdAt: daysAgo(15),
      updatedAt: daysAgo(12),
    },
  ];

  const batch = db.batch();
  for (const c of consultations) {
    const ref = db.collection("consultations").doc(c.id);
    batch.set(ref, c);
  }
  await batch.commit();
  console.log(`✅ Seeded ${consultations.length} consultations`);
  return consultations.length;
}

// ============================================
// SEED NOTIFICATIONS
// ============================================

async function seedNotifications(): Promise<number> {
  const notifications = [
    // Notifications for agent1 (Chinedu Eze)
    {
      id: "seed-notif-001",
      userId: IDS.agent1User,
      type: "payment_received",
      title: "Payment received",
      body: "₦50,000 received from John Doe for Short Stay C Visa consultation.",
      actionUrl: `/transactions`,
      relatedEntityType: "application",
      relatedEntityId: IDS.app1,
      isRead: false,
      createdAt: daysAgo(0),
    },
    {
      id: "seed-notif-002",
      userId: IDS.agent1User,
      type: "consultation_reminder",
      title: "Upcoming consultation",
      body: "Interview prep session with Sipho Ndlovu tomorrow at 11:00 AM.",
      actionUrl: `/appointments`,
      relatedEntityType: "consultation",
      relatedEntityId: "seed-consult-003",
      isRead: false,
      createdAt: daysAgo(0),
    },
    {
      id: "seed-notif-003",
      userId: IDS.agent1User,
      type: "document_status",
      title: "Document uploaded",
      body: "Sipho Ndlovu uploaded professional references for Employment Permit application.",
      actionUrl: `/case-management/${IDS.app8}`,
      relatedEntityType: "document",
      relatedEntityId: IDS.app8,
      isRead: false,
      createdAt: daysAgo(1),
    },
    {
      id: "seed-notif-004",
      userId: IDS.agent1User,
      type: "application_update",
      title: "Application status change",
      body: "Sipho Ndlovu's Employment Permit application has an interview scheduled.",
      actionUrl: `/case-management/${IDS.app8}`,
      relatedEntityType: "application",
      relatedEntityId: IDS.app8,
      isRead: true,
      readAt: daysAgo(1),
      createdAt: daysAgo(2),
    },
    {
      id: "seed-notif-005",
      userId: IDS.agent1User,
      type: "payment_received",
      title: "Payment received",
      body: "₦75,000 received from Jane Smith for Employment Permit service fee (held in escrow).",
      actionUrl: `/transactions`,
      relatedEntityType: "application",
      relatedEntityId: IDS.app2,
      isRead: true,
      readAt: daysAgo(14),
      createdAt: daysAgo(15),
    },
    {
      id: "seed-notif-006",
      userId: IDS.agent1User,
      type: "application_update",
      title: "New application assigned",
      body: "Tunde Bakare started a Short Stay C Visa application. Awaiting payment.",
      actionUrl: `/case-management/${IDS.app5}`,
      relatedEntityType: "application",
      relatedEntityId: IDS.app5,
      isRead: true,
      readAt: daysAgo(2),
      createdAt: daysAgo(3),
    },
    // Notifications for agent2 (Fatima Bello)
    {
      id: "seed-notif-007",
      userId: IDS.agent2User,
      type: "application_update",
      title: "Visa approved",
      body: "Ahmed Ali's Short Stay C Visa has been approved by the embassy.",
      actionUrl: `/case-management/${IDS.app3}`,
      relatedEntityType: "application",
      relatedEntityId: IDS.app3,
      isRead: true,
      readAt: daysAgo(4),
      createdAt: daysAgo(5),
    },
    {
      id: "seed-notif-008",
      userId: IDS.agent2User,
      type: "consultation_reminder",
      title: "Upcoming consultation",
      body: "Follow-up consultation with Wanjiku Mwangi scheduled for next week.",
      actionUrl: `/appointments`,
      relatedEntityType: "consultation",
      relatedEntityId: "seed-consult-004",
      isRead: false,
      createdAt: daysAgo(0),
    },
    // Notifications for owner (Adaeze Okonkwo)
    {
      id: "seed-notif-009",
      userId: IDS.ownerUser,
      type: "system",
      title: "Weekly summary",
      body: "Your agency processed 3 applications this week. 1 approved, 2 in progress.",
      isRead: false,
      createdAt: daysAgo(0),
    },
    {
      id: "seed-notif-010",
      userId: IDS.ownerUser,
      type: "payment_received",
      title: "Agency revenue update",
      body: "₦60,000 received from Sipho Ndlovu's Employment Permit (held in escrow).",
      actionUrl: `/transactions`,
      relatedEntityType: "application",
      relatedEntityId: IDS.app8,
      isRead: true,
      readAt: daysAgo(7),
      createdAt: daysAgo(8),
    },
    {
      id: "seed-notif-011",
      userId: IDS.ownerUser,
      type: "application_update",
      title: "Application rejected",
      body: "Lisa Wong's Student Visa (D) application was rejected by the embassy.",
      actionUrl: `/case-management/${IDS.app4}`,
      relatedEntityType: "application",
      relatedEntityId: IDS.app4,
      isRead: true,
      readAt: daysAgo(9),
      createdAt: daysAgo(10),
    },
    {
      id: "seed-notif-012",
      userId: IDS.ownerUser,
      type: "system",
      title: "New agent review",
      body: "Ahmed Ali left a 5-star review for Fatima Bello.",
      isRead: true,
      readAt: daysAgo(3),
      createdAt: daysAgo(4),
    },
  ];

  const batch = db.batch();
  for (const n of notifications) {
    const ref = db.collection("notifications").doc(n.id);
    batch.set(ref, n);
  }
  await batch.commit();
  console.log(`✅ Seeded ${notifications.length} notifications`);
  return notifications.length;
}

// ============================================
// MAIN EXPORT
// ============================================

async function seedPaymentRequests(): Promise<number> {
  const now = Timestamp.now();
  const paymentRequests = [
    {
      id: "seed-pr-001",
      applicationId: IDS.app1,
      agentId: IDS.agent1,
      agencyId: IDS.agency,
      clientId: IDS.client1User,
      clientName: "Adaeze Okafor",
      clientEmail: "adaeze@email.com",
      amount: 75000_00, // ₦75,000 in kobo
      currency: "NGN",
      description: "Visa Processing Fee",
      status: "paid",
      paidAt: now,
      createdAt: Timestamp.fromDate(new Date("2025-09-15")),
      updatedAt: now,
    },
    {
      id: "seed-pr-002",
      applicationId: IDS.app1,
      agentId: IDS.agent1,
      agencyId: IDS.agency,
      clientId: IDS.client1User,
      clientName: "Adaeze Okafor",
      clientEmail: "adaeze@email.com",
      amount: 25000_00, // ₦25,000 in kobo
      currency: "NGN",
      description: "Document Authentication Fee",
      status: "pending",
      createdAt: Timestamp.fromDate(new Date("2025-12-01")),
      updatedAt: Timestamp.fromDate(new Date("2025-12-01")),
    },
    {
      id: "seed-pr-003",
      applicationId: IDS.app2,
      agentId: IDS.agent1,
      agencyId: IDS.agency,
      clientId: IDS.client2User,
      clientName: "Kwame Mensah",
      clientEmail: "kwame@email.com",
      amount: 150000_00, // ₦150,000 in kobo
      currency: "NGN",
      description: "Embassy Application Fee",
      status: "pending",
      createdAt: Timestamp.fromDate(new Date("2025-11-20")),
      updatedAt: Timestamp.fromDate(new Date("2025-11-20")),
    },
    {
      id: "seed-pr-004",
      applicationId: IDS.app5,
      agentId: IDS.agent2,
      agencyId: IDS.agency,
      clientId: IDS.client5User,
      clientName: "Aisha Bello",
      clientEmail: "aisha@email.com",
      amount: 50000_00, // ₦50,000 in kobo
      currency: "NGN",
      description: "Consultation Fee",
      status: "cancelled",
      cancelledAt: now,
      createdAt: Timestamp.fromDate(new Date("2025-10-05")),
      updatedAt: now,
    },
    {
      id: "seed-pr-005",
      applicationId: IDS.app3,
      agentId: IDS.agent1,
      agencyId: IDS.agency,
      clientId: IDS.client3User,
      clientName: "Amara Njoku",
      clientEmail: "amara@email.com",
      amount: 100000_00, // ₦100,000 in kobo
      currency: "NGN",
      description: "Visa Service Fee",
      status: "paid",
      paidAt: Timestamp.fromDate(new Date("2025-10-20")),
      createdAt: Timestamp.fromDate(new Date("2025-10-10")),
      updatedAt: Timestamp.fromDate(new Date("2025-10-20")),
    },
  ];

  for (const pr of paymentRequests) {
    await db.collection("paymentRequests").doc(pr.id).set(pr);
  }

  return paymentRequests.length;
}

// ============================================
// CONVERSATIONS & MESSAGES
// ============================================

const CONV_IDS = {
  conv1: "seed-conv-001", // agent1 ↔ client1 (app1)
  conv2: "seed-conv-002", // agent1 ↔ client2 (app2)
  conv3: "seed-conv-003", // agent2 ↔ client3 (app3)
  conv4: "seed-conv-004", // owner ↔ client5 (app5)
};

async function seedConversations(): Promise<number> {
  const convs = [
    {
      id: CONV_IDS.conv1,
      userId: IDS.client1User,
      agentId: IDS.agent1,
      applicationId: IDS.app1,
      lastMessageAt: daysAgo(0),
      lastMessage: "Your documents have been reviewed and approved!",
      unreadCountUser: 1,
      unreadCountAgent: 0,
      createdAt: daysAgo(14),
      updatedAt: daysAgo(0),
    },
    {
      id: CONV_IDS.conv2,
      userId: IDS.client2User,
      agentId: IDS.agent1,
      applicationId: IDS.app2,
      lastMessageAt: daysAgo(1),
      lastMessage: "Please upload your proof of funds",
      unreadCountUser: 0,
      unreadCountAgent: 1,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(1),
    },
    {
      id: CONV_IDS.conv3,
      userId: IDS.client3User,
      agentId: IDS.agent2,
      applicationId: IDS.app3,
      lastMessageAt: daysAgo(2),
      lastMessage: "Thank you for your patience",
      unreadCountUser: 0,
      unreadCountAgent: 0,
      createdAt: daysAgo(7),
      updatedAt: daysAgo(2),
    },
    {
      id: CONV_IDS.conv4,
      userId: IDS.client5User,
      agentId: IDS.ownerAgent,
      applicationId: IDS.app5,
      lastMessageAt: daysAgo(3),
      lastMessage: "I'll follow up with the embassy this week",
      unreadCountUser: 1,
      unreadCountAgent: 0,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(3),
    },
  ];

  const batch = db.batch();
  for (const conv of convs) {
    batch.set(db.collection("conversations").doc(conv.id), conv);
  }
  await batch.commit();

  // Seed messages for each conversation
  const allMessages = [
    // Conv 1: agent1 ↔ client1
    {
      convId: CONV_IDS.conv1,
      messages: [
        { senderId: IDS.agent1User, senderType: "agent" as const, content: "Welcome John! I'm Chinedu, your assigned agent for the UK Work Visa application. How can I help you today?", createdAt: daysAgo(14) },
        { senderId: IDS.client1User, senderType: "user" as const, content: "Hi Chinedu! I just submitted my documents. Can you confirm you received everything?", createdAt: daysAgo(13) },
        { senderId: IDS.agent1User, senderType: "agent" as const, content: "Yes, I can see your uploads. I'm reviewing them now. I'll get back to you within 24 hours.", createdAt: daysAgo(13) },
        { senderId: IDS.client1User, senderType: "user" as const, content: "Thank you so much! Looking forward to hearing from you.", createdAt: daysAgo(12) },
        { senderId: IDS.agent1User, senderType: "agent" as const, content: "Your documents have been reviewed and approved!", createdAt: daysAgo(0), isRead: false },
      ],
    },
    // Conv 2: agent1 ↔ client2
    {
      convId: CONV_IDS.conv2,
      messages: [
        { senderId: IDS.agent1User, senderType: "agent" as const, content: "Hello Jane, I'm handling your Canada Study Visa application. Please let me know if you have any questions.", createdAt: daysAgo(10) },
        { senderId: IDS.client2User, senderType: "user" as const, content: "Thanks Chinedu! I'm still gathering some documents. What's the deadline?", createdAt: daysAgo(9) },
        { senderId: IDS.agent1User, senderType: "agent" as const, content: "Please upload your proof of funds", createdAt: daysAgo(1) },
        { senderId: IDS.client2User, senderType: "user" as const, content: "I'll have it ready by tomorrow!", createdAt: daysAgo(1), isRead: false },
      ],
    },
    // Conv 3: agent2 ↔ client3
    {
      convId: CONV_IDS.conv3,
      messages: [
        { senderId: IDS.agent2User, senderType: "agent" as const, content: "Hi Ahmed, I'm Fatima and I'll be assisting with your Germany Work Visa. Let's get started!", createdAt: daysAgo(7) },
        { senderId: IDS.client3User, senderType: "user" as const, content: "Great to meet you Fatima! What documents do I need first?", createdAt: daysAgo(6) },
        { senderId: IDS.agent2User, senderType: "agent" as const, content: "I'll send you a checklist shortly. For now, please make sure your passport is valid for at least 6 months.", createdAt: daysAgo(5) },
        { senderId: IDS.client3User, senderType: "user" as const, content: "It is valid until 2028. Thanks for checking!", createdAt: daysAgo(3) },
        { senderId: IDS.agent2User, senderType: "agent" as const, content: "Thank you for your patience", createdAt: daysAgo(2) },
      ],
    },
    // Conv 4: owner ↔ client5
    {
      convId: CONV_IDS.conv4,
      messages: [
        { senderId: IDS.ownerUser, senderType: "agent" as const, content: "Hello Tunde, this is Adaeze from Japa Immigration Services. I'm personally overseeing your application.", createdAt: daysAgo(20) },
        { senderId: IDS.client5User, senderType: "user" as const, content: "That's great to hear! I've been waiting for an update on my embassy submission.", createdAt: daysAgo(15) },
        { senderId: IDS.ownerUser, senderType: "agent" as const, content: "I'll follow up with the embassy this week", createdAt: daysAgo(3) },
      ],
    },
  ];

  let msgCount = 0;
  for (const convMessages of allMessages) {
    const batch = db.batch();
    let idx = 1;
    for (const msg of convMessages.messages) {
      const msgId = `${convMessages.convId}-msg-${String(idx).padStart(3, "0")}`;
      const msgRef = db.collection("conversations").doc(convMessages.convId).collection("messages").doc(msgId);
      batch.set(msgRef, {
        id: msgId,
        conversationId: convMessages.convId,
        senderId: msg.senderId,
        senderType: msg.senderType,
        content: msg.content,
        isRead: msg.isRead ?? true,
        createdAt: msg.createdAt,
      });
      idx++;
      msgCount++;
    }
    await batch.commit();
  }

  console.log(`  ✅ ${convs.length} conversations, ${msgCount} messages`);
  return convs.length;
}

export async function seedPortalData(): Promise<{
  authUsers: number;
  users: number;
  agencies: number;
  agents: number;
  applications: number;
  timelineEntries: number;
  documents: number;
  notes: number;
  reviews: number;
  transactions: number;
  consultations: number;
  notifications: number;
  paymentRequests: number;
  conversations: number;
}> {
  console.log("\n🌱 Seeding portal integration data...\n");

  const authUsers = await seedAuthUsers();
  const users = await seedUsers();
  const agencies = await seedAgency();
  const agents = await seedAgents();
  const applications = await seedApplications();
  const timelineEntries = await seedTimelines();
  const documents = await seedDocuments();
  const notes = await seedNotes();
  const reviews = await seedReviews();
  const transactions = await seedTransactions();
  const consultations = await seedConsultations();
  const notifications = await seedNotifications();
  const paymentRequests = await seedPaymentRequests();
  const conversations = await seedConversations();

  console.log("\n✅ Portal seed complete!\n");

  return { authUsers, users, agencies, agents, applications, timelineEntries, documents, notes, reviews, transactions, consultations, notifications, paymentRequests, conversations };
}
