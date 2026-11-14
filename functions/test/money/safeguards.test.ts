// ============================================
// Unit tests: exchange-rate safeguards from the #178 reviews (issue #214)
// ============================================
//
// Hermetic: in-memory rate service (test/money/helpers.ts), and for the
// Firestore store the in-memory Firestore fake with its fake transaction
// runner. One `describe` per item of the issue, in the issue's order:
//  1. override re-check after a new provider rate + 24h cap on unreferenced overrides
//  2. rate-age limit covers a four-day closure (Easter)
//  3. stored currency entries merge over the default; range capped
//  4. admin "refresh now" (audited, rate-limited)
//  5. transactional override write; correct `old` when clearing an expired override
//  6. Firestore store and in-memory store behave the same (clearProvider)
//  7. one 168h TTL constant

import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { MoneyError } from "../../src/money/errors";
import {
  DEFAULT_CURRENCIES_CONFIG,
  MAX_OVERRIDE_TTL_HOURS,
  MAX_RATE_RANGE_RATIO,
  parseCurrenciesConfig,
} from "../../src/money/config";
import {
  MANUAL_REFRESH_COOLDOWN_MINUTES,
  MAX_UNREFERENCED_OVERRIDE_TTL_HOURS,
  RateService,
} from "../../src/money/rate.service";
import { firestoreRateStore } from "../../src/money/stores";
import * as firebase from "../../src/utils/firebase";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store as fakeDocs } from "../helpers/fake-firestore";
import { fakeClock, fakeProvider, makeService, memoryRateStore } from "./helpers";
import type { RateStore } from "../../src/money/rate.types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HOUR = 3_600_000;
const code = (e: unknown) => (e instanceof MoneyError ? e.code : "not-a-money-error");
const REASON = "CBN site is down today";

/** Run `fn` with console.error captured; returns what was logged. */
async function captureErrors(fn: () => Promise<unknown>): Promise<string[]> {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return logged;
}

// ---------------------------------------------------------------
// 1. Override re-check and unreferenced TTL
// ---------------------------------------------------------------
describe("an override that no longer fits the provider rate is flagged; unreferenced overrides expire within 24h", () => {
  test("reset-reference, typo override 1050, next refresh stores 1500: logged, flagged in the overview, and gone within 24h", async () => {
    const { service, store, clock } = makeService();
    await service.refreshAll(); // provider 1500
    await service.resetReference("NGN", "Genuine devaluation confirmed", "admin-1");
    // The typo: 1050 for 1500, asking for a week. No provider rate to check against.
    const r = await service.setOverride("NGN", { rate: 1050, reason: REASON, ttlHours: 168 }, "admin-1");
    assert.equal(r.override?.unreferenced, true);
    assert.equal(r.override!.expiresAt.getTime() - r.override!.setAt.getTime(), MAX_UNREFERENCED_OVERRIDE_TTL_HOURS * HOUR);
    assert.equal(store.audit.at(-1)?.unreferenced, true);

    // Before the refresh: flagged as unreferenced only.
    let [row] = await service.adminOverview();
    assert.deepEqual(row.warnings.map((w) => w.code), ["OVERRIDE_UNREFERENCED"]);

    // The next refresh accepts 1500 (first rate, inside the range) and shouts.
    clock.advanceHours(1);
    let outcomes: Awaited<ReturnType<typeof service.refreshAll>> = [];
    const logged = await captureErrors(async () => {
      outcomes = await service.refreshAll();
    });
    assert.equal(outcomes[0].ok, true);
    assert.match(outcomes[0].warning ?? "", /1050.*more than 10%.*1500/);
    assert.ok(logged.some((l) => /NGN/.test(l) && /1050/.test(l)), "logged at error level");
    [row] = await service.adminOverview();
    assert.deepEqual(row.warnings.map((w) => w.code).sort(), ["OVERRIDE_OUTSIDE_PROVIDER_BAND", "OVERRIDE_UNREFERENCED"]);
    assert.equal((await service.getRate("NGN")).rate, 1050); // still wins until fixed or expired...

    // ...but for 24h at most: after that the provider rate prices again.
    clock.advanceHours(23.5);
    assert.equal((await service.getRate("NGN")).rate, 1500);
    [row] = await service.adminOverview();
    assert.deepEqual(row.warnings, []);
  });

  test("the config's default TTL is also capped at 24h for an unreferenced override", async () => {
    const { service } = makeService({ config: { overrideTtlHours: 96 } });
    const r = await service.setOverride("NGN", { rate: 1500, reason: REASON }, "a");
    assert.equal(r.override!.expiresAt.getTime() - r.override!.setAt.getTime(), 24 * HOUR);
  });

  test("a shorter TTL for an unreferenced override is kept", async () => {
    const { service } = makeService();
    const r = await service.setOverride("NGN", { rate: 1500, reason: REASON, ttlHours: 3 }, "a");
    assert.equal(r.override!.expiresAt.getTime() - r.override!.setAt.getTime(), 3 * HOUR);
  });

  test("a referenced override keeps the TTL it asked for (up to 168h) and is not flagged while inside the band", async () => {
    const { service } = makeService();
    await service.refreshAll();
    const r = await service.setOverride("NGN", { rate: 1520, reason: REASON, ttlHours: 168 }, "a");
    assert.equal(r.override?.unreferenced, undefined);
    assert.equal(r.override!.expiresAt.getTime() - r.override!.setAt.getTime(), 168 * HOUR);
    const [row] = await service.adminOverview();
    assert.deepEqual(row.warnings, []);
  });

  test("a referenced override that drifts outside the band after a provider move is flagged", async () => {
    const { service, cbn, clock } = makeService();
    await service.refreshAll(); // 1500
    await service.setOverride("NGN", { rate: 1640, reason: REASON, ttlHours: 48 }, "a"); // +9.3%
    clock.advanceHours(6);
    cbn.result = { ok: true, rate: 1440, asOf: new Date("2026-11-13T12:00:00Z") }; // -4%: accepted
    const out = await service.refreshAll();
    assert.equal(out[0].ok, true);
    assert.ok(out[0].warning, "1640 is ~13.9% above 1440");
    const [row] = await service.adminOverview();
    assert.deepEqual(row.warnings.map((w) => w.code), ["OVERRIDE_OUTSIDE_PROVIDER_BAND"]);
  });
});

// ---------------------------------------------------------------
// 2. Four-day closure
// ---------------------------------------------------------------
describe("rate-age limit covers a four-day bank closure", () => {
  // Easter 2027: Good Friday 26 March to Easter Monday 29 March. The last row
  // before it is Thursday 25 March, dated at the start of the Lagos day
  // (2027-03-24T23:00Z). Tuesday's row appears during Tuesday.
  const thursdayRow = new Date("2027-03-24T23:00:00Z");

  test("default is 144h, cap 240h kept", () => {
    assert.equal(DEFAULT_CURRENCIES_CONFIG.maxRateAgeHours, 144);
    assert.equal(parseCurrenciesConfig(null).maxRateAgeHours, 144);
    assert.equal(parseCurrenciesConfig({ maxRateAgeHours: 1000 }).maxRateAgeHours, 240);
  });

  test("Thursday's rate keeps pricing every 6 hours from Thursday until Tuesday 17:00Z", async () => {
    const clock = fakeClock("2027-03-25T15:00:00Z");
    const cbn = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: thursdayRow } });
    const { service } = makeService({ clock, cbn });
    // Refresh on the 6-hourly schedule; CBN keeps returning Thursday's row.
    while (clock.now() < new Date("2027-03-30T17:00:00Z")) {
      const [o] = await service.refreshAll();
      assert.equal(o.ok, true, `refresh at ${clock.now().toISOString()}`);
      assert.equal((await service.getRate("NGN")).rate, 1500, `price at ${clock.now().toISOString()}`);
      clock.advanceHours(6);
    }
  });

  test("with the old 120h default the same closure stopped pricing on Monday night", async () => {
    const clock = fakeClock("2027-03-30T00:00:00Z"); // 121h after Thursday's row date
    const cbn = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: thursdayRow } });
    const { service } = makeService({ clock, cbn, config: { maxRateAgeHours: 120 } });
    assert.equal((await service.refreshAll())[0].ok, false);
  });

  test("a rate older than 144h is still refused", async () => {
    const clock = fakeClock("2027-03-31T00:00:00Z"); // 145h
    const cbn = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: thursdayRow } });
    const { service } = makeService({ clock, cbn });
    assert.equal((await service.refreshAll())[0].ok, false);
  });
});

// ---------------------------------------------------------------
// 3. Config merge and range caps
// ---------------------------------------------------------------
describe("a stored currency entry merges over the default", () => {
  test("only marginBps stored: NGN keeps enabled, countries and its 200-5000 range", () => {
    const c = parseCurrenciesConfig({ currencies: { NGN: { marginBps: 50 } } });
    assert.deepEqual(c.currencies.NGN, { enabled: true, countries: ["NG", "Nigeria"], marginBps: 50, minRate: 200, maxRate: 5000 });
  });

  test("one end of the range stored: the other comes from the default", () => {
    const c = parseCurrenciesConfig({ currencies: { NGN: { minRate: 300 } } });
    assert.deepEqual([c.currencies.NGN.minRate, c.currencies.NGN.maxRate], [300, 5000]);
  });

  test("a stored range wider than the ratio cap, or above MAX_RATE, is ignored and the default kept", () => {
    assert.equal(MAX_RATE_RANGE_RATIO, 50);
    for (const bad of [{ minRate: 200, maxRate: 1e9 }, { minRate: 100, maxRate: 5001 * 10 }, { minRate: 1, maxRate: 2e9 }]) {
      const c = parseCurrenciesConfig({ currencies: { NGN: bad } });
      assert.deepEqual([c.currencies.NGN.minRate, c.currencies.NGN.maxRate], [200, 5000], JSON.stringify(bad));
    }
    // Exactly at the cap is allowed.
    const ok = parseCurrenciesConfig({ currencies: { NGN: { minRate: 100, maxRate: 5000 } } });
    assert.deepEqual([ok.currencies.NGN.minRate, ok.currencies.NGN.maxRate], [100, 5000]);
  });

  test("a new currency with an over-wide range has no range (fails closed)", () => {
    const c = parseCurrenciesConfig({ currencies: { GHS: { enabled: true, countries: ["GH"], minRate: 1, maxRate: 100 } } });
    assert.equal(c.currencies.GHS.minRate, undefined);
  });

  test("NGN can still be switched off, and a doc listing only another currency keeps NGN's default", () => {
    assert.equal(parseCurrenciesConfig({ currencies: { NGN: { enabled: false } } }).currencies.NGN.enabled, false);
    const c = parseCurrenciesConfig({ currencies: { GHS: { enabled: true, countries: ["GH"], minRate: 5, maxRate: 50 } } });
    assert.deepEqual(Object.keys(c.currencies).sort(), ["GHS", "NGN"]);
    assert.equal(c.currencies.NGN.maxRate, 5000);
  });

  test("end to end: a doc that only sets a margin still refuses an unreferenced 150 override", async () => {
    const { service } = makeService({ config: { currencies: { NGN: { marginBps: 50 } } } });
    await assert.rejects(service.setOverride("NGN", { rate: 150, reason: REASON }, "a"), (e) => code(e) === "INVALID_INPUT");
    await service.setOverride("NGN", { rate: 1500, reason: REASON }, "a");
  });
});

// ---------------------------------------------------------------
// 4. Admin refresh now
// ---------------------------------------------------------------
describe("admin refresh now", () => {
  test("restores pricing after a mistaken reset-reference, and is audited", async () => {
    const { service, store } = makeService();
    await service.refreshAll();
    await service.resetReference("NGN", "oops wrong currency", "admin-1");
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
    const out = await service.refreshNow("NGN", "Undo the mistaken reset", "admin-1");
    assert.deepEqual([out.ok, out.rate, out.source], [true, 1500, "cbn"]);
    assert.equal((await service.getRate("NGN")).rate, 1500);
    const a = store.audit.at(-1)!;
    assert.deepEqual(
      [a.action, a.by, a.reason, a.old, a.new, a.outcome],
      ["provider_refresh", "admin-1", "Undo the mistaken reset", null, { rate: 1500, source: "cbn" }, "ok: cbn 1500"]
    );
  });

  test("rate-limited: once per currency per 5 minutes, with a retry hint; nothing audited when refused", async () => {
    const { service, store, clock, cbn } = makeService();
    assert.equal(MANUAL_REFRESH_COOLDOWN_MINUTES, 5);
    await service.refreshNow("NGN", undefined, "admin-1");
    const audits = store.audit.length;
    const callsBefore = cbn.calls;
    clock.advanceHours(1 / 60); // 1 minute later, another admin
    await assert.rejects(service.refreshNow("NGN", undefined, "admin-2"), (e: any) => {
      assert.equal(code(e), "RATE_LIMITED");
      assert.equal(e.retryAfterSeconds, 240);
      return true;
    });
    assert.equal(store.audit.length, audits);
    assert.equal(cbn.calls, callsBefore, "the provider was not called");
    clock.advanceHours(4 / 60);
    await service.refreshNow("NGN", undefined, "admin-2");
  });

  test("a failed refresh is audited with the reason and leaves the stored rate as it was", async () => {
    const { service, store, cbn, clock } = makeService();
    await service.refreshAll();
    clock.advanceHours(1);
    cbn.result = { ok: false, reason: "CBN answered 503" };
    const out = await service.refreshNow("NGN", undefined, "admin-1");
    assert.equal(out.ok, false);
    assert.equal(store.docs.get("NGN")?.provider?.rate, 1500);
    const a = store.audit.at(-1)!;
    assert.equal(a.reason, "Manual refresh requested");
    assert.match(a.outcome ?? "", /^failed: .*503/);
    assert.deepEqual([a.old, a.new], [{ rate: 1500, source: "cbn" }, { rate: 1500, source: "cbn" }]);
  });

  test("unknown or disabled currency, or a bad reason, is refused before anything runs", async () => {
    const { service, cbn } = makeService({ config: { currencies: { GHS: { enabled: false, countries: [] } } } });
    await assert.rejects(service.refreshNow("XXX", undefined, "a"), (e) => code(e) === "CURRENCY_UNSUPPORTED");
    await assert.rejects(service.refreshNow("GHS", undefined, "a"), (e) => code(e) === "CURRENCY_DISABLED");
    for (const reason of ["no", 5, "x".repeat(501)]) {
      await assert.rejects(service.refreshNow("NGN", reason, "a"), (e) => code(e) === "INVALID_INPUT");
    }
    assert.equal(cbn.calls, 0);
  });
});

// ---------------------------------------------------------------
// 5. Transactional write and correct audit values
// ---------------------------------------------------------------
describe("override write and audit run in one transaction", () => {
  test("the band is checked against the doc as read inside the transaction", async () => {
    // A store whose transaction sees a different (newer) provider rate than a
    // plain read would: the check must use the transaction's view.
    const inner = memoryRateStore();
    const clock = fakeClock();
    const svc = makeService({ store: inner, clock });
    await svc.service.refreshAll(); // stored 1500
    const seen: number[] = [];
    const racing: RateStore = {
      ...inner,
      async transact(c, decide) {
        // A refresh landed just before the transaction read: provider is now 1300.
        const doc = inner.docs.get(c)!;
        inner.docs.set(c, { ...doc, provider: { ...doc.provider!, rate: 1300 } });
        return inner.transact(c, (stored) => {
          seen.push(stored!.provider!.rate);
          return decide(stored);
        });
      },
    };
    const service = new RateService({ config: { read: async () => null }, rates: racing, providers: { cbn: svc.cbn, oanda: svc.oanda }, now: clock.now });
    // 1600 is inside 10% of 1500 but NOT of 1300: refused, nothing written.
    await assert.rejects(service.setOverride("NGN", { rate: 1600, reason: REASON }, "a"), (e) => code(e) === "INVALID_INPUT");
    assert.deepEqual(seen, [1300]);
    assert.equal(inner.docs.get("NGN")?.override, null);
    assert.equal(inner.audit.length, 0);
    // And the audit `old` is the rate the transaction saw.
    await service.setOverride("NGN", { rate: 1350, reason: REASON }, "a");
    assert.deepEqual(inner.audit.at(-1)?.old, { rate: 1300, source: "cbn" });
  });

  test("clearing an override that has already expired records the provider rate as `old`, not the manual rate", async () => {
    const { service, store, clock } = makeService();
    await service.refreshAll(); // 1500
    await service.setOverride("NGN", { rate: 1520, reason: REASON, ttlHours: 1 }, "a");
    clock.advanceHours(2);
    await service.clearOverride("NGN", "tidy up the old one", "a");
    const a = store.audit.at(-1)!;
    assert.deepEqual([a.action, a.old, a.new], ["override_cleared", { rate: 1500, source: "cbn" }, { rate: 1500, source: "cbn" }]);
  });

  test("clearing with a stale provider rate records null, never a stale rate", async () => {
    const { service, store, clock } = makeService();
    await service.refreshAll();
    await service.setOverride("NGN", { rate: 1520, reason: REASON, ttlHours: 168 }, "a");
    clock.advanceHours(100); // provider fetchedAt now past the 72h freshness limit; override still active
    await service.clearOverride("NGN", "remove it now", "a");
    const a = store.audit.at(-1)!;
    assert.deepEqual([a.old, a.new], [{ rate: 1520, source: "manual" }, null]);
  });
});

// ---------------------------------------------------------------
// 6. Firestore store (fake Firestore) and parity with the in-memory store
// ---------------------------------------------------------------
describe("Firestore rate store", () => {
  const audit = (action: "override_set" | "provider_reset") => ({
    currency: "NGN",
    action,
    by: "a",
    at: new Date("2026-11-13T09:00:00Z"),
    reason: REASON,
    old: null,
    new: null,
  });

  before(async () => {
    await installFakes();
    (firebase.collections as any).exchangeRateAudit = fakeCollection("exchangeRateAudit");
    (firestoreRateStore as any).runTransaction = fakeRunTransaction;
  });
  beforeEach(() => resetStore());

  test("transact writes the override and its audit together; Timestamps and the unreferenced flag round-trip", async () => {
    const setAt = new Date("2026-11-13T09:00:00Z");
    await firestoreRateStore.transact("NGN", (stored) => {
      assert.equal(stored, null);
      return {
        override: { rate: 1500, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + HOUR), unreferenced: true },
        audit: { ...audit("override_set"), unreferenced: true },
      };
    });
    const raw = fakeDocs.get("exchangeRates/NGN") as any;
    assert.ok(raw.override.setAt instanceof Timestamp);
    const got = await firestoreRateStore.get("NGN");
    assert.equal(got?.override?.unreferenced, true);
    assert.equal(got?.override?.expiresAt.getTime(), setAt.getTime() + HOUR);
    const list = await firestoreRateStore.listAudit("NGN", 5);
    assert.deepEqual([list.length, list[0].action, list[0].unreferenced], [1, "override_set", true]);
  });

  test("a throw from decide writes nothing", async () => {
    await assert.rejects(
      firestoreRateStore.transact("NGN", () => {
        throw new MoneyError("INVALID_INPUT", "no");
      }),
      MoneyError
    );
    assert.equal(fakeDocs.size, 0);
  });

  test("claimManualRefresh: allowed, then refused inside the cooldown with a retry hint, then allowed", async () => {
    const t0 = new Date("2026-11-13T09:00:00Z");
    assert.deepEqual(await firestoreRateStore.claimManualRefresh("NGN", t0, 5 * 60_000), { allowed: true });
    assert.deepEqual(await firestoreRateStore.claimManualRefresh("NGN", new Date(t0.getTime() + 60_000), 5 * 60_000), {
      allowed: false,
      retryAfterSeconds: 240,
    });
    assert.deepEqual(await firestoreRateStore.claimManualRefresh("NGN", new Date(t0.getTime() + 5 * 60_000), 5 * 60_000), { allowed: true });
  });

  test("appendAudit stores the outcome", async () => {
    await firestoreRateStore.appendAudit({ ...audit("provider_reset"), action: "provider_refresh", outcome: "ok: cbn 1500" });
    assert.equal((await firestoreRateStore.listAudit("NGN", 1))[0].outcome, "ok: cbn 1500");
  });

  test("clearProvider over a corrupt provider map clears providerCorrupt, in both stores", async () => {
    // Firestore: a present but unreadable provider map.
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: { rate: "garbage" } });
    assert.equal((await firestoreRateStore.get("NGN"))?.providerCorrupt, true);
    await firestoreRateStore.transact("NGN", () => ({ clearProvider: true, audit: audit("provider_reset") }));
    const fs = await firestoreRateStore.get("NGN");
    // In-memory: the same starting state and the same call.
    const mem = memoryRateStore();
    mem.docs.set("NGN", { currency: "NGN", provider: null, override: null, lastError: null, providerCorrupt: true });
    await mem.transact("NGN", () => ({ clearProvider: true, audit: audit("provider_reset") }));
    const m = await mem.get("NGN");
    assert.deepEqual([fs?.provider, fs?.providerCorrupt], [null, false]);
    assert.deepEqual([m?.provider, m?.providerCorrupt], [null, false]);
  });

  test("the service over the Firestore store: reset-reference on a corrupt map, then a refresh, prices again", async () => {
    fakeDocs.set("exchangeRates/NGN", { currency: "NGN", provider: { rate: "garbage" } });
    const clock = fakeClock();
    const cbn = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: new Date("2026-11-13T00:00:00Z") } });
    const service = new RateService({
      config: { read: async () => null },
      rates: firestoreRateStore,
      providers: { cbn, oanda: fakeProvider("oanda", { configured: false }) },
      now: clock.now,
    });
    await assert.rejects(service.setOverride("NGN", { rate: 1500, reason: REASON }, "a"), MoneyError); // corrupt blocks it
    await service.resetReference("NGN", "Corrupt map, starting over", "a");
    const out = await service.refreshNow("NGN", undefined, "a");
    assert.equal(out.ok, true);
    assert.equal((await service.getRate("NGN")).rate, 1500);
    const actions = (await firestoreRateStore.listAudit("NGN", 10)).map((a) => a.action).sort();
    assert.deepEqual(actions, ["provider_refresh", "provider_reset"]);
  });
});

// ---------------------------------------------------------------
// 7. One 168h constant
// ---------------------------------------------------------------
describe("one 168h override TTL constant", () => {
  test("the config cap and the request bound are the same constant", async () => {
    assert.equal(MAX_OVERRIDE_TTL_HOURS, 168);
    assert.equal(parseCurrenciesConfig({ overrideTtlHours: 1e6 }).overrideTtlHours, MAX_OVERRIDE_TTL_HOURS);
    const { service } = makeService();
    await service.refreshAll();
    await assert.rejects(service.setOverride("NGN", { rate: 1500, reason: REASON, ttlHours: MAX_OVERRIDE_TTL_HOURS + 1 }, "a"), MoneyError);
    await service.setOverride("NGN", { rate: 1500, reason: REASON, ttlHours: MAX_OVERRIDE_TTL_HOURS }, "a");
  });
});
