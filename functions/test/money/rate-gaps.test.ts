// ============================================
// Unit tests: remaining exchange-rate gaps from the #214 review (issue #229)
// ============================================
//
// Hermetic: the in-memory rate service (test/money/helpers.ts), and for the
// Firestore store the in-memory Firestore fake with its fake transaction
// runner. One `describe` per decision of the issue, in the plan's order:
//  1. an unreferenced (or legacy) override outside the band of a stored
//     provider rate stops winning, and keeps not winning once that rate goes
//     stale (fails closed, RATE_STALE); the overview flags it
//  2. a stored currency range may only narrow the default
//  3. refreshNow audits every outcome; the slot is released when the refresh
//     failed before the provider was contacted
//  4. the scheduled refresh writes the provider rate conditionally
//  5. the "Public rates" doc comment sits on createPublicRatesRouter

import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { MoneyError } from "../../src/money/errors";
import { parseCurrenciesConfig } from "../../src/money/config";
import { RateService } from "../../src/money/rate.service";
import { isUnreferencedOverride, type RateStore, type StoredRate } from "../../src/money/rate.types";
import { firestoreRateStore } from "../../src/money/stores";
import * as firebase from "../../src/utils/firebase";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store as fakeDocs } from "../helpers/fake-firestore";
import { fakeClock, fakeProvider, makeService, memoryRateStore } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HOUR = 3_600_000;
const code = (e: unknown) => (e instanceof MoneyError ? e.code : "not-a-money-error");
const REASON = "CBN site is down today";

/** Run `fn` with console.error and console.warn silenced; returns what was logged. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; logged: string[] }> {
  const logged: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    return { result: await fn(), logged };
  } catch (error) {
    return { error, logged };
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
}

/** A stored provider rate fetched `hoursAgo` before the fake clock's start. */
const providerAt = (rate: number, fetchedAt: Date) => ({
  rate,
  asOf: new Date(fetchedAt.getTime() - HOUR),
  fetchedAt,
  source: "cbn" as const,
});

// ---------------------------------------------------------------
// 1. Unreferenced override vs a stored (fresh or stale) provider rate
// ---------------------------------------------------------------
describe("an unreferenced override outside the band of a stored provider rate stops winning", () => {
  test("reset -> override 1050 -> provider 1500 prices at 1500 at once, and the overview says why", async () => {
    const { service, store, clock } = makeService();
    await service.refreshAll(); // provider 1500
    await service.resetReference("NGN", "Genuine devaluation confirmed", "admin-1");
    await service.setOverride("NGN", { rate: 1050, reason: REASON }, "admin-1");
    // No provider rate yet: the override is all there is, so it prices.
    assert.equal((await service.getRate("NGN")).rate, 1050);

    clock.advanceHours(1);
    const { result } = await quietly(() => service.refreshAll());
    assert.equal(result![0].ok, true);
    assert.match(result![0].warning ?? "", /no longer prices/);

    const rate = await service.getRate("NGN");
    assert.deepEqual([rate.rate, rate.source], [1500, "cbn"]);
    const [row] = await service.adminOverview();
    assert.deepEqual([row.effective?.rate, row.effective?.source], [1500, "cbn"]);
    const superseded = row.warnings.find((w) => w.code === "OVERRIDE_SUPERSEDED");
    assert.ok(superseded, "flagged as superseded");
    assert.match(superseded!.message, /1050.*1500/);
    // The override is still stored (the admin decides to clear or replace it).
    assert.equal(store.docs.get("NGN")?.override?.rate, 1050);
  });

  test("an unreferenced override INSIDE the band of the fresh provider rate keeps winning", async () => {
    const { service, cbn, clock } = makeService();
    await service.setOverride("NGN", { rate: 1450, reason: REASON }, "a"); // no provider yet
    clock.advanceHours(1);
    cbn.result = { ok: true, rate: 1500, asOf: new Date("2026-11-13T09:00:00Z") }; // 1450 is -3.3%
    await service.refreshAll();
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1450, "manual"]);
    const [row] = await service.adminOverview();
    assert.deepEqual(row.warnings.map((w) => w.code), ["OVERRIDE_UNREFERENCED"]);
  });

  // #229 review (blocking): supersession is judged against ANY stored
  // provider rate, fresh or stale. Before the fix, an out-of-band unreferenced
  // override priced again as soon as the provider rate went stale.
  test("an unreferenced override facing only a STALE out-of-band provider rate fails closed (RATE_STALE)", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    const { service } = makeService({ store, clock });
    const setAt = clock.now();
    store.docs.set("NGN", {
      currency: "NGN",
      // fetched 100h ago: past the 72h freshness limit
      provider: providerAt(1500, new Date(setAt.getTime() - 100 * HOUR)),
      override: { rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR), unreferenced: true },
      lastError: null,
    });
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_STALE");
    const [row] = await service.adminOverview();
    assert.equal(row.effective, null);
    assert.ok(row.warnings.some((w) => w.code === "OVERRIDE_SUPERSEDED"), "still flagged as superseded");
  });

  test("an unreferenced override INSIDE the band of a stale provider rate keeps winning (not superseded)", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    const { service } = makeService({ store, clock });
    const setAt = clock.now();
    store.docs.set("NGN", {
      currency: "NGN",
      provider: providerAt(1500, new Date(setAt.getTime() - 100 * HOUR)),
      override: { rate: 1450, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR), unreferenced: true },
      lastError: null,
    });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1450, "manual"]);
  });

  // The reviewer's reproduction, end to end through the real refresh path:
  // an accepted provider row that is already ~130h old (holiday closure)
  // ages past the 144h rate-age limit while the 24h override is still live.
  test("reviewer scenario: aged asOf ages out under a superseded override -> RATE_STALE, never 1050 manual", async () => {
    const { service, cbn, clock } = makeService();
    await service.refreshAll(); // 1500, current
    await service.resetReference("NGN", "Genuine devaluation confirmed", "admin-1");
    await service.setOverride("NGN", { rate: 1050, reason: REASON }, "admin-1"); // typo, unreferenced, 24h

    // The upstream serves a row dated 130h ago; it is within 144h, so accepted.
    clock.advanceHours(1);
    cbn.result = { ok: true, rate: 1500, asOf: new Date(clock.now().getTime() - 130 * HOUR) };
    const first = await quietly(() => service.refreshAll());
    assert.equal(first.result![0].ok, true);
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1500, "cbn"]);

    // 15h later the upstream is still stuck on the same row: now 145h old,
    // refused. The stored provider rate is past the rate-age limit.
    clock.advanceHours(15);
    const second = await quietly(() => service.refreshAll());
    assert.equal(second.result![0].ok, false);
    assert.match(second.result![0].reason ?? "", /dated more than 144 hours ago/);

    // The override (still active: 16h of 24h) must NOT price again.
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_STALE");
    const [row] = await service.adminOverview();
    assert.equal(row.effective, null);
    assert.ok(row.warnings.some((w) => w.code === "OVERRIDE_SUPERSEDED"));
  });

  test("a referenced override inside the band keeps winning and records the rate it was checked against", async () => {
    const { service } = makeService();
    await service.refreshAll(); // 1500
    const saved = await service.setOverride("NGN", { rate: 1560, reason: REASON, ttlHours: 48 }, "a");
    assert.equal(saved.override?.referenceRate, 1500);
    assert.equal(isUnreferencedOverride(saved.override!), false);
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1560, "manual"]);
  });

  test("a referenced override that drifts outside the band is flagged but NOT superseded (as before)", async () => {
    const { service, cbn, clock } = makeService();
    await service.refreshAll(); // 1500
    await service.setOverride("NGN", { rate: 1640, reason: REASON, ttlHours: 48 }, "a");
    clock.advanceHours(6);
    cbn.result = { ok: true, rate: 1440, asOf: new Date("2026-11-13T12:00:00Z") };
    const { result } = await quietly(() => service.refreshAll());
    assert.match(result![0].warning ?? "", /check it and clear or replace it/);
    assert.equal((await service.getRate("NGN")).rate, 1640);
    const [row] = await service.adminOverview();
    assert.deepEqual(row.warnings.map((w) => w.code), ["OVERRIDE_OUTSIDE_PROVIDER_BAND"]);
  });

  test("a legacy override (no unreferenced flag, no referenceRate) is treated as unreferenced", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    const { service } = makeService({ store, clock });
    const setAt = new Date(clock.now().getTime() - HOUR);
    store.docs.set("NGN", {
      currency: "NGN",
      provider: providerAt(1500, clock.now()), // fresh
      // As #178 code wrote it: a week-long override, no flags.
      override: { rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 168 * HOUR) },
      lastError: null,
    });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1500, "cbn"]);
    const [row] = await service.adminOverview();
    assert.deepEqual(row.warnings.map((w) => w.code).sort(), ["OVERRIDE_OUTSIDE_PROVIDER_BAND", "OVERRIDE_SUPERSEDED"]);
    // A legacy override inside the band still prices.
    store.docs.set("NGN", { ...store.docs.get("NGN")!, override: { ...store.docs.get("NGN")!.override!, rate: 1480 } });
    assert.equal((await service.getRate("NGN")).rate, 1480);
  });

  // #229 review (blocking): a legacy override can live up to 168h, longer
  // than the 72h freshness limit (fetchedAt). When that lapses, the override
  // that the provider rate had shown wrong must not price again.
  test("a legacy out-of-band override fails closed when the 72h freshness limit lapses", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    const { service } = makeService({ store, clock });
    const setAt = new Date(clock.now().getTime() - HOUR);
    store.docs.set("NGN", {
      currency: "NGN",
      provider: providerAt(1500, clock.now()), // fresh now
      override: { rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 168 * HOUR) },
      lastError: null,
    });
    assert.equal((await service.getRate("NGN")).rate, 1500);
    clock.advanceHours(73); // fetchedAt now 73h old; override still has ~94h
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_STALE");
    // A legacy override INSIDE the band is not superseded, stale or not.
    store.docs.set("NGN", { ...store.docs.get("NGN")!, override: { ...store.docs.get("NGN")!.override!, rate: 1480 } });
    assert.deepEqual([(await service.getRate("NGN")).rate, (await service.getRate("NGN")).source], [1480, "manual"]);
  });

  // #229 review: the old text claimed every superseded override "was not
  // checked against a provider rate when set", untrue for legacy ones.
  test("the OVERRIDE_SUPERSEDED message is true for both a post-reset and a legacy override", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    const { service } = makeService({ store, clock });
    const setAt = clock.now();
    const base = { rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR) };
    for (const override of [{ ...base, unreferenced: true }, base]) {
      store.docs.set("NGN", { currency: "NGN", provider: providerAt(1500, clock.now()), override, lastError: null });
      const [row] = await service.adminOverview();
      const msg = row.warnings.find((w) => w.code === "OVERRIDE_SUPERSEDED")?.message ?? "";
      assert.match(msg, /reference is unknown/);
      assert.doesNotMatch(msg, /was not checked against a provider rate/);
    }
  });

  test("audits agree with pricing: clearing a superseded override records the provider rate as `old`", async () => {
    const { service, store, clock } = makeService();
    await service.refreshAll();
    await service.resetReference("NGN", "Genuine devaluation confirmed", "a");
    await service.setOverride("NGN", { rate: 1050, reason: REASON }, "a");
    clock.advanceHours(1);
    await quietly(() => service.refreshAll());
    await service.clearOverride("NGN", "it was a typo", "a");
    assert.deepEqual(store.audit.at(-1)?.old, { rate: 1500, source: "cbn" });
  });
});

// ---------------------------------------------------------------
// 2. A stored range may only narrow the default
// ---------------------------------------------------------------
describe("a stored currency range may only narrow the default", () => {
  const range = (raw: Record<string, unknown>, c = "NGN") => {
    const e = parseCurrenciesConfig({ currencies: { [c]: raw } }).currencies[c];
    return [e.minRate, e.maxRate];
  };

  test("a narrower range is honoured", () => {
    assert.deepEqual(range({ minRate: 1000, maxRate: 2000 }), [1000, 2000]);
  });

  test("each wider bound falls back to the default's bound on its own", () => {
    assert.deepEqual(range({ minRate: 100, maxRate: 5000 }), [200, 5000]);
    assert.deepEqual(range({ minRate: 300, maxRate: 9000 }), [300, 5000]);
    assert.deepEqual(range({ minRate: 100, maxRate: 2000 }), [200, 2000]);
    assert.deepEqual(range({ minRate: 199.99, maxRate: 5000.01 }), [200, 5000]);
  });

  test("a malformed bound falls back; a narrowed but inverted pair keeps the default pair", () => {
    assert.deepEqual(range({ minRate: -5, maxRate: "x" }), [200, 5000]);
    assert.deepEqual(range({ minRate: 3000, maxRate: 2500 }), [200, 5000]);
  });

  test("a currency with no default range keeps the existing pair validation", () => {
    assert.deepEqual(range({ enabled: true, countries: ["GH"], minRate: 5, maxRate: 50 }, "GHS"), [5, 50]);
    assert.deepEqual(range({ enabled: true, countries: ["GH"], minRate: 1, maxRate: 100 }, "GHS"), [undefined, undefined]);
    assert.deepEqual(range({ enabled: true, countries: ["GH"], minRate: 50, maxRate: 5 }, "GHS"), [undefined, undefined]);
  });

  test("end to end: a stored 100-5000 cannot let an unreferenced 150 override (decimal slip) through", async () => {
    const { service } = makeService({ config: { currencies: { NGN: { minRate: 100, maxRate: 5000 } } } });
    await assert.rejects(service.setOverride("NGN", { rate: 150, reason: REASON }, "a"), (e) => code(e) === "INVALID_INPUT");
  });

  test("end to end: a stored 100-5000 cannot let a first provider rate of 150 through", async () => {
    const cbn = fakeProvider("cbn", { result: { ok: true, rate: 150, asOf: new Date("2026-11-13T00:00:00Z") } });
    const { service, store } = makeService({ cbn, config: { currencies: { NGN: { minRate: 100, maxRate: 5000 } } } });
    const { result } = await quietly(() => service.refreshAll());
    assert.equal(result![0].ok, false);
    assert.equal(store.docs.get("NGN")?.provider ?? null, null);
  });
});

// ---------------------------------------------------------------
// 3. refreshNow audits every outcome
// ---------------------------------------------------------------
describe("refresh now audits every outcome", () => {
  /** A memory store with chosen methods made to throw (one-shot or always). */
  function failingStore(fail: Partial<Record<"getFirst" | "getAfter" | "saveProvider" | "appendAudit", boolean>>) {
    const inner = memoryRateStore();
    let gets = 0;
    const store: RateStore & { inner: typeof inner } = {
      ...inner,
      inner,
      async get(c) {
        gets++;
        // refreshNow reads: before (1st), refreshOne (2nd), after (3rd).
        if (fail.getFirst && gets === 1) throw new Error("Firestore unavailable (read)");
        if (fail.getAfter && gets === 3) throw new Error("Firestore unavailable (after)");
        return inner.get(c);
      },
      async saveProvider(c, p, e) {
        if (fail.saveProvider) throw new Error("Firestore unavailable (write)");
        return inner.saveProvider(c, p, e);
      },
      async appendAudit(a) {
        if (fail.appendAudit) throw new Error("Firestore unavailable (audit)");
        return inner.appendAudit(a);
      },
    };
    return store;
  }

  test("a Firestore error before the provider is contacted: audited, rethrown, provider not called, slot released", async () => {
    const store = failingStore({ getFirst: true });
    const { service, cbn } = makeService({ store: store as any });
    const { error } = await quietly(() => service.refreshNow("NGN", undefined, "admin-1"));
    assert.match((error as Error)?.message ?? "", /Firestore unavailable \(read\)/);
    assert.equal(cbn.calls, 0);
    const a = store.inner.audit.at(-1)!;
    assert.equal(a.action, "provider_refresh");
    assert.match(a.outcome ?? "", /^failed: Firestore unavailable \(read\) \(refresh slot released\)/);
    assert.equal(store.inner.docs.get("NGN")?.manualRefreshAt, null);
    // The slot is free: the admin can try again at once, and it works.
    const out = await service.refreshNow("NGN", undefined, "admin-1");
    assert.equal(out.ok, true);
  });

  test("a Firestore error after the provider was contacted: audited, rethrown, slot kept", async () => {
    const store = failingStore({ saveProvider: true });
    const { service, cbn, clock } = makeService({ store: store as any });
    const { error } = await quietly(() => service.refreshNow("NGN", "Undo the mistaken reset", "admin-1"));
    assert.match((error as Error)?.message ?? "", /write/);
    assert.equal(cbn.calls, 1);
    const a = store.inner.audit.at(-1)!;
    assert.deepEqual([a.action, a.reason, a.old, a.new], ["provider_refresh", "Undo the mistaken reset", null, null]);
    assert.match(a.outcome ?? "", /^failed: Firestore unavailable \(write\)$/);
    clock.advanceHours(1 / 60);
    await assert.rejects(service.refreshNow("NGN", undefined, "admin-1"), (e) => code(e) === "RATE_LIMITED");
  });

  test("a failed audit write after a successful refresh: the response still reports the new rate", async () => {
    const store = failingStore({ appendAudit: true });
    const { service } = makeService({ store: store as any });
    const { result, error, logged } = await quietly(() => service.refreshNow("NGN", undefined, "admin-1"));
    assert.equal(error, undefined);
    assert.deepEqual([result?.ok, result?.rate, result?.source], [true, 1500, "cbn"]);
    assert.equal((await service.getRate("NGN")).rate, 1500);
    assert.ok(logged.some((l) => /audit write failed/.test(l) && /ok: cbn 1500/.test(l)), "logged at error level");
  });

  test("the rate after the refresh cannot be read: still audited, `new` null and noted", async () => {
    const store = failingStore({ getAfter: true });
    const { service } = makeService({ store: store as any });
    const out = await service.refreshNow("NGN", undefined, "admin-1");
    assert.equal(out.ok, true);
    const a = store.inner.audit.at(-1)!;
    assert.equal(a.new, null);
    assert.match(a.outcome ?? "", /^ok: cbn 1500 \(rate after the refresh could not be read\)$/);
  });
});

// ---------------------------------------------------------------
// 4. Conditional provider write
// ---------------------------------------------------------------
describe("the scheduled refresh writes the provider rate conditionally", () => {
  test("a reset-reference landing while the provider is fetched is not undone", async () => {
    const { service, store, cbn, clock } = makeService();
    await service.refreshAll(); // 1500 stored
    clock.advanceHours(6);
    // The admin's reset commits while the scheduled refresh waits on CBN.
    const fetch = cbn.fetchRate.bind(cbn);
    cbn.fetchRate = async (c: string) => {
      await service.resetReference("NGN", "Genuine devaluation confirmed", "admin-1");
      return fetch(c);
    };
    const { result } = await quietly(() => service.refreshAll());
    assert.equal(result![0].ok, false);
    assert.match(result![0].reason ?? "", /changed during the refresh/);
    assert.equal(store.docs.get("NGN")?.provider, null, "the reset stands");
    assert.equal(store.docs.get("NGN")?.lastError, null, "not recorded as a provider failure");
    // The next refresh judges the new rate against the doc as it is now.
    cbn.fetchRate = fetch;
    cbn.result = { ok: true, rate: 2100, asOf: new Date("2026-11-13T12:00:00Z") }; // +40%: only possible after the reset
    const next = await service.refreshAll();
    assert.deepEqual([next[0].ok, next[0].rate], [true, 2100]);
  });

  test("with nothing changed in between, the rate is stored as before", async () => {
    const { service, store } = makeService();
    const out = await service.refreshAll();
    assert.equal(out[0].ok, true);
    assert.equal(store.docs.get("NGN")?.provider?.rate, 1500);
  });

  describe("Firestore store", () => {
    before(async () => {
      await installFakes();
      (firebase.collections as any).exchangeRateAudit = fakeCollection("exchangeRateAudit");
      (firestoreRateStore as any).runTransaction = fakeRunTransaction;
    });
    beforeEach(() => resetStore());

    const t0 = new Date("2026-11-13T09:00:00Z");
    const p1500 = providerAt(1500, t0);
    const docWith = (provider: ReturnType<typeof providerAt> | null): Record<string, unknown> => ({
      currency: "NGN",
      provider: provider
        ? { ...provider, asOf: Timestamp.fromDate(provider.asOf), fetchedAt: Timestamp.fromDate(provider.fetchedAt) }
        : null,
    });

    test("writes when the provider part is unchanged (a refresh-now claim in between does not count)", async () => {
      fakeDocs.set("exchangeRates/NGN", docWith(p1500));
      const expected = await firestoreRateStore.get("NGN");
      await firestoreRateStore.claimManualRefresh("NGN", t0, 5 * 60_000); // touches the same doc
      const ok = await firestoreRateStore.saveProvider("NGN", providerAt(1520, new Date(t0.getTime() + HOUR)), expected);
      assert.equal(ok.saved, true);
      assert.equal((await firestoreRateStore.get("NGN"))?.provider?.rate, 1520);
    });

    test("refuses, writing nothing, when the provider was reset in between", async () => {
      fakeDocs.set("exchangeRates/NGN", docWith(p1500));
      const expected = await firestoreRateStore.get("NGN");
      fakeDocs.set("exchangeRates/NGN", docWith(null)); // reset-reference committed
      const ok = await firestoreRateStore.saveProvider("NGN", providerAt(1520, t0), expected);
      assert.equal(ok.saved, false);
      assert.equal((await firestoreRateStore.get("NGN"))?.provider, null);
    });

    test("refuses when another refresh stored a different rate in between; a first write needs a missing doc", async () => {
      fakeDocs.set("exchangeRates/NGN", docWith(p1500));
      const expected = await firestoreRateStore.get("NGN");
      fakeDocs.set("exchangeRates/NGN", docWith(providerAt(1510, t0)));
      assert.equal((await firestoreRateStore.saveProvider("NGN", providerAt(1520, t0), expected)).saved, false);
      // No doc read (null) and none there: the first rate is written.
      resetStore();
      assert.equal((await firestoreRateStore.saveProvider("NGN", p1500, null)).saved, true);
      assert.equal((await firestoreRateStore.saveProvider("NGN", p1500, null)).saved, false, "a doc now exists");
    });

    // #229 review: saveProvider hands back the override as read inside its
    // transaction, so refreshOne's warning reflects the doc at write time.
    test("on success it returns the override read in the transaction (null when none)", async () => {
      fakeDocs.set("exchangeRates/NGN", docWith(p1500));
      const expected = await firestoreRateStore.get("NGN");
      // An override lands after the caller's read, before the save.
      const setAt = t0;
      fakeDocs.set("exchangeRates/NGN", {
        ...docWith(p1500),
        override: {
          rate: 1050, reason: REASON, setBy: "a", unreferenced: true,
          setAt: Timestamp.fromDate(setAt), expiresAt: Timestamp.fromDate(new Date(setAt.getTime() + 24 * HOUR)),
        },
      });
      const res = await firestoreRateStore.saveProvider("NGN", providerAt(1520, new Date(t0.getTime() + HOUR)), expected);
      assert.equal(res.saved, true);
      assert.equal(res.saved && res.override?.rate, 1050);
      assert.equal((await firestoreRateStore.get("NGN"))?.override?.rate, 1050, "the merge keeps the override");
      resetStore();
      const first = await firestoreRateStore.saveProvider("NGN", p1500, null);
      assert.deepEqual(first, { saved: true, override: null });
    });

    test("the provider fetch never runs inside a transaction", async () => {
      let inTx = false;
      const prev = (firestoreRateStore as any).runTransaction;
      (firestoreRateStore as any).runTransaction = async (fn: any) => {
        inTx = true;
        try {
          return await fakeRunTransaction(fn);
        } finally {
          inTx = false;
        }
      };
      try {
        const cbn = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: new Date("2026-11-13T00:00:00Z") } });
        const fetch = cbn.fetchRate.bind(cbn);
        const seen: boolean[] = [];
        cbn.fetchRate = async (c: string) => {
          seen.push(inTx);
          return fetch(c);
        };
        const clock = fakeClock();
        const service = new RateService({
          config: { read: async () => null },
          rates: firestoreRateStore,
          providers: { cbn, oanda: fakeProvider("oanda", { configured: false }) },
          now: clock.now,
        });
        assert.equal((await service.refreshAll())[0].ok, true);
        assert.equal((await service.refreshNow("NGN", undefined, "a")).ok, true);
        assert.deepEqual(seen, [false, false]);
      } finally {
        (firestoreRateStore as any).runTransaction = prev;
      }
    });

    test("releaseManualRefresh clears only the claim it was given", async () => {
      await firestoreRateStore.claimManualRefresh("NGN", t0, 5 * 60_000);
      await firestoreRateStore.releaseManualRefresh("NGN", new Date(t0.getTime() - 1));
      assert.equal((await firestoreRateStore.get("NGN"))?.manualRefreshAt?.getTime(), t0.getTime());
      await firestoreRateStore.releaseManualRefresh("NGN", t0);
      assert.equal((await firestoreRateStore.get("NGN"))?.manualRefreshAt, null);
      assert.deepEqual(await firestoreRateStore.claimManualRefresh("NGN", new Date(t0.getTime() + 1000), 5 * 60_000), {
        allowed: true,
      });
    });

    test("referenceRate round-trips; a stored override without flags reads as legacy (unreferenced)", async () => {
      const setAt = t0;
      const ov = { rate: 1520, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + HOUR) };
      await firestoreRateStore.transact("NGN", () => ({
        override: { ...ov, referenceRate: 1500 },
        audit: { currency: "NGN", action: "override_set", by: "a", at: setAt, reason: REASON, old: null, new: null },
      }));
      const got = (await firestoreRateStore.get("NGN")) as StoredRate;
      assert.equal(got.override?.referenceRate, 1500);
      assert.equal(isUnreferencedOverride(got.override!), false);
      // A pre-#229 doc: no referenceRate, no unreferenced flag.
      fakeDocs.set("exchangeRates/NGN", {
        currency: "NGN",
        override: { ...ov, setAt: Timestamp.fromDate(ov.setAt), expiresAt: Timestamp.fromDate(ov.expiresAt) },
      });
      const legacy = (await firestoreRateStore.get("NGN")) as StoredRate;
      assert.equal(legacy.override?.referenceRate, undefined);
      assert.equal(isUnreferencedOverride(legacy.override!), true);
    });
  });
});

// ---------------------------------------------------------------
// 4b. #229 review: the refresh warning judges the override as it is when the
//     rate is written, not as it was read before the provider fetch
// ---------------------------------------------------------------
describe("the refresh warning uses the override re-read at write time", () => {
  /** A cbn provider that runs `during` while its fetch is "in flight". */
  function providerWith(during: () => void, rate = 1500) {
    const p = fakeProvider("cbn", { result: { ok: true, rate, asOf: new Date("2026-11-13T10:00:00Z") } });
    const inner = p.fetchRate.bind(p);
    p.fetchRate = async (currency) => {
      during();
      return inner(currency);
    };
    return p;
  }

  test("an override CLEARED while the fetch ran gives no warning", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    const cbn = providerWith(() => {
      store.docs.set("NGN", { ...store.docs.get("NGN")!, override: null }); // admin clears it
    });
    const { service } = makeService({ store, clock, cbn });
    const setAt = clock.now();
    store.docs.set("NGN", {
      currency: "NGN",
      provider: null,
      override: { rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR), unreferenced: true },
      lastError: null,
    });
    clock.advanceHours(1);
    const { result, logged } = await quietly(() => service.refreshAll());
    assert.equal(result![0].ok, true);
    assert.equal(result![0].warning, undefined);
    assert.equal(logged.some((l) => /active override/.test(l)), false);
  });

  test("an override SET while the fetch ran is warned about", async () => {
    const store = memoryRateStore();
    const clock = fakeClock();
    const cbn = providerWith(() => {
      const setAt = clock.now();
      store.docs.set("NGN", {
        ...(store.docs.get("NGN") ?? { currency: "NGN", provider: null, override: null, lastError: null }),
        override: { rate: 1050, reason: REASON, setBy: "a", setAt, expiresAt: new Date(setAt.getTime() + 24 * HOUR), unreferenced: true },
      });
    });
    const { service } = makeService({ store, clock, cbn });
    const { result, logged } = await quietly(() => service.refreshAll());
    assert.equal(result![0].ok, true);
    assert.match(result![0].warning ?? "", /active override 1050 .*no longer prices/);
    assert.ok(logged.some((l) => /active override 1050/.test(l)));
  });
});

// ---------------------------------------------------------------
// 5. "Public rates" doc comment placement
// ---------------------------------------------------------------
describe("the Public rates doc comment documents createPublicRatesRouter", () => {
  test("the JSDoc block right before createPublicRatesRouter is the Public rates one", () => {
    const src = readFileSync(join(__dirname, "../../src/routes/exchange-rate.routes.ts"), "utf8");
    const at = src.indexOf("export function createPublicRatesRouter(");
    assert.ok(at > 0);
    const before = src.slice(0, at).trimEnd();
    assert.ok(before.endsWith("*/"), "a doc comment sits directly on the function");
    const doc = before.slice(before.lastIndexOf("/**"));
    assert.match(doc, /Public rates\. Exposes ONLY/);
    // And the cache constant keeps its own comment, above.
    assert.match(src, /\/\*\* How long one instance reuses a built GET \/rates body \(issue #214\)\. \*\/\nexport const PUBLIC_RATES_CACHE_MS/);
  });
});
