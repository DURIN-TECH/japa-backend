// ============================================
// Rules unit tests — agencies and applications (issue #138)
// ============================================
//
// Run with `npm run test:emulator`. Uses @firebase/rules-unit-testing against
// the Firestore emulator, which has loaded the repo's real ../firestore.rules.
//
// Both collections are written by the backend (Admin SDK, through the API):
// no portal or mobile code writes either of them from a client SDK.
//  - agencies: the owner may write ONLY the owner-editable profile fields
//    (the same allow-list as AGENCY_OWNER_EDITABLE_FIELDS / PUT
//    /agencies/me). Every other field is server-written, one field at a time:
//    review-gated (`status`, `compliance`, `reviewedBy/At`), authority
//    anchors (`ownerId`, `ownerName`, `slug`), counters (`totalAgents`),
//    server-managed (`logoUrl`, timestamps) and any field added later.
//    Creation is backend-only.
//  - applications: creation and every update are backend-only; no signed-in
//    user (the applicant, the assigned agent, a stranger) can write any field.
// The "allow" side of the application's editable fields (userNotes /
// agentNotes) is the API's job. The agency equivalent is tested both here
// (the rule) and in agency-authority.emu.ts (PUT /agencies/me).
//
// The field lists are spelled out here on purpose (not imported from the
// rules or the services): the test is the independent statement of what a
// client must and must not be able to write.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";

import { clientDb, rulesEnv, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

const OWNER = "owner-uid";
const OWNER_EMAIL = "delivered+owner@resend.dev";
const MEMBER = "member-uid";
const APPLICANT = "applicant-uid";
const STRANGER = "stranger-uid";
const AGENCY = "agency-1";
const APP = "application-1";

/** The agency as the backend writes it (pending review, compliance started). */
const AGENCY_DOC = {
  id: AGENCY,
  name: "Agency One",
  slug: "agency-one",
  ownerId: OWNER,
  ownerName: "Olu Owner",
  address: "1 Marina Road",
  state: "Lagos",
  description: "Study visas",
  logoUrl: "https://storage.googleapis.com/bucket/agency-logos/agency-1/logo.png",
  consultationFeeUsd: { amountMinor: 10000, currency: "USD" },
  services: [{ id: "s1", name: "Study visa", priceUsd: { amountMinor: 5000, currency: "USD" } }],
  totalAgents: 2,
  totalCases: 3,
  activeCases: 1,
  status: "pending_review",
  compliance: { status: "in_progress", legalFirstName: "Olu" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/**
 * The fields the owner MAY write from a client SDK (issue #138). Spelled out
 * here on purpose, so a change to the rule has to be a change to this test
 * too. Issue #179: no money here any more (the API's PUT /agencies/me list
 * additionally has the validated `consultationFeeUsd` and `services`).
 */
const AGENCY_OWNER_EDITABLE_FIELDS: Record<string, unknown> = {
  name: "Renamed",
  address: "2 Other Street",
  state: "Abuja",
  description: "Changed",
};

/**
 * Issue #179 (closes #168): every MONEY field on an agency doc, with a value
 * a client might try. Only the API writes prices (it validates the dollar
 * amount), so the owner and a member are both denied each one.
 */
const AGENCY_MONEY_FIELDS: Array<[string, unknown]> = [
  ["consultationFeeUsd", { amountMinor: 1, currency: "USD" }],
  ["consultationFeeUsd.amountMinor", 1],
  ["consultationFee", 1],
  ["services", []],
  ["services", [{ id: "s1", name: "Study visa", priceUsd: { amountMinor: 1, currency: "USD" } }]],
  ["migratedFrom", { consultationFee: { amount: 1, currency: "NGN", rate: 1 } }],
];

/**
 * Every agency field a client must NOT be able to write, with a value a client
 * might try. Grouped only for the reader: the rule is hasOnly(the editable
 * list), so all of these are refused, known today or added later.
 */
const AGENCY_PROTECTED_FIELDS: Record<string, unknown> = {
  // ---- review-gated ----
  status: "approved",
  compliance: { status: "verified" },
  "compliance.status": "verified",
  "compliance.reviewedBy": "admin-uid",
  "compliance.settlementBank": { bankName: "X", accountNumber: "0000000000", accountName: "Me" },
  reviewedBy: "admin-uid",
  reviewedAt: new Date(),
  rejectionReason: "",
  // ---- authority anchors ----
  ownerId: STRANGER,
  ownerName: "Somebody Else",
  id: "agency-2",
  slug: "another-agency",
  agentIds: [STRANGER],
  // ---- counters (the seat check reads totalAgents) ----
  totalAgents: -50,
  totalCases: 0,
  activeCases: 0,
  // ---- server-managed ----
  createdAt: new Date(),
  updatedAt: new Date(),
  logoUrl: "https://example.invalid/x.png",
  // ---- a field nobody has thought of yet ----
  somethingNew: true,
};

/** The application as the backend writes it. `agentId` is the agent's USER uid. */
const APPLICATION_DOC = {
  id: APP,
  userId: APPLICANT,
  agentId: MEMBER,
  agencyId: AGENCY,
  visaTypeId: "visa-1",
  countryCode: "IE",
  mode: "agent",
  status: "submitted",
  paymentStatus: "pending",
  totalFee: 500000,
  amountPaid: 0,
  createdVia: "portal",
  userNotes: "",
  agentNotes: "",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/** Every application field a client might try to write. */
const APPLICATION_FIELDS: Record<string, unknown> = {
  // ---- review / progress ----
  status: "approved",
  currentStep: "Decision",
  nextStep: "None",
  rejectionReason: "",
  // ---- assignment (who may see and handle the case) ----
  agentId: STRANGER,
  agencyId: "agency-2",
  mode: "self",
  userId: STRANGER,
  createdVia: "portal",
  // ---- payment ----
  paymentStatus: "paid",
  totalFee: 0,
  amountPaid: 500000,
  // ---- denormalised display fields ----
  clientName: "Somebody Else",
  clientEmail: "delivered+else@resend.dev",
  // ---- editable, but only through PUT /applications/:id ----
  userNotes: "hello",
  agentNotes: "hello",
  updatedAt: new Date(),
  // ---- a field nobody has thought of yet ----
  somethingNew: true,
};

/** Client Firestore handles for each actor (custom claims as the backend sets them). */
const asOwner = () => clientDb(OWNER, { email: OWNER_EMAIL, role: "owner", agencyId: AGENCY });
const asMember = () => clientDb(MEMBER, { role: "agent", agencyId: AGENCY, agent: true });
const asApplicant = () => clientDb(APPLICANT, { role: "client" });
const asStranger = () => clientDb(STRANGER, { role: "client" });
const asAdmin = () => clientDb("admin-uid", { role: "admin", admin: true });

before(async () => {
  await rulesEnv();
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

beforeEach(async () => {
  await (await rulesEnv()).clearFirestore();
  await withoutRules(async (db) => {
    await db.collection("agencies").doc(AGENCY).set(AGENCY_DOC);
    await db.collection("applications").doc(APP).set(APPLICATION_DOC);
    // The assigned agent's profile: the application read rule looks it up.
    await db.collection("agents").doc(MEMBER).set({ id: MEMBER, userId: MEMBER, agencyId: AGENCY, agencyRole: "agent" });
    await db
      .collection("applications")
      .doc(APP)
      .collection("notes")
      .doc("note-1")
      .set({ id: "note-1", authorId: APPLICANT, content: "original" });
    await db
      .collection("applications")
      .doc(APP)
      .collection("timeline")
      .doc("t-1")
      .set({ id: "t-1", status: "submitted" });
  });
});

// ============================================
// agencies/{agencyId}
// ============================================

describe("agencies/{agencyId}: the owner may edit exactly the owner-editable profile", () => {
  /** Read the stored agency with rules off (what the write actually saved). */
  async function storedAgency(): Promise<Record<string, unknown>> {
    let data: Record<string, unknown> = {};
    await withoutRules(async (db) => {
      const snap = await db.collection("agencies").doc(AGENCY).get();
      data = snap.data() ?? {};
    });
    return data;
  }

  for (const [field, value] of Object.entries(AGENCY_OWNER_EDITABLE_FIELDS)) {
    test(`ALLOW the owner updating ${field}`, async () => {
      await assertSucceeds((await asOwner()).collection("agencies").doc(AGENCY).update({ [field]: value }));
      assert.deepEqual((await storedAgency())[field], value);
    });
  }

  test("ALLOW several owner-editable fields in one update, leaving everything else alone", async () => {
    await assertSucceeds(
      (await asOwner()).collection("agencies").doc(AGENCY).update({
        name: "Renamed",
        address: "2 Other Street",
        description: "Changed",
      })
    );
    const after = await storedAgency();
    assert.equal(after.name, "Renamed");
    assert.equal(after.address, "2 Other Street");
    assert.equal(after.description, "Changed");
    // The prices are untouched (issue #179).
    assert.deepEqual(after.consultationFeeUsd, AGENCY_DOC.consultationFeeUsd);
    assert.deepEqual(after.services, AGENCY_DOC.services);
    // The protected fields are untouched.
    assert.equal(after.status, AGENCY_DOC.status);
    assert.equal(after.ownerId, OWNER);
    assert.equal(after.totalAgents, AGENCY_DOC.totalAgents);
  });
});

describe("agencies/{agencyId}: every other field is server-written", () => {
  for (const [field, value] of Object.entries(AGENCY_PROTECTED_FIELDS)) {
    test(`DENY the owner updating ${field}`, async () => {
      await assertFails((await asOwner()).collection("agencies").doc(AGENCY).update({ [field]: value }));
    });
  }

  test("DENY a protected field hidden in an otherwise allowed update", async () => {
    await assertFails(
      (await asOwner()).collection("agencies").doc(AGENCY).update({ description: "hi", status: "approved" })
    );
    await assertFails(
      (await asOwner())
        .collection("agencies")
        .doc(AGENCY)
        .update({ name: "Renamed", totalAgents: -50 })
    );
  });

  test("DENY removing a review-gated field by overwriting the document", async () => {
    const { compliance: _dropped, ...withoutCompliance } = AGENCY_DOC;
    void _dropped;
    await assertFails((await asOwner()).collection("agencies").doc(AGENCY).set(withoutCompliance));
  });

  test("DENY a member or a stranger updating the agency", async () => {
    await assertFails((await asMember()).collection("agencies").doc(AGENCY).update({ name: "Mine now" }));
    await assertFails((await asStranger()).collection("agencies").doc(AGENCY).update({ ownerId: STRANGER }));
    // Even an otherwise owner-editable field.
    await assertFails((await asMember()).collection("agencies").doc(AGENCY).update({ description: "hi" }));
  });

  test("DENY a signed-in non-owner who happens to hold the owner claim of this agency", async () => {
    // The rule reads the RECORD (resource.data.ownerId), not the claim: a
    // stale or forged claim must not turn into write access.
    const forged = await clientDb(STRANGER, { role: "owner", agencyId: AGENCY });
    await assertFails(forged.collection("agencies").doc(AGENCY).update({ name: "Mine now" }));
  });
});

describe("agencies/{agencyId}: money fields are API-only (issue #179, closes #168)", () => {
  for (const [field, value] of AGENCY_MONEY_FIELDS) {
    test(`DENY the owner writing ${field} (${JSON.stringify(value).slice(0, 40)})`, async () => {
      await assertFails((await asOwner()).collection("agencies").doc(AGENCY).update({ [field]: value }));
    });
    test(`DENY a member agent writing ${field} (${JSON.stringify(value).slice(0, 40)})`, async () => {
      await assertFails((await asMember()).collection("agencies").doc(AGENCY).update({ [field]: value }));
    });
  }

  test("DENY a price hidden in an otherwise allowed owner update", async () => {
    await assertFails(
      (await asOwner())
        .collection("agencies")
        .doc(AGENCY)
        .update({ description: "hi", consultationFeeUsd: { amountMinor: 1, currency: "USD" } })
    );
  });

  test("DENY the owner and a member writing a per-visa price (backend-only subcollection)", async () => {
    for (const who of [asOwner, asMember]) {
      const ref = (await who()).collection("agencies").doc(AGENCY).collection("visaPrices").doc("GB__uk-student");
      await assertFails(
        ref.set({ id: "GB__uk-student", agencyId: AGENCY, priceUsd: { amountMinor: 1, currency: "USD" } })
      );
      await assertFails(ref.set({ id: "GB__uk-student", agencyId: AGENCY, price: 1 }));
    }
  });
});

describe("agencies/{agencyId}: create is backend-only", () => {
  test("DENY a signed-in user creating an agency that names them as owner", async () => {
    await assertFails(
      (await asStranger()).collection("agencies").doc("agency-new").set({
        id: "agency-new",
        name: "New",
        ownerId: STRANGER,
        ownerName: "Me",
        services: [],
        totalAgents: 1,
        status: "pending_review",
      })
    );
  });

  for (const [field, value] of Object.entries({
    status: "approved",
    compliance: { status: "verified" },
    ownerId: STRANGER,
    ownerName: "Someone",
    totalAgents: 0,
    totalCases: 0,
    reviewedBy: "admin-uid",
    slug: "taken",
    logoUrl: "https://example.invalid/x.png",
  })) {
    test(`DENY a client create carrying ${field}`, async () => {
      await assertFails(
        (await asStranger())
          .collection("agencies")
          .doc("agency-new")
          .set({ id: "agency-new", name: "New", [field]: value })
      );
    });
  }

  test("DENY even the minimal create: only the owner-editable profile", async () => {
    await assertFails(
      (await asStranger())
        .collection("agencies")
        .doc("agency-new")
        .set({ name: "New", address: "1 Road", services: [] })
    );
  });
});

describe("agencies/{agencyId}: reads and deletes are unchanged", () => {
  test("ALLOW the owner to read their agency", async () => {
    await assertSucceeds((await asOwner()).collection("agencies").doc(AGENCY).get());
  });

  test("ALLOW an admin (by custom claim) to read any agency", async () => {
    await assertSucceeds((await asAdmin()).collection("agencies").doc(AGENCY).get());
  });

  test("DENY a stranger reading the agency (it holds the compliance file)", async () => {
    await assertFails((await asStranger()).collection("agencies").doc(AGENCY).get());
  });

  test("DENY the owner deleting the agency", async () => {
    await assertFails((await asOwner()).collection("agencies").doc(AGENCY).delete());
  });
});

// ============================================
// applications/{applicationId}
// ============================================

describe("applications/{applicationId}: update is backend-only", () => {
  for (const [field, value] of Object.entries(APPLICATION_FIELDS)) {
    test(`DENY the applicant updating ${field}`, async () => {
      await assertFails((await asApplicant()).collection("applications").doc(APP).update({ [field]: value }));
    });
  }

  for (const field of ["status", "agentId", "agencyId", "paymentStatus", "amountPaid", "userId"]) {
    test(`DENY the assigned agent updating ${field}`, async () => {
      await assertFails(
        (await asMember()).collection("applications").doc(APP).update({ [field]: APPLICATION_FIELDS[field] })
      );
    });
  }

  test("DENY a stranger updating the application", async () => {
    await assertFails((await asStranger()).collection("applications").doc(APP).update({ agentId: STRANGER }));
  });
});

describe("applications/{applicationId}: create is backend-only", () => {
  test("DENY a signed-in user creating their own application from a client", async () => {
    await assertFails(
      (await asStranger())
        .collection("applications")
        .doc("application-new")
        .set({ id: "application-new", userId: STRANGER, visaTypeId: "visa-1", status: "draft" })
    );
  });

  for (const [field, value] of Object.entries({
    status: "approved",
    paymentStatus: "paid",
    agentId: MEMBER,
    agencyId: AGENCY,
  })) {
    test(`DENY a client create carrying ${field}`, async () => {
      await assertFails(
        (await asStranger())
          .collection("applications")
          .doc("application-new")
          .set({ id: "application-new", userId: STRANGER, [field]: value })
      );
    });
  }
});

describe("applications/{applicationId}: reads are unchanged", () => {
  test("ALLOW the applicant to read their own application", async () => {
    await assertSucceeds((await asApplicant()).collection("applications").doc(APP).get());
  });

  test("ALLOW the assigned agent to read it", async () => {
    await assertSucceeds((await asMember()).collection("applications").doc(APP).get());
  });

  test("DENY a stranger reading it", async () => {
    await assertFails((await asStranger()).collection("applications").doc(APP).get());
  });

  test("DENY the applicant deleting it from a client", async () => {
    await assertFails((await asApplicant()).collection("applications").doc(APP).delete());
  });
});

// ============================================
// applications/{id}/notes and /timeline
// ============================================

describe("applications/{id}/notes and /timeline: writes are backend-only", () => {
  test("DENY a stranger adding a note to somebody else's application", async () => {
    await assertFails(
      (await asStranger())
        .collection("applications")
        .doc(APP)
        .collection("notes")
        .doc("note-x")
        .set({ id: "note-x", authorId: STRANGER, content: "pay this account instead" })
    );
  });

  test("DENY the applicant adding, editing or deleting a note from a client", async () => {
    const notes = (await asApplicant()).collection("applications").doc(APP).collection("notes");
    await assertFails(notes.doc("note-y").set({ id: "note-y", authorId: APPLICANT, content: "hi" }));
    await assertFails(notes.doc("note-1").update({ content: "edited", authorName: "Your agent" }));
    await assertFails(notes.doc("note-1").delete());
  });

  test("DENY an agent-side user writing a timeline entry from a client", async () => {
    await assertFails(
      (await asMember())
        .collection("applications")
        .doc(APP)
        .collection("timeline")
        .doc("t-x")
        .set({ id: "t-x", status: "approved" })
    );
  });

  test("ALLOW the applicant to read the notes and the timeline of their own application (unchanged)", async () => {
    const app = (await asApplicant()).collection("applications").doc(APP);
    await assertSucceeds(app.collection("notes").doc("note-1").get());
    await assertSucceeds(app.collection("timeline").doc("t-1").get());
  });
});
