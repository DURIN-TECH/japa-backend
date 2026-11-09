// ============================================
// Unit tests — visa fee extraction + code-side currency conversion (issue #59)
// ============================================
//
// Run with `npm test` (node:test via tsx). NO network: the FX fetch is an
// injected stub (or a stub `fetch`), and no LLM is called. No Firestore /
// emulator either: the modules under test are importable without Firebase
// Admin init (only the `Timestamp` class is used).
//
// Fee figures below are ILLUSTRATIVE fixtures (round numbers chosen to make
// the arithmetic obvious), not real published fees.
//
// Covers: the validator rules for `feeComponents`, the prompt's fee rule,
// computeFee (totals, rounding, two currencies, USD, free), official pegs,
// stale/missing flags (no fake 0), the appConfig/fx refresh (incl. a throwing
// fetcher), the ingest field mapping (no baseCostUsd / undefined written),
// re-converting flagged visas with zero extractor calls, the approval guard,
// and the finite-only min used by the country stats.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import {
  EXTRACTOR_PROMPT_VERSION,
  ExtractionValidationError,
  buildSystemPrompt,
  validateExtractedVisa,
} from "../src/services/visa-catalog-extract.service";
import {
  FEE_MISSING_COST_MESSAGE,
  FEE_NOT_CONVERTED_MESSAGE,
  FRANKFURTER_LATEST_URL,
  FX_MAX_AGE_DAYS,
  FX_SOURCE_ECB,
  FX_SOURCE_PEG,
  OFFICIAL_USD_PEGS,
  VisaFeeNotConvertibleError,
  assertVisaApprovable,
  computeFee,
  fetchFrankfurterRates,
  isFxFresh,
  planFeeReconvert,
  refreshFxRates,
  type FxStore,
} from "../src/services/visa-catalog-fx";
import { buildScrapeMeta, extractedToVisaFields, finiteMin } from "../src/services/visa-catalog-meta";
import type { VisaType } from "../src/types";
import type { ExtractedFeeComponent, ExtractedVisa, FxRatesDoc } from "../src/types/visa-catalog";

// ----- Fixtures -----

// Injected clock for every test.
const NOW = Timestamp.fromDate(new Date("2026-11-09T12:00:00Z"));
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => Timestamp.fromMillis(NOW.toMillis() - d * DAY_MS);

/** A stored rate doc; GBP 0.8 / EUR 0.9 per USD keep the expected USD figures exact. */
function fxDoc(fetchedAt: Timestamp = NOW, rates: Record<string, number> = { GBP: 0.8, EUR: 0.9 }): FxRatesDoc {
  return { base: "USD", rates, fetchedAt, rateDate: "2026-11-06", source: FX_SOURCE_ECB };
}

// Skilled Worker-like: application fee + Immigration Health Surcharge per year x 3.
const SW_COMPONENTS: ExtractedFeeComponent[] = [
  { kind: "application", label: "Application fee (outside the UK, over 3 years)", amount: 1000, currency: "GBP", per: "application" },
  { kind: "surcharge", label: "Immigration Health Surcharge", amount: 1000, currency: "GBP", per: "year", years: 3 },
];

/** A minimal valid raw LLM payload; `over` replaces / adds keys. */
function rawVisa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Skilled Worker visa",
    code: "SKILLED_WORKER",
    description: "Work in the UK for an approved employer.",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    validityPeriod: "5 years",
    isExtendable: true,
    eligibilityCriteria: ["Job offer from an approved employer"],
    confidence: 0.9,
    feeComponents: SW_COMPONENTS,
    citations: {
      "fee.application": "£1,000 if your certificate of sponsorship is for more than 3 years",
      "fee.surcharge": "healthcare surcharge - usually £1,000 per year",
      "fee.years": "Your visa can last for up to 3 years",
    },
    ...over,
  };
}

/** Assert validation fails and one problem matches `re`. */
function assertRejects(raw: unknown, re: RegExp) {
  assert.throws(
    () => validateExtractedVisa(raw),
    (err: unknown) => {
      assert.ok(err instanceof ExtractionValidationError);
      assert.ok(
        err.problems.some((p) => re.test(p)),
        `expected a problem matching ${re}, got: ${err.problems.join(" | ")}`
      );
      return true;
    }
  );
}

// ----- Validator -----

describe("validateExtractedVisa — feeComponents", () => {
  test("accepts a valid Skilled Worker-like payload and drops baseCostUsd", () => {
    const v = validateExtractedVisa(rawVisa({ baseCostUsd: 999 }));
    assert.deepEqual(v.feeComponents, SW_COMPONENTS);
    // The LLM's own USD figure is never carried through.
    assert.equal("baseCostUsd" in v, false);
  });

  test("(a) rejects a non-zero component with no citation", () => {
    assertRejects(rawVisa({ citations: { "fee.surcharge": "x", "fee.years": "y" } }), /fee\.application/);
    assertRejects(rawVisa({ citations: { "fee.application": "x", "fee.years": "y" } }), /fee\.surcharge/);
  });

  test("(b) rejects a non-zero component with no or an unknown currency", () => {
    const noCur = [{ ...SW_COMPONENTS[0], currency: "" }, SW_COMPONENTS[1]];
    assertRejects(rawVisa({ feeComponents: noCur }), /currency is required/);
    const bad = [{ ...SW_COMPONENTS[0], currency: "XXQ" }, SW_COMPONENTS[1]];
    assertRejects(rawVisa({ feeComponents: bad }), /"XXQ" is not a known ISO 4217/);
  });

  test("(c) rejects per:\"year\" with no years or no fee.years citation", () => {
    const noYears = [SW_COMPONENTS[0], { ...SW_COMPONENTS[1], years: undefined }];
    assertRejects(rawVisa({ feeComponents: noYears }), /years must be an integer >= 1/);
    const zeroYears = [SW_COMPONENTS[0], { ...SW_COMPONENTS[1], years: 0 }];
    assertRejects(rawVisa({ feeComponents: zeroYears }), /years must be an integer >= 1/);
    assertRejects(
      rawVisa({ citations: { "fee.application": "a", "fee.surcharge": "b" } }),
      /citations\["fee\.years"\] is missing/
    );
  });

  test("rejects a fee.years citation with no duration in it", () => {
    assertRejects(
      rawVisa({ citations: { "fee.application": "a £1,000 fee", "fee.surcharge": "b", "fee.years": "£1,035 per person" } }),
      /must quote a visa length\/duration/
    );
  });

  test("rejects a fee.years citation that just repeats the fee.application quote", () => {
    const line = "up to 3 years - £819 per person";
    assertRejects(
      rawVisa({ citations: { "fee.application": line, "fee.surcharge": "b", "fee.years": line } }),
      /not repeat the fee\.application quote/
    );
  });

  test("accepts duration phrasings: digits, words, years and months", () => {
    for (const q of ["Your visa can last for up to 5 years", "2 years and 9 months", "for five years", "a 12-month course"]) {
      assert.doesNotThrow(() =>
        validateExtractedVisa(rawVisa({ citations: { "fee.application": "a", "fee.surcharge": "b", "fee.years": q } }))
      );
    }
  });

  test("(d) rejects a negative amount", () => {
    const neg = [{ ...SW_COMPONENTS[0], amount: -5 }];
    assertRejects(rawVisa({ feeComponents: neg }), /amount must be >= 0/);
  });

  test("(e) rejects two application components", () => {
    const two = [SW_COMPONENTS[0], { ...SW_COMPONENTS[0], amount: 500 }];
    assertRejects(rawVisa({ feeComponents: two }), /at most one application/);
  });

  test("rejects a missing feeComponents array", () => {
    const raw = rawVisa();
    delete raw.feeComponents;
    assertRejects(raw, /"feeComponents" must be an array/);
  });

  test("accepts a free visa: one application component of 0, no citation, no currency", () => {
    const v = validateExtractedVisa(
      rawVisa({
        feeComponents: [{ kind: "application", label: "Free", amount: 0, currency: "", per: "application" }],
        citations: {},
      })
    );
    assert.equal(v.feeComponents.length, 1);
    assert.equal(v.feeComponents[0].amount, 0);
  });

  test("accepts an empty feeComponents (page states no fee)", () => {
    const v = validateExtractedVisa(rawVisa({ feeComponents: [], citations: {} }));
    assert.deepEqual(v.feeComponents, []);
  });

  test("accepts components in two currencies (2nd surcharge uses suffixed keys)", () => {
    const v = validateExtractedVisa(
      rawVisa({
        feeComponents: [
          { kind: "application", label: "Visa fee", amount: 100, currency: "eur", per: "application" },
          { kind: "surcharge", label: "Health levy", amount: 50, currency: "GBP", per: "year", years: 2 },
          { kind: "surcharge", label: "Biometrics", amount: 20, currency: "USD", per: "application" },
        ],
        citations: { "fee.application": "a", "fee.surcharge": "b", "fee.years": "for 2 years", "fee.surcharge.2": "d" },
      })
    );
    // Currency is normalised to upper case.
    assert.deepEqual(v.feeComponents.map((c) => c.currency), ["EUR", "GBP", "USD"]);
  });
});

// ----- Prompt -----

describe("extractor prompt — fee rule", () => {
  const prompt = buildSystemPrompt();

  test("no longer asks the model to convert to USD, and forbids arithmetic", () => {
    assert.doesNotMatch(prompt, /convert local fees to USD/i);
    assert.doesNotMatch(prompt, /baseCostUsd/);
    assert.match(prompt, /Do NOT convert currency/);
    assert.match(prompt, /Do NOT do any arithmetic/);
  });

  test("states the include/exclude rule", () => {
    assert.match(prompt, /MAIN applicant's government application fee/);
    assert.match(prompt, /OUTSIDE the country/);
    assert.match(prompt, /Immigration Health Surcharge/);
    for (const excluded of [/dependants/, /priority/, /shortage/, /reduced-rate/, /in-country/]) {
      assert.match(prompt, excluded);
    }
  });

  test("prompt version is bumped (v3: deterministic fee length)", () => {
    assert.equal(EXTRACTOR_PROMPT_VERSION, "2026-11-fee-length-v3");
  });

  test("states the deterministic visa-length rule with the Skilled Worker example", () => {
    assert.match(prompt, /LONGEST length/);
    assert.match(prompt, /Never pick a shorter-length option/);
    assert.match(prompt, /MAXIMUM length/);
    assert.match(prompt, /surcharge uses that SAME length/);
    assert.match(prompt, /application amount 1618, healthcare surcharge\s+1035 per year with years 5/);
    assert.match(prompt, /WRONG: 819 with years 3/);
  });

  test("fee.years must quote a duration, not the fee sentence", () => {
    assert.match(prompt, /citations\['fee\.years'\].*must quote the text that states the\s+visa LENGTH\/DURATION/s);
    assert.match(prompt, /must NOT simply repeat the fee sentence/);
  });
});

// ----- computeFee -----

describe("computeFee", () => {
  test("Skilled Worker-like: application + IHS x years, code-computed total, rounded USD", () => {
    const { baseCostUsd, feeMeta } = computeFee(SW_COMPONENTS, fxDoc(), NOW);
    // GBP 1000 + 1000 x 3 = GBP 4000; / 0.8 GBP per USD = USD 5000.
    assert.deepEqual(feeMeta.totals, [{ currency: "GBP", amount: 4000 }]);
    assert.deepEqual(feeMeta.components.map((c) => c.totalInCurrency), [1000, 3000]);
    assert.equal(feeMeta.totalUsd, 5000);
    assert.equal(baseCostUsd, 5000);
    assert.equal(feeMeta.fxSource, FX_SOURCE_ECB);
    assert.equal(feeMeta.fxDate, "2026-11-06");
    assert.equal(feeMeta.fxRateToUsd?.GBP, 1 / 0.8);
    assert.equal(feeMeta.fxStale, undefined);
    assert.equal(feeMeta.fxMissing, undefined);
  });

  test("rounds once, to whole USD", () => {
    // GBP 127 / 0.747 = 170.01... → 170
    const { baseCostUsd, feeMeta } = computeFee(
      [{ kind: "application", label: "Visitor", amount: 127, currency: "GBP", per: "application" }],
      fxDoc(NOW, { GBP: 0.747 }),
      NOW
    );
    assert.equal(baseCostUsd, 170);
    assert.ok(Math.abs((feeMeta.totalUsd ?? 0) - 127 / 0.747) < 1e-9);
  });

  test("Visitor-like: application component only", () => {
    const { baseCostUsd, feeMeta } = computeFee(
      [{ kind: "application", label: "Standard Visitor visa", amount: 100, currency: "GBP", per: "application" }],
      fxDoc(),
      NOW
    );
    assert.equal(baseCostUsd, 125);
    assert.equal(feeMeta.components.length, 1);
  });

  test("free visa converts to 0 with no rate at all", () => {
    const { baseCostUsd, feeMeta } = computeFee(
      [{ kind: "application", label: "Free", amount: 0, currency: "", per: "application" }],
      undefined,
      NOW
    );
    assert.equal(baseCostUsd, 0);
    assert.equal(feeMeta.fxMissing, undefined);
    assert.equal(feeMeta.fxSource, undefined);
  });

  test("a USD fee passes through without FX", () => {
    const { baseCostUsd, feeMeta } = computeFee(
      [{ kind: "application", label: "MRV fee", amount: 185, currency: "USD", per: "application" }],
      undefined,
      NOW
    );
    assert.equal(baseCostUsd, 185);
    assert.equal(feeMeta.fxSource, undefined);
    assert.equal(feeMeta.fxRateToUsd, undefined);
  });

  test("two-currency components are converted separately, summed, rounded once", () => {
    const { baseCostUsd, feeMeta } = computeFee(
      [
        { kind: "application", label: "Visa fee", amount: 90, currency: "EUR", per: "application" },
        { kind: "surcharge", label: "Levy", amount: 40, currency: "GBP", per: "year", years: 2 },
      ],
      fxDoc(),
      NOW
    );
    // EUR 90 / 0.9 = 100; GBP 80 / 0.8 = 100 → 200.
    assert.deepEqual(feeMeta.totals, [
      { currency: "EUR", amount: 90 },
      { currency: "GBP", amount: 80 },
    ]);
    assert.equal(baseCostUsd, 200);
    assert.deepEqual(Object.keys(feeMeta.fxRateToUsd ?? {}).sort(), ["EUR", "GBP"]);
  });

  test("empty components: no baseCostUsd (no fake 0)", () => {
    const { baseCostUsd, feeMeta } = computeFee([], fxDoc(), NOW);
    assert.equal(baseCostUsd, undefined);
    assert.deepEqual(feeMeta, { components: [], totals: [] });
  });
});

// ----- Official pegs -----

describe("official USD pegs", () => {
  test("table holds AED 3.6725, SAR 3.75, QAR 3.64", () => {
    assert.deepEqual({ ...OFFICIAL_USD_PEGS }, { AED: 3.6725, SAR: 3.75, QAR: 3.64 });
  });

  for (const [currency, peg] of Object.entries({ AED: 3.6725, SAR: 3.75, QAR: 3.64 })) {
    test(`${currency} converts with the peg, never stale, with no / an old appConfig/fx`, () => {
      const comps: ExtractedFeeComponent[] = [
        { kind: "application", label: "Visa", amount: peg * 100, currency, per: "application" },
      ];
      for (const fx of [undefined, fxDoc(daysAgo(30))]) {
        const { baseCostUsd, feeMeta } = computeFee(comps, fx, NOW);
        assert.equal(baseCostUsd, 100);
        assert.equal(feeMeta.fxSource, FX_SOURCE_PEG);
        assert.equal(feeMeta.fxDate, "2026-11-09"); // the conversion date
        assert.equal(feeMeta.fxStale, undefined);
        assert.equal(feeMeta.fxMissing, undefined);
      }
    });
  }
});

// ----- No usable rate -----

describe("no usable rate → flagged, no baseCostUsd", () => {
  test("TWD (not published by ECB) → fxMissing, totals kept, no USD", () => {
    const { baseCostUsd, feeMeta } = computeFee(
      [{ kind: "application", label: "Visa fee", amount: 1600, currency: "TWD", per: "application" }],
      fxDoc(),
      NOW
    );
    assert.equal(baseCostUsd, undefined);
    assert.equal(feeMeta.fxMissing, true);
    assert.equal(feeMeta.totalUsd, undefined);
    assert.deepEqual(feeMeta.totals, [{ currency: "TWD", amount: 1600 }]);
  });

  test("no appConfig/fx at all → fxMissing", () => {
    const { baseCostUsd, feeMeta } = computeFee(SW_COMPONENTS, undefined, NOW);
    assert.equal(baseCostUsd, undefined);
    assert.equal(feeMeta.fxMissing, true);
  });

  test(`rate fetched more than FX_MAX_AGE_DAYS (${FX_MAX_AGE_DAYS}) ago → fxStale`, () => {
    const { baseCostUsd, feeMeta } = computeFee(SW_COMPONENTS, fxDoc(daysAgo(8)), NOW);
    assert.equal(baseCostUsd, undefined);
    assert.equal(feeMeta.fxStale, true);
    assert.equal(feeMeta.fxMissing, undefined);
    assert.deepEqual(feeMeta.totals, [{ currency: "GBP", amount: 4000 }]);
  });

  test("exactly FX_MAX_AGE_DAYS old is still fresh", () => {
    assert.equal(isFxFresh(fxDoc(daysAgo(FX_MAX_AGE_DAYS)), NOW), true);
    assert.equal(isFxFresh(fxDoc(daysAgo(FX_MAX_AGE_DAYS + 0.01)), NOW), false);
  });

  test("one unconverted currency blocks the whole fee", () => {
    const { baseCostUsd, feeMeta } = computeFee(
      [
        { kind: "application", label: "Visa", amount: 100, currency: "GBP", per: "application" },
        { kind: "surcharge", label: "Levy", amount: 50, currency: "TWD", per: "application" },
      ],
      fxDoc(),
      NOW
    );
    assert.equal(baseCostUsd, undefined);
    assert.equal(feeMeta.fxMissing, true);
  });
});

// ----- appConfig/fx refresh -----

/** In-memory FxStore stub. */
function memoryStore(initial?: FxRatesDoc): FxStore & { doc?: FxRatesDoc; writes: number } {
  const s = {
    doc: initial,
    writes: 0,
    async get() {
      return s.doc;
    },
    async set(d: FxRatesDoc) {
      s.doc = d;
      s.writes++;
    },
  };
  return s;
}

describe("refreshFxRates", () => {
  test("writes { base, rates, fetchedAt, rateDate, source } from the fetcher", async () => {
    const store = memoryStore();
    const res = await refreshFxRates({
      fetchRates: async () => ({ rates: { GBP: 0.75 }, rateDate: "2026-11-06" }),
      store,
      now: NOW,
    });
    assert.equal(res.refreshed, true);
    assert.deepEqual(store.doc, {
      base: "USD",
      rates: { GBP: 0.75 },
      fetchedAt: NOW,
      rateDate: "2026-11-06",
      source: FX_SOURCE_ECB,
    });
  });

  test("a throwing fetcher keeps the previous doc and the run continues", async () => {
    const previous = fxDoc(daysAgo(2));
    const store = memoryStore(previous);
    const logs: string[] = [];
    const res = await refreshFxRates({
      fetchRates: async () => {
        throw new Error("network down");
      },
      store,
      now: NOW,
      log: (m) => logs.push(m),
    });
    assert.equal(res.refreshed, false);
    assert.equal(res.error, "network down");
    assert.equal(res.fx, previous); // still used (2 days old = fresh)
    assert.equal(store.writes, 0); // never overwritten with nothing
    assert.equal(logs.length, 1);
  });

  test("fetchFrankfurterRates calls the USD-based latest endpoint and keeps valid rates", async () => {
    let calledUrl = "";
    const stubFetch = (async (url: string) => {
      calledUrl = url;
      return new Response(
        JSON.stringify({ amount: 1, base: "USD", date: "2026-11-06", rates: { GBP: 0.74711, BAD: "x" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const r = await fetchFrankfurterRates(stubFetch);
    assert.equal(calledUrl, FRANKFURTER_LATEST_URL);
    assert.equal(FRANKFURTER_LATEST_URL, "https://api.frankfurter.dev/v1/latest?base=USD");
    assert.deepEqual(r, { rates: { GBP: 0.74711 }, rateDate: "2026-11-06" });
  });

  test("fetchFrankfurterRates throws on HTTP error", async () => {
    const stubFetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(fetchFrankfurterRates(stubFetch), /HTTP 503/);
  });
});

// ----- Ingest mapping -----

describe("ingest field mapping (extractedToVisaFields + buildScrapeMeta)", () => {
  const extracted = validateExtractedVisa(rawVisa()) as ExtractedVisa;

  test("writes the code-computed baseCostUsd when converted", () => {
    const { baseCostUsd } = computeFee(extracted.feeComponents, fxDoc(), NOW);
    const f = extractedToVisaFields({ countryCode: "GB", visaId: "gb-x", code: "X", extracted, baseCostUsd });
    assert.equal(f.baseCostUsd, 5000);
  });

  test("stale rate: baseCostUsd key absent and no undefined values anywhere", () => {
    const { baseCostUsd, feeMeta } = computeFee(extracted.feeComponents, fxDoc(daysAgo(8)), NOW);
    const f = extractedToVisaFields({ countryCode: "GB", visaId: "gb-x", code: "X", extracted, baseCostUsd });
    assert.equal("baseCostUsd" in f, false);
    const meta = buildScrapeMeta({
      sourceUrl: "https://www.gov.uk/skilled-worker-visa",
      routeName: "Skilled Worker visa",
      model: "stub",
      contentHash: "h",
      extracted,
      extractedAt: NOW,
      fee: feeMeta,
      extractorPromptVersion: EXTRACTOR_PROMPT_VERSION,
    });
    assert.equal(meta.fee?.fxStale, true);
    assert.equal(meta.extractorPromptVersion, EXTRACTOR_PROMPT_VERSION);
    // Walk every value: nothing may be `undefined` (Firestore would reject it).
    const walk = (v: unknown, p: string) => {
      assert.notEqual(v, undefined, `undefined at ${p}`);
      if (v && typeof v === "object" && !(v instanceof Timestamp)) {
        for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
      }
    };
    walk(f, "fields");
    walk(meta, "scrapeMeta");
  });
});

// ----- Re-convert flagged visas (no LLM call) -----

describe("planFeeReconvert", () => {
  /** A pending scraped doc whose fee was flagged stale at ingest. */
  function staleVisa(over: Partial<VisaType> = {}): Pick<VisaType, "source" | "reviewStatus" | "scrapeMeta"> {
    const { feeMeta } = computeFee(SW_COMPONENTS, fxDoc(daysAgo(8)), NOW);
    return {
      source: "scraped",
      reviewStatus: "pending_review",
      scrapeMeta: {
        sourceUrl: "u",
        routeName: "r",
        model: "m",
        confidence: 1,
        citations: {},
        contentHash: "hash-unchanged",
        extractedAt: NOW,
        fee: feeMeta,
      },
      ...over,
    };
  }

  // (The orchestrator-level "zero extractor calls" check is in
  // visa-catalog-fx-service.test.ts; this is the pure decision.)
  test("a stale-flagged visa is unflagged after a refresh", () => {
    const plan = planFeeReconvert(staleVisa(), fxDoc(NOW), NOW);
    assert.ok(plan);
    assert.equal(plan.baseCostUsd, 5000);
    assert.equal(plan.fee.fxStale, undefined);
    assert.equal(plan.fee.fxMissing, undefined);
    assert.equal(plan.fee.fxSource, FX_SOURCE_ECB);
    assert.equal(plan.fee.totalUsd, 5000);
  });

  test("still no rate with the same flags → no write", () => {
    assert.equal(planFeeReconvert(staleVisa(), fxDoc(daysAgo(9)), NOW), null);
  });

  test("approved / seeded / agent docs are not touched", () => {
    assert.equal(planFeeReconvert(staleVisa({ reviewStatus: "approved" }), fxDoc(), NOW), null);
    assert.equal(planFeeReconvert(staleVisa({ source: "agent" }), fxDoc(), NOW), null);
    assert.equal(planFeeReconvert(staleVisa({ source: undefined, reviewStatus: undefined }), fxDoc(), NOW), null);
  });

  test("an unflagged fee is left alone", () => {
    const { feeMeta } = computeFee(SW_COMPONENTS, fxDoc(), NOW);
    const v = staleVisa();
    v.scrapeMeta = { ...v.scrapeMeta!, fee: feeMeta };
    assert.equal(planFeeReconvert(v, fxDoc(), NOW), null);
  });
});

// ----- Approval guard -----

describe("assertVisaApprovable", () => {
  const flagged = (flag: "fxStale" | "fxMissing") =>
    ({
      source: "scraped",
      baseCostUsd: 719, // an old LLM value left unchanged on the doc
      scrapeMeta: { fee: { components: [], totals: [], [flag]: true } },
    }) as unknown as VisaType;

  for (const flag of ["fxStale", "fxMissing"] as const) {
    test(`throws the typed error for a scraped visa with ${flag}`, () => {
      assert.throws(
        () => assertVisaApprovable(flagged(flag)),
        (e: unknown) =>
          e instanceof VisaFeeNotConvertibleError &&
          e.code === "FEE_NOT_CONVERTED" &&
          e.message === FEE_NOT_CONVERTED_MESSAGE
      );
    });
  }

  test("throws for a non-finite baseCostUsd", () => {
    assert.throws(
      () => assertVisaApprovable({ source: "scraped" } as VisaType),
      (e: unknown) => e instanceof VisaFeeNotConvertibleError && e.message === FEE_MISSING_COST_MESSAGE
    );
  });

  test("a normally converted scraped visa passes", () => {
    const { baseCostUsd, feeMeta } = computeFee(SW_COMPONENTS, fxDoc(), NOW);
    assert.doesNotThrow(() =>
      assertVisaApprovable({ source: "scraped", baseCostUsd, scrapeMeta: { fee: feeMeta } } as VisaType)
    );
  });
});

// ----- Country stats -----

describe("finiteMin", () => {
  test("ignores undefined / NaN and falls back to 0", () => {
    assert.equal(finiteMin([500, undefined, NaN, 130]), 130);
    assert.equal(finiteMin([undefined]), 0);
    assert.equal(finiteMin([]), 0);
  });
});
