// ============================================
// Unit tests — visa extraction eval: golden set, scorer, runner, recorder (issue #60)
// ============================================
//
// Run with `npm test` (node:test via tsx). NO network and NO LLM: the scorer
// is pure, the runner is driven through `--replay` (stored outputs) or an
// injected stub extractor, and the recorder gets a stub HTTP client. No
// DEEPSEEK_API_KEY is needed (and env is injected, so a key in the shell is
// never used).
//
// Covers:
//  - the golden set itself: files + `_fixture` metadata, every `source` quote
//    is verbatim in guide.json (and visible to the extractor), Student known
//    gap, verifiedBy/verifiedOn present, no seed-data imports;
//  - the scorer, per field type: exact pass/fail, fee order independence,
//    missing/extra/wrong-years components, feeUnverifiedReasons, known-gap
//    handling, tolerance edges, keyword hit/miss, validity, name, host, an
//    `actual` missing fields, a failed extraction, and the gate;
//  - the runner: replay of a committed sample (exact scores + exit code), exit
//    2 without a key (before any call), a failing extraction does not crash,
//    results file name/content, --compare, --only;
//  - eval:record: rejection of non-200 / non-guide / withdrawn responses,
//    dry run writes nothing, --write writes, the unified diff;
//  - isolation: nothing under src/ imports eval/, and eval is not wired into
//    `npm test`, CI workflows or deploy scripts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  EVAL_ROUTES,
  FIELD_WEIGHTS,
  OVERALL_PASS_THRESHOLD,
  ROUTE_PASS_THRESHOLD,
} from "../eval/config";
import { unifiedDiff } from "../eval/diff";
import {
  fixtureFetchService,
  guidePlainText,
  loadExpected,
  loadGuide,
  quoteInText,
  type GuideFixture,
} from "../eval/golden";
import { recordRoutes, toRecordedBody, RecordRejectedError, parseRecordArgs } from "../eval/record";
import { main, parseRunArgs, resultsFileName, type EvalResultFile } from "../eval/run";
import {
  containsKeyword,
  durationsIn,
  evaluateGate,
  processingTolerance,
  scoreRoute,
  type ExpectedVisa,
  type RouteScore,
} from "../eval/score";
import { VISA_SOURCE_OVERRIDES } from "../src/data/seed-visa-sources";
import { VisaCatalogFetchService, type VisaCatalogHttpClient } from "../src/services/visa-catalog-fetch.service";
import { GovukContentApiAdapter } from "../src/services/visa-source-adapters";
import type { ExtractedVisa } from "../src/types/visa-catalog";

// ----- Paths -----

const FUNCTIONS_DIR = path.join(__dirname, "..");
const EVAL_DIR = path.join(FUNCTIONS_DIR, "eval");
const FIXTURES = path.join(__dirname, "fixtures");
/** Test-only golden dir (copies of two expected.json files) used by the replay test. */
const TEST_GOLDEN = path.join(FIXTURES, "eval-golden");
/** Committed sample results file (hand-written outputs) replayed by the runner test. */
const SAMPLE_RESULTS = path.join(FIXTURES, "eval-sample-results.json");

/** A fresh temp dir per test that needs to write. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seli-eval-test-"));
}

/** Collect every `source` / `yearsSource` quote of an expected.json, with its JSON path. */
function quotesOf(expected: unknown): { at: string; quote: string }[] {
  const out: { at: string; quote: string }[] = [];
  const walk = (o: unknown, at: string) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if ((k === "source" || k === "yearsSource") && typeof v === "string") out.push({ at: `${at}.${k}`, quote: v });
      else walk(v, `${at}.${k}`);
    }
  };
  walk(expected, "");
  return out;
}

/** Concatenated raw part HTML of a guide (href quotes for URL hosts live here). */
function guideHtml(g: GuideFixture): string {
  return (g.body.details?.parts ?? []).map((p) => p.body).join("\n");
}

// ============================================
// Golden set
// ============================================

describe("golden set (eval/golden)", () => {
  test("v1 covers the 6 agreed UK routes", () => {
    assert.deepEqual(
      EVAL_ROUTES.map((r) => r.route).sort(),
      ["global-talent", "graduate-visa", "skilled-worker-visa", "standard-visitor", "student-visa", "uk-family-visa"]
    );
  });

  for (const r of EVAL_ROUTES) {
    describe(r.route, () => {
      const guide = loadGuide(r.route);
      const expected = loadExpected(r.route);

      test("guide.json is a recorded Content API guide with _fixture metadata", () => {
        assert.equal(guide._fixture.sourceUrl, `https://www.gov.uk/api/content/${r.route}`);
        assert.match(guide._fixture.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(guide._fixture.recordedBy, /Seli-VisaCatalogBot/);
        assert.equal(guide.status, 200);
        assert.equal(guide.body.schema_name, "guide");
        assert.ok((guide.body.details?.parts ?? []).length > 0);
      });

      test("expected.json identifies its route, fixture and verification status", () => {
        assert.equal(expected.route, r.route);
        assert.equal(expected.sourceUrl, r.url);
        assert.equal(expected.fixtureRecordedAt, guide._fixture.recordedAt);
        // Filled by a human who checked the LIVE page ("pending" until then).
        assert.ok(expected.verifiedBy.trim().length > 0);
        assert.ok(expected.verifiedOn.trim().length > 0);
      });

      test("every source quote is verbatim in guide.json", () => {
        const text = guidePlainText(guide.body);
        const html = guideHtml(guide);
        const quotes = quotesOf(expected);
        assert.ok(quotes.length >= 9, "every field carries a source quote");
        for (const { at, quote } of quotes) {
          assert.ok(
            quoteInText(quote, text) || html.includes(quote),
            `${r.route}${at} is not in guide.json: ${JSON.stringify(quote)}`
          );
        }
      });

      test("every non-URL quote is in the text the extractor actually sees", async () => {
        // Same page config as the runner (registry section overrides).
        const pin = VISA_SOURCE_OVERRIDES[r.url] ?? {};
        const doc = await new GovukContentApiAdapter(fixtureFetchService(r.url, guide)).fetch({
          url: r.url,
          routeName: r.routeName,
          validation: "text_verified",
          includeSections: pin.includeSections,
          excludeSections: pin.excludeSections,
        });
        for (const { at, quote } of quotesOf(expected)) {
          if (at.startsWith(".applicationUrlHost")) continue; // an href: never in extractor text
          assert.ok(quoteInText(quote, doc.text), `${r.route}${at} is not in the selected sections`);
        }
      });

      test("fee components are well-formed (per-year ones have years + a length quote)", () => {
        for (const c of expected.feeComponents.components) {
          assert.ok(["application", "surcharge"].includes(c.kind));
          assert.equal(c.currency, "GBP");
          if (c.per === "year") {
            assert.ok(Number.isInteger(c.years) && (c.years as number) >= 1);
            assert.ok(c.yearsSource && /\d+\s*years?/.test(c.yearsSource));
          } else {
            assert.equal(c.years, undefined);
          }
        }
        assert.equal(expected.feeComponents.components.filter((c) => c.kind === "application").length, 1);
      });
    });
  }

  test("Student marks the IHS as known gap #69 and expects the application fee only", () => {
    const st = loadExpected("student-visa");
    assert.deepEqual(st.knownGaps, [{ field: "feeComponents", ref: "#69", note: "IHS is on a linked page" }]);
    assert.deepEqual(
      st.feeComponents.components.map((c) => c.kind),
      ["application"]
    );
  });

  test("skilled-worker-visa and graduate-visa guides are copies of the existing test fixtures", () => {
    for (const r of ["skilled-worker-visa", "graduate-visa"]) {
      const golden = fs.readFileSync(path.join(EVAL_DIR, "golden", r, "guide.json"), "utf8");
      const fixture = fs.readFileSync(path.join(FIXTURES, `govuk-${r}.json`), "utf8");
      assert.equal(golden, fixture);
    }
  });

  test("the eval never imports the visa seed data", () => {
    for (const f of fs.readdirSync(EVAL_DIR).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(EVAL_DIR, f), "utf8");
      // No import of the visa seeds (seed-visa-sources = the source REGISTRY, allowed).
      assert.doesNotMatch(src, /from\s+["'][^"']*(seed-countries-visas|seed-all)["']/, f);
      // No seeded `uk-*` visa id referenced anywhere.
      assert.doesNotMatch(src, /["']uk-(skilled-worker|student|visitor|family)["']/, f);
    }
    for (const r of EVAL_ROUTES) {
      const raw = fs.readFileSync(path.join(EVAL_DIR, "golden", r.route, "expected.json"), "utf8");
      assert.doesNotMatch(raw, /["']uk-(skilled-worker|student|visitor|family)["']/, r.route);
    }
  });
});

// ============================================
// Scorer
// ============================================

/** The Skilled Worker expected values (real golden file) — the scorer tests' baseline. */
const SW: ExpectedVisa = loadExpected("skilled-worker-visa");
const STUDENT: ExpectedVisa = loadExpected("student-visa");

/** An `actual` that scores 1 on every Skilled Worker field. */
function perfectSW(): ExtractedVisa {
  return {
    name: "Skilled Worker visa",
    code: "SKILLED_WORKER",
    description: "Work for an approved employer.",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 1,
    processingDaysMax: 21,
    feeComponents: [
      { kind: "application", label: "fee", amount: 1618, currency: "GBP", per: "application" },
      { kind: "surcharge", label: "IHS", amount: 1035, currency: "GBP", per: "year", years: 5 },
    ],
    validityPeriod: "Up to 5 years",
    isExtendable: true,
    eligibilityCriteria: [
      "Job with an approved employer",
      "Certificate of sponsorship",
      "Job on the eligible occupations list",
      "Minimum salary",
      "English",
    ],
    applicationUrl: "https://apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/sort/start/skilled_worker_out_uk",
    confidence: 0.9,
    citations: {},
  };
}

/** One field's result from a route score. */
const field = (r: RouteScore, f: string) => {
  const x = r.fields.find((y) => y.field === f);
  assert.ok(x, `field ${f}`);
  return x;
};

describe("scorer (eval/score.ts)", () => {
  test("a perfect extraction scores 1 with no fee mismatch", () => {
    const r = scoreRoute(SW, perfectSW());
    assert.equal(r.score, 1);
    assert.equal(r.feeMismatch, false);
    assert.equal(r.weightTotal, Object.values(FIELD_WEIGHTS).reduce((a, b) => a + b, 0));
  });

  test("exact: category and isExtendable pass/fail", () => {
    const a = perfectSW();
    a.category = "business";
    a.isExtendable = false;
    const r = scoreRoute(SW, a);
    assert.equal(field(r, "category").score, 0);
    assert.equal(field(r, "isExtendable").score, 0);
    assert.equal(field(r, "name").score, 1);
  });

  test("fee: order-independent", () => {
    const a = perfectSW();
    a.feeComponents.reverse();
    const r = scoreRoute(SW, a);
    assert.equal(field(r, "feeComponents").score, 1);
    assert.equal(r.feeMismatch, false);
  });

  test("fee: label differences are ignored, currency case is normalised", () => {
    const a = perfectSW();
    a.feeComponents[0] = { ...a.feeComponents[0], label: "Something else", currency: "gbp" };
    assert.equal(scoreRoute(SW, a).feeMismatch, false);
  });

  test("fee: missing component is a mismatch", () => {
    const a = perfectSW();
    a.feeComponents = a.feeComponents.slice(0, 1);
    const r = scoreRoute(SW, a);
    assert.equal(r.feeMismatch, true);
    assert.match(field(r, "feeComponents").detail ?? "", /missing: surcharge 1035 GBP per year x5/);
  });

  test("fee: extra component is a mismatch", () => {
    const a = perfectSW();
    a.feeComponents.push({ kind: "surcharge", label: "x", amount: 10, currency: "GBP", per: "application" });
    const r = scoreRoute(SW, a);
    assert.equal(r.feeMismatch, true);
    assert.match(field(r, "feeComponents").detail ?? "", /extra: surcharge 10 GBP/);
  });

  test("fee: wrong amount and wrong years are mismatches", () => {
    const wrongAmount = perfectSW();
    wrongAmount.feeComponents[0] = { ...wrongAmount.feeComponents[0], amount: 819 };
    assert.equal(scoreRoute(SW, wrongAmount).feeMismatch, true);
    const wrongYears = perfectSW();
    wrongYears.feeComponents[1] = { ...wrongYears.feeComponents[1], years: 3 };
    assert.equal(scoreRoute(SW, wrongYears).feeMismatch, true);
  });

  test("fee: feeUnverifiedReasons on the output is a mismatch", () => {
    const a = perfectSW();
    a.feeUnverifiedReasons = ["dropped surcharge"];
    const r = scoreRoute(SW, a);
    assert.equal(r.feeMismatch, true);
    assert.equal(field(r, "feeComponents").score, 0);
  });

  test("known gap: Student extra IHS component / feeUnverifiedReasons are notes, not mismatches", () => {
    const a: ExtractedVisa = {
      ...perfectSW(),
      category: "student",
      feeComponents: [
        { kind: "application", label: "fee", amount: 558, currency: "GBP", per: "application" },
        { kind: "surcharge", label: "IHS", amount: 776, currency: "GBP", per: "year", years: 3 },
      ],
      feeUnverifiedReasons: ["dropped surcharge \"IHS\": years"],
    };
    const r = scoreRoute(STUDENT, a);
    assert.equal(r.feeMismatch, false);
    assert.equal(field(r, "feeComponents").score, 1);
    assert.ok(r.notes.some((n) => /known gap #69.*surcharge 776 GBP/.test(n)));
    assert.ok(r.notes.some((n) => /known gap #69.*feeUnverifiedReasons/.test(n)));
    // The gap itself is always reported.
    assert.ok(r.notes.some((n) => /known gap #69 \(feeComponents\): IHS is on a linked page/.test(n)));
  });

  test("known gap: a wrong Student APPLICATION fee is still a mismatch", () => {
    const a: ExtractedVisa = {
      ...perfectSW(),
      feeComponents: [{ kind: "application", label: "fee", amount: 490, currency: "GBP", per: "application" }],
    };
    assert.equal(scoreRoute(STUDENT, a).feeMismatch, true);
  });

  test("numeric: +/- 20% tolerance edges (and at least 1 day)", () => {
    assert.equal(processingTolerance(21), 4.2);
    assert.equal(processingTolerance(2), 1);
    const at = (max: number) => {
      const a = perfectSW();
      a.processingDaysMax = max;
      return field(scoreRoute(SW, a), "processingDaysMax").score;
    };
    assert.equal(at(25), 1); // 21 + 4 <= 4.2
    assert.equal(at(17), 1); // 21 - 4
    assert.equal(at(26), 0); // 21 + 5 > 4.2
    assert.equal(at(16), 0);
    // Small expected value: the 1-day floor applies.
    const small: ExpectedVisa = { ...SW, processingDaysMax: { value: 2, source: "" } };
    const s = (v: number) => {
      const a = perfectSW();
      a.processingDaysMax = v;
      return field(scoreRoute(small, a), "processingDaysMax").score;
    };
    assert.equal(s(3), 1);
    assert.equal(s(1), 1);
    assert.equal(s(4), 0);
  });

  test("numeric: range mode (page only bounds the value) is inclusive", () => {
    const at = (min: number) => {
      const a = perfectSW();
      a.processingDaysMin = min;
      return field(scoreRoute(SW, a), "processingDaysMin").score;
    };
    assert.equal(at(0), 1);
    assert.equal(at(21), 1);
    assert.equal(at(22), 0);
    assert.equal(at(-1), 0);
  });

  test("keyword: eligibility = fraction of themes hit, whole-word matching", () => {
    const a = perfectSW();
    a.eligibilityCriteria = ["Job with an approved employer", "English"];
    const r = scoreRoute(SW, a);
    assert.equal(field(r, "eligibility").score, 2 / 5);
    assert.match(field(r, "eligibility").detail ?? "", /missed themes: certificate of sponsorship/);
    // "cos" must not match inside "costs".
    assert.equal(containsKeyword("Visa costs", "cos"), false);
    assert.equal(containsKeyword("A CoS from your employer", "cos"), true);
    assert.equal(containsKeyword("combined income of £29,000", "29,000"), true);
  });

  test("keyword: validityPeriod must state each expected duration", () => {
    assert.deepEqual(durationsIn("up to 2 years and 9 months"), [
      { amount: 2, unit: "year" },
      { amount: 9, unit: "month" },
    ]);
    assert.deepEqual(durationsIn("five years"), [{ amount: 5, unit: "year" }]);
    const a = perfectSW();
    a.validityPeriod = "3 years";
    assert.equal(field(scoreRoute(SW, a), "validityPeriod").score, 0);
    a.validityPeriod = "Five years, extendable";
    assert.equal(field(scoreRoute(SW, a), "validityPeriod").score, 1);
    // Partial credit for a two-part duration.
    const fam = loadExpected("uk-family-visa");
    const b = { ...perfectSW(), validityPeriod: "2 years" };
    assert.equal(field(scoreRoute(fam, b), "validityPeriod").score, 0.5);
  });

  test("keyword: name is case/punctuation-insensitive containment", () => {
    const a = perfectSW();
    a.name = "UK SKILLED-WORKER Visa";
    assert.equal(field(scoreRoute(SW, a), "name").score, 1);
    a.name = "Worker visa";
    assert.equal(field(scoreRoute(SW, a), "name").score, 0);
  });

  test("url: applicationUrl host must equal the expected host", () => {
    const a = perfectSW();
    a.applicationUrl = "https://www.gov.uk/skilled-worker-visa/apply";
    assert.equal(field(scoreRoute(SW, a), "applicationUrlHost").score, 0);
    a.applicationUrl = "not a url";
    assert.equal(field(scoreRoute(SW, a), "applicationUrlHost").score, 0);
  });

  test("an actual with missing fields scores those fields 0 without throwing", () => {
    const r = scoreRoute(SW, { name: "Skilled Worker" } as Partial<ExtractedVisa>);
    assert.equal(field(r, "name").score, 1);
    for (const f of ["category", "processingDaysMin", "processingDaysMax", "validityPeriod", "isExtendable", "eligibility", "applicationUrlHost", "feeComponents"]) {
      assert.equal(field(r, f).score, 0, f);
    }
    assert.equal(r.feeMismatch, true);
  });

  test("a failed extraction scores the route 0 and counts as a fee mismatch", () => {
    const r = scoreRoute(SW, null, "ExtractionValidationError: bad");
    assert.equal(r.score, 0);
    assert.equal(r.feeMismatch, true);
    assert.equal(r.error, "ExtractionValidationError: bad");
  });

  test("gate: a fee mismatch fails even when every score is high", () => {
    const good = scoreRoute(SW, perfectSW());
    const a = perfectSW();
    a.feeComponents[0] = { ...a.feeComponents[0], amount: 819 };
    const feeBad = scoreRoute(SW, a); // 9/12 = 0.75 on its own, overall 0.875
    const g = evaluateGate([good, good, good, feeBad]);
    assert.ok(g.overall >= OVERALL_PASS_THRESHOLD);
    assert.equal(g.pass, false);
    assert.match(g.failures[0], /fee mismatch on skilled-worker-visa \(hard gate\)/);
  });

  test("gate: overall below threshold, or one route below the route threshold, fails", () => {
    const good = scoreRoute(SW, perfectSW());
    assert.equal(evaluateGate([good]).pass, true);
    // Route at 8/12 = 0.667 (< 0.7) with correct fees.
    const a = perfectSW();
    a.category = "other";
    a.isExtendable = false;
    a.eligibilityCriteria = ["nothing relevant"];
    const weak = scoreRoute(SW, a);
    assert.ok(weak.score < ROUTE_PASS_THRESHOLD && !weak.feeMismatch);
    const g = evaluateGate([good, good, good, good, good, weak]);
    assert.ok(g.overall >= OVERALL_PASS_THRESHOLD);
    assert.equal(g.pass, false);
    assert.ok(g.failures.some((f) => /route skilled-worker-visa 0\.667 < 0\.7/.test(f)));
    // Overall below 0.85 on its own.
    const g2 = evaluateGate([good, weak]);
    assert.ok(g2.failures.some((f) => /^overall 0\.833 < 0\.85/.test(f)));
  });
});

// ============================================
// Runner
// ============================================

/** Captures log lines for assertions. */
function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: (l: string) => lines.push(l), logError: (l: string) => errors.push(l) };
}

describe("runner (eval/run.ts)", () => {
  test("--replay re-scores the committed sample with exact scores and exit 0 (no key, no LLM)", async () => {
    const c = capture();
    const code = await main(["--replay", SAMPLE_RESULTS], {
      env: {},
      goldenDir: TEST_GOLDEN,
      log: c.log,
      logError: c.logError,
      extractor: {
        model: "must-not-be-called",
        extract: async () => {
          throw new Error("replay must not call the extractor");
        },
      },
    });
    assert.equal(code, 0, c.errors.join("\n"));
    const out = c.lines.join("\n");
    assert.match(out, /skilled-worker-visa\s+0\.917/);
    assert.match(out, /student-visa\s+0\.883/);
    assert.match(out, /OVERALL 0\.900/);
    assert.match(out, /GATE: PASS/);
    assert.match(out, /known gap #69/);
  });

  test("--replay exits 1 when a stored output has a fee mismatch", async () => {
    const sample = JSON.parse(fs.readFileSync(SAMPLE_RESULTS, "utf8")) as EvalResultFile;
    const sw = sample.routes.find((r) => r.route === "skilled-worker-visa");
    assert.ok(sw?.extracted);
    sw.extracted.feeComponents[1].amount = 819;
    const dir = tmpDir();
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify(sample));
    const c = capture();
    const code = await main(["--replay", file], { env: {}, goldenDir: TEST_GOLDEN, log: c.log, logError: c.logError });
    assert.equal(code, 1);
    assert.match(c.lines.join("\n"), /GATE: FAIL[\s\S]*fee mismatch on skilled-worker-visa/);
  });

  test("--replay --only and --compare print a per-field delta", async () => {
    const c = capture();
    const code = await main(["--replay", SAMPLE_RESULTS, "--only", "student-visa", "--compare", SAMPLE_RESULTS], {
      env: {},
      goldenDir: TEST_GOLDEN,
      log: c.log,
      logError: c.logError,
    });
    assert.equal(code, 0);
    const out = c.lines.join("\n");
    assert.doesNotMatch(out, /^skilled-worker-visa\s+0\.917/m);
    assert.match(out, /Compare with eval-sample-results\.json/);
    assert.match(out, /processingDaysMax\s+0\.500\s+0\.000\s+-0\.500/);
    assert.match(out, /student-visa\s+0\.883\s+0\.883\s+ 0\.000/);
  });

  test("without DEEPSEEK_API_KEY a live run exits 2 before any call", async () => {
    const c = capture();
    const code = await main([], { env: {}, log: c.log, logError: c.logError, writeResults: false });
    assert.equal(code, 2);
    assert.match(c.errors.join("\n"), /DEEPSEEK_API_KEY is not set/);
    assert.equal(c.lines.filter((l) => l.startsWith("extracting")).length, 0);
  });

  test("usage / config errors exit 2", async () => {
    const quiet = { env: {}, log: () => undefined, logError: () => undefined, writeResults: false };
    assert.equal(await main(["--only", "nope"], { ...quiet, env: { DEEPSEEK_API_KEY: "x" } }), 2);
    assert.equal(await main(["--bogus"], quiet), 2);
    assert.equal(await main(["--replay", "/does/not/exist.json"], quiet), 2);
    // Missing fixture for a route.
    assert.equal(await main([], { ...quiet, env: { DEEPSEEK_API_KEY: "x" }, goldenDir: tmpDir() }), 2);
    // A flag without its value is a usage error.
    assert.ok("error" in parseRunArgs(["--only"]));
    assert.ok("error" in parseRunArgs(["--replay", "--only", "x"]));
  });

  test("live run (stub extractor): real adapter text, a throwing route scores 0 without crashing, results file written", async () => {
    const seen: { route: string; text: string }[] = [];
    const outDir = tmpDir();
    const c = capture();
    const code = await main(["--only", "skilled-worker-visa"], {
      env: {},
      resultsDir: outDir,
      now: () => new Date("2026-11-09T18:30:12.345Z"),
      gitInfo: () => ({ sha: "abc123", dirty: false }),
      log: c.log,
      logError: c.logError,
      extractor: {
        model: "stub-model",
        extract: async (text, ctx) => {
          seen.push({ route: ctx.routeName, text });
          throw new Error("DeepSeek API error 500: boom");
        },
      },
    });
    assert.equal(code, 1); // route 0 → below the gate
    assert.equal(seen.length, 1);
    assert.equal(seen[0].route, "Skilled Worker visa");
    // The real adapter's selection: fee part in, switching part out.
    assert.match(seen[0].text, /## How much it costs/);
    assert.doesNotMatch(seen[0].text, /## Switch to this visa/);
    const name = resultsFileName("2026-11-fee-length-v3", "stub-model", new Date("2026-11-09T18:30:12.345Z"));
    assert.equal(name, "2026-11-fee-length-v3__stub-model__20261109T183012Z.json");
    const files = fs.readdirSync(outDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("__stub-model__20261109T183012Z.json"));
    const res = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), "utf8")) as EvalResultFile;
    assert.equal(res.model, "stub-model");
    assert.equal(res.gitSha, "abc123");
    assert.equal(res.mode, "live");
    assert.equal(res.pass, false);
    assert.equal(res.routes[0].extracted, null);
    assert.match(res.routes[0].error ?? "", /DeepSeek API error 500/);
    assert.equal(res.routes[0].score.score, 0);
    assert.deepEqual(res.thresholds, { overall: OVERALL_PASS_THRESHOLD, route: ROUTE_PASS_THRESHOLD });
    assert.match(c.lines.join("\n"), /EXTRACTION FAILED/);
  });

  test("live run (stub extractor returning a perfect output) passes with exit 0", async () => {
    const code = await main(["--only", "skilled-worker-visa"], {
      env: {},
      writeResults: false,
      log: () => undefined,
      logError: () => undefined,
      gitInfo: () => ({ sha: "x", dirty: false }),
      extractor: { model: "stub", extract: async () => perfectSW() },
    });
    assert.equal(code, 0);
  });
});

// ============================================
// eval:record
// ============================================

/** Stub HTTP serving one Content API response (and robots.txt). */
function recordService(routes: Record<string, { status: number; body: string; contentType?: string }>) {
  const calls: string[] = [];
  const client: VisaCatalogHttpClient = {
    async get(url) {
      calls.push(url);
      if (url === "https://www.gov.uk/robots.txt") return { status: 200, data: "User-agent: *\nDisallow: /search/all*\n" };
      const r = routes[url] ?? { status: 404, body: "<html>not found</html>", contentType: "text/html" };
      return { status: r.status, data: r.body, headers: { "content-type": r.contentType ?? "" } };
    },
  };
  return { service: new VisaCatalogFetchService({ http: client, minIntervalMs: 0 }), calls };
}

/** A test fixture's body as a served JSON string. */
const servedBody = (name: string) => {
  const f = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as { status: number; body: unknown };
  return { status: f.status, body: typeof f.body === "string" ? f.body : JSON.stringify(f.body), contentType: "application/json" };
};

describe("eval:record (eval/record.ts)", () => {
  const api = "https://www.gov.uk/api/content/graduate-visa";
  const graduate = EVAL_ROUTES.filter((r) => r.route === "graduate-visa");

  test("non-200, non-guide and withdrawn responses are rejected", () => {
    const notFound = servedBody("govuk-404.json");
    assert.throws(() => toRecordedBody({ ...notFound, finalUrl: api, contentType: "" }, api), RecordRejectedError);
    const org = servedBody("govuk-non-guide-organisation.json");
    assert.throws(() => toRecordedBody({ ...org, finalUrl: api, contentType: "" }, api), /not a guide/);
    const withdrawn = servedBody("govuk-graduate-visa-withdrawn.json");
    assert.throws(() => toRecordedBody({ ...withdrawn, finalUrl: api, contentType: "" }, api), /WITHDRAWN/);
  });

  test("a rejected response aborts without writing", async () => {
    const dir = tmpDir();
    const { service } = recordService({ [api]: servedBody("govuk-graduate-visa-withdrawn.json") });
    const lines: string[] = [];
    const code = await recordRoutes({ routes: graduate, write: true, fetchService: service, goldenDir: dir, log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.equal(fs.existsSync(path.join(dir, "graduate-visa", "guide.json")), false);
    assert.match(lines.join("\n"), /ABORT graduate-visa.*WITHDRAWN/);
  });

  test("dry run prints a diff and writes nothing; --write writes the trimmed fixture", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "graduate-visa"));
    // Stored fixture = the real one with one sentence changed, so there is a diff.
    const stored = loadGuide("graduate-visa");
    const parts = stored.body.details?.parts ?? [];
    parts[0] = { ...parts[0], body: parts[0].body.replace("within 8 weeks", "within 6 weeks") };
    const storedFile = path.join(dir, "graduate-visa", "guide.json");
    fs.writeFileSync(storedFile, JSON.stringify(stored));
    const before = fs.readFileSync(storedFile, "utf8");

    const { service, calls } = recordService({ [api]: servedBody("govuk-graduate-visa.json") });
    const lines: string[] = [];
    assert.equal(await recordRoutes({ routes: graduate, write: false, fetchService: service, goldenDir: dir, log: (l) => lines.push(l) }), 0);
    assert.equal(fs.readFileSync(storedFile, "utf8"), before, "dry run changed no file");
    const out = lines.join("\n");
    assert.match(out, /graduate-visa: CHANGED/);
    assert.match(out, /^-.*within 6 weeks/m);
    assert.match(out, /^\+.*within 8 weeks/m);
    // Robots checked, then the Content API URL fetched.
    assert.deepEqual(calls, ["https://www.gov.uk/robots.txt", api]);

    const lines2: string[] = [];
    assert.equal(
      await recordRoutes({ routes: graduate, write: true, fetchService: service, goldenDir: dir, log: (l) => lines2.push(l), today: "2026-11-10" }),
      0
    );
    const written = JSON.parse(fs.readFileSync(storedFile, "utf8")) as GuideFixture;
    assert.equal(written._fixture.recordedAt, "2026-11-10");
    assert.equal(written._fixture.sourceUrl, api);
    assert.match(written._fixture.recordedBy, /Seli-VisaCatalogBot\/1\.0.*Accept: application\/json/);
    assert.deepEqual(written.body.details?.parts, loadGuide("graduate-visa").body.details?.parts);
    assert.match(lines2.join("\n"), /RE-VERIFY eval\/golden\/graduate-visa\/expected\.json/);
  });

  test("argument parsing", () => {
    assert.deepEqual(parseRecordArgs([]), { error: "usage: npm run eval:record -- <route|--all> [--write]" });
    const all = parseRecordArgs(["--all", "--write"]);
    assert.ok(!("error" in all) && all.routes.length === 6 && all.write);
    assert.ok("error" in parseRecordArgs(["nope"]));
  });

  test("unifiedDiff: identical texts give an empty diff; changes are shown with context", () => {
    assert.equal(unifiedDiff("a\nb", "a\nb", "old", "new"), "");
    const d = unifiedDiff("a\nb\nc\nd", "a\nB\nc\nd", "old", "new", 1);
    assert.equal(d, ["--- old", "+++ new", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n"));
  });
});

// ============================================
// Isolation: not in src/, CI or deploys
// ============================================

describe("eval isolation", () => {
  /** Every .ts file under a directory (recursive). */
  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? tsFiles(p) : e.name.endsWith(".ts") ? [p] : [];
    });
  }

  test("nothing under src/ imports the eval", () => {
    for (const f of tsFiles(path.join(FUNCTIONS_DIR, "src"))) {
      const src = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(src, /from\s+["'][^"']*\/eval(\/|["'])|require\(["'][^"']*\/eval(\/|["'])/, path.relative(FUNCTIONS_DIR, f));
    }
  });

  test("the build tsconfig does not compile eval/ (no eval code in lib/)", () => {
    const raw = fs.readFileSync(path.join(FUNCTIONS_DIR, "tsconfig.json"), "utf8");
    assert.doesNotMatch(raw, /eval/);
  });

  test("eval:visa-extract is not wired into npm test, other scripts or CI workflows", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(FUNCTIONS_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name === "eval:visa-extract") continue;
      assert.doesNotMatch(cmd, /eval:visa-extract|eval\/run/, `script ${name}`);
    }
    assert.doesNotMatch(pkg.scripts.test, /eval/);
    const wf = path.join(FUNCTIONS_DIR, "..", ".github", "workflows");
    for (const f of fs.existsSync(wf) ? fs.readdirSync(wf) : []) {
      assert.doesNotMatch(fs.readFileSync(path.join(wf, f), "utf8"), /eval:visa-extract|eval\/run|eval:record/, f);
    }
  });
});
