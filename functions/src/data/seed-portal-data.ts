/**
 * Seed data for portal integration testing
 *
 * Creates: users, agents, an agency, applications (with timeline, documents, notes),
 * and links everything together so the portal pages render with realistic data.
 *
 * All IDs are deterministic so the seed is idempotent (safe to re-run).
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";

const db = getFirestore();

// ============================================
// DETERMINISTIC IDS
// ============================================
const IDS = {
  // Users
  ownerUser: "seed-user-owner-001",
  agent1User: "seed-user-agent-001",
  agent2User: "seed-user-agent-002",
  client1User: "seed-user-client-001",
  client2User: "seed-user-client-002",
  client3User: "seed-user-client-003",
  client4User: "seed-user-client-004",
  client5User: "seed-user-client-005",

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
// SEED FUNCTIONS
// ============================================

async function seedUsers() {
  const now = Timestamp.now();

  const users = [
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
    totalCases: 5,
    activeCases: 3,
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

  const allTimelines = [...app1Timeline, ...app3Timeline];

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

  const allDocs = [...app1Docs, ...app2Docs];

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

// ============================================
// MAIN EXPORT
// ============================================

export async function seedPortalData(): Promise<{
  users: number;
  agencies: number;
  agents: number;
  applications: number;
  timelineEntries: number;
  documents: number;
  notes: number;
}> {
  console.log("\n🌱 Seeding portal integration data...\n");

  const users = await seedUsers();
  const agencies = await seedAgency();
  const agents = await seedAgents();
  const applications = await seedApplications();
  const timelineEntries = await seedTimelines();
  const documents = await seedDocuments();
  const notes = await seedNotes();

  console.log("\n✅ Portal seed complete!\n");

  return { users, agencies, agents, applications, timelineEntries, documents, notes };
}
