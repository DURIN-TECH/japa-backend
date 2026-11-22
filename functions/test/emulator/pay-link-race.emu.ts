// ============================================
// Emulator test: guest pay-again links under REAL Firestore transactions (issue #391)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, a
// `demo-` project, the real Express app over HTTP). Paystack is the
// in-process stub below: no real charge or refund. The pay-again email is
// caught by replacing `payLinkRuntime.sendEmail`.
//
// The unit tests (test/consultations/consultation-pay-link.test.ts) run
// transactions one at a time on an in-memory store. Only real Firestore
// transactions show that, at the same time:
//  - several settles of the late payment mint ONE link and send ONE email;
//  - several mints leave at most ONE live link per booking;
//  - two checkout calls on one link open ONE Paystack checkout;
//  - several settles of the link's checkout confirm once and set `usedAt` once.
// It also checks the routes over real HTTP: the dead-link 410, and that the
// token is refused as a sign-in token by an authenticated route.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount } from "./helpers";
import { fakeClock, makeService } from "../money/helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const accounts: Record<string, TestAccount> = {};
const tokens: Record<string, string> = {};
/** reference -> what the stubbed Paystack verify reports. */
const reports = new Map<string, any>();
/** Every stubbed Paystack initialize call (our reference). */
const charges: string[] = [];
/** Every pay-again email (url carries the raw token). */
const emails: Array<{ url: string }> = [];
let restore: () => void = () => undefined;

/** The charge path's clock (fixed; rates are dated to it). */
const clock = fakeClock(new Date().toISOString());
/** The charge of the first checkout: ₦9,000.00 in kobo ($6 at ₦1,500). */
const FEE = 900_000;
/** The agency's public slug. */
const SLUG = "emu-sunrise";

/** A signed-in account with role claims and a user doc. */
async function principal(name: string, claims: Record<string, unknown>): Promise<void> {
  const account = await signUp(name);
  const { auth, collections } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  accounts[name] = account;
  tokens[name] = await refreshIdToken(account);
  await collections.users.doc(account.uid).set({ id: account.uid, email: account.email, firstName: name, lastName: "T" });
}

/**
 * An UNPAID GUEST booking (`bookedVia: "public_page"`) whose checkout
 * `cons-<id>-ref` was opened and whose quote lock passed an hour ago (so the
 * agent may reschedule it). Paystack reports that checkout PAID, exactly,
 * with a known fee (the refund starts).
 */
async function seedGuestPastLock(id: string): Promise<string> {
  const { collections } = await import("../../src/utils/firebase");
  const now = clock.now().getTime();
  const day = new Date(now + 7 * 86_400_000);
  const dayUtc = Timestamp.fromDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())));
  const reference = `cons-${id}-ref`;
  await collections.consultations.doc(id).set({
    id, userId: accounts.uguest.uid, agentId: accounts.uagent.uid, agencyId: "emu-agency", bookedVia: "public_page",
    clientName: "Guest", clientEmail: accounts.uguest.email, agentName: "uagent", type: "initial", scheduledDate: dayUtc,
    scheduledTime: "10:00", durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment",
    paymentStatus: "pending", priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: FEE,
    fxRate: 1500, fxRateAsOf: Timestamp.fromMillis(now - 7_200_000), fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(now - 5_400_000), quoteExpiresAt: Timestamp.fromMillis(now - 3_600_000),
    transactionId: reference, checkoutUrl: `https://checkout.paystack.test/${reference}`,
    createdAt: Timestamp.fromMillis(now - 7_200_000), updatedAt: Timestamp.fromMillis(now - 7_200_000),
  });
  reports.set(reference, {
    status: "success", metadata: { purpose: "consultation", consultationId: id },
    amount: FEE, currency: "NGN", paidAt: clock.now().toISOString(), fees: 15_000,
  });
  return reference;
}

/** Every stored pay link of booking `id`. */
async function linksOf(id: string): Promise<any[]> {
  const { collections } = await import("../../src/utils/firebase");
  return (await collections.consultationPayLinks.where("consultationId", "==", id).get()).docs.map((d) => d.data());
}

/** The raw token of the last pay-again email. */
function lastToken(): string {
  const url = emails.at(-1)!.url;
  return url.slice(url.indexOf("#t=") + 3);
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();

  // ---- Rates and clock: in-memory, fixed ----
  const { chargeRuntime } = await import("../../src/services/charge-checkout.service");
  const { paystackProvider } = await import("../../src/services/billing/paystack.provider");
  const { payLinkRuntime } = await import("../../src/services/consultation-pay-link.service");
  const { service, store: rates } = makeService({ config: { defaultCurrency: "NGN", currencies: {} }, clock });
  const at = clock.now();
  rates.docs.set("NGN", { currency: "NGN", provider: { rate: 1500, asOf: at, fetchedAt: at, source: "cbn" }, override: null, lastError: null } as any);
  const ps = paystackProvider as any;
  const saved = {
    rates: chargeRuntime.rates,
    now: chargeRuntime.now,
    initializeCharge: ps.initializeCharge,
    getTransactionMetadata: ps.getTransactionMetadata,
    createRefund: ps.createRefund,
    findRefundsForTransaction: ps.findRefundsForTransaction,
    sendEmail: payLinkRuntime.sendEmail,
  };
  chargeRuntime.rates = async () => service;
  chargeRuntime.now = () => clock.now();

  // ---- Paystack: recorders, never the network ----
  ps.initializeCharge = async (input: { reference: string }) => {
    charges.push(input.reference);
    // A little latency, so parallel requests really overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, reference: input.reference };
  };
  ps.getTransactionMetadata = async (reference: string) => reports.get(reference) ?? null;
  let counter = 0;
  ps.createRefund = async (input: { reference: string; amount: { amountMinor: number; currency: string } }) => ({
    id: String(++counter), status: "pending", transactionReference: input.reference,
    amount: input.amount.amountMinor, currency: input.amount.currency,
  });
  ps.findRefundsForTransaction = async () => [];
  // ---- The pay-again email: recorded, never sent ----
  payLinkRuntime.sendEmail = async (m) => {
    emails.push({ url: m.url });
    return "sent";
  };
  restore = () => {
    chargeRuntime.rates = saved.rates;
    chargeRuntime.now = saved.now;
    ps.initializeCharge = saved.initializeCharge;
    ps.getTransactionMetadata = saved.getTransactionMetadata;
    ps.createRefund = saved.createRefund;
    ps.findRefundsForTransaction = saved.findRefundsForTransaction;
    payLinkRuntime.sendEmail = saved.sendEmail;
  };

  await principal("uagent", { role: "agent", agencyId: null, admin: false });
  await principal("uguest", { role: "client", agencyId: null, admin: false });
  const { collections } = await import("../../src/utils/firebase");
  await collections.agencies.doc("emu-agency").set({ id: "emu-agency", name: "Emu Sunrise", slug: SLUG, ownerId: accounts.uagent.uid, status: "approved" });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

describe("guest pay-again links under concurrency (#391)", () => {
  test("end to end: concurrent settles mint one link; concurrent checkouts open one; concurrent settles use it once", async () => {
    const reference = await seedGuestPastLock("pl1");
    const moved = await api.call("PUT", "/consultations/pl1", tokens.uagent, { scheduledTime: "12:00" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    // ---- The late payment lands from four places at once ----
    const { settlePayment } = await import("../../src/services/consultation-charge.service");
    await Promise.all([
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
      api.call("POST", "/consultations/public/verify", undefined, { reference }),
      settlePayment("pl1", reference, reports.get(reference)),
      settlePayment("pl1", reference, reports.get(reference)),
    ]);
    let links = await linksOf("pl1");
    assert.equal(links.length, 1, "one link");
    assert.equal(emails.length, 1, "one email");
    const token = lastToken();
    assert.ok(emails[0].url.includes(`/a/${SLUG}/pay#t=`), "the token rides in the URL fragment");
    // From here on, every log line is captured (the request logger included).
    const lines: string[] = [];
    const realLog = console.log;
    const realErr = console.error;
    const realWarn = console.warn;
    const grab = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.log = grab;
    console.error = grab;
    console.warn = grab;
    try {
      assert.ok(!JSON.stringify(links).includes(token), "only the hash is stored");

      // ---- The token is not a sign-in token anywhere ----
      const asBearer = await api.call("GET", "/consultations/pl1", token);
      assert.equal(asBearer.status, 401, "refused by an authenticated route");

      // ---- GET over HTTP ----
      const got = await api.call("POST", "/consultations/public/pay-links/lookup", undefined, { token });
      assert.equal(got.status, 200, JSON.stringify(got.body));
      assert.equal(got.body.data.agencyName, "Emu Sunrise");
      assert.equal(got.body.data.scheduledTime, "12:00");

      // ---- Two checkouts at once: one Paystack checkout ----
      const before = charges.length;
      const [a, b] = await Promise.all([
        api.call("POST", "/consultations/public/pay-links/checkout", undefined, { token }),
        api.call("POST", "/consultations/public/pay-links/checkout", undefined, { token }),
      ]);
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200, JSON.stringify(b.body));
      assert.equal(charges.length - before, 1, "one checkout");
      assert.equal(a.body.data.authorizationUrl, b.body.data.authorizationUrl);

      // ---- The guest pays it; it settles from four places at once ----
      const newRef = charges.at(-1)!;
      reports.set(newRef, {
        status: "success", metadata: { purpose: "consultation", consultationId: "pl1", agencySlug: SLUG },
        amount: a.body.data.chargedAmountMinor, currency: a.body.data.chargedCurrency, paidAt: clock.now().toISOString(), fees: 15_000,
      });
      const outcomes = await Promise.all([
        api.call("POST", "/consultations/public/verify", undefined, { reference: newRef }),
        api.call("POST", "/consultations/public/verify", undefined, { reference: newRef }),
        settlePayment("pl1", newRef, reports.get(newRef)),
        settlePayment("pl1", newRef, reports.get(newRef)),
      ]);
      const kinds = (outcomes.slice(2) as any[]).map((o) => o.kind);
      assert.ok(kinds.every((k) => k === "confirmed" || k === "already_paid"));
      const { collections } = await import("../../src/utils/firebase");
      const booking = (await collections.consultations.doc("pl1").get()).data()!;
      assert.equal(booking.paymentStatus, "paid");
      const fees = (await collections.transactions.where("consultationId", "==", "pl1").get()).docs
        .map((d) => d.data())
        .filter((t) => t.type === "consultation_fee");
      assert.equal(fees.length, 1, "one confirmation");
      links = await linksOf("pl1");
      assert.ok(links[0].usedAt, "used");
      assert.equal(links[0].usedByReference, newRef);

      // ---- Dead now: the same 410 on both routes ----
      const dead = await api.call("POST", "/consultations/public/pay-links/lookup", undefined, { token });
      const deadPost = await api.call("POST", "/consultations/public/pay-links/checkout", undefined, { token });
      const unknown = await api.call("POST", "/consultations/public/pay-links/lookup", undefined, { token: "B".repeat(43) });
      for (const r of [dead, deadPost, unknown]) {
        assert.equal(r.status, 410);
        assert.deepEqual(r.body, dead.body);
      }
      assert.equal(dead.body.error, "PAY_LINK_INVALID");
      const malformed = await api.call("POST", "/consultations/public/pay-links/lookup", undefined, { token: "nope" });
      assert.equal(malformed.status, 400);
      // The old path shapes no longer exist.
      const oldPath = await api.call("GET", `/consultations/public/pay-links/${token}`);
      assert.equal(oldPath.status, 404);
    } finally {
      console.log = realLog;
      console.error = realErr;
      console.warn = realWarn;
    }
    assert.ok(lines.some((l) => l.includes("POST /consultations/public/pay-links/lookup")), "the request logger ran");
    // The 404 above logged its own path (it was a test of the old shape); every other line is token-free.
    const others = lines.filter((l) => !l.startsWith("GET /consultations/public/pay-links/"));
    assert.ok(!others.join("\n").includes(token), "no token in any log line");
  });

  test("three mints at once leave exactly one live link", async () => {
    const reference = await seedGuestPastLock("pl2");
    const moved = await api.call("PUT", "/consultations/pl2", tokens.uagent, { scheduledTime: "12:00" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const { mintPayLink } = await import("../../src/services/consultation-pay-link.service");
    const minted = await Promise.all([mintPayLink("pl2", reference), mintPayLink("pl2", reference), mintPayLink("pl2", reference)]);
    assert.ok(minted.every((m) => m), "each mint committed (retried on fresh data)");
    const links = await linksOf("pl2");
    assert.equal(links.length, 3);
    assert.equal(links.filter((l) => !l.usedAt && !l.supersededAt).length, 1, "one live link");
    // Only the live one answers 200.
    const answers = await Promise.all(minted.map((m) => api.call("POST", "/consultations/public/pay-links/lookup", undefined, { token: m!.token })));
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 410, 410]);
  });
});
