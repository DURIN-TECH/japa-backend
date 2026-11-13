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
    const b = makeService({ config: { currencies: { NGN: { enabled: true, countries: [], marginBps: 200 } }, defaultMarginBps: 50 } });
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
    const oanda = fakeProvider("oanda", { configured: true, supports: ["NGN"], result: { ok: true, rate: 1450, asOf: new Date() } });
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
