// ============================================
// Unit tests: Money helpers and the rounding rule (issue #178)
// ============================================

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { convertUsdToLocal, format, fromMajor, makeMoney, scaleRate, toMajor } from "../../src/money/money";
import { getCurrencyInfo, minorUnitFactor } from "../../src/money/currencies";
import { MoneyError } from "../../src/money/errors";

const usd = (cents: number) => makeMoney(cents, "USD");

describe("currency table", () => {
  test("NGN and USD have exponent 2; unknown codes have no row", () => {
    assert.equal(getCurrencyInfo("NGN")?.exponent, 2);
    assert.equal(getCurrencyInfo("USD")?.exponent, 2);
    assert.equal(getCurrencyInfo("XXX"), undefined);
    assert.equal(minorUnitFactor("NGN"), 100n);
    assert.equal(minorUnitFactor("UGX"), 1n);
  });
});

describe("toMajor / fromMajor / format", () => {
  test("round-trip for typical amounts", () => {
    for (const s of ["0.00", "0.01", "12.50", "1234567.89"]) {
      assert.equal(toMajor(fromMajor(s, "USD")), s);
    }
  });
  test("fromMajor accepts numbers and short decimals", () => {
    assert.deepEqual(fromMajor(12.5, "USD"), { amountMinor: 1250, currency: "USD" });
    assert.deepEqual(fromMajor("7", "NGN"), { amountMinor: 700, currency: "NGN" });
    assert.deepEqual(fromMajor("0.1", "NGN"), { amountMinor: 10, currency: "NGN" });
  });
  test("fromMajor refuses too many decimals, junk, negatives and non-finite numbers", () => {
    for (const bad of ["1.234", "abc", "-1", "", "1e3", "1,000"]) {
      assert.throws(() => fromMajor(bad, "USD"), (e) => e instanceof MoneyError && e.code === "INVALID_INPUT");
    }
    assert.throws(() => fromMajor(NaN, "USD"), MoneyError);
    assert.throws(() => fromMajor(Infinity, "USD"), MoneyError);
    assert.throws(() => fromMajor(1e21, "USD"), MoneyError);
  });
  test("zero-exponent currencies have no decimals", () => {
    assert.equal(toMajor({ amountMinor: 1500, currency: "UGX" }), "1500");
    assert.throws(() => fromMajor("1.5", "UGX"), MoneyError);
  });
  test("an unknown currency is a typed error", () => {
    assert.throws(() => fromMajor("1", "XXX"), (e) => e instanceof MoneyError && e.code === "CURRENCY_UNSUPPORTED");
  });
  test("format groups thousands and uses the symbol", () => {
    assert.equal(format({ amountMinor: 150_000_000, currency: "NGN" }), "₦1,500,000.00");
    assert.equal(format(usd(1250)), "$12.50");
    assert.equal(format(usd(5)), "$0.05");
  });
  test("makeMoney refuses fractions, negatives and unsafe integers", () => {
    assert.throws(() => makeMoney(1.5, "USD"), MoneyError);
    assert.throws(() => makeMoney(-1, "USD"), MoneyError);
    assert.throws(() => makeMoney(Number.MAX_SAFE_INTEGER + 1, "USD"), MoneyError);
  });
});

describe("scaleRate", () => {
  test("scales to 6 decimals as an integer", () => {
    assert.equal(scaleRate(1353.9741), 1353974100n);
    assert.equal(scaleRate(1), 1000000n);
  });
  test("refuses zero, negative, NaN, Infinity, absurd", () => {
    for (const bad of [0, -5, NaN, Infinity, 2e9]) assert.throws(() => scaleRate(bad), MoneyError);
  });
});

describe("convertUsdToLocal: rounding is half up, once, to the local minor unit", () => {
  test("exact conversions", () => {
    // $10.00 at 1500 = N15,000.00
    assert.deepEqual(convertUsdToLocal(usd(1000), 1500, "NGN"), { amountMinor: 1_500_000, currency: "NGN" });
    // $1.00 at 1353.9741 = N1,353.97 (1353.9741 -> .97)
    assert.equal(convertUsdToLocal(usd(100), 1353.9741, "NGN").amountMinor, 135_397);
  });
  test("rounds half up at exactly one kobo: 0.5 kobo goes up, 0.49 down", () => {
    // 1 cent at 0.5 NGN per USD = 0.005 NGN = 0.5 kobo -> 1 kobo (half up)
    assert.equal(convertUsdToLocal(usd(1), 0.5, "NGN").amountMinor, 1);
    // 1 cent at 0.49 = 0.49 kobo -> 0
    assert.equal(convertUsdToLocal(usd(1), 0.49, "NGN").amountMinor, 0);
    // 1 cent at 1.5 = 1.5 kobo -> 2 ; at 1.4999 -> 1
    assert.equal(convertUsdToLocal(usd(1), 1.5, "NGN").amountMinor, 2);
    assert.equal(convertUsdToLocal(usd(1), 1.4999, "NGN").amountMinor, 1);
  });
  test("a large amount stays exact (no float drift)", () => {
    // $1,000,000.00 at 1353.9741 = N1,353,974,100.00 exactly
    assert.equal(convertUsdToLocal(usd(100_000_000), 1353.9741, "NGN").amountMinor, 135_397_410_000);
    // $9,999,999.99 at 1500.123456
    // 999999999 cents * 1500.123456 = 1500123454.499... kobo-scale: verify with BigInt
    const expected = (999_999_999n * 1_500_123_456n + 500_000n) / 1_000_000n;
    assert.equal(convertUsdToLocal(usd(999_999_999), 1500.123456, "NGN").amountMinor, Number(expected));
  });
  test("margin is applied before the single rounding", () => {
    // $10 at 1500 with 250 bps = 15000 * 1.025 = 15375.00
    assert.equal(convertUsdToLocal(usd(1000), 1500, "NGN", 250).amountMinor, 1_537_500);
    // 0 bps equals no margin
    assert.equal(convertUsdToLocal(usd(1000), 1500, "NGN", 0).amountMinor, 1_500_000);
  });
  test("zero-exponent target currency", () => {
    // $1.00 at 3700 UGX = 3700 UGX (minor unit == major)
    assert.equal(convertUsdToLocal(usd(100), 3700, "UGX").amountMinor, 3700);
  });
  test("zero amount is zero", () => {
    assert.equal(convertUsdToLocal(usd(0), 1500, "NGN").amountMinor, 0);
  });
  test("refuses non-USD input, bad margin, bad rate and overflow", () => {
    assert.throws(() => convertUsdToLocal({ amountMinor: 100, currency: "NGN" }, 1500, "NGN"), MoneyError);
    assert.throws(() => convertUsdToLocal(usd(100), 1500, "NGN", -1), MoneyError);
    assert.throws(() => convertUsdToLocal(usd(100), 1500, "NGN", 1.5), MoneyError);
    assert.throws(() => convertUsdToLocal(usd(100), 0, "NGN"), MoneyError);
    assert.throws(() => convertUsdToLocal(usd(100), 1500, "XXX"), (e) => e instanceof MoneyError && e.code === "CURRENCY_UNSUPPORTED");
    assert.throws(() => convertUsdToLocal(usd(Number.MAX_SAFE_INTEGER), 1e8, "NGN"), MoneyError);
  });
});
