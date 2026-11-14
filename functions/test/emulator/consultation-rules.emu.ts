// ============================================
// Emulator test — consultations are written by the backend only (issue #180)
// ============================================
//
// Run with `npm run test:emulator` (the repo's real firestore.rules loaded by
// the Firestore emulator, exercised through @firebase/rules-unit-testing).
//
// Why: a consultation carries the money its client is charged (the charge
// snapshot, the quote lock), the Paystack reference that settles it, its
// superseded checkouts and its payment status. Before this fix any signed-in
// user could CREATE a consultation for themselves with any of those fields
// (e.g. already `paymentStatus: "paid"`), and the booking's client or agent
// could UPDATE it (e.g. mark it paid, or lower `chargedAmountMinor` before
// paying). That bypassed the whole server-side charge path.
//
// Pinned here:
//  1. reads are unchanged: the booking's client, its agent (agent claim +
//     the agents doc's userId) and an admin can read it; another client and
//     a signed-out visitor cannot;
//  2. create, update and delete are refused for the client, the agent, an
//     admin and a signed-out visitor, including the money-path updates
//     (`paymentStatus: "paid"`, `chargedAmountMinor`, `supersededCheckouts`)
//     and a create that claims to be paid;
//  3. the stored booking is unchanged afterwards;
//  4. transactions stay read-only for clients (the fee Transaction).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { anonymousDb, clientDb, isDenied, resetEmulators, rulesEnv, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** The booking's client, their agent's account, another client, an admin. */
const CLIENT = "cr-client";
const AGENT_UID = "cr-agent";
const OTHER = "cr-other";
const ADMIN = "cr-admin";
/** The agent DOC id (a consultation's `agentId` is the agents doc id). */
const AGENT_DOC = "cr-agent-doc";
const BOOKING = "cr-booking";

/** Token claims as the backend sets them. */
const CLAIMS: Record<string, Record<string, unknown>> = {
  [CLIENT]: { role: "client", agencyId: null, admin: false },
  [OTHER]: { role: "client", agencyId: null, admin: false },
  [AGENT_UID]: { role: "agent", agencyId: "cr-agency", admin: false, agent: true },
  [ADMIN]: { role: "admin", agencyId: null, admin: true },
};

/** A pending #180 booking awaiting payment. */
const PENDING = {
  id: BOOKING,
  userId: CLIENT,
  agentId: AGENT_DOC,
  clientName: "Chi Client",
  clientEmail: "delivered+client@resend.dev",
  agentName: "Ada Agent",
  type: "initial",
  scheduledTime: "10:00",
  status: "pending_payment",
  paymentStatus: "pending",
  priceUsdCents: 1_000,
  chargedCurrency: "NGN",
  chargedAmountMinor: 1_500_000,
  transactionId: "cons-crbooking-ref",
};

/** Firestore as `uid` would see it from a client SDK. */
const as = (uid: string) => clientDb(uid, CLAIMS[uid]);

before(async () => {
  await resetEmulators();
  await withoutRules(async (db) => {
    await db.collection("agents").doc(AGENT_DOC).set({ id: AGENT_DOC, userId: AGENT_UID });
    await db.collection("consultations").doc(BOOKING).set(PENDING);
    await db.collection("transactions").doc("cr-tx").set({ id: "cr-tx", userId: CLIENT, amount: 1_500_000, currency: "NGN" });
  });
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

// ============================================
// 1. Reads unchanged
// ============================================

describe("consultation reads are unchanged", () => {
  for (const [who, uid] of [["the booking's client", CLIENT], ["its agent", AGENT_UID], ["an admin", ADMIN]] as const) {
    test(`${who} can read the booking`, async () => {
      const snap = await (await as(uid)).collection("consultations").doc(BOOKING).get();
      assert.equal(snap.data().chargedAmountMinor, 1_500_000);
    });
  }

  test("another client and a signed-out visitor cannot read it", async () => {
    assert.equal(await isDenied((await as(OTHER)).collection("consultations").doc(BOOKING).get()), true);
    assert.equal(await isDenied((await anonymousDb()).collection("consultations").doc(BOOKING).get()), true);
  });
});

// ============================================
// 2. Writes refused for every client principal
// ============================================

describe("consultation writes are backend only", () => {
  /** Each money-path update a client SDK might try. */
  const UPDATES: Array<[string, Record<string, unknown>]> = [
    ["mark it paid", { paymentStatus: "paid", status: "scheduled" }],
    ["lower the amount charged", { chargedAmountMinor: 1 }],
    ["plant a superseded checkout", { supersededCheckouts: [{ reference: "fake", chargedAmountMinor: 1, chargedCurrency: "NGN" }] }],
    ["swap the Paystack reference", { transactionId: "someone-elses-ref" }],
    ["a harmless-looking field", { meetingLink: "https://meet.example.test/x" }],
  ];

  for (const [who, uid] of [["the booking's client", CLIENT], ["its agent", AGENT_UID], ["an admin", ADMIN]] as const) {
    for (const [what, data] of UPDATES) {
      test(`${who} cannot update it to ${what}`, async () => {
        const db = await as(uid);
        assert.equal(await isDenied(db.collection("consultations").doc(BOOKING).update(data)), true);
      });
    }

    test(`${who} cannot create a consultation, even one claiming to be paid`, async () => {
      const db = await as(uid);
      const own = { ...PENDING, id: `cr-new-${uid}`, userId: uid, paymentStatus: "paid", status: "scheduled", chargedAmountMinor: 1 };
      assert.equal(await isDenied(db.collection("consultations").doc(own.id).set(own)), true);
      // An auto-id create too (Firestore refuses `undefined`, so drop `id`).
      const { id: _id, ...withoutId } = own;
      void _id;
      assert.equal(await isDenied(db.collection("consultations").add(withoutId)), true);
    });

    test(`${who} cannot delete it`, async () => {
      const db = await as(uid);
      assert.equal(await isDenied(db.collection("consultations").doc(BOOKING).delete()), true);
    });
  }

  test("a signed-out visitor cannot create, update or delete", async () => {
    const db = await anonymousDb();
    assert.equal(await isDenied(db.collection("consultations").doc("cr-anon").set({ ...PENDING, id: "cr-anon" })), true);
    assert.equal(await isDenied(db.collection("consultations").doc(BOOKING).update({ paymentStatus: "paid" })), true);
    assert.equal(await isDenied(db.collection("consultations").doc(BOOKING).delete()), true);
  });

  test("the stored booking is unchanged after every refused write", async () => {
    let stored: any;
    await withoutRules(async (db) => {
      stored = (await db.collection("consultations").doc(BOOKING).get()).data();
    });
    assert.deepEqual(stored, PENDING);
  });
});

// ============================================
// 3. Transactions stay read-only for clients
// ============================================

describe("fee transactions stay read-only for clients", () => {
  test("the client reads their own transaction but cannot write one", async () => {
    const db = await as(CLIENT);
    assert.equal((await db.collection("transactions").doc("cr-tx").get()).data().amount, 1_500_000);
    assert.equal(await isDenied(db.collection("transactions").doc("cr-tx").update({ amount: 1 })), true);
    assert.equal(
      await isDenied(db.collection("transactions").doc("cr-tx2").set({ id: "cr-tx2", userId: CLIENT, amount: 1 })),
      true
    );
    assert.equal(await isDenied(db.collection("transactions").doc("cr-tx").delete()), true);
  });
});
