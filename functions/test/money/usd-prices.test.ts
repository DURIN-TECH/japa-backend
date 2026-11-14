// ============================================
// Unit tests — dollar price input, stored reads, the reverse conversion and
// the local figure on reads (issue #179). Hermetic: no Firestore, no network.
// ============================================
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PRICE_USD_CENTS,
  isPriceInputError,
  parseUsdPriceInput,
  readStoredUsd,
  zeroUsd,
} from "../../src/money/usd-price";
import { convertLocalToUsd, convertUsdToLocal } from "../../src/money/money";
import { loadLocalPricer, localPricing, pricerFromRate } from "../../src/money/local-price";
import { useFixedRate } from "../helpers/local-pricing";
import { makeService } from "./helpers";

/** USD Money from cents. */
const usd = (c: number) => ({ amountMinor: c, currency: "USD" });

describe("parseUsdPriceInput", () => {
  test("dollar strings and numbers become whole cents; currency optional and case-insensitive", () => {
    assert.deepEqual(parseUsdPriceInput({ amount: "10.00", currency: "USD" }, "f"), usd(1000));
    assert.deepEqual(parseUsdPriceInput({ amount: "10.5" }, "f"), usd(1050));
    assert.deepEqual(parseUsdPriceInput({ amount: 12.34 }, "f"), usd(1234));
    assert.deepEqual(parseUsdPriceInput({ amount: 0, currency: "usd" }, "f"), usd(0));
    assert.deepEqual(parseUsdPriceInput({ amount: " 7 " }, "f"), usd(700));
  });

  test("the cap is $100,000.00 inclusive", () => {
    assert.equal(MAX_PRICE_USD_CENTS, 10_000_000);
    assert.deepEqual(parseUsdPriceInput({ amount: "100000" }, "f"), usd(MAX_PRICE_USD_CENTS));
    assert.throws(() => parseUsdPriceInput({ amount: "100000.01" }, "f"), /at most 100000\.00/);
  });

  test("refuses anything that is not a finite, non-negative, whole-cent USD amount", () => {
    for (const bad of [
      undefined, null, 10, "10", [], {}, true,
      { amount: -0.01 }, { amount: "-1" }, { amount: Number.NaN }, { amount: Infinity }, { amount: -Infinity },
      { amount: 1.005 }, { amount: "1.001" }, { amount: "1e3" }, { amount: 1e21 }, { amount: "" }, { amount: "ten" },
      { amount: null }, { amount: {} }, { amount: 10, currency: "NGN" }, { amount: 10, currency: "" },
      { amount: 10, currency: 840 }, { amountMinor: 1000, currency: "USD" }, { amount: 10, rate: 1500 },
    ]) {
      assert.throws(
        () => parseUsdPriceInput(bad, "consultationFeeUsd"),
        (e: unknown) => isPriceInputError(e) && (e as Error).message.startsWith("consultationFeeUsd:"),
        JSON.stringify(bad)
      );
    }
  });
});

describe("readStoredUsd", () => {
  test("only a well-formed USD Money is a price; a copy without extra keys is returned", () => {
    assert.deepEqual(readStoredUsd({ amountMinor: 1000, currency: "USD", extra: 1 }), usd(1000));
    assert.deepEqual(readStoredUsd(zeroUsd()), usd(0));
    for (const bad of [undefined, null, 5000, "5000", { amountMinor: 1000, currency: "NGN" }, { amountMinor: -1, currency: "USD" }, { amountMinor: 1.5, currency: "USD" }, { currency: "USD" }]) {
      assert.equal(readStoredUsd(bad), null, JSON.stringify(bad));
    }
  });
});

describe("convertLocalToUsd (migration rounding: half up to a whole cent)", () => {
  test("whole results are exact", () => {
    // ₦15,000.00 at 1500 = $10.00
    assert.deepEqual(convertLocalToUsd({ amountMinor: 1_500_000, currency: "NGN" }, 1500), usd(1000));
    assert.deepEqual(convertLocalToUsd({ amountMinor: 0, currency: "NGN" }, 1500), usd(0));
  });

  test("rounds half up, once", () => {
    // ₦5,000 at 1353.9741 = $3.69283... -> $3.69
    assert.deepEqual(convertLocalToUsd({ amountMinor: 500_000, currency: "NGN" }, 1353.9741), usd(369));
    // ₦7.50 at 1000 = 0.75 cent -> rounds to 1 cent
    assert.deepEqual(convertLocalToUsd({ amountMinor: 750, currency: "NGN" }, 1000), usd(1));
    // ₦5.00 at 1000 = 0.5 cent -> half rounds UP to 1 cent
    assert.deepEqual(convertLocalToUsd({ amountMinor: 500, currency: "NGN" }, 1000), usd(1));
    // ₦4.99 at 1000 = 0.499 cent -> 0
    assert.deepEqual(convertLocalToUsd({ amountMinor: 499, currency: "NGN" }, 1000), usd(0));
  });

  test("a zero-exponent currency uses its own factor from the table", () => {
    // USh 3,700 at 3700 per dollar = $1.00
    assert.deepEqual(convertLocalToUsd({ amountMinor: 3700, currency: "UGX" }, 3700), usd(100));
  });

  test("round trip stays within a cent", () => {
    const local = convertUsdToLocal(usd(1234), 1353.9741, "NGN");
    assert.deepEqual(convertLocalToUsd(local, 1353.9741), usd(1234));
  });

  test("refuses bad input", () => {
    assert.throws(() => convertLocalToUsd({ amountMinor: -1, currency: "NGN" }, 1500));
    assert.throws(() => convertLocalToUsd({ amountMinor: 1, currency: "XYZ" }, 1500));
    assert.throws(() => convertLocalToUsd({ amountMinor: 1, currency: "NGN" }, 0));
  });
});

describe("pricerFromRate", () => {
  const rate = { currency: "NGN", rate: 1500, asOf: "2026-11-13T00:00:00.000Z", source: "cbn" as const, marginBps: 0 };

  test("prices with the same maths as the charge path (margin included)", () => {
    assert.deepEqual(pricerFromRate("NGN", rate).price(usd(1000)), {
      amountMinor: 1_500_000, currency: "NGN", rate: 1500, asOf: rate.asOf, available: true,
    });
    const withMargin = pricerFromRate("NGN", { ...rate, marginBps: 100 }).price(usd(1000));
    assert.equal(withMargin.amountMinor, convertUsdToLocal(usd(1000), 1500, "NGN", 100).amountMinor);
    assert.equal(pricerFromRate("NGN", rate).price(usd(0)).amountMinor, 0);
  });

  test("no rate: every quote is unavailable, the currency is still named", () => {
    assert.deepEqual(pricerFromRate("NGN", null).price(usd(1000)), {
      amountMinor: null, currency: "NGN", rate: null, asOf: null, available: false,
    });
  });
});

describe("loadLocalPricer (never fails a read)", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("a fresh stored rate prices in the default currency for an anonymous viewer", async () => {
    restore = useFixedRate(1500);
    const pricer = await loadLocalPricer();
    assert.equal(pricer.currency, "NGN");
    assert.equal(pricer.price(usd(100)).amountMinor, 150_000);
  });

  test("no stored rate (RATE_UNAVAILABLE): unavailable, nothing thrown, nothing logged", async () => {
    restore = useFixedRate(null);
    const original = console.error;
    let logged = 0;
    console.error = () => {
      logged++;
    };
    try {
      const q = (await loadLocalPricer()).price(usd(100));
      assert.equal(q.available, false);
      assert.equal(logged, 0);
    } finally {
      console.error = original;
    }
  });

  test("a stale rate (RATE_STALE) is unavailable too", async () => {
    const { service, store, clock } = makeService();
    store.docs.set("NGN", {
      currency: "NGN",
      provider: { rate: 1500, asOf: new Date("2026-11-13T00:00:00Z"), fetchedAt: new Date("2026-11-13T00:00:00Z"), source: "cbn" },
      override: null,
      lastError: null,
    });
    clock.advanceHours(24 * 30);
    const saved = localPricing.rates;
    localPricing.rates = async () => service;
    restore = () => {
      localPricing.rates = saved;
    };
    assert.equal((await loadLocalPricer()).price(usd(100)).available, false);
  });

  test("an unexpected failure (config unreadable) is logged once and still unavailable", async () => {
    const saved = localPricing.rates;
    localPricing.rates = async () => {
      throw new Error("firestore down");
    };
    restore = () => {
      localPricing.rates = saved;
    };
    const original = console.error;
    let logged = 0;
    console.error = () => {
      logged++;
    };
    try {
      const pricer = await loadLocalPricer({ uid: "u1" });
      assert.equal(pricer.currency, "NGN");
      assert.equal(pricer.price(usd(100)).available, false);
      assert.equal(logged, 1);
    } finally {
      console.error = original;
    }
  });

  test("a signed-in viewer's currency comes from their stored profile country", async () => {
    // GHS is not configured, so a Ghana profile with a GHS mapping would be
    // CURRENCY_UNSUPPORTED; an unmapped country falls back to NGN.
    restore = useFixedRate(1500, { countries: { u1: "Nigeria", u2: "Atlantis" } });
    assert.equal((await loadLocalPricer({ uid: "u1" })).currency, "NGN");
    assert.equal((await loadLocalPricer({ uid: "u2" })).currency, "NGN");
    // A profile read failure falls back to the default, never fails the read.
    localPricing.profileCountry = async () => {
      throw new Error("boom");
    };
    assert.equal((await loadLocalPricer({ uid: "u3" })).price(usd(100)).amountMinor, 150_000);
  });
});
