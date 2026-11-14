// ============================================
// Unit tests: admin rate HOLD and the #229 round-2 edge cases (issue #241)
// ============================================
//
// Hermetic: the in-memory rate service (test/money/helpers.ts), a small
// Express app over it for the routes, the real app for the admin gate, and
// the in-memory Firestore fake for the Firestore store. One `describe` per
// decision of the issue's plan:
//  1. PUT/DELETE /admin/exchange-rates/:currency/hold: validation, admin gate,
//     corrupt-map refusal, audit written with the change in one transaction
//  2. while held, the hold is the effective rate (outranks overrides);
//     refreshes still store the provider rate (same guards); provider
//     freshness does not stop a hold, its own expiry does
//  3. admin overview (held rate, expiry, reason, provider rate, gap, band
//     warning) and public GET /rates (rate only, cache cleared on change)
//  4. edge cases: a damaged provider map supersedes an unreferenced/legacy
//     override; reset-reference clears a superseded unreferenced override
//  5. the charge snapshot records fxRateSource "hold"
//  6. the Firestore store round-trips the hold and the extra audit entries
//  7. review round 1: override_set keeps the entered rate; damaged or
//     hand-edited holds are ignored for pricing, flagged, and clearable;
//     warning texts name the hold when it is what prices

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Timestamp } from "firebase-admin/firestore";
import { app } from "../../src/app";
import { auth } from "../../src/utils/firebase";
import * as firebase from "../../src/utils/firebase";
import { MoneyError } from "../../src/money/errors";
import { makeMoney } from "../../src/money/money";
import { quote, toChargeSnapshot } from "../../src/money/quote";
import { firestoreRateStore } from "../../src/money/stores";
import { createAdminExchangeRateRouter, createPublicRatesRouter } from "../../src/routes/exchange-rate.routes";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store as fakeDocs } from "../helpers/fake-firestore";
import { fakeClock, fakeProvider, makeService, memoryRateStore } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HOUR = 3_600_000;
const code = (e: unknown) => (e instanceof MoneyError ? e.code : "not-a-money-error");
const REASON = "CBN is lagging the market rate";
const usd = (cents: number) => makeMoney(cents, "USD");

/** Run `fn` with console.error and console.warn silenced. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
}

/** A CBN fake that answers `rate`, dated at the clock's current time. */
function cbnAt(clock: ReturnType<typeof fakeClock>, rate: number) {
  return { ok: true as const, rate, asOf: clock.now() };
}

/** A service whose CBN starts lagging at 1300, with that rate already stored. */
async function laggingCbn() {
  const clock = fakeClock();
  const cbn = fakeProvider("cbn", { result: { ok: true, rate: 1300, asOf: clock.now() } });
  const ctx = makeService({ clock, cbn });
  await ctx.service.refreshAll();
  return ctx;
}

// ---------------------------------------------------------------
// 1. Setting and clearing a hold: validation and audit
// ---------------------------------------------------------------
describe("setHold / clearHold validation and audit", () => {
  test("a valid hold is stored with its hold_set audit entry (who, when, old, new, reason, expiry)", async () => {
    const { service, store, clock } = await laggingCbn();
    const hold = await service.setHold("ngn", { rate: 1800, reason: REASON, ttlHours: 48 }, "admin-1");
    assert.equal(hold.rate, 1800);
    assert.equal(hold.expiresAt.getTime(), clock.now().getTime() + 48 * HOUR);
    assert.equal(store.docs.get("NGN")?.hold?.rate, 1800);
    const entry = store.audit.at(-1)!;
    assert.equal(entry.action, "hold_set");
    assert.equal(entry.by, "admin-1");
    assert.equal(entry.at.getTime(), clock.now().getTime());
    assert.equal(entry.reason, REASON);
    assert.deepEqual(entry.old, { rate: 1300, source: "cbn" });
    assert.deepEqual(entry.new, { rate: 1800, source: "hold" });
    assert.equal(entry.holdExpiresAt?.getTime(), hold.expiresAt.getTime());
  });

  test("reason must be 5-500 characters", async () => {
    const { service } = await laggingCbn();
    for (const reason of [undefined, 42, "four", "    abc   ", "x".repeat(501)]) {
      await assert.rejects(service.setHold("NGN", { rate: 1800, reason, ttlHours: 24 }, "a"), (e) => code(e) === "INVALID_INPUT");
    }
    await service.setHold("NGN", { rate: 1800, reason: "x".repeat(500), ttlHours: 24 }, "a");
    await service.setHold("NGN", { rate: 1800, reason: "fives", ttlHours: 24 }, "a");
  });

  test("ttlHours is required and must be 1-168", async () => {
    const { service } = await laggingCbn();
    for (const ttlHours of [undefined, null, "24", 0, 0.5, 169, Infinity, NaN]) {
      await assert.rejects(service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours }, "a"), (e) => code(e) === "INVALID_INPUT", String(ttlHours));
    }
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 1 }, "a");
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 168 }, "a");
  });

  test("the held rate must pass the plausible range (NGN 200-5000) and be a positive number", async () => {
    const { service, store } = await laggingCbn();
    for (const rate of [199, 5001, 0, -5, "1800", NaN, Infinity]) {
      await assert.rejects(service.setHold("NGN", { rate, reason: REASON, ttlHours: 24 }, "a"), (e) => code(e) === "INVALID_INPUT", String(rate));
    }
    assert.equal(store.docs.get("NGN")?.hold ?? null, null, "nothing stored");
    // Both range ends are inclusive, like the other range checks.
    await service.setHold("NGN", { rate: 200, reason: REASON, ttlHours: 24 }, "a");
    await service.setHold("NGN", { rate: 5000, reason: REASON, ttlHours: 24 }, "a");
  });

  test("there is no band check against the provider: 1800 holds over a 1300 provider rate", async () => {
    const { service } = await laggingCbn();
    // The same rate as an override is refused (outside the 10% band).
    await assert.rejects(service.setOverride("NGN", { rate: 1800, reason: REASON }, "a"), (e) => code(e) === "INVALID_INPUT");
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a");
    assert.equal((await service.getRate("NGN")).rate, 1800);
  });

  test("refused on a corrupt provider map; nothing (hold or audit) is written", async () => {
    const store = memoryRateStore();
    store.docs.set("NGN", { currency: "NGN", provider: null, providerCorrupt: true, override: null, lastError: null });
    const { service } = makeService({ store });
    await assert.rejects(service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a"), (e) => code(e) === "INVALID_INPUT");
    assert.equal(store.docs.get("NGN")?.hold ?? null, null);
    assert.equal(store.audit.length, 0);
  });

  test("unknown currency -> CURRENCY_UNSUPPORTED; disabled currency -> CURRENCY_DISABLED", async () => {
    const { service } = makeService({ config: { currencies: { NGN: { enabled: false } } } });
    await assert.rejects(service.setHold("XXX", { rate: 1800, reason: REASON, ttlHours: 24 }, "a"), (e) => code(e) === "CURRENCY_UNSUPPORTED");
    await assert.rejects(service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a"), (e) => code(e) === "CURRENCY_DISABLED");
  });

  test("a hold works with no provider rate at all (range-checked), and replaces an earlier hold", async () => {
    const { service, store } = makeService();
    await service.setHold("NGN", { rate: 1700, reason: REASON, ttlHours: 24 }, "a");
    await service.setHold("NGN", { rate: 1750, reason: "revised hold level", ttlHours: 24 }, "b");
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1750, "hold"]);
    assert.deepEqual(store.audit.at(-1)!.old, { rate: 1700, source: "hold" });
  });

  test("clearHold: reason 5-500, refuses when there is no hold, audits hold_cleared with old/new effective rates", async () => {
    const { service, store } = await laggingCbn();
    await assert.rejects(service.clearHold("NGN", "Nothing to clear yet", "a"), (e) => code(e) === "INVALID_INPUT");
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a");
    await assert.rejects(service.clearHold("NGN", "shrt", "a"), (e) => code(e) === "INVALID_INPUT");
    // A well-formed but unknown code has no doc, so no hold (same as clearOverride).
    await assert.rejects(service.clearHold("XXX", "CBN caught up today", "a"), (e) => code(e) === "INVALID_INPUT");
    await assert.rejects(service.clearHold("12", "CBN caught up today", "a"), (e) => code(e) === "CURRENCY_UNSUPPORTED");
    await service.clearHold("NGN", "CBN caught up today", "admin-2");
    assert.equal(store.docs.get("NGN")?.hold, null);
    const entry = store.audit.at(-1)!;
    assert.equal(entry.action, "hold_cleared");
    assert.equal(entry.by, "admin-2");
    assert.equal(entry.reason, "CBN caught up today");
    assert.deepEqual(entry.old, { rate: 1800, source: "hold" });
    assert.deepEqual(entry.new, { rate: 1300, source: "cbn" });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1300, "cbn"]);
  });
});

// ---------------------------------------------------------------
// 2. Effective rate while held; refreshes; expiry
// ---------------------------------------------------------------
describe("while held, the hold prices and refreshes only record the provider rate", () => {
  // The issue's scenario end to end.
  test("CBN lags at 1300 while the true rate is 1800: hold 1800 -> refresh stores 1300 -> quote 1800 -> expiry -> 1300", async () => {
    const { service, store, clock, cbn } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "admin-1");

    // A scheduled refresh 6h later: CBN still says ~1300; it IS stored.
    clock.advanceHours(6);
    cbn.result = cbnAt(clock, 1300);
    const [out] = await quietly(() => service.refreshAll());
    assert.deepEqual([out.ok, out.rate], [true, 1300]);
    assert.match(out.warning ?? "", /held rate 1800 .* provider rate 1300/);
    assert.equal(store.docs.get("NGN")?.provider?.rate, 1300);
    assert.equal(store.docs.get("NGN")?.provider?.fetchedAt.getTime(), clock.now().getTime());

    // ... but the quote prices at the held rate: $100 -> NGN 180,000.
    const q = await quote(usd(10_000), "NGN", service);
    assert.deepEqual([q.rate, q.source, q.local.amountMinor], [1800, "hold", 18_000_000]);

    // The hold expires (24h after it was set): normal rules, the fresh 1300.
    clock.advanceHours(18);
    const after = await quote(usd(10_000), "NGN", service);
    assert.deepEqual([after.rate, after.source], [1300, "cbn"]);
  });

  test("same scenario with no refresh while held: at expiry the provider rate is stale -> RATE_STALE", async () => {
    const { service, clock } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 100 }, "a");
    // 80h on: past the 72h freshness limit, the hold still prices.
    clock.advanceHours(80);
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1800, "hold"]);
    // 100h: the hold has expired; the 1300 is 100h old -> RATE_STALE.
    clock.advanceHours(20);
    await assert.rejects(quote(usd(10_000), "NGN", service), (e) => code(e) === "RATE_STALE");
  });

  test("a hold prices even with no provider rate stored, and ends exactly at expiresAt", async () => {
    const { service, clock } = makeService();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 2 }, "a");
    clock.advanceHours(2 - 1 / 3600);
    assert.equal((await service.getRate("NGN")).source, "hold");
    clock.advanceHours(1 / 3600);
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
  });

  test("a hold outranks an active override; clearing it lets the override price again", async () => {
    const { service, store } = await laggingCbn();
    await service.setOverride("NGN", { rate: 1350, reason: REASON, ttlHours: 48 }, "a");
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a");
    assert.deepEqual(store.audit.at(-1)!.old, { rate: 1350, source: "manual" });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1800, "hold"]);
    // An override set while held is audited with the rate ENTERED as `new`
    // and the rate really in effect (the hold) as `effective` (#241 review).
    await service.setOverride("NGN", { rate: 1360, reason: "replace the override", ttlHours: 48 }, "a");
    assert.deepEqual(store.audit.at(-1)!.new, { rate: 1360, source: "manual" });
    assert.deepEqual(store.audit.at(-1)!.effective, { rate: 1800, source: "hold" });
    await service.clearHold("NGN", "CBN caught up today", "a");
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1360, "manual"]);
  });

  test("refreshes behind a hold keep the same guards (jump guard, range) and never touch the hold", async () => {
    const { service, store, clock, cbn } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 48 }, "a");
    clock.advanceHours(6);
    // CBN catches up in one go: 1300 -> 1800 is a 38% jump, rejected as always.
    cbn.result = cbnAt(clock, 1800);
    const [out] = await quietly(() => service.refreshAll());
    assert.equal(out.ok, false);
    assert.match(out.reason ?? "", /more than 10%/);
    assert.equal(store.docs.get("NGN")?.provider?.rate, 1300);
    assert.equal(store.docs.get("NGN")?.hold?.rate, 1800);
    assert.equal((await service.getRate("NGN")).rate, 1800);
  });

  test("a manual refresh while held stores the provider rate and audits the hold as old and new", async () => {
    const { service, store, clock, cbn } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 48 }, "a");
    clock.advanceHours(1);
    cbn.result = cbnAt(clock, 1310);
    const out = await quietly(() => service.refreshNow("NGN", undefined, "admin-1"));
    assert.deepEqual([out.ok, out.rate], [true, 1310]);
    assert.equal(store.docs.get("NGN")?.provider?.rate, 1310);
    const entry = store.audit.at(-1)!;
    assert.equal(entry.action, "provider_refresh");
    assert.deepEqual([entry.old, entry.new], [{ rate: 1800, source: "hold" }, { rate: 1800, source: "hold" }]);
    assert.equal((await service.getRate("NGN")).rate, 1800);
  });

  test("an in-band refresh under a hold carries no warning", async () => {
    const { service, clock, cbn } = await laggingCbn();
    await service.setHold("NGN", { rate: 1350, reason: REASON, ttlHours: 48 }, "a");
    clock.advanceHours(6);
    cbn.result = cbnAt(clock, 1310);
    const [out] = await service.refreshAll();
    assert.equal(out.ok, true);
    assert.equal(out.warning, undefined);
  });
});

// ---------------------------------------------------------------
// 3. Admin overview and public rates
// ---------------------------------------------------------------
describe("admin overview shows the hold next to the provider rate", () => {
  test("held rate, expiry, reason, latest provider rate, gap, and a band warning", async () => {
    const { service, clock } = await laggingCbn();
    const hold = await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 100 }, "admin-1");
    const [row] = await service.adminOverview();
    assert.deepEqual([row.effective?.rate, row.effective?.source], [1800, "hold"]);
    assert.ok(row.hold);
    assert.equal(row.hold!.rate, 1800);
    assert.equal(row.hold!.reason, REASON);
    assert.equal(row.hold!.setBy, "admin-1");
    assert.equal(row.hold!.expiresAt.getTime(), hold.expiresAt.getTime());
    assert.equal(row.hold!.provider?.rate, 1300);
    assert.equal(row.hold!.provider?.fresh, true);
    // 1800 - 1300 = 500 = 38.46% of 1300 -> 3846 bps (truncated).
    assert.deepEqual(row.hold!.gap, { rate: 500, bps: 3846, outsideBand: true });
    const w = row.warnings.find((x) => x.code === "HOLD_OUTSIDE_PROVIDER_BAND");
    assert.ok(w);
    assert.match(w!.message, /1800.*1300/);
    // Provider goes stale under the hold: shown as not fresh, hold still prices.
    clock.advanceHours(80);
    const [later] = await service.adminOverview();
    assert.equal(later.hold!.provider?.fresh, false);
    assert.equal(later.effective?.source, "hold");
  });

  test("inside the band: gap shown (negative too), no warning; no provider rate: gap null", async () => {
    const { service } = await laggingCbn();
    await service.setHold("NGN", { rate: 1235, reason: REASON, ttlHours: 48 }, "a");
    const [row] = await service.adminOverview();
    assert.deepEqual(row.hold!.gap, { rate: -65, bps: -500, outsideBand: false });
    assert.equal(row.warnings.length, 0);

    const fresh = makeService();
    await fresh.service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 48 }, "a");
    const [none] = await fresh.service.adminOverview();
    assert.equal(none.hold!.provider, null);
    assert.equal(none.hold!.gap, null);
    assert.equal(none.warnings.length, 0);
  });

  test("an expired hold is not shown as active (hold null)", async () => {
    const { service, clock } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 1 }, "a");
    clock.advanceHours(2);
    const [row] = await service.adminOverview();
    assert.equal(row.hold, null);
    assert.equal(row.effective?.source, "cbn");
    assert.equal(row.audit[0].action, "hold_set");
  });
});

// ---------------------------------------------------------------
// 4. Edge cases from the #229 round-2 review
// ---------------------------------------------------------------
describe("a damaged provider map supersedes an unreferenced or legacy override", () => {
  const setAt = new Date("2026-11-13T09:00:00Z");
  const overrideFor = (extra: Record<string, unknown>) => ({
    rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR), ...extra,
  });

  test("superseded by a provider rate, then the map is damaged: the override does NOT price again", async () => {
    const { service, store, clock, cbn } = makeService();
    await service.refreshAll();
    await service.resetReference("NGN", "Genuine devaluation confirmed", "a");
    await service.setOverride("NGN", { rate: 1050, reason: REASON }, "a");
    clock.advanceHours(1);
    cbn.result = cbnAt(clock, 1500);
    await quietly(() => service.refreshAll());
    assert.equal((await service.getRate("NGN")).source, "cbn", "superseded");
    // Damaged outside the app (console edit / bad migration): reads as corrupt.
    const doc = store.docs.get("NGN")!;
    store.docs.set("NGN", { ...doc, provider: null, providerCorrupt: true });
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
    const [row] = await service.adminOverview();
    const w = row.warnings.find((x) => x.code === "OVERRIDE_SUPERSEDED");
    assert.ok(w, "flagged as superseded");
    assert.match(w!.message, /unreadable/);
  });

  test("a legacy override (no referenceRate, no unreferenced) over a corrupt map fails closed", async () => {
    const store = memoryRateStore();
    store.docs.set("NGN", { currency: "NGN", provider: null, providerCorrupt: true, override: overrideFor({}), lastError: null });
    const { service } = makeService({ store });
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
  });

  test("a REFERENCED override over a corrupt map still prices (it was band-checked when set; unchanged)", async () => {
    const store = memoryRateStore();
    store.docs.set("NGN", {
      currency: "NGN", provider: null, providerCorrupt: true, override: overrideFor({ rate: 1450, referenceRate: 1500 }), lastError: null,
    });
    const { service } = makeService({ store });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1450, "manual"]);
  });
});

describe("reset-reference clears a superseded unreferenced override", () => {
  test("override 1050 superseded by 1500, then reset: the override is cleared (audited) and does not price again", async () => {
    const { service, store, clock, cbn } = makeService();
    await service.refreshAll();
    await service.resetReference("NGN", "Genuine devaluation confirmed", "a");
    await service.setOverride("NGN", { rate: 1050, reason: REASON }, "a");
    clock.advanceHours(1);
    cbn.result = cbnAt(clock, 1500);
    await quietly(() => service.refreshAll());
    const before = store.audit.length;

    await service.resetReference("NGN", "Accept the move to the new level", "admin-2");
    const doc = store.docs.get("NGN")!;
    assert.equal(doc.provider, null);
    assert.equal(doc.override, null, "superseded override cleared");
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
    // Two entries from the one transaction: the reset and the clear.
    const added = store.audit.slice(before);
    assert.deepEqual(added.map((a) => a.action), ["provider_reset", "override_cleared"]);
    const cleared = added[1];
    assert.equal(cleared.by, "admin-2");
    assert.match(cleared.reason, /1050.*1500.*Accept the move/);
    assert.deepEqual(cleared.old, { rate: 1500, source: "cbn" });
    assert.equal(cleared.new, null);
  });

  test("an unreferenced override INSIDE the band is kept by a reset", async () => {
    const { service, store, clock, cbn } = makeService();
    await service.setOverride("NGN", { rate: 1450, reason: REASON }, "a"); // no provider yet: unreferenced
    clock.advanceHours(1);
    cbn.result = cbnAt(clock, 1500);
    await service.refreshAll();
    await service.resetReference("NGN", "Accept the move to the new level", "a");
    assert.equal(store.docs.get("NGN")?.override?.rate, 1450);
    assert.deepEqual(store.audit.slice(-1).map((a) => a.action), ["provider_reset"]);
  });

  test("a referenced override that drifted out of band is kept (never superseded)", async () => {
    const { service, store, clock, cbn } = makeService();
    await service.refreshAll(); // 1500
    await service.setOverride("NGN", { rate: 1400, reason: REASON }, "a"); // referenced
    clock.advanceHours(6);
    cbn.result = cbnAt(clock, 1640);
    await quietly(() => service.refreshAll()); // 1400 now >10% from 1640
    await service.resetReference("NGN", "Accept the move to the new level", "a");
    assert.equal(store.docs.get("NGN")?.override?.rate, 1400);
  });

  test("an unreferenced override over a corrupt map is cleared by the reset too", async () => {
    const store = memoryRateStore();
    const setAt = new Date("2026-11-13T09:00:00Z");
    store.docs.set("NGN", {
      currency: "NGN", provider: null, providerCorrupt: true, lastError: null,
      override: { rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR), unreferenced: true },
    });
    const { service } = makeService({ store });
    await service.resetReference("NGN", "Repair the damaged provider map", "a");
    assert.equal(store.docs.get("NGN")?.override, null);
    assert.match(store.audit.at(-1)!.reason, /unreadable/);
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
  });

  test("a reset leaves an active hold alone", async () => {
    const { service, store } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a");
    await service.resetReference("NGN", "Accept the move to the new level", "a");
    assert.equal(store.docs.get("NGN")?.hold?.rate, 1800);
    assert.equal((await service.getRate("NGN")).source, "hold");
  });
});

// ---------------------------------------------------------------
// 5. Charge snapshot
// ---------------------------------------------------------------
describe("charge snapshot records a held rate", () => {
  test("fxRateSource is 'hold' and fxRate the held rate", async () => {
    const { service } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a");
    const snap = toChargeSnapshot(await quote(usd(2_500), "NGN", service));
    assert.equal(snap.fxRateSource, "hold");
    assert.equal(snap.fxRate, 1800);
    assert.equal(snap.chargedAmountMinor, 4_500_000); // $25 x 1800 = NGN 45,000.00
  });
});

// ---------------------------------------------------------------
// Routes: admin gate on the real app, behaviour on a small app
// ---------------------------------------------------------------
const PRINCIPALS: Record<string, any> = {
  admin: { uid: "uid-admin", role: "admin" },
  client: { uid: "uid-client", role: "client" },
  agent: { uid: "uid-agent", role: "agent", agencyId: "agency-1" },
  owner: { uid: "uid-owner", role: "owner", agencyId: "agency-1" },
};

async function call(base: string, path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

describe("hold routes", () => {
  let realServer: Server;
  let realBase = "";
  let server: Server;
  let base = "";
  let ctx: Awaited<ReturnType<typeof laggingCbn>>;
  let originalVerify: typeof auth.verifyIdToken;
  /** Uncached GET /rates builds (one config read each). */
  let builds = 0;

  before(async () => {
    await installFakes();
    originalVerify = auth.verifyIdToken;
    (auth as any).verifyIdToken = async (token: string) => {
      const p = PRINCIPALS[token];
      if (!p) throw new Error("unknown test token");
      return { ...p, admin: p.role === "admin" };
    };
    await new Promise<void>((resolve) => {
      realServer = app.listen(0, "127.0.0.1", resolve);
    });
    realBase = `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;

    ctx = await laggingCbn();
    const realGetConfig = ctx.service.getConfig.bind(ctx.service);
    ctx.service.getConfig = async () => {
      builds++;
      return realGetConfig();
    };
    const a = express();
    a.use(express.json());
    a.use("/rates", createPublicRatesRouter(ctx.service, { now: () => ctx.clock.now().getTime() }));
    a.use("/admin/exchange-rates", createAdminExchangeRateRouter(ctx.service));
    await new Promise<void>((resolve) => {
      server = a.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    (auth as any).verifyIdToken = originalVerify;
    await new Promise<void>((resolve) => realServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("real app: no token -> 401; client, agent, owner -> 403 on PUT and DELETE", async () => {
    resetStore();
    for (const method of ["PUT", "DELETE"]) {
      const body = { rate: 1800, reason: "should not work", ttlHours: 24 };
      assert.equal((await call(realBase, "/admin/exchange-rates/NGN/hold", { method, body })).status, 401, method);
      for (const who of ["client", "agent", "owner"]) {
        const r = await call(realBase, "/admin/exchange-rates/NGN/hold", { token: who, method, body });
        assert.equal(r.status, 403, `${who} ${method}`);
      }
    }
  });

  test("PUT /:currency/hold: 200 and the hold; bad input 400; unknown currency 404", async () => {
    const ok = await call(base, "/admin/exchange-rates/NGN/hold", {
      token: "admin", method: "PUT", body: { rate: 1800, reason: REASON, ttlHours: 24 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.rate, 1800);
    assert.equal(ok.json.data.setBy, "uid-admin");
    for (const body of [
      { rate: 6000, reason: REASON, ttlHours: 24 },
      { rate: 1800, reason: "shrt", ttlHours: 24 },
      { rate: 1800, reason: REASON, ttlHours: 169 },
      { rate: 1800, reason: REASON },
    ]) {
      const bad = await call(base, "/admin/exchange-rates/NGN/hold", { token: "admin", method: "PUT", body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal(bad.json.error, "INVALID_INPUT");
    }
    const unknown = await call(base, "/admin/exchange-rates/XXX/hold", { token: "admin", method: "PUT", body: { rate: 1800, reason: REASON, ttlHours: 24 } });
    assert.equal(unknown.status, 404);
    // The override route is not shadowed: PUT /NGN still sets an override.
    const override = await call(base, "/admin/exchange-rates/NGN", { token: "admin", method: "PUT", body: { rate: 1310, reason: REASON } });
    assert.equal(override.status, 200);
    assert.equal(ctx.store.docs.get("NGN")?.override?.rate, 1310);
    assert.equal(ctx.store.docs.get("NGN")?.hold?.rate, 1800, "the hold is untouched");
  });

  test("GET /admin/exchange-rates shows the hold, provider rate and gap", async () => {
    const r = await call(base, "/admin/exchange-rates", { token: "admin" });
    assert.equal(r.status, 200);
    const row = r.json.data.currencies[0];
    assert.equal(row.hold.rate, 1800);
    assert.equal(row.hold.reason, REASON);
    assert.ok(row.hold.expiresAt);
    assert.equal(row.hold.provider.rate, 1300);
    assert.deepEqual(row.hold.gap, { rate: 500, bps: 3846, outsideBand: true });
    assert.ok(row.warnings.some((w: any) => w.code === "HOLD_OUTSIDE_PROVIDER_BAND"));
  });

  test("public GET /rates shows the held rate with no hold details; cache cleared on set and clear", async () => {
    builds = 0;
    const held = await call(base, "/rates");
    assert.equal(held.json.data.currencies[0].rate, 1800);
    assert.deepEqual(Object.keys(held.json.data.currencies[0]).sort(), ["asOf", "available", "currency", "exponent", "rate"]);
    for (const forbidden of ["hold", REASON, "uid-admin", "source", "manual", "override", "expiresAt", "gap"]) {
      assert.ok(!held.text.includes(forbidden), `public body leaked "${forbidden}"`);
    }
    await call(base, "/rates");
    assert.equal(builds, 1, "served from cache");

    // DELETE: reason required, then cleared -> the override (1310) prices, at once.
    const bad = await call(base, "/admin/exchange-rates/NGN/hold", { token: "admin", method: "DELETE", body: {} });
    assert.equal(bad.status, 400);
    const cleared = await call(base, "/admin/exchange-rates/NGN/hold", { token: "admin", method: "DELETE", body: { reason: "CBN caught up today" } });
    assert.equal(cleared.status, 200);
    builds = 0;
    const afterClear = await call(base, "/rates");
    assert.equal(builds, 1, "clearing the hold invalidated the cache");
    assert.equal(afterClear.json.data.currencies[0].rate, 1310);

    // Setting a hold invalidates it too.
    await call(base, "/admin/exchange-rates/NGN/hold", { token: "admin", method: "PUT", body: { rate: 1750, reason: REASON, ttlHours: 24 } });
    builds = 0;
    const afterSet = await call(base, "/rates");
    assert.equal(builds, 1, "setting a hold invalidated the cache");
    assert.equal(afterSet.json.data.currencies[0].rate, 1750);
    // No hold to clear -> 400.
    await call(base, "/admin/exchange-rates/NGN/hold", { token: "admin", method: "DELETE", body: { reason: "CBN caught up today" } });
    const none = await call(base, "/admin/exchange-rates/NGN/hold", { token: "admin", method: "DELETE", body: { reason: "CBN caught up today" } });
    assert.equal(none.status, 400);
  });
});

// ---------------------------------------------------------------
// 6. Firestore store: hold round trip and extra audit entries
// ---------------------------------------------------------------
describe("Firestore store and the hold", () => {
  const t0 = new Date("2026-11-13T09:00:00Z");
  const providerDoc = {
    rate: 1300, source: "cbn", asOf: Timestamp.fromDate(new Date(t0.getTime() - HOUR)), fetchedAt: Timestamp.fromDate(t0),
  };

  before(async () => {
    await installFakes();
    (firebase.collections as any).exchangeRateAudit = fakeCollection("exchangeRateAudit");
    (firestoreRateStore as any).runTransaction = fakeRunTransaction;
  });
  beforeEach(() => resetStore());

  test("transact writes the hold with its audit; get reads it back; null clears it", async () => {
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: providerDoc });
    const hold = { rate: 1800, reason: REASON, setBy: "a", setAt: t0, expiresAt: new Date(t0.getTime() + 24 * HOUR) };
    await firestoreRateStore.transact("NGN", () => ({
      hold,
      audit: {
        currency: "NGN", action: "hold_set", by: "a", at: t0, reason: REASON,
        old: { rate: 1300, source: "cbn" }, new: { rate: 1800, source: "hold" }, holdExpiresAt: hold.expiresAt,
      },
    }));
    const read = await firestoreRateStore.get("NGN");
    assert.deepEqual(read?.hold, hold);
    assert.equal(read?.provider?.rate, 1300, "the provider rate is untouched");
    const [entry] = await firestoreRateStore.listAudit("NGN", 5);
    assert.equal(entry.action, "hold_set");
    assert.equal(entry.holdExpiresAt?.getTime(), hold.expiresAt.getTime());

    await firestoreRateStore.transact("NGN", () => ({
      hold: null,
      audit: { currency: "NGN", action: "hold_cleared", by: "a", at: t0, reason: REASON, old: null, new: null },
    }));
    assert.equal((await firestoreRateStore.get("NGN"))?.hold, null);
  });

  test("extraAudits are written in the same transaction", async () => {
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: providerDoc });
    await firestoreRateStore.transact("NGN", () => ({
      clearProvider: true,
      override: null,
      audit: { currency: "NGN", action: "provider_reset", by: "a", at: t0, reason: REASON, old: null, new: null },
      extraAudits: [
        { currency: "NGN", action: "override_cleared", by: "a", at: new Date(t0.getTime() + 1), reason: REASON, old: null, new: null },
      ],
    }));
    const audit = await firestoreRateStore.listAudit("NGN", 5);
    assert.deepEqual(audit.map((a) => a.action).sort(), ["override_cleared", "provider_reset"]);
  });

  test("a malformed hold reads as no hold; saveProvider returns the hold read in its transaction", async () => {
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: providerDoc, hold: { rate: "1800", setAt: "yesterday" } });
    assert.equal((await firestoreRateStore.get("NGN"))?.hold, null);

    const holdDoc = {
      rate: 1800, reason: REASON, setBy: "a", setAt: Timestamp.fromDate(t0), expiresAt: Timestamp.fromDate(new Date(t0.getTime() + HOUR)),
    };
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: providerDoc, hold: holdDoc });
    const expected = await firestoreRateStore.get("NGN");
    const res = await firestoreRateStore.saveProvider(
      "NGN", { rate: 1310, source: "cbn", asOf: t0, fetchedAt: new Date(t0.getTime() + HOUR) }, expected
    );
    assert.equal(res.saved, true);
    assert.equal(res.saved && res.hold?.rate, 1800);
    const after = await firestoreRateStore.get("NGN");
    assert.equal(after?.provider?.rate, 1310);
    assert.equal(after?.hold?.rate, 1800, "the merge keeps the hold");
  });
});

// ---------------------------------------------------------------
// 7. Review round 1 (issue #241)
// ---------------------------------------------------------------
describe("review: override_set audit keeps the rate the admin entered", () => {
  test("NGN held at 1800, override 1350 set: audit new = 1350 manual, effective = 1800 hold; 1350 prices after the hold", async () => {
    const { service, store, clock } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 6 }, "admin-1");
    await service.setOverride("NGN", { rate: 1350, reason: "market rate for after the hold", ttlHours: 48 }, "admin-2");
    const entry = store.audit.at(-1)!;
    assert.equal(entry.action, "override_set");
    assert.equal(entry.by, "admin-2");
    assert.deepEqual(entry.old, { rate: 1800, source: "hold" });
    assert.deepEqual(entry.new, { rate: 1350, source: "manual" });
    assert.deepEqual(entry.effective, { rate: 1800, source: "hold" });
    // The hold expires (no audit entry for that); 1350 now prices, and the
    // trail above shows who chose it and when.
    clock.advanceHours(7);
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1350, "manual"]);
  });

  test("with no hold, new and effective are both the override", async () => {
    const { service, store } = await laggingCbn();
    await service.setOverride("NGN", { rate: 1350, reason: REASON, ttlHours: 48 }, "a");
    const entry = store.audit.at(-1)!;
    assert.deepEqual(entry.new, { rate: 1350, source: "manual" });
    assert.deepEqual(entry.effective, { rate: 1350, source: "manual" });
  });
});

describe("review: a damaged or hand-edited hold is ignored for pricing, flagged, and clearable", () => {
  const setAt = new Date("2026-11-13T09:00:00Z");
  const holdFor = (extra: Record<string, unknown>) => ({
    rate: 1800, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR), ...extra,
  });

  test("unreadable hold map: prices as no hold, HOLD_CORRUPT says what prices; DELETE clears it (audited)", async () => {
    const { service, store } = await laggingCbn();
    store.docs.set("NGN", { ...store.docs.get("NGN")!, hold: null, holdCorrupt: true });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1300, "cbn"]);
    const [row] = await service.adminOverview();
    assert.equal(row.hold, null);
    const w = row.warnings.find((x) => x.code === "HOLD_CORRUPT");
    assert.ok(w, "flagged");
    assert.match(w!.message, /unreadable.*ignored.*provider rate 1300 \(cbn\)/);

    await service.clearHold("NGN", "remove the damaged hold map", "admin-1");
    const entry = store.audit.at(-1)!;
    assert.equal(entry.action, "hold_cleared");
    assert.equal(entry.holdCorrupt, true);
    assert.deepEqual([entry.old, entry.new], [{ rate: 1300, source: "cbn" }, { rate: 1300, source: "cbn" }]);
    assert.equal(store.docs.get("NGN")?.holdCorrupt, undefined);
    const [after] = await service.adminOverview();
    assert.equal(after.warnings.length, 0);
    // Nothing left to clear now.
    await assert.rejects(service.clearHold("NGN", "again please", "a"), (e) => code(e) === "INVALID_INPUT");
  });

  test("a hold edited past the plausible range (1e6) does not price; HOLD_INVALID; clearable", async () => {
    const { service, store } = await laggingCbn();
    store.docs.set("NGN", { ...store.docs.get("NGN")!, hold: holdFor({ rate: 1_000_000 }) });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1300, "cbn"]);
    const [row] = await service.adminOverview();
    assert.equal(row.hold, null);
    const w = row.warnings.find((x) => x.code === "HOLD_INVALID");
    assert.ok(w);
    assert.match(w!.message, /plausible range 200-5000/);
    assert.ok(!row.warnings.some((x) => x.code === "HOLD_OUTSIDE_PROVIDER_BAND"), "an ignored hold has no band warning");
    await service.clearHold("NGN", "remove the hand-edited hold", "a");
    assert.equal(store.docs.get("NGN")?.hold, null);
  });

  test("a hold whose expiry is more than 168h after setAt (or from now) does not price; HOLD_INVALID", async () => {
    const { service, store } = await laggingCbn();
    store.docs.set("NGN", { ...store.docs.get("NGN")!, hold: holdFor({ expiresAt: new Date(setAt.getTime() + 365 * 24 * HOUR) }) });
    assert.equal((await service.getRate("NGN")).source, "cbn");
    let [row] = await service.adminOverview();
    assert.match(row.warnings.find((x) => x.code === "HOLD_INVALID")!.message, /more than 168h/);
    // setAt moved into the future to dodge the cap: still caught (from now).
    store.docs.set("NGN", {
      ...store.docs.get("NGN")!,
      hold: holdFor({ setAt: new Date(setAt.getTime() + 300 * HOUR), expiresAt: new Date(setAt.getTime() + 400 * HOUR) }),
    });
    assert.equal((await service.getRate("NGN")).source, "cbn");
    [row] = await service.adminOverview();
    assert.ok(row.warnings.some((x) => x.code === "HOLD_INVALID"));
  });

  test("a legitimate 168h hold still prices (cap is inclusive, small clock skew allowed)", async () => {
    const { service, store, clock } = await laggingCbn();
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 168 }, "a");
    assert.equal((await service.getRate("NGN")).source, "hold");
    // Another instance whose clock is 1 minute behind the one that set it.
    const h = store.docs.get("NGN")!.hold!;
    store.docs.set("NGN", { ...store.docs.get("NGN")!, hold: { ...h, setAt: new Date(clock.now().getTime() + 60_000), expiresAt: new Date(h.expiresAt.getTime() + 60_000) } });
    assert.equal((await service.getRate("NGN")).source, "hold");
    const [row] = await service.adminOverview();
    assert.ok(!row.warnings.some((x) => x.code === "HOLD_INVALID"));
  });

  test("a hold left outside its currency's plausible range after the range is narrowed in config is ignored", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    store.docs.set("NGN", { currency: "NGN", provider: null, override: null, lastError: null, hold: holdFor({}) });
    const wide = makeService({ store, clock });
    assert.equal((await wide.service.getRate("NGN")).source, "hold");
    // Ops narrows NGN to 1000-1700 (inside the 200-5000 default): 1800 fails.
    const narrow = makeService({ store, clock, config: { currencies: { NGN: { enabled: true, minRate: 1000, maxRate: 1700 } } } });
    await assert.rejects(narrow.service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
    const [row] = await narrow.service.adminOverview();
    assert.match(row.warnings.find((x) => x.code === "HOLD_INVALID")!.message, /1000-1700.*nothing \(RATE_UNAVAILABLE\)/);
  });
});

describe("review: warning texts name the hold when it prices", () => {
  test("refresh band warning under a hold names the override that prices after it, not the provider rate", async () => {
    const { service, clock, cbn } = await laggingCbn();
    await service.setOverride("NGN", { rate: 1350, reason: REASON, ttlHours: 48 }, "a");
    await service.setHold("NGN", { rate: 1800, reason: REASON, ttlHours: 24 }, "a");
    clock.advanceHours(1);
    cbn.result = cbnAt(clock, 1310);
    const [out] = await quietly(() => service.refreshAll());
    assert.equal(out.ok, true);
    assert.match(out.warning ?? "", /held rate 1800 .*then the override 1350 would price/);
    assert.doesNotMatch(out.warning ?? "", /then the provider rate does/);
  });

  test("superseded-override overview text says the hold prices first", async () => {
    const { service, clock, cbn } = makeService();
    await service.refreshAll();
    await service.resetReference("NGN", "Genuine devaluation confirmed", "a");
    await service.setOverride("NGN", { rate: 1050, reason: REASON }, "a");
    clock.advanceHours(1);
    cbn.result = cbnAt(clock, 1500);
    await quietly(() => service.refreshAll());
    await service.setHold("NGN", { rate: 1600, reason: REASON, ttlHours: 24 }, "a");
    const [row] = await service.adminOverview();
    const w = row.warnings.find((x) => x.code === "OVERRIDE_SUPERSEDED");
    assert.ok(w);
    assert.match(w!.message, /The held rate 1600 prices until .*; after that, pricing uses the provider rate/);
    const band = row.warnings.find((x) => x.code === "OVERRIDE_OUTSIDE_PROVIDER_BAND");
    assert.match(band!.message, /no longer prices \(the held rate 1600 prices until .*then the provider rate does/);
    // Without the hold the original wording stands.
    await service.clearHold("NGN", "CBN caught up today", "a");
    const [plain] = await service.adminOverview();
    assert.match(plain.warnings.find((x) => x.code === "OVERRIDE_SUPERSEDED")!.message, /\. Pricing uses the provider rate while it is fresh/);
  });
});

describe("review: Firestore store and damaged holds / the audit `effective` field", () => {
  const t0 = new Date("2026-11-13T09:00:00Z");
  const providerDoc = {
    rate: 1300, source: "cbn", asOf: Timestamp.fromDate(new Date(t0.getTime() - HOUR)), fetchedAt: Timestamp.fromDate(t0),
  };

  before(async () => {
    await installFakes();
    (firebase.collections as any).exchangeRateAudit = fakeCollection("exchangeRateAudit");
    (firestoreRateStore as any).runTransaction = fakeRunTransaction;
  });
  beforeEach(() => resetStore());

  test("a malformed hold map is read as holdCorrupt; writing hold null clears it", async () => {
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: providerDoc, hold: { rate: "1800", setAt: "yesterday" } });
    const read = await firestoreRateStore.get("NGN");
    assert.equal(read?.hold, null);
    assert.equal(read?.holdCorrupt, true);
    await firestoreRateStore.transact("NGN", () => ({
      hold: null,
      audit: { currency: "NGN", action: "hold_cleared", by: "a", at: t0, reason: REASON, old: null, new: null, holdCorrupt: true },
    }));
    const after = await firestoreRateStore.get("NGN");
    assert.equal(after?.holdCorrupt, undefined);
    const [entry] = await firestoreRateStore.listAudit("NGN", 5);
    assert.equal(entry.holdCorrupt, true);
    // A well-formed doc has no flag at all.
    fakeDocs.set("exchangeRates/USD", { currency: "USD", provider: providerDoc });
    assert.equal((await firestoreRateStore.get("USD"))?.holdCorrupt, undefined);
  });

  test("override_set `effective` round-trips, including null", async () => {
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: providerDoc });
    await firestoreRateStore.transact("NGN", () => ({
      audit: {
        currency: "NGN", action: "override_set", by: "a", at: t0, reason: REASON,
        old: { rate: 1800, source: "hold" }, new: { rate: 1350, source: "manual" }, effective: { rate: 1800, source: "hold" },
      },
    }));
    await firestoreRateStore.transact("NGN", () => ({
      audit: {
        currency: "NGN", action: "override_set", by: "a", at: new Date(t0.getTime() + 1), reason: REASON,
        old: null, new: { rate: 1360, source: "manual" }, effective: null,
      },
    }));
    const [latest, first] = await firestoreRateStore.listAudit("NGN", 5);
    assert.deepEqual([latest.new, latest.effective], [{ rate: 1360, source: "manual" }, null]);
    assert.deepEqual([first.new, first.effective], [{ rate: 1350, source: "manual" }, { rate: 1800, source: "hold" }]);
  });
});
