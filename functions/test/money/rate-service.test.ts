// ============================================
// Unit tests: quote(), rate service, config, selection, admin override (issue #178)
// ============================================

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { quote, quoteWithRate, toChargeSnapshot } from "../../src/money/quote";
import { makeMoney } from "../../src/money/money";
import { MoneyError } from "../../src/money/errors";
import { parseCurrenciesConfig, resolveChargeCurrency, DEFAULT_CURRENCIES_CONFIG } from "../../src/money/config";
import { selectProviders } from "../../src/money/providers/select";
import { fakeProvider, makeService } from "./helpers";

const usd = (c: number) => makeMoney(c, "USD");
const code = (e: unknown) => (e instanceof MoneyError ? e.code : "not-a-money-error");

describe("quoteWithRate is pure", () => {
  const rate = { currency: "NGN", rate: 1500, asOf: "2026-11-13T00:00:00.000Z", source: "cbn" as const, marginBps: 0 };
  test("returns usd, local, rate, asOf, source, marginBps", () => {
    const q = quoteWithRate(usd(2500), rate);
    assert.deepEqual(q, {
      usd: { amountMinor: 2500, currency: "USD" },
      local: { amountMinor: 3_750_000, currency: "NGN" },
      rate: 1500,
      asOf: rate.asOf,
      source: "cbn",
      marginBps: 0,
    });
    assert.deepEqual(quoteWithRate(usd(2500), rate), q); // same in, same out
  });
  test("margin field is carried and applied", () => {
    const q = quoteWithRate(usd(1000), { ...rate, marginBps: 100 });
    assert.equal(q.marginBps, 100);
    assert.equal(q.local.amountMinor, 1_515_000);
  });
  test("refuses a non-USD price", () => {
    assert.throws(() => quoteWithRate({ amountMinor: 1, currency: "NGN" }, rate), MoneyError);
  });
  test("toChargeSnapshot uses the exact contract field names", () => {
    const snap = toChargeSnapshot(quoteWithRate(usd(1000), rate));
    assert.deepEqual(Object.keys(snap).sort(), [
      "chargedAmountMinor", "chargedCurrency", "fxMarginBps", "fxRate", "fxRateAsOf", "fxRateSource", "priceUsdCents",
    ]);
    assert.equal(snap.priceUsdCents, 1000);
    assert.equal(snap.chargedCurrency, "NGN");
    assert.equal(snap.chargedAmountMinor, 1_500_000);
    assert.equal(snap.fxRateAsOf.toDate().toISOString(), rate.asOf);
  });
});

describe("quote(): rate, freshness expiry, unsupported currency", () => {
  test("missing rate -> RATE_UNAVAILABLE, never a number", async () => {
    const { service } = makeService();
    await assert.rejects(quote(usd(100), "NGN", service), (e) => code(e) === "RATE_UNAVAILABLE");
  });
  test("fresh rate prices; the same rate past the freshness limit fails with RATE_STALE", async () => {
    const { service, clock } = makeService();
    await service.refreshAll();
    const q = await quote(usd(1000), "ngn", service);
    assert.equal(q.local.amountMinor, 1_500_000);
    assert.equal(q.source, "cbn");
    clock.advanceHours(71);
    await quote(usd(1000), "NGN", service); // still inside 72h
    clock.advanceHours(2);
    await assert.rejects(quote(usd(1000), "NGN", service), (e) => code(e) === "RATE_STALE");
  });
  test("freshness limit comes from config", async () => {
    const { service, clock } = makeService({ config: { freshnessHours: 2 } });
    await service.refreshAll();
    clock.advanceHours(3);
    await assert.rejects(quote(usd(100), "NGN", service), (e) => code(e) === "RATE_STALE");
  });
  test("unsupported and disabled currencies are typed errors, not a fallback", async () => {
    const { service } = makeService({
      config: { currencies: { NGN: { enabled: true, countries: ["NG"] }, GHS: { enabled: false, countries: ["GH"] } } },
    });
    await service.refreshAll();
    await assert.rejects(quote(usd(100), "XXX", service), (e) => code(e) === "CURRENCY_UNSUPPORTED");
    await assert.rejects(quote(usd(100), "EUR", service), (e) => code(e) === "CURRENCY_UNSUPPORTED"); // known, not configured
    await assert.rejects(quote(usd(100), "GHS", service), (e) => code(e) === "CURRENCY_DISABLED");
    await assert.rejects(quote(usd(100), "not a code", service), (e) => code(e) === "CURRENCY_UNSUPPORTED");
  });
  test("margin comes from config (per currency, else default)", async () => {
    const { service } = makeService({ config: { defaultMarginBps: 50 } });
    await service.refreshAll();
    assert.equal((await quote(usd(100), "NGN", service)).marginBps, 50);
    const b = makeService({ config: { currencies: { NGN: { enabled: true, countries: [], marginBps: 200, minRate: 200, maxRate: 5000 } }, defaultMarginBps: 50 } });
    await b.service.refreshAll();
    assert.equal((await quote(usd(100), "NGN", b.service)).marginBps, 200);
  });
});

describe("config", () => {
  test("a missing doc gives defaults: NGN only, margin 0", () => {
    const c = parseCurrenciesConfig(null);
    assert.equal(c.currencies.NGN.enabled, true);
    assert.equal(c.defaultMarginBps, 0);
    assert.equal(c.provider, "cbn");
  });
  test("adding a currency is a config change, malformed entries are ignored", () => {
    const c = parseCurrenciesConfig({
      currencies: { NGN: { enabled: true, countries: ["NG"] }, GHS: { enabled: true, countries: ["GH", "Ghana"] }, BAD: 5, XXX: { enabled: true } },
      freshnessHours: -1,
      defaultMarginBps: 99999,
    });
    assert.deepEqual(Object.keys(c.currencies).sort(), ["GHS", "NGN"]);
    assert.equal(c.freshnessHours, DEFAULT_CURRENCIES_CONFIG.freshnessHours);
    assert.equal(c.defaultMarginBps, 0);
  });
  test("charge currency comes from the profile country; NGN by default; the client cannot choose", () => {
    const c = parseCurrenciesConfig({
      currencies: { NGN: { enabled: true, countries: ["NG", "Nigeria"] }, GHS: { enabled: true, countries: ["GH", "Ghana"] } },
    });
    assert.equal(resolveChargeCurrency("Nigeria", c), "NGN");
    assert.equal(resolveChargeCurrency(" gh ", c), "GHS");
    assert.equal(resolveChargeCurrency(undefined, c), "NGN");
    assert.equal(resolveChargeCurrency("Brazil", c), "NGN");
    // The function's only inputs are the profile country and config: there is no currency parameter.
    assert.equal(resolveChargeCurrency.length, 2);
  });
  test("a country mapped to a disabled currency resolves to it (so the quote errors, no silent naira)", async () => {
    const raw = { currencies: { NGN: { enabled: true, countries: ["NG"] }, GHS: { enabled: false, countries: ["GH"] } } };
    const { service } = makeService({ config: raw });
    const cfg = await service.getConfig();
    const cur = resolveChargeCurrency("GH", cfg);
    assert.equal(cur, "GHS");
    await assert.rejects(quote(usd(100), cur, service), (e) => code(e) === "CURRENCY_DISABLED");
  });
});

describe("provider selection and fallback", () => {
  const cbn = fakeProvider("cbn");
  test("default is cbn only", () => {
    const oanda = fakeProvider("oanda", { configured: true });
    assert.deepEqual(selectProviders({ provider: "cbn" }, { cbn, oanda }).map((p) => p.id), ["cbn"]);
  });
  test("oanda preferred but no key -> cbn only (never called)", () => {
    const oanda = fakeProvider("oanda", { configured: false });
    assert.deepEqual(selectProviders({ provider: "oanda" }, { cbn, oanda }).map((p) => p.id), ["cbn"]);
  });
  test("oanda preferred with a key -> oanda then cbn", () => {
    const oanda = fakeProvider("oanda", { configured: true });
    assert.deepEqual(selectProviders({ provider: "oanda" }, { cbn, oanda }).map((p) => p.id), ["oanda", "cbn"]);
  });
  test("refresh falls back to cbn when oanda fails, and records the source", async () => {
    const oanda = fakeProvider("oanda", { configured: true, result: { ok: false, reason: "down" } });
    const c = fakeProvider("cbn", { result: { ok: true, rate: 1400, asOf: new Date("2026-11-13T00:00:00Z") } });
    const { service, store } = makeService({ config: { provider: "oanda" }, cbn: c, oanda });
    const out = await service.refreshAll();
    assert.equal(oanda.calls, 1);
    assert.deepEqual([out[0].ok, out[0].source], [true, "cbn"]);
    assert.equal(store.docs.get("NGN")?.provider?.source, "cbn");
  });
  test("refresh uses oanda when it answers", async () => {
    const oanda = fakeProvider("oanda", { configured: true, supports: ["NGN"], result: { ok: true, rate: 1450, asOf: new Date("2026-11-13T00:00:00Z") } });
    const { service, cbn } = makeService({ config: { provider: "oanda" }, oanda });
    const out = await service.refreshAll();
    assert.equal(out[0].source, "oanda");
    assert.equal((cbn as { calls?: number }).calls, 0);
  });
});

describe("outage keeps the last rate until the limit; never invents one", () => {
  test("failed refresh keeps the stored rate and records the error", async () => {
    const { service, store, cbn, clock } = makeService();
    await service.refreshAll();
    cbn.result = { ok: false, reason: "CBN answered 503" };
    clock.advanceHours(6);
    const out = await service.refreshAll();
    assert.equal(out[0].ok, false);
    assert.match(store.docs.get("NGN")?.lastError?.message ?? "", /503/);
    assert.equal((await service.getRate("NGN")).rate, 1500); // still serving
    clock.advanceHours(70);
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_STALE");
  });
  test("an invalid provider rate is rejected, not stored", async () => {
    const bad = fakeProvider("cbn", { result: { ok: true, rate: -3, asOf: new Date() } });
    const { service, store } = makeService({ cbn: bad });
    const out = await service.refreshAll();
    assert.equal(out[0].ok, false);
    assert.equal(store.docs.get("NGN")?.provider ?? null, null);
  });
  test("disabled currencies are not refreshed", async () => {
    const { service, cbn } = makeService({ config: { currencies: { NGN: { enabled: false, countries: [] } } } });
    assert.deepEqual(await service.refreshAll(), []);
    assert.equal((cbn as { calls?: number }).calls, 0);
  });
});

describe("admin override: bounds and audit", () => {
  const input = (rate: unknown, reason: unknown = "CBN site is down today") => ({ rate, reason });

  test("accepts a rate inside the band, stores who/when/why and writes an audit entry", async () => {
    const { service, store, clock } = makeService();
    await service.refreshAll(); // provider rate 1500
    const r = await service.setOverride("NGN", input(1560), "admin-1"); // +4%
    assert.equal(r.override?.setBy, "admin-1");
    assert.equal(r.override?.reason, "CBN site is down today");
    const eff = await service.getRate("NGN");
    assert.deepEqual([eff.rate, eff.source], [1560, "manual"]);
    assert.equal(store.audit.length, 1);
    const a = store.audit[0];
    assert.deepEqual(
      [a.action, a.by, a.currency, a.old, a.new, a.at.toISOString()],
      ["override_set", "admin-1", "NGN", { rate: 1500, source: "cbn" }, { rate: 1560, source: "manual" }, clock.now().toISOString()]
    );
  });
  test("band edges: exactly 10% is accepted, just over is refused", async () => {
    const { service } = makeService();
    await service.refreshAll();
    await service.setOverride("NGN", input(1650), "a"); // exactly +10%
    await service.setOverride("NGN", input(1350), "a"); // exactly -10%
    await assert.rejects(service.setOverride("NGN", input(1650.01), "a"), (e) => code(e) === "INVALID_INPUT");
    await assert.rejects(service.setOverride("NGN", input(1349.99), "a"), (e) => code(e) === "INVALID_INPUT");
  });
  test("rejects non-positive, non-finite, non-number, huge rates and a missing reason", async () => {
    const { service, store } = makeService();
    await service.refreshAll();
    for (const bad of [0, -1, NaN, Infinity, "1500", null, 1e10]) {
      await assert.rejects(service.setOverride("NGN", input(bad), "a"), MoneyError, String(bad));
    }
    for (const reason of [undefined, "", "no", "x".repeat(501), 5]) {
      await assert.rejects(service.setOverride("NGN", { rate: 1500, reason }, "a"), MoneyError);
    }
    assert.equal(store.audit.length, 0); // nothing audited, nothing stored on a refusal
    assert.equal(store.docs.get("NGN")?.override ?? null, null);
  });
  test("ttlHours is bounded", async () => {
    const { service } = makeService();
    await service.refreshAll();
    for (const ttl of [0, 169, NaN, "5"]) {
      await assert.rejects(service.setOverride("NGN", { ...input(1500), ttlHours: ttl }, "a"), MoneyError);
    }
    const ok = await service.setOverride("NGN", { ...input(1500), ttlHours: 2 }, "a");
    assert.equal(ok.override!.expiresAt.getTime() - ok.override!.setAt.getTime(), 2 * 3_600_000);
  });
  test("unsupported / disabled currency cannot be overridden", async () => {
    const { service } = makeService();
    await assert.rejects(service.setOverride("EUR", input(1), "a"), (e) => code(e) === "CURRENCY_UNSUPPORTED");
  });
  test("with no provider rate ever stored, the override is allowed but audited as unreferenced", async () => {
    const { service, store } = makeService();
    await service.setOverride("NGN", input(1500), "a");
    assert.equal(store.audit[0].unreferenced, true);
    assert.equal(store.audit[0].old, null);
  });
  test("an override expires; the fresh provider rate serves again; refresh does not clobber an active override", async () => {
    const { service, clock } = makeService();
    await service.refreshAll();
    await service.setOverride("NGN", { ...input(1520), ttlHours: 1 }, "a");
    clock.advanceHours(0.5);
    await service.refreshAll(); // provider part updates, override still wins
    assert.equal((await service.getRate("NGN")).source, "manual");
    clock.advanceHours(1);
    assert.equal((await service.getRate("NGN")).source, "cbn");
  });
  test("clearing an override is audited with old and new", async () => {
    const { service, store } = makeService();
    await service.refreshAll();
    await service.setOverride("NGN", input(1520), "a");
    await service.clearOverride("NGN", "CBN is back", "admin-2");
    assert.equal((await service.getRate("NGN")).source, "cbn");
    const a = store.audit[1];
    assert.deepEqual([a.action, a.by, a.old, a.new], ["override_cleared", "admin-2", { rate: 1520, source: "manual" }, { rate: 1500, source: "cbn" }]);
    await assert.rejects(service.clearOverride("NGN", "again please", "a"), MoneyError);
  });
  test("adminOverview lists stored state and audit history", async () => {
    const { service } = makeService();
    await service.refreshAll();
    await service.setOverride("NGN", input(1510), "a");
    const [row] = await service.adminOverview();
    assert.equal(row.currency, "NGN");
    assert.equal(row.audit.length, 1);
    assert.equal(row.stored?.override?.reason, "CBN site is down today");
    assert.equal(row.effective?.source, "manual");
  });
});

// ============================================
// Review fixes (issue #178): stale-date guard, jump guard, plausible range, caps
// ============================================

describe("rate's own date (asOf) limits staleness", () => {
  test("an old asOf with a fresh fetchedAt is RATE_STALE (stuck upstream re-read)", async () => {
    // Provider keeps answering with a 6-day-old row; refresh must NOT store/re-stamp it.
    const old = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: new Date("2026-11-07T00:00:00Z") } });
    const { service, store } = makeService({ cbn: old });
    const out = await service.refreshAll();
    assert.equal(out[0].ok, false);
    assert.match(store.docs.get("NGN")?.lastError?.message ?? "", /hours ago/);
    assert.equal(store.docs.get("NGN")?.provider ?? null, null);
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_UNAVAILABLE");
  });
  test("a stored rate whose asOf passes the limit goes stale even while fetchedAt is fresh", async () => {
    const { service, store, clock } = makeService();
    await service.refreshAll();
    // simulate a re-stamp: fetchedAt now, asOf 6 days old
    const doc = store.docs.get("NGN")!;
    doc.provider = { ...doc.provider!, asOf: new Date(clock.now().getTime() - 6 * 24 * 3_600_000), fetchedAt: clock.now() };
    await assert.rejects(service.getRate("NGN"), (e) => code(e) === "RATE_STALE");
  });
  test("a weekend-old rate (3 days) still prices", async () => {
    const fri = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: new Date("2026-11-13T00:00:00Z") } });
    const { service, clock } = makeService({ cbn: fri, config: { freshnessHours: 168 } });
    await service.refreshAll();
    clock.advanceHours(24 * 3 - 9);
    assert.equal((await service.getRate("NGN")).rate, 1500);
  });
  test("a future-dated provider rate is rejected", async () => {
    const fut = fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: new Date("2026-11-20T00:00:00Z") } });
    const { service, store } = makeService({ cbn: fut });
    const out = await service.refreshAll();
    assert.equal(out[0].ok, false);
    assert.match(store.docs.get("NGN")?.lastError?.message ?? "", /future/);
  });
});

describe("jump guard and plausible range", () => {
  test("decimal slip 1353.97 -> 135.39 is rejected, stored rate kept, lastError recorded", async () => {
    const { service, store, cbn, clock } = makeService();
    cbn.result = { ok: true, rate: 1353.97, asOf: new Date("2026-11-13T00:00:00Z") };
    await service.refreshAll();
    clock.advanceHours(6);
    cbn.result = { ok: true, rate: 135.39, asOf: new Date("2026-11-13T12:00:00Z") };
    const out = await service.refreshAll();
    assert.equal(out[0].ok, false);
    assert.equal(store.docs.get("NGN")?.provider?.rate, 1353.97);
    assert.ok(store.docs.get("NGN")?.lastError);
    assert.equal((await service.getRate("NGN")).rate, 1353.97);
  });
  test("a move inside the jump limit is accepted", async () => {
    const { service, cbn } = makeService();
    cbn.result = { ok: true, rate: 1500, asOf: new Date("2026-11-13T00:00:00Z") };
    await service.refreshAll();
    cbn.result = { ok: true, rate: 1560, asOf: new Date("2026-11-13T01:00:00Z") };
    assert.equal((await service.refreshAll())[0].ok, true);
  });
  test("first-run value outside the plausible range is rejected (nothing stored)", async () => {
    for (const bad of [135.39, 13539, 1]) {
      const p = fakeProvider("cbn", { result: { ok: true, rate: bad, asOf: new Date("2026-11-13T00:00:00Z") } });
      const { service, store } = makeService({ cbn: p });
      assert.equal((await service.refreshAll())[0].ok, false, String(bad));
      assert.equal(store.docs.get("NGN")?.provider ?? null, null);
    }
  });
  test("no stored rate and no configured range -> refused (nothing to judge by)", async () => {
    const { service } = makeService({ config: { currencies: { NGN: { enabled: true, countries: [] } } } });
    assert.equal((await service.refreshAll())[0].ok, false);
  });
  test("the guard applies to every provider (oanda too)", async () => {
    const oanda = fakeProvider("oanda", { configured: true, result: { ok: true, rate: 150, asOf: new Date("2026-11-13T00:00:00Z") } });
    const { service } = makeService({ config: { provider: "oanda" }, oanda });
    const out = await service.refreshAll();
    // oanda rejected (range) -> falls back to cbn 1500
    assert.equal(out[0].source, "cbn");
  });
  test("the admin path for a real large move: reset-reference (audited), then the new level is accepted", async () => {
    const { service, store, cbn, clock } = makeService();
    cbn.result = { ok: true, rate: 1500, asOf: new Date("2026-11-13T00:00:00Z") };
    await service.refreshAll();
    clock.advanceHours(6);
    cbn.result = { ok: true, rate: 2100, asOf: new Date("2026-11-13T12:00:00Z") };
    assert.equal((await service.refreshAll())[0].ok, false);
    await service.resetReference("NGN", "Genuine devaluation confirmed", "admin-9");
    assert.deepEqual(
      [store.audit.at(-1)?.action, store.audit.at(-1)?.by, store.audit.at(-1)?.old],
      ["provider_reset", "admin-9", { rate: 1500, source: "cbn" }]
    );
    assert.equal((await service.refreshAll())[0].ok, true);
    assert.equal((await service.getRate("NGN")).rate, 2100);
    await assert.rejects(service.resetReference("NGN", "x", "a"), MoneyError); // reason too short
  });
  test("one currency failing does not abort the others, and failures are logged at error level", async () => {
    const calls: string[] = [];
    const p = fakeProvider("cbn", { supports: ["NGN", "GHS"], result: { ok: true, rate: 1500, asOf: new Date("2026-11-13T00:00:00Z") } });
    p.fetchRate = async (c: string) => {
      calls.push(c);
      if (c === "NGN") throw new Error("boom");
      return { ok: true, rate: 12, asOf: new Date("2026-11-13T00:00:00Z") };
    };
    const { service } = makeService({
      cbn: p,
      config: { currencies: { NGN: { enabled: true, countries: [] }, GHS: { enabled: true, countries: [], minRate: 1, maxRate: 100 } } },
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      const out = await service.refreshAll();
      assert.deepEqual(out.map((o) => [o.currency, o.ok]), [["NGN", false], ["GHS", true]]);
    } finally {
      console.error = orig;
    }
    assert.ok(errors.some((e) => /NGN/.test(e)));
    assert.deepEqual(calls, ["NGN", "GHS"]);
  });
});

describe("override reference rules and config caps", () => {
  test("an unreferenced override must be inside the plausible range", async () => {
    const { service } = makeService();
    for (const bad of [150, 6000, 1e9]) {
      await assert.rejects(service.setOverride("NGN", { rate: bad, reason: "CBN site is down today" }, "a"), MoneyError, String(bad));
    }
    await service.setOverride("NGN", { rate: 1500, reason: "CBN site is down today" }, "a");
  });
  test("an unreferenced override with no configured range is refused", async () => {
    const { service } = makeService({ config: { currencies: { NGN: { enabled: true, countries: [] } } } });
    await assert.rejects(service.setOverride("NGN", { rate: 1500, reason: "CBN site is down today" }, "a"), MoneyError);
  });
  test("an unreadable stored provider map blocks the unreferenced path", async () => {
    const { service, store } = makeService();
    store.docs.set("NGN", { currency: "NGN", provider: null, override: null, lastError: null, providerCorrupt: true });
    await assert.rejects(service.setOverride("NGN", { rate: 1500, reason: "CBN site is down today" }, "a"), MoneyError);
  });
  test("config caps: a typo cannot disable freshness, age, band or jump protection", () => {
    const c = parseCurrenciesConfig({
      freshnessHours: 100000, maxRateAgeHours: 1e9, overrideBandPercent: 5000, maxProviderJumpPercent: 99999, overrideTtlHours: 1e6,
    });
    assert.equal(c.freshnessHours, 168);
    assert.equal(c.maxRateAgeHours, 240);
    assert.equal(c.overrideBandPercent, 25);
    assert.equal(c.maxProviderJumpPercent, 50);
    assert.equal(c.overrideTtlHours, 168);
    assert.equal(parseCurrenciesConfig({ freshnessHours: "x" }).freshnessHours, 72);
  });
  test("a plausible range with min >= max is dropped", () => {
    const c = parseCurrenciesConfig({ currencies: { NGN: { enabled: true, countries: [], minRate: 5000, maxRate: 200 } } });
    assert.equal(c.currencies.NGN.minRate, undefined);
  });
});

describe("quote never returns a zero local amount", () => {
  test("a price that rounds to zero is refused; so is a zero price", () => {
    const tiny = { currency: "NGN", rate: 0.4, asOf: "2026-11-13T00:00:00.000Z", source: "cbn" as const, marginBps: 0 };
    assert.throws(() => quoteWithRate(usd(1), tiny), (e) => code(e) === "INVALID_INPUT");
    assert.throws(() => quoteWithRate(usd(0), { ...tiny, rate: 1500 }), (e) => code(e) === "INVALID_INPUT");
  });
});
