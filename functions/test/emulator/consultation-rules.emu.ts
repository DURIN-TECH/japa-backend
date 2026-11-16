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
//  1. reads (issue #332): the booking's CLIENT can no longer read it
//     directly, by id or by a query on their own `userId`. The document
//     holds Seli's exchange-rate markup (fxMarginBps) and the raw rate, on
//     the booking and on every `supersededCheckouts` entry, and rules cannot
//     hide single fields; clients read through GET /consultations, which
//     gives the allow-listed view. Its agent (agent claim + the agents doc's
//     userId) and an admin can still read it; another client, another agent
//     and a signed-out visitor cannot;
//  2. create, update and delete are refused for the client, the agent, an
//     admin and a signed-out visitor, including the money-path updates
//     (`paymentStatus: "paid"`, `chargedAmountMinor`, `supersededCheckouts`)
//     and a create that claims to be paid;
//  3. the stored booking is unchanged afterwards;
//  4. the fee Transaction cannot be read or written by the client at all
//     (issue #329: transactions are backend-only; the app reads its payment
//     history through GET /transactions).

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
/** (#332) An agent who is NOT this booking's agent (their own agents doc). */
const OTHER_AGENT_UID = "cr-other-agent";
/** The agent DOC id (a consultation's `agentId` is the agents doc id). */
const AGENT_DOC = "cr-agent-doc";
const BOOKING = "cr-booking";

/** Token claims as the backend sets them. */
const CLAIMS: Record<string, Record<string, unknown>> = {
  [CLIENT]: { role: "client", agencyId: null, admin: false },
  [OTHER]: { role: "client", agencyId: null, admin: false },
  [AGENT_UID]: { role: "agent", agencyId: "cr-agency", admin: false, agent: true },
  [ADMIN]: { role: "admin", agencyId: null, admin: true },
  [OTHER_AGENT_UID]: { role: "agent", agencyId: "cr-agency-2", admin: false, agent: true },
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
  // (#332) What a direct client read would give away: the raw rate and
  // Seli's markup, on the booking and on a replaced checkout.
  fxRate: 1463.41,
  fxRateSource: "cbn",
  fxMarginBps: 250,
  supersededCheckouts: [
    { reference: "cons-crbooking-old", priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: 1_490_000, fxRate: 1453.66, fxMarginBps: 250 },
  ],
  transactionId: "cons-crbooking-ref",
};

/** Firestore as `uid` would see it from a client SDK. */
const as = (uid: string) => clientDb(uid, CLAIMS[uid]);

before(async () => {
  await resetEmulators();
  await withoutRules(async (db) => {
    await db.collection("agents").doc(AGENT_DOC).set({ id: AGENT_DOC, userId: AGENT_UID });
    await db.collection("agents").doc("cr-other-agent-doc").set({ id: "cr-other-agent-doc", userId: OTHER_AGENT_UID });
    await db.collection("consultations").doc(BOOKING).set(PENDING);
    await db.collection("transactions").doc("cr-tx").set({ id: "cr-tx", userId: CLIENT, amount: 1_500_000, currency: "NGN" });
  });
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

// ============================================
// 1. Reads: closed to the client, unchanged for the agent side (issue #332)
// ============================================

describe("consultation reads: the client is refused, the agent side is unchanged", () => {
  test("the booking's client cannot read their own booking by id", async () => {
    // Before #332 this read succeeded and returned fxMarginBps and fxRate.
    assert.equal(await isDenied((await as(CLIENT)).collection("consultations").doc(BOOKING).get()), true);
  });

  test("the booking's client cannot list or query their own bookings either", async () => {
    const db = await as(CLIENT);
    // The query a client SDK would use for "my consultations".
    assert.equal(await isDenied(db.collection("consultations").where("userId", "==", CLIENT).get()), true);
    assert.equal(await isDenied(db.collection("consultations").get()), true);
    // A filter on the hidden field must not work as an oracle for it.
    assert.equal(
      await isDenied(db.collection("consultations").where("userId", "==", CLIENT).where("fxMarginBps", "==", 250).get()),
      true
    );
  });

  test("a client holding a forged-looking role claim but no agent claim is still refused", async () => {
    // The agent branch needs the `agent` claim AND the agents doc's userId;
    // the client has neither for this booking.
    const db = await clientDb(CLIENT, { role: "client", agencyId: null, admin: false, agent: false });
    assert.equal(await isDenied(db.collection("consultations").doc(BOOKING).get()), true);
  });

  for (const [who, uid] of [["its agent", AGENT_UID], ["an admin", ADMIN]] as const) {
    test(`${who} can still read the booking, snapshot included`, async () => {
      const snap = await (await as(uid)).collection("consultations").doc(BOOKING).get();
      assert.equal(snap.data().chargedAmountMinor, 1_500_000);
      // The agent side keeps the full document (unchanged by #332).
      assert.equal(snap.data().fxMarginBps, 250);
    });
  }

  test("another client, another agent and a signed-out visitor cannot read it", async () => {
    assert.equal(await isDenied((await as(OTHER)).collection("consultations").doc(BOOKING).get()), true);
    assert.equal(await isDenied((await as(OTHER_AGENT_UID)).collection("consultations").doc(BOOKING).get()), true);
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
// 3. Transactions are closed to clients
// ============================================

describe("fee transactions are closed to clients", () => {
  test("the client can neither read their own transaction nor write one", async () => {
    const db = await as(CLIENT);
    // (#329) Before: the payer could read the whole document (markup, raw
    // rate, agent ids). Now a direct read is refused, own document or not.
    assert.equal(await isDenied(db.collection("transactions").doc("cr-tx").get()), true);
    assert.equal(await isDenied(db.collection("transactions").where("userId", "==", CLIENT).get()), true);
    assert.equal(await isDenied(db.collection("transactions").doc("cr-tx").update({ amount: 1 })), true);
    assert.equal(
      await isDenied(db.collection("transactions").doc("cr-tx2").set({ id: "cr-tx2", userId: CLIENT, amount: 1 })),
      true
    );
    assert.equal(await isDenied(db.collection("transactions").doc("cr-tx").delete()), true);
  });
});
