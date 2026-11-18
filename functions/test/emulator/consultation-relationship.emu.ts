// ============================================
// Emulator tests — what counts as an agent-client relationship (issue #321)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators, the real
// Express app, real ID tokens, the REAL Firestore query engine).
//
// The unit suite (test/consultations/consultation-agent-booking-relationship
// .test.ts) covers the same rules on an in-memory fake. These tests exist
// because two of the rules lean on real Firestore behaviour the fake only
// imitates:
//  - the PAID lookup is `orderBy("paidAt")`, which works only because
//    Firestore leaves a document WITHOUT the ordered field out of the result
//    (a free booking is stored `paymentStatus: "paid"` with no `paidAt`);
//  - the client-message lookup is a two-equality query on the `messages`
//    subcollection of each conversation of the pair.
//
// The agent flow of `POST /consultations` is called for a client with exactly
// ONE link to the agent, a counting and a non-counting case per source:
//   guest booking (public page): unpaid, free -> 403; paid -> 201
//   booking made by an agent:    unpaid, free -> 403; paid -> 201
//   booking made by the client:  free -> 201
//   row from before #321:        unpaid -> 403; paid -> 201
//   conversation:                agent-started, no client message -> 403;
//                                client message / client-started -> 201
// plus the two end-to-end checks written in the issue (a FREE guest booking
// through the real public route; an agent opening a conversation with a
// stranger's uid and writing in it), and the ids Firestore refuses (400).
//
// The agents here have NO consultation fee, so an allowed booking is free:
// 201 with no Paystack call (the emulator run has no payment provider).
// (The emulator does not enforce composite indexes; the two the paid lookup
// needs are in firestore.indexes.json.)

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { resetEmulators, rulesEnv, RunningApi, startApi, TestAccount, withoutRules } from "./helpers";
import { put, seedAgency, seedClient, seedMember, SeededAgency, SeededAgent, stored } from "./agency-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
/** The agency every case books under, and its member agent (the caller). */
let agency: SeededAgency;
let member: SeededAgent;

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();
  agency = await seedAgency("r321");
  member = await seedMember(agency, "r321-member");
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

// ============================================
// Helpers
// ============================================

let counter = 0;
/** A unique document id for a seeded row. */
function uid(prefix: string): string {
  return `${prefix}-r321-${Date.now()}-${++counter}`;
}

/** The agent flow of POST /consultations: `member` books for `clientUid`. */
async function book(clientUid: unknown, extra: Record<string, unknown> = {}, token = member.account.idToken) {
  return api.call("POST", "/consultations", token, {
    userId: clientUid,
    type: "initial",
    scheduledDate: "2027-02-01",
    scheduledTime: "10:00",
    ...extra,
  });
}

/** Every consultation of `clientUid` (rules off). */
async function consultationsOf(clientUid: string): Promise<any[]> {
  const out: any[] = [];
  await withoutRules(async (db) => {
    const snap = await db.collection("consultations").where("userId", "==", clientUid).get();
    snap.forEach((d: any) => out.push(d.data()));
  });
  return out;
}

/** An earlier consultation of `client` with `member` (by uid) under the agency, plus `fields`. */
async function seedConsultation(client: TestAccount, fields: Record<string, unknown>): Promise<string> {
  const id = uid("consult");
  await put("consultations", id, {
    id,
    userId: client.uid,
    agentId: member.account.uid,
    agencyId: agency.agencyId,
    clientName: "Test User",
    clientEmail: client.email,
    agentName: "Member",
    type: "initial",
    scheduledDate: new Date("2026-12-01T10:00:00Z"),
    scheduledTime: "10:00",
    durationMinutes: 30,
    timezone: "Africa/Lagos",
    status: "scheduled",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return id;
}

/** A conversation between `client` and `member` (agent DOCUMENT id), plus `fields`. */
async function seedConversation(client: TestAccount, fields: Record<string, unknown>): Promise<string> {
  const id = uid("conv");
  await put("conversations", id, {
    id,
    userId: client.uid,
    agentId: member.agentDocId,
    lastMessageAt: new Date(),
    unreadCountUser: 0,
    unreadCountAgent: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return id;
}

/** A message in a conversation, as the API stores one. */
async function seedMessage(conversationId: string, senderId: string, senderType: "user" | "agent"): Promise<void> {
  const id = uid("msg");
  await withoutRules(async (db) => {
    await db.collection("conversations").doc(conversationId).collection("messages").doc(id).set({
      id, conversationId, senderId, senderType, content: "hello", isRead: false, createdAt: new Date(),
    });
  });
}

/** 403 FORBIDDEN, and no booking was written for the client beyond the `seeded` ones. */
async function assertRefused(res: { status: number; body: any }, client: TestAccount, seeded: number, label: string) {
  assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, "FORBIDDEN", label);
  assert.equal((await consultationsOf(client.uid)).length, seeded, `${label}: nothing written`);
  // The refusal names nobody.
  assert.ok(!JSON.stringify(res.body).includes(client.email), label);
}

/** 201: a free booking by the agent for the client, stored as agent-made. */
async function assertBooked(res: { status: number; body: any }, client: TestAccount, label: string) {
  assert.equal(res.status, 201, `${label}: ${JSON.stringify(res.body)}`);
  const saved = await stored("consultations", res.body.data.id);
  assert.deepEqual(
    { userId: saved.userId, agentId: saved.agentId, agencyId: saved.agencyId, bookedVia: saved.bookedVia },
    { userId: client.uid, agentId: member.account.uid, agencyId: agency.agencyId, bookedVia: "agent" },
    label
  );
}

// ============================================
// Earlier consultations
// ============================================

describe("#321 an earlier consultation counts only if the client booked it or it was paid", () => {
  /** [label, stored fields, does it count?] */
  const CASES: Array<[string, Record<string, unknown>, boolean]> = [
    ["guest booking, unpaid", { bookedVia: "public_page", status: "pending_payment", paymentStatus: "pending", priceUsdCents: 1000 }, false],
    ["guest booking, free", { bookedVia: "public_page", paymentStatus: "paid", priceUsdCents: 0 }, false],
    ["guest booking, paid", { bookedVia: "public_page", paymentStatus: "paid", priceUsdCents: 1000, paidAt: new Date() }, true],
    ["agent-made, unpaid", { bookedVia: "agent", status: "pending_payment", paymentStatus: "pending", priceUsdCents: 1000 }, false],
    ["agent-made, free", { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 0 }, false],
    ["agent-made, paid", { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 1000, paidAt: new Date() }, true],
    ["client-made, free", { bookedVia: "client", paymentStatus: "paid", priceUsdCents: 0 }, true],
    ["before #321 (no bookedVia), unpaid", { status: "pending_payment", paymentStatus: "pending" }, false],
    ["before #321 (no bookedVia), paid", { status: "completed", paymentStatus: "paid", paidAt: new Date() }, true],
  ];

  for (const [label, fields, counts] of CASES) {
    test(`${label}: ${counts ? "201" : "403"}`, async () => {
      const client = await seedClient(uid("c"));
      await seedConsultation(client, fields);
      const res = await book(client.uid);
      if (counts) await assertBooked(res, client, label);
      else await assertRefused(res, client, 1, label);
    });
  }

  test("an agency booking (a colleague's, paid) counts for the member through the agency", async () => {
    const client = await seedClient(uid("c"));
    await seedConsultation(client, {
      agentId: agency.owner.uid, bookedVia: "public_page", paymentStatus: "paid", priceUsdCents: 1000, paidAt: new Date(),
    });
    await assertBooked(await book(client.uid), client, "agency paid booking");
  });

  test("free bookings next to a paid one do not hide it (real orderBy on paidAt)", async () => {
    const client = await seedClient(uid("c"));
    // Free bookings are `paymentStatus: "paid"` with NO paidAt.
    for (let i = 0; i < 5; i++) await seedConsultation(client, { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 0 });
    await assertRefused(await book(client.uid), client, 5, "free only");
    await seedConsultation(client, { bookedVia: "agent", paymentStatus: "paid", priceUsdCents: 1000, paidAt: new Date() });
    await assertBooked(await book(client.uid), client, "free + paid");
  });

  test("the agent's own free booking does not unlock the next one", async () => {
    // First booking through a real link (a conversation the client started)...
    const client = await seedClient(uid("c"));
    const convId = await seedConversation(client, { startedBy: "user" });
    const first = await book(client.uid);
    await assertBooked(first, client, "first booking");
    // ...then that link goes away: the free agent-made booking alone is not one.
    await withoutRules(async (db) => {
      await db.collection("conversations").doc(convId).delete();
    });
    await assertRefused(await book(client.uid), client, 1, "own free booking");
  });
});

// ============================================
// The public page (the real route)
// ============================================

describe("#321 a free guest booking from the public page is not a relationship", () => {
  test("guest-book a free consultation for an existing client's email, then the agency's agent books for that uid: 403, nothing written", async () => {
    const client = await seedClient(uid("c"));
    // Anyone can type the client's email into the agency's public form (no auth).
    const guest = await api.call("POST", `/agencies/public/${agency.agencyId}/consultations`, undefined, {
      clientName: "Some Body",
      clientEmail: client.email,
      scheduledDate: "2027-02-01",
      scheduledTime: "09:00",
    });
    assert.equal(guest.status, 201, JSON.stringify(guest.body));
    const [saved] = await consultationsOf(client.uid);
    // It landed on the EXISTING account, under the agency, free, marked as a guest booking.
    assert.deepEqual(
      {
        userId: saved.userId, agencyId: saved.agencyId, priceUsdCents: saved.priceUsdCents,
        paymentStatus: saved.paymentStatus, paidAt: saved.paidAt ?? null, bookedVia: saved.bookedVia,
      },
      {
        userId: client.uid, agencyId: agency.agencyId, priceUsdCents: 0,
        paymentStatus: "paid", paidAt: null, bookedVia: "public_page",
      }
    );

    // A member of the agency, and its owner (the guest booking's own agent), are both refused.
    await assertRefused(await book(client.uid), client, 1, "member after a free guest booking");
    await assertRefused(await book(client.uid, {}, agency.owner.idToken), client, 1, "owner after a free guest booking");
  });
});

// ============================================
// Conversations
// ============================================

describe("#321 a conversation counts only if the client started it or wrote in it", () => {
  test("seeded: agent-started with only agent messages: 403; with a client message: 201", async () => {
    const client = await seedClient(uid("c"));
    const convId = await seedConversation(client, { startedBy: "agent" });
    await seedMessage(convId, member.account.uid, "agent");
    await assertRefused(await book(client.uid), client, 0, "agent messages only");
    await seedMessage(convId, client.uid, "user");
    await assertBooked(await book(client.uid), client, "client message");
  });

  test("seeded: a conversation from before #321 (no startedBy) counts only once the client has written", async () => {
    const client = await seedClient(uid("c"));
    const convId = await seedConversation(client, {});
    await assertRefused(await book(client.uid), client, 0, "legacy, empty");
    // A "user" message that is NOT the client's does not count.
    await seedMessage(convId, member.account.uid, "user");
    await assertRefused(await book(client.uid), client, 0, "legacy, not the client's message");
    await seedMessage(convId, client.uid, "user");
    await assertBooked(await book(client.uid), client, "legacy, client wrote");
  });

  test("seeded: a client-started conversation counts with no message", async () => {
    const client = await seedClient(uid("c"));
    await seedConversation(client, { startedBy: "user" });
    await assertBooked(await book(client.uid), client, "client-started");
  });

  test("the real routes: an agent opens a conversation with a stranger's uid and sends a message, then books: 403", async () => {
    const stranger = await seedClient(uid("c"));
    const opened = await api.call("POST", "/conversations", member.account.idToken, { participantId: stranger.uid });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const convId: string = opened.body.data.id;
    const sent = await api.call("POST", `/conversations/${convId}/messages`, member.account.idToken, { content: "Hello, book with me" });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    const conv = await stored("conversations", convId);
    assert.deepEqual(
      { userId: conv.userId, agentId: conv.agentId, startedBy: conv.startedBy },
      { userId: stranger.uid, agentId: member.agentDocId, startedBy: "agent" }
    );
    await assertRefused(await book(stranger.uid), stranger, 0, "agent-opened conversation");

    // Once the client really answers, it is a relationship.
    const reply = await api.call("POST", `/conversations/${convId}/messages`, stranger.idToken, { content: "Hi" });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    await assertBooked(await book(stranger.uid), stranger, "after the client replied");
  });

  test("the real routes: a conversation the client opens is stored startedBy user, and the agent may book", async () => {
    const client = await seedClient(uid("c"));
    const opened = await api.call("POST", "/conversations", client.idToken, { participantId: member.agentDocId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal((await stored("conversations", opened.body.data.id)).startedBy, "user");
    await assertBooked(await book(client.uid), client, "client-opened conversation");
  });
});

// ============================================
// Strangers and bad ids
// ============================================

describe("#321 strangers and ids Firestore refuses", () => {
  test("a stranger and a uid that does not exist get the same 403", async () => {
    const stranger = await seedClient(uid("c"));
    const a = await book(stranger.uid);
    const b = await book("uid-that-does-not-exist");
    assert.equal(a.status, 403);
    assert.deepEqual(b, a);
  });

  test("a userId or applicationId of '.', '..', '__x__' or over 1500 bytes is 400 VALIDATION_ERROR, never 500", async () => {
    const client = await seedClient(uid("c"));
    await seedConversation(client, { startedBy: "user" });
    for (const bad of [".", "..", "__x__", "__name__", "a/b", "x".repeat(1501)]) {
      const label = bad.length > 20 ? `${bad.length} chars` : bad;
      const asUser = await book(bad);
      assert.deepEqual({ status: asUser.status, error: asUser.body.error }, { status: 400, error: "VALIDATION_ERROR" }, `userId ${label}`);
      const asApp = await book(client.uid, { applicationId: bad });
      assert.deepEqual({ status: asApp.status, error: asApp.body.error }, { status: 400, error: "VALIDATION_ERROR" }, `applicationId ${label}`);
    }
    assert.equal((await consultationsOf(client.uid)).length, 0, "nothing written");
  });
});
