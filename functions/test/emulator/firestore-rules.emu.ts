// ============================================
// Rules unit tests — users, agents, agencyInvitations (issue #135)
// ============================================
//
// Run with `npm run test:emulator`. Uses @firebase/rules-unit-testing against
// the Firestore emulator, which has loaded the repo's real ../firestore.rules.
//
// One test per field, in both directions:
//  - ALLOW: every field on the self-editable allow-list can be written by the
//    document's own user (so a legitimate profile edit keeps working);
//  - DENY: every field the backend treats as authority, or manages itself,
//    is refused on create, on update and on removal.
// The field lists below are spelled out here on purpose (not imported from
// the rules or the services): the test is the independent statement of what
// is and is not self-editable.

import { test, describe, before, after, beforeEach } from "node:test";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";

import { anonymousDb, clientDb, rulesEnv, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

const ALICE = "alice-uid";
const ALICE_EMAIL = "delivered+alice@resend.dev";
const BOB = "bob-uid";
const BOB_EMAIL = "delivered+bob@resend.dev";
const AGENCY = "agency-1";
const OTHER_AGENCY = "agency-2";

/** Alice's profile as the backend provisions it. */
const ALICE_USER_DOC = {
  id: ALICE,
  email: ALICE_EMAIL,
  firstName: "Alice",
  lastName: "A",
  onboardingCompleted: false,
  hasPassport: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/** Alice's agent profile as the backend writes it (a member of AGENCY). */
const ALICE_AGENT_DOC = {
  id: "agent-alice",
  userId: ALICE,
  agencyId: AGENCY,
  agencyRole: "agent",
  displayName: "Alice A",
  bio: "",
  yearsOfExperience: 1,
  specializations: [],
  languages: ["English"],
  featuredVisas: [],
  verificationStatus: "pending",
  rating: 0,
  totalReviews: 0,
  totalApplications: 0,
  successRate: 0,
  responseTime: "N/A",
  consultationFee: 0,
  serviceFees: {},
  isAvailable: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/** A sample value for every self-editable user field (firestore.rules allow-list). */
const USER_ALLOWED: Record<string, unknown> = {
  firstName: "Alicia",
  lastName: "Ade",
  middleName: "M",
  phone: "+2348000000000",
  dateOfBirth: new Date("1990-01-01T00:00:00Z"),
  address: { city: "Lagos" },
  residentialCountry: "NG",
  profilePhotoUrl: "https://example.invalid/a.png",
  hasPassport: true,
  passportNumber: "A0000000",
  passportExpiryDate: new Date("2030-01-01T00:00:00Z"),
  passportCountry: "NG",
  notificationPreferences: { email: false, push: true },
  updatedAt: new Date(),
};

/** A sample value for every user field a client must NOT be able to write. */
const USER_PROTECTED: Record<string, unknown> = {
  admin: true,
  role: "admin",
  agencyId: AGENCY,
  agencyRole: "owner",
  identityVerification: { status: "verified" },
  isProvisional: true,
  onboardingCompleted: true,
  onboardingCompletedAt: new Date(),
  lastLoginAt: new Date(),
  fcmTokens: ["token"],
  someFutureField: "anything", // unknown fields are refused too (allow-list)
};

/** A sample value for every self-editable agent field. */
const AGENT_ALLOWED: Record<string, unknown> = {
  displayName: "Alice Updated",
  bio: "New bio",
  profilePhotoUrl: "https://example.invalid/a.png",
  licenseNumber: "LIC-1",
  yearsOfExperience: 5,
  specializations: ["Student Visa"],
  languages: ["English", "Yoruba"],
  featuredVisas: ["visa-1"],
  consultationFee: 10000,
  serviceFees: { "visa-1": 50000 },
  availableSlots: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
  updatedAt: new Date(),
};

/** A sample value for every agent field a client must NOT be able to write. */
const AGENT_PROTECTED: Record<string, unknown> = {
  agencyId: OTHER_AGENCY,
  agencyRole: "owner",
  verificationStatus: "verified",
  verifiedAt: new Date(),
  verifiedBy: "someone",
  verificationDocuments: ["path/doc.pdf"],
  isAvailable: true,
  rating: 5,
  totalReviews: 100,
  totalApplications: 100,
  successRate: 100,
  responseTime: "1 hour",
  someFutureField: "anything",
};

/** Alice's client-side Firestore (token: her uid + email, no role claims). */
const alice = () => clientDb(ALICE, { email: ALICE_EMAIL });
/** Bob's client-side Firestore. */
const bob = () => clientDb(BOB, { email: BOB_EMAIL });

before(async () => {
  await rulesEnv();
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

// Every test starts from the same server-written documents.
beforeEach(async () => {
  await (await rulesEnv()).clearFirestore();
  await withoutRules(async (db) => {
    await db.collection("users").doc(ALICE).set(ALICE_USER_DOC);
    await db.collection("agents").doc(ALICE_AGENT_DOC.id).set(ALICE_AGENT_DOC);
    await db.collection("agencyInvitations").doc("invite-1").set({
      id: "invite-1",
      agencyId: AGENCY,
      invitedBy: ALICE,
      invitedEmail: BOB_EMAIL,
      email: BOB_EMAIL,
      status: "pending",
    });
  });
});

// ============================================
// users/{uid}
// ============================================

describe("users/{uid}: reads", () => {
  test("a user reads their own profile; nobody else can", async () => {
    await assertSucceeds((await alice()).collection("users").doc(ALICE).get());
    await assertFails((await bob()).collection("users").doc(ALICE).get());
    await assertFails((await anonymousDb()).collection("users").doc(ALICE).get());
  });
});

describe("users/{uid}: update", () => {
  for (const [field, value] of Object.entries(USER_ALLOWED)) {
    test(`ALLOW own update of ${field}`, async () => {
      await assertSucceeds((await alice()).collection("users").doc(ALICE).update({ [field]: value }));
    });
  }

  for (const [field, value] of Object.entries({
    ...USER_PROTECTED,
    // Identity / bookkeeping fields that exist on the document already.
    email: "delivered+someone-else@resend.dev",
    id: "another-id",
    createdAt: new Date(),
  })) {
    test(`DENY own update of ${field}`, async () => {
      await assertFails((await alice()).collection("users").doc(ALICE).update({ [field]: value }));
    });
  }

  test("DENY a protected field hidden in an otherwise valid update", async () => {
    await assertFails((await alice()).collection("users").doc(ALICE).update({ firstName: "Alicia", admin: true }));
  });

  test("DENY removing a server-written field (a real admin cannot be un-flagged from the client)", async () => {
    await withoutRules(async (db) => {
      await db.collection("users").doc(ALICE).update({ admin: true });
    });
    // Overwrite without `admin`: the field would be removed.
    await assertFails((await alice()).collection("users").doc(ALICE).set(ALICE_USER_DOC));
  });

  test("DENY updating somebody else's profile, even an allowed field", async () => {
    await assertFails((await bob()).collection("users").doc(ALICE).update({ firstName: "Mallory" }));
  });
});

describe("users/{uid}: create", () => {
  test("ALLOW creating an own profile from allow-listed fields plus truthful id / email", async () => {
    await assertSucceeds(
      (await bob())
        .collection("users")
        .doc(BOB)
        .set({ ...USER_ALLOWED, id: BOB, email: BOB_EMAIL, createdAt: new Date() })
    );
  });

  for (const [field, value] of Object.entries(USER_PROTECTED)) {
    test(`DENY own create carrying ${field}`, async () => {
      await assertFails(
        (await bob())
          .collection("users")
          .doc(BOB)
          .set({ id: BOB, email: BOB_EMAIL, firstName: "Bob", [field]: value })
      );
    });
  }

  test("DENY create with somebody else's email or a mismatched id", async () => {
    const ref = (await bob()).collection("users").doc(BOB);
    await assertFails(ref.set({ id: BOB, email: ALICE_EMAIL, firstName: "Bob" }));
    await assertFails(ref.set({ id: ALICE, email: BOB_EMAIL, firstName: "Bob" }));
  });

  test("DENY creating a profile for another uid", async () => {
    await assertFails((await bob()).collection("users").doc("carol-uid").set({ firstName: "Carol" }));
  });
});

// ============================================
// agents/{agentId}
// ============================================

describe("agents/{agentId}: update", () => {
  for (const [field, value] of Object.entries(AGENT_ALLOWED)) {
    test(`ALLOW own update of ${field}`, async () => {
      await assertSucceeds(
        (await alice()).collection("agents").doc(ALICE_AGENT_DOC.id).update({ [field]: value })
      );
    });
  }

  for (const [field, value] of Object.entries({
    ...AGENT_PROTECTED,
    userId: BOB,
    id: "another-id",
    createdAt: new Date(),
  })) {
    test(`DENY own update of ${field}`, async () => {
      await assertFails(
        (await alice()).collection("agents").doc(ALICE_AGENT_DOC.id).update({ [field]: value })
      );
    });
  }

  test("DENY clearing own agencyId / agencyRole (leaving an agency goes through the API)", async () => {
    const ref = (await alice()).collection("agents").doc(ALICE_AGENT_DOC.id);
    await assertFails(ref.update({ agencyId: null }));
    await assertFails(ref.update({ agencyRole: null }));
  });

  test("DENY a protected field hidden in an otherwise valid update", async () => {
    await assertFails(
      (await alice()).collection("agents").doc(ALICE_AGENT_DOC.id).update({ bio: "hi", agencyRole: "owner" })
    );
  });

  test("DENY updating somebody else's agent profile", async () => {
    await assertFails((await bob()).collection("agents").doc(ALICE_AGENT_DOC.id).update({ bio: "defaced" }));
  });

  test("ALLOW an admin (by custom claim) to update any field, e.g. verification", async () => {
    const adminDb = await clientDb("admin-uid", { admin: true, role: "admin" });
    await assertSucceeds(
      adminDb.collection("agents").doc(ALICE_AGENT_DOC.id).update({ verificationStatus: "verified" })
    );
  });
});

describe("agents/{agentId}: create", () => {
  test("ALLOW creating an own agent profile from allow-listed fields", async () => {
    await assertSucceeds(
      (await bob())
        .collection("agents")
        .doc("agent-bob")
        .set({ ...AGENT_ALLOWED, id: "agent-bob", userId: BOB, createdAt: new Date() })
    );
  });

  for (const [field, value] of Object.entries(AGENT_PROTECTED)) {
    test(`DENY own create carrying ${field}`, async () => {
      await assertFails(
        (await bob())
          .collection("agents")
          .doc("agent-bob")
          .set({ id: "agent-bob", userId: BOB, displayName: "Bob", [field]: value })
      );
    });
  }

  test("DENY creating an agent profile for another user", async () => {
    await assertFails(
      (await bob()).collection("agents").doc("agent-x").set({ userId: ALICE, displayName: "Not Alice" })
    );
  });
});

// ============================================
// agencyInvitations/{id}
// ============================================

describe("agencyInvitations: backend-only writes", () => {
  test("DENY creating an invitation from a client, whoever the inviter claims to be", async () => {
    const invitation = {
      agencyId: AGENCY,
      invitedBy: BOB,
      invitedEmail: BOB_EMAIL,
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await assertFails((await bob()).collection("agencyInvitations").doc("forged").set(invitation));
    // Even a signed-in agency owner (by claim) creates invitations via the API.
    const ownerDb = await clientDb(ALICE, { email: ALICE_EMAIL, role: "owner", agencyId: AGENCY });
    await assertFails(
      ownerDb.collection("agencyInvitations").doc("forged-2").set({ ...invitation, invitedBy: ALICE })
    );
  });

  test("DENY updating an invitation from a client (inviter and invitee alike)", async () => {
    await assertFails(
      (await alice()).collection("agencyInvitations").doc("invite-1").update({ invitedEmail: ALICE_EMAIL })
    );
    await assertFails((await bob()).collection("agencyInvitations").doc("invite-1").update({ status: "accepted" }));
  });

  test("ALLOW the inviter to read their invitation (reads are unchanged)", async () => {
    await assertSucceeds((await alice()).collection("agencyInvitations").doc("invite-1").get());
  });
});
