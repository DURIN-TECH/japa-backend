// ============================================
// Unit tests: guest "pay again" links after a rescheduled refund (issue #391)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (charges, lookups and refunds are recorders; no real
// money moves), a fixed clock the tests move. The pay-again email is caught
// by replacing `payLinkRuntime.sendEmail` (the one place the raw token goes).
//
// What is covered, by acceptance criterion:
//  - MINT: a guest booking's `paid_for_rescheduled_slot` payment mints one
//    link and emails it (refund started, AND refund held for an admin); an
//    app client's booking gets no link and the usual notice; a held refund
//    started later by an admin mints only when no live link is left;
//  - STORAGE: only SHA-256 stored (doc id + tokenHash); the raw token is in
//    no Firestore doc, no notification, no log line, no API answer;
//  - EXPIRY: 72 h after minting, or the slot start when sooner; a newer link
//    kills the older one;
//  - EMAIL: copy ("we're refunding ... Your refund is on its way"), the
//    portal URL `<APP_URL>/a/<slug>/pay/<token>`, the expiry with its zone;
//    one email for a guest (the refund notice skips its own);
//  - GET: the booking-only summary + today's price, nothing else, no writes;
//  - POST checkout: priced now with a new lock, same checkout inside the
//    lock, re-priced after it (rate moved), confirm URL on the agency page;
//  - ONE USE: used only by a confirming payment (same commit); abandoning a
//    checkout does not use it;
//  - DEAD: one identical 410 for unknown / expired / used / superseded /
//    booking not pending_payment, nothing written; malformed 400 with no
//    Firestore read; 503 when no price;
//  - CONCURRENCY: two checkouts at once give one; two settlements give one
//    usedAt and one paid booking; two payments on one link (two checkouts)
//    give one confirmation and the other follows #354's rules;
//  - the rate limiter and the log redaction.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import {
  useHarness, harness, docsIn, seed, paystackPaid, paystackAbandoned, captureRes, setRate, dropRate, T0,
} from "./harness";
import { store, writes } from "../helpers/fake-firestore";
import {
  adminRefund, admin, agent, bookingOf, client, edit, FEE_NGN, refOf, refundRows, setStatus, SLOT_DAY, SLOT_TIME, SLOT_ZONE,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { consultationPayLinkController } from "../../src/controllers/consultation-pay-link.controller";
import { settlePayment } from "../../src/services/consultation-charge.service";
import {
  describeExpiry,
  hashPayLinkToken,
  isWellFormedPayLinkToken,
  mintPayLink,
  PAY_LINK_INVALID_MESSAGE,
  payLinkExpiry,
  payLinkRuntime,
  PayLinkEmail,
  redactPayLinkPath,
} from "../../src/services/consultation-pay-link.service";
import { createPublicRateLimit } from "../../src/middleware/public-rate-limit";
import { EMAIL_BRANDING } from "../../src/services/email/branding";
import type { Money } from "../../src/types/money";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup: record notifications, emails and every log line
// ============================================

/** Every notification sent during a test (with its channels). */
const notified: Array<{ userId: string; type: string; body: string; channels?: string[] }> = [];
/** Every pay-again email sent during a test. */
const emails: PayLinkEmail[] = [];
/** Every console line during a test (to prove no raw token is logged). */
const logs: string[] = [];
const real = { log: console.log, error: console.error, warn: console.warn };
const realSendEmail = payLinkRuntime.sendEmail;

/** The agency of every booking here, with its public slug. */
const SLUG = "sunrise-visas";

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async (n: any) => {
    notified.push({ userId: n.userId, type: n.type, body: n.body, channels: n.channels });
  };
});
beforeEach(async () => {
  harness.reset();
  notified.length = 0;
  emails.length = 0;
  logs.length = 0;
  payLinkRuntime.sendEmail = async (m) => {
    emails.push(m);
  };
  const capture = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  await seed("agencies", "agency-a", { name: "Sunrise Visas", slug: SLUG, ownerId: "uid-owner-a", status: "approved" });
});
afterEach(() => {
  console.log = real.log;
  console.error = real.error;
  console.warn = real.warn;
  payLinkRuntime.sendEmail = realSendEmail;
});

// ============================================
// Helpers
// ============================================

/**
 * Seed an UNPAID, priced booking `id` with an OPEN checkout, locked for 30
 * minutes from "now". A GUEST booking (`bookedVia: "public_page"`) unless
 * `over` says otherwise.
 */
async function seedPending(id = "c1", over: Record<string, unknown> = {}): Promise<string> {
  const reference = refOf(id);
  await seed("consultations", id, {
    userId: client.uid, agentId: agent.uid, agencyId: "agency-a", bookedVia: "public_page",
    clientName: "Chi Guest", clientEmail: "delivered+guest1@resend.dev", clientPhone: "+2348000000000", agentName: "Ada Agent",
    type: "initial", scheduledDate: SLOT_DAY, scheduledTime: SLOT_TIME, durationMinutes: 30, timezone: SLOT_ZONE,
    status: "pending_payment", paymentStatus: "pending",
    priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: FEE_NGN.amountMinor,
    fxRate: 1500, fxRateAsOf: T0, fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: T0, quoteExpiresAt: Timestamp.fromMillis(T0.toMillis() + 30 * 60_000),
    transactionId: reference, checkoutUrl: `https://checkout.paystack.test/${reference}`,
    checkoutCallbackUrl: `${EMAIL_BRANDING.appUrl}/a/${SLUG}/confirm`,
    createdAt: T0, updatedAt: T0,
    ...over,
  });
  return reference;
}

/** POST /consultations/public/verify with `reference`. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

/** GET /consultations/public/pay-links/:token. */
async function getLink(token: string) {
  const { out, res } = captureRes();
  await consultationPayLinkController.getPayLink({ params: { token } } as any, res);
  return out;
}

/** POST /consultations/public/pay-links/:token/checkout. */
async function payLinkCheckout(token: string) {
  const { out, res } = captureRes();
  await consultationPayLinkController.checkout({ params: { token }, body: {} } as any, res);
  return out;
}

/**
 * The full #354 path: a guest booking rescheduled after its lock, then the
 * OLD checkout paid. Returns the retired reference. `fees` is Paystack's fee
 * on that charge (undefined: "Paystack reported none", the refund is held).
 */
async function lateGuestPayment(opts: { id?: string; fees?: number | undefined; to?: { date: string; time: string } } = {}) {
  const id = opts.id ?? "c1";
  const reference = await seedPending(id);
  harness.clock.advanceHours(1); // past the 30-minute quote lock
  const moved = await edit(agent, { scheduledDate: opts.to?.date ?? "2026-11-27", scheduledTime: opts.to?.time ?? "11:00" }, id);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  paystackPaid(reference, id, FEE_NGN, harness.clock.now(), "fees" in opts ? { fees: opts.fees } : {});
  const out = await verify(reference);
  assert.equal(out.status, 409, JSON.stringify(out.body));
  assert.equal(out.body.error, "CONSULTATION_RESCHEDULED");
  return reference;
}

/** The raw token of the last pay-again email (from its URL). */
function lastToken(): string {
  const url = emails.at(-1)!.url;
  return url.slice(url.lastIndexOf("/") + 1);
}

/** Every stored pay link, as [id, data]. */
function links(): Array<[string, Record<string, any>]> {
  return docsIn("consultationPayLinks");
}

/** Everything in the fake Firestore, as one string (to look for a raw token). */
function allStoredText(): string {
  return JSON.stringify([...store.entries()]);
}

/** Pay a checkout reference of booking `id` at its stored price, through verify. */
async function payCurrent(id = "c1") {
  const b = bookingOf(id)!;
  const charged: Money = { amountMinor: b.chargedAmountMinor, currency: b.chargedCurrency };
  paystackPaid(b.transactionId, id, charged);
  return verify(b.transactionId);
}

// ============================================
// Minting
// ============================================

describe("minting the link when a guest's late payment is recorded", () => {
  test("a guest booking gets one link, emailed to the portal page; the refund notice sends no second email", async () => {
    await lateGuestPayment();
    assert.equal(links().length, 1, "one link");
    assert.equal(emails.length, 1, "one pay-again email");
    const email = emails[0];
    assert.equal(email.to, "delivered+guest1@resend.dev");
    assert.equal(email.agencyId, "agency-a");
    const token = lastToken();
    assert.ok(isWellFormedPayLinkToken(token), "43 base64url chars (32 random bytes)");
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.equal(email.url, `${EMAIL_BRANDING.appUrl.replace(/\/+$/, "")}/a/${SLUG}/pay/${token}`);

    // The refund still runs as #354 built it (in full).
    assert.equal(refundRows().length, 1);
    assert.equal(refundRows()[0].amount, FEE_NGN.amountMinor);
    // The client's refund notice: in-app/push only (the guest's email is the pay-link one).
    const notice = notified.find((n) => n.userId === client.uid && n.type === "consultation_refunded")!;
    assert.ok(notice, "the refund notice still goes in-app");
    assert.deepEqual(notice.channels, ["in_app", "push"]);
  });

  test("the email copy says the refund is on its way and names the expiry with its timezone", async () => {
    await lateGuestPayment();
    const { payLinkEmailBody } = await import("../../src/services/consultation-pay-link.service");
    const body = payLinkEmailBody(emails[0].expiresText);
    assert.match(body, /^Your consultation moved, so we're refunding your payment in full\. Your refund is on its way\./);
    assert.match(body, /The link works for this booking only and expires on .+ \(Africa\/Lagos\)\.$/);
    // 72 h after the payment was recorded (now = 2026-11-13T10:00Z -> 16 Nov 10:00Z = 11:00 Lagos).
    assert.match(emails[0].expiresText, /^Monday,? 16 November 2026 at 11:00 \(Africa\/Lagos\)$/);
  });

  test("an app client's booking (not public_page) gets no link and the usual refund notice", async () => {
    const reference = await seedPending("c1", { bookedVia: "client" });
    harness.clock.advanceHours(1);
    assert.equal((await edit(agent, { scheduledDate: "2026-11-27", scheduledTime: "11:00" })).status, 200);
    paystackPaid(reference, "c1", FEE_NGN);
    assert.equal((await verify(reference)).status, 409);
    assert.equal(links().length, 0);
    assert.equal(emails.length, 0);
    const notice = notified.find((n) => n.userId === client.uid && n.type === "consultation_refunded")!;
    assert.equal(notice.body, "Your consultation moved, so we've refunded your payment in full. Please pay again for the new time.");
    assert.equal(notice.channels, undefined, "the policy's channels (email included), as before");
  });

  test("a refund HELD for an admin (fee unknown) still sends the link as soon as the payment is recorded", async () => {
    const reference = await lateGuestPayment({ fees: undefined });
    assert.equal(refundRows().length, 0, "held: no refund row");
    assert.equal(links().length, 1);
    assert.equal(emails.length, 1);
    // A webhook retry of the held exception sends nothing again.
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: undefined });
    await verify(reference);
    assert.equal(links().length, 1);
    assert.equal(emails.length, 1);
  });

  test("admin retry of a held refund: no new link while one is live; a new one once it expired", async () => {
    const reference = await lateGuestPayment({ fees: undefined });
    const refundId = (await import("../../src/money/refund-id")).refundDocId(reference);
    // Paystack now reports the fee: the admin retries.
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: 15_000 });
    const out = await adminRefund(admin, { refundId });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(refundRows().length, 1);
    assert.equal(links().length, 1, "the live link is kept (no second link)");
    assert.equal(emails.length, 1);
    // The refund notice then goes out as usual (with its own email).
    assert.equal(notified.filter((n) => n.type === "consultation_refunded" && n.userId === client.uid).at(-1)!.channels, undefined);
  });

  test("admin retry after the first link expired mints a fresh one", async () => {
    const reference = await lateGuestPayment({ fees: undefined });
    const refundId = (await import("../../src/money/refund-id")).refundDocId(reference);
    harness.clock.advanceHours(73);
    setRate("NGN", 1500); // a fresh rate (the stored one went stale over 73 h)
    paystackPaid(reference, "c1", FEE_NGN, harness.clock.now(), { fees: 15_000 });
    assert.equal((await adminRefund(admin, { refundId })).status, 200);
    assert.equal(links().length, 2);
    assert.equal(emails.length, 2);
    assert.equal((await getLink(lastToken())).status, 200, "the new link works");
  });

  test("no link when the booking was paid since (nothing left to pay for)", async () => {
    const reference = await seedPending();
    harness.clock.advanceHours(1);
    assert.equal((await edit(agent, { scheduledDate: "2026-11-27", scheduledTime: "11:00" })).status, 200);
    // A fresh checkout is opened and paid first...
    const { out, res } = captureRes();
    await consultationController.checkoutConsultation({ userId: client.uid, params: { id: "c1" }, body: {} } as any, res);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await payCurrent()).status, 200);
    // ...then the OLD one lands.
    paystackPaid(reference, "c1", FEE_NGN);
    await verify(reference);
    assert.equal(links().length, 0);
    assert.equal(emails.length, 0);
  });
});

// ============================================
// The real email sender (the branded template, no link in the audit row)
// ============================================

describe("the pay-again email", () => {
  test("goes through the branded template with the link as its button, and the audit row has no link", async () => {
    const { emailService } = await import("../../src/services/email/email.service");
    const firebase: any = await import("../../src/utils/firebase");
    const { fakeCollection } = await import("../helpers/fake-firestore");
    const realDeliveries = firebase.collections.notificationDeliveries;
    firebase.collections.notificationDeliveries = fakeCollection("notificationDeliveries");
    const realSend = (emailService as any).sendNotification;
    const sent: any[] = [];
    (emailService as any).sendNotification = async (m: any) => {
      sent.push(m);
      return { status: "sent", providerId: "re_1" };
    };
    payLinkRuntime.sendEmail = realSendEmail;
    try {
      await lateGuestPayment();
      assert.equal(sent.length, 1);
      const m = sent[0];
      const token = m.actionUrl.slice(m.actionUrl.lastIndexOf("/") + 1);
      assert.equal(m.to, "delivered+guest1@resend.dev");
      assert.equal(m.actionUrl, `${EMAIL_BRANDING.appUrl.replace(/\/+$/, "")}/a/${SLUG}/pay/${token}`);
      assert.equal(m.actionLabel, "Pay for the new time");
      assert.deepEqual(m.brandFor, { agencyId: "agency-a" });
      assert.match(m.body, /we're refunding your payment in full\. Your refund is on its way\./);
      assert.ok(!m.body.includes(token), "the body copy itself carries no token (the button does)");
      const rows = docsIn("notificationDeliveries").map(([, d]) => d);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "sent");
      assert.ok(!JSON.stringify(rows).includes(token), "the audit row has no link");
    } finally {
      (emailService as any).sendNotification = realSend;
      firebase.collections.notificationDeliveries = realDeliveries;
    }
  });
});

// ============================================
// Storage: hash only, raw token nowhere
// ============================================

describe("only the hash is stored", () => {
  test("doc id and tokenHash are the SHA-256; the raw token is in no doc, notification or log line", async () => {
    await lateGuestPayment();
    const token = lastToken();
    const [[id, link]] = links();
    assert.equal(id, hashPayLinkToken(token));
    assert.equal(link.tokenHash, id);
    assert.equal(link.consultationId, "c1");
    assert.equal(link.agencySlug, SLUG);
    assert.equal(link.usedAt, null);
    assert.equal(link.supersededAt, null);
    assert.ok(!allStoredText().includes(token), "not in Firestore");
    assert.ok(!JSON.stringify(notified).includes(token), "not in any notification");
    // Use it, then check the logs and the answers too.
    const got = await getLink(token);
    const opened = await payLinkCheckout(token);
    assert.ok(!JSON.stringify(got.body).includes(token));
    assert.ok(!JSON.stringify(opened.body).includes(token));
    assert.ok(!logs.join("\n").includes(token), "not in any log line");
    assert.ok(!allStoredText().includes(token), "still not in Firestore");
  });
});

// ============================================
// Expiry and replacement
// ============================================

describe("expiry and replacement", () => {
  test("pure: 72 h after minting, or the slot start when sooner; none once the slot started", () => {
    const booking = { scheduledDate: SLOT_DAY, scheduledTime: SLOT_TIME, timezone: SLOT_ZONE } as any; // starts 2026-11-20T09:00Z
    const far = new Date("2026-11-13T09:00:00Z");
    assert.equal(payLinkExpiry(booking, far)!.toISOString(), "2026-11-16T09:00:00.000Z");
    const near = new Date("2026-11-19T09:00:00Z");
    assert.equal(payLinkExpiry(booking, near)!.toISOString(), "2026-11-20T09:00:00.000Z", "capped at the slot start");
    assert.equal(payLinkExpiry(booking, new Date("2026-11-20T09:00:00Z")), null);
    assert.equal(payLinkExpiry({ scheduledTime: "10:00" } as any, far), null, "no readable slot: no link");
    assert.match(describeExpiry(new Date("2026-11-16T09:00:00Z"), "Africa/Lagos"), /^Monday,? 16 November 2026 at 10:00 \(Africa\/Lagos\)$/);
  });

  test("the stored expiry is 72 h out for a far slot, and the link dies after it", async () => {
    await lateGuestPayment();
    const [[, link]] = links();
    assert.equal(link.expiresAt.toMillis() - harness.clock.now().getTime(), 72 * 3_600_000);
    const token = lastToken();
    harness.clock.advanceHours(71);
    assert.equal((await getLink(token)).status, 200);
    harness.clock.advanceHours(1);
    assert.equal((await getLink(token)).status, 410);
  });

  test("moved to a slot sooner than 72 h: the link expires at the slot start", async () => {
    // Now is 2026-11-13T10:00Z after the lock passes; 14 Nov 11:00 Lagos = 10:00Z, 24 h later.
    await lateGuestPayment({ to: { date: "2026-11-14", time: "11:00" } });
    const [[, link]] = links();
    assert.equal(link.expiresAt.toDate().toISOString(), "2026-11-14T10:00:00.000Z");
  });

  test("a newer link kills the older one (at most one live link)", async () => {
    await lateGuestPayment();
    const first = lastToken();
    const minted = await mintPayLink("c1", "manual");
    assert.ok(minted);
    const second = minted!.token;
    const byId = new Map(links());
    assert.ok(byId.get(hashPayLinkToken(first))!.supersededAt, "older marked superseded");
    assert.equal(byId.get(hashPayLinkToken(second))!.supersededAt, null);
    assert.equal((await getLink(first)).status, 410);
    assert.equal((await getLink(second)).status, 200);
  });
});

// ============================================
// GET: the booking summary
// ============================================

describe("GET /consultations/public/pay-links/:token", () => {
  test("answers that booking only, priced now in the charge currency, and writes nothing", async () => {
    await lateGuestPayment();
    setRate("NGN", 1600); // the rate moved since the first checkout
    const before = writes.length;
    const out = await getLink(lastToken());
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(writes.length, before, "nothing written");
    const d = out.body.data;
    assert.deepEqual(Object.keys(d).sort(), [
      "agencyName", "agencySlug", "consultationType", "durationMinutes", "linkExpiresAt", "price",
      "scheduledDate", "scheduledTime", "startsAt", "timezone",
    ]);
    assert.equal(d.agencyName, "Sunrise Visas");
    assert.equal(d.agencySlug, SLUG);
    assert.equal(d.consultationType, "initial");
    assert.equal(d.scheduledDate, "2026-11-27T00:00:00.000Z", "the NEW date");
    assert.equal(d.scheduledTime, "11:00");
    assert.equal(d.timezone, "Africa/Lagos");
    assert.equal(d.startsAt, "2026-11-27T10:00:00.000Z");
    assert.equal(d.price.locked, false);
    assert.equal(d.price.priceUsdCents, 600);
    assert.equal(d.price.chargedCurrency, "NGN");
    assert.equal(d.price.chargedAmountMinor, 960_000, "$6 at today's ₦1,600");
    assert.equal(d.price.effectiveRate, 1600);
    assert.equal(d.price.quoteExpiresAt, null);
    // Nothing about anyone: no email, phone, ids, references, raw rate.
    const text = JSON.stringify(out.body);
    for (const leak of ["delivered+guest1", "+2348000000000", "uid-", "cons-", "c1", "fxRate", "fxMarginBps", "agency-a", "Chi Guest"]) {
      assert.ok(!text.includes(leak), `no ${leak}`);
    }
  });

  test("inside a checkout's quote lock the price shown IS that checkout's", async () => {
    await lateGuestPayment();
    const token = lastToken();
    const opened = await payLinkCheckout(token);
    assert.equal(opened.status, 200);
    setRate("NGN", 1700);
    const out = await getLink(token);
    assert.equal(out.body.data.price.locked, true);
    assert.equal(out.body.data.price.chargedAmountMinor, opened.body.data.chargedAmountMinor);
    assert.equal(out.body.data.price.quoteExpiresAt, opened.body.data.quoteExpiresAt);
  });

  test("no usable rate: 503 PRICING_UNAVAILABLE", async () => {
    await lateGuestPayment();
    dropRate("NGN");
    const out = await getLink(lastToken());
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "PRICING_UNAVAILABLE");
  });
});

// ============================================
// POST checkout
// ============================================

describe("POST /consultations/public/pay-links/:token/checkout", () => {
  test("opens a checkout on that booking at today's rate with a new lock, returning to the agency's confirm page", async () => {
    const oldRef = await lateGuestPayment();
    setRate("NGN", 1600);
    const charges = harness.charges.length;
    const out = await payLinkCheckout(lastToken());
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const d = out.body.data;
    assert.deepEqual(Object.keys(d).sort(), [
      "authorizationUrl", "chargedAmountMinor", "chargedCurrency", "effectiveRate", "priceUsdCents",
      "quoteExpiresAt", "quoteLockedAt", "requiresPayment", "reused",
    ]);
    assert.equal(d.requiresPayment, true);
    assert.equal(d.reused, false);
    assert.equal(harness.charges.length, charges + 1, "one Paystack checkout");
    const charge = harness.charges.at(-1)!;
    // The amount shown is the amount charged.
    assert.deepEqual(charge.amount, { amountMinor: d.chargedAmountMinor, currency: d.chargedCurrency });
    assert.equal(d.chargedAmountMinor, 960_000);
    assert.equal(d.priceUsdCents, 600);
    assert.equal(d.effectiveRate, 1600);
    assert.equal(charge.callbackUrl, `${EMAIL_BRANDING.appUrl}/a/${SLUG}/confirm`);
    assert.equal(charge.metadata?.consultationId, "c1");
    assert.equal(charge.metadata?.agencySlug, SLUG);
    assert.notEqual(charge.reference, oldRef);
    assert.equal(new Date(d.quoteExpiresAt).getTime() - harness.clock.now().getTime(), 30 * 60_000, "a new 30-minute lock");
    assert.equal(bookingOf("c1")!.transactionId, charge.reference, "on the same booking");
    assert.equal(docsIn("consultations").length, 1, "no second booking");
  });

  test("inside the lock: the same checkout, never a second; after it: a new one priced now", async () => {
    await lateGuestPayment();
    const token = lastToken();
    const first = await payLinkCheckout(token);
    const ref1 = bookingOf("c1")!.transactionId;
    paystackAbandoned(ref1, "c1");
    const again = await payLinkCheckout(token);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.reused, true);
    assert.equal(again.body.data.authorizationUrl, first.body.data.authorizationUrl);
    assert.equal(harness.charges.length, 1, "still one checkout");
    // The lock passes and the rate moves.
    harness.clock.advanceHours(1);
    setRate("NGN", 1800);
    const later = await payLinkCheckout(token);
    assert.equal(later.status, 200);
    assert.equal(later.body.data.reused, false);
    assert.notEqual(later.body.data.authorizationUrl, first.body.data.authorizationUrl);
    assert.equal(later.body.data.chargedAmountMinor, 1_080_000, "$6 at ₦1,800");
    assert.equal(harness.charges.length, 2);
  });

  test("a payment still in progress: 409 PAYMENT_IN_PROGRESS with the same checkout", async () => {
    await lateGuestPayment();
    const token = lastToken();
    const first = await payLinkCheckout(token);
    const { paystackStatus } = await import("./harness");
    paystackStatus(bookingOf("c1")!.transactionId, "c1", "ongoing");
    harness.clock.advanceHours(1);
    const out = await payLinkCheckout(token);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYMENT_IN_PROGRESS");
    assert.equal(out.body.data.authorizationUrl, first.body.data.authorizationUrl);
    assert.equal(harness.charges.length, 1);
  });

  test("no usable rate: 503, and no Paystack call", async () => {
    await lateGuestPayment();
    dropRate("NGN");
    const out = await payLinkCheckout(lastToken());
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "PRICING_UNAVAILABLE");
    assert.equal(harness.charges.length, 0);
  });
});

// ============================================
// One use
// ============================================

describe("used up only by a confirming payment", () => {
  test("abandoning the checkout leaves the link live; paying it uses it up in the same commit", async () => {
    await lateGuestPayment();
    const token = lastToken();
    assert.equal((await payLinkCheckout(token)).status, 200);
    paystackAbandoned(bookingOf("c1")!.transactionId, "c1");
    assert.equal((await getLink(token)).status, 200, "abandoned: still live");
    assert.equal(links()[0][1].usedAt, null);

    const paidRef = bookingOf("c1")!.transactionId;
    const paid = await payCurrent();
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    const b = bookingOf("c1")!;
    assert.equal(b.paymentStatus, "paid");
    assert.equal(b.status, "scheduled");
    const link = links()[0][1];
    assert.ok(link.usedAt, "usedAt set");
    assert.equal(link.usedAt.toMillis(), b.paidAt.toMillis(), "same commit as the confirmation");
    assert.equal(link.usedByReference, paidRef);
    assert.equal((await getLink(token)).status, 410);
    assert.equal((await payLinkCheckout(token)).status, 410);
  });

  test("a checkout paid but not yet verified is settled by the next POST, which uses the link", async () => {
    await lateGuestPayment();
    const token = lastToken();
    await payLinkCheckout(token);
    const b = bookingOf("c1")!;
    paystackPaid(b.transactionId, "c1", { amountMinor: b.chargedAmountMinor, currency: "NGN" });
    const out = await payLinkCheckout(token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.data, { requiresPayment: false, status: "scheduled" });
    assert.ok(links()[0][1].usedAt);
  });
});

// ============================================
// Dead links: one generic 410
// ============================================

describe("dead links", () => {
  test("unknown, expired, used, superseded and not-payable all answer the SAME 410 and write nothing", async () => {
    const bodies: Array<{ name: string; status: number; body: unknown; wrote: number }> = [];
    const probe = async (name: string, token: string) => {
      for (const call of [getLink, payLinkCheckout]) {
        const before = writes.length;
        const out = await call(token);
        bodies.push({ name, status: out.status, body: out.body, wrote: writes.length - before });
      }
    };

    // Unknown (well-formed, never minted).
    await probe("unknown", "A".repeat(43));

    // Superseded.
    await lateGuestPayment({ id: "c1" });
    const superseded = lastToken();
    await mintPayLink("c1", "manual");
    await probe("superseded", superseded);

    // Used (booking c2 paid through its link).
    await lateGuestPayment({ id: "c2" });
    const used = lastToken();
    await payLinkCheckout(used);
    await payCurrent("c2");
    await probe("used", used);

    // Booking cancelled (link itself unused and unexpired).
    await lateGuestPayment({ id: "c3" });
    const cancelled = lastToken();
    assert.equal((await setStatus(agent, "cancelled", "c3")).status, 200);
    await probe("cancelled", cancelled);

    // Expired.
    await lateGuestPayment({ id: "c4" });
    const expired = lastToken();
    harness.clock.advanceHours(73);
    await probe("expired", expired);

    const first = bodies[0];
    assert.equal(first.status, 410);
    assert.deepEqual(first.body, { success: false, error: "PAY_LINK_INVALID", message: PAY_LINK_INVALID_MESSAGE });
    for (const b of bodies) {
      assert.equal(b.status, 410, b.name);
      assert.deepEqual(b.body, first.body, `${b.name}: identical body`);
      assert.equal(b.wrote, 0, `${b.name}: nothing written`);
    }
  });

  test("a malformed token is 400 with no Firestore read", async () => {
    const firebase: any = await import("../../src/utils/firebase");
    const realLinks = firebase.collections.consultationPayLinks;
    let reads = 0;
    firebase.collections.consultationPayLinks = new Proxy(realLinks, {
      get(target, prop) {
        reads++;
        return target[prop];
      },
    });
    try {
      for (const bad of ["short", "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + "/", "A".repeat(42) + ".", ""]) {
        for (const call of [getLink, payLinkCheckout]) {
          const out = await call(bad);
          assert.equal(out.status, 400, bad);
          assert.equal(out.body.error, "VALIDATION_ERROR");
        }
      }
      assert.equal(reads, 0, "no Firestore access");
    } finally {
      firebase.collections.consultationPayLinks = realLinks;
    }
  });

  test("the token is useless anywhere else: another booking's id is never reachable through it", async () => {
    await lateGuestPayment({ id: "c1" });
    const token = lastToken();
    await seedPending("other", { clientEmail: "delivered+someone@resend.dev" });
    const out = await payLinkCheckout(token);
    assert.equal(out.status, 200);
    assert.equal(bookingOf("other")!.transactionId, refOf("other"), "the other booking is untouched");
    assert.equal(harness.charges.at(-1)!.metadata?.consultationId, "c1");
    assert.equal(harness.charges.at(-1)!.email, "delivered+guest1@resend.dev");
    // Not a Firebase ID token (no JWT shape): verifyAuth can never accept it.
    assert.ok(!token.includes("."));
  });
});

// ============================================
// Concurrency
// ============================================

describe("concurrency", () => {
  test("two checkout calls at once on one link give one checkout", async () => {
    await lateGuestPayment();
    const token = lastToken();
    const [a, b] = await Promise.all([payLinkCheckout(token), payLinkCheckout(token)]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(harness.charges.length, 1, "one Paystack checkout");
    assert.equal(a.body.data.authorizationUrl, b.body.data.authorizationUrl);
  });

  test("two settlements of the same payment give one usedAt and one paid booking", async () => {
    await lateGuestPayment();
    await payLinkCheckout(lastToken());
    const b = bookingOf("c1")!;
    const reported = {
      status: "success", metadata: { purpose: "consultation", consultationId: "c1" },
      amount: b.chargedAmountMinor, currency: "NGN", paidAt: harness.clock.now().toISOString(), fees: 0,
    } as any;
    const before = writes.length;
    const outcomes = await Promise.all([
      settlePayment("c1", b.transactionId, reported),
      settlePayment("c1", b.transactionId, reported),
    ]);
    assert.deepEqual(outcomes.map((o) => o!.kind).sort(), ["already_paid", "confirmed"]);
    const usedWrites = writes.slice(before).filter((w) => w.path.startsWith("consultationPayLinks/") && "usedAt" in w.data);
    assert.equal(usedWrites.length, 1, "usedAt written once");
    assert.equal(docsIn("transactions").filter(([, d]) => d.type === "consultation_fee").length, 1);
    assert.equal(bookingOf("c1")!.paymentStatus, "paid");
  });

  test("two payments on one link (two checkouts): one confirms, the other follows #354 (refunded, never a second fee)", async () => {
    await lateGuestPayment();
    const token = lastToken();
    // Checkout A, abandoned until the lock passed; checkout B replaces it.
    await payLinkCheckout(token);
    const refA = bookingOf("c1")!.transactionId;
    const chargeA: Money = { amountMinor: bookingOf("c1")!.chargedAmountMinor, currency: "NGN" };
    paystackAbandoned(refA, "c1");
    harness.clock.advanceHours(1);
    setRate("NGN", 1600);
    await payLinkCheckout(token);
    const refB = bookingOf("c1")!.transactionId;
    const chargeB: Money = { amountMinor: bookingOf("c1")!.chargedAmountMinor, currency: "NGN" };
    assert.notEqual(refA, refB);
    // The guest pays BOTH, and the two settle at once.
    paystackPaid(refA, "c1", chargeA);
    paystackPaid(refB, "c1", chargeB);
    const [va, vb] = await Promise.all([verify(refA), verify(refB)]);
    assert.ok([va.status, vb.status].every((s) => s === 200), JSON.stringify([va.body, vb.body]));
    const fees = docsIn("transactions").filter(([, d]) => d.type === "consultation_fee");
    assert.equal(fees.length, 1, "one confirmation");
    const exceptions = docsIn("consultationPaymentExceptions").map(([, d]) => d);
    // The first #354 exception (old slot) + exactly one for the second payment.
    const second = exceptions.filter((e) => e.reason === "paid_on_superseded_reference_after_booking_paid");
    assert.equal(second.length, 1, "the other payment is a recorded second charge");
    assert.equal(refundRows().length, 2, "the old-slot refund + the second-charge refund");
    const link = links()[0][1];
    assert.ok(link.usedAt);
    assert.equal(bookingOf("c1")!.paymentStatus, "paid");
  });
});

// ============================================
// The rate limit and the log redaction
// ============================================

describe("protections", () => {
  test("the per-IP limiter answers 429 past the limit and resets with the window", () => {
    let clock = 0;
    const limiter = createPublicRateLimit({ limit: 2, windowMs: 1000, now: () => clock });
    const run = (ip: string) => {
      const { out, res } = captureRes();
      (res as any).setHeader = () => undefined;
      let passed = false;
      limiter({ ip } as any, res, () => (passed = true));
      return passed ? 200 : out.status;
    };
    assert.deepEqual([run("1.1.1.1"), run("1.1.1.1"), run("1.1.1.1")], [200, 200, 429]);
    assert.equal(run("2.2.2.2"), 200, "per IP");
    clock = 1000;
    assert.equal(run("1.1.1.1"), 200, "a new window");
  });

  test("the request log never shows a token", () => {
    const token = "A".repeat(43);
    assert.equal(redactPayLinkPath(`/consultations/public/pay-links/${token}`), "/consultations/public/pay-links/[token]");
    assert.equal(
      redactPayLinkPath(`/consultations/public/pay-links/${token}/checkout`),
      "/consultations/public/pay-links/[token]/checkout"
    );
    assert.equal(redactPayLinkPath("/consultations/public/verify"), "/consultations/public/verify");
  });
});
