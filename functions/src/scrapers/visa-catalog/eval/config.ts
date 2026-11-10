import * as path from "path";

// ============================================
// VISA EXTRACTION EVAL — CONFIG (issue #60)
// ============================================
//
// Every number that decides whether an eval run passes lives in THIS file:
// field weights, the processing-days tolerance and the pass thresholds. They
// are documented in src/scrapers/visa-catalog/eval/README.md ("How a run is scored"); change them here
// (and in the README) in a reviewed commit, never to make one run pass.
//
// Pass bar (user decision, issue #60 checkpoint 1):
//   - overall weighted score >= 0.85, AND
//   - no single route below 0.7, AND
//   - no fee mismatch on any route (a hard gate, whatever the scores), except
//     fee items covered by a route's `knownGaps`, AND
//   - no processing citation mismatch (issue #87, hard gate):
//     processingDaysMin/Max within PROCESSING_DAYS_TOLERANCE of at least one
//     duration the output's own processing citations state.
//
// This module is pure config (path + constants): no network, no Firebase.

// ----- Pass thresholds -----

/** Soft gate: the overall weighted score must be at least this. */
export const OVERALL_PASS_THRESHOLD = 0.85;

/** Soft gate: every single route's weighted score must be at least this. */
export const ROUTE_PASS_THRESHOLD = 0.7;

// ----- Numeric tolerance -----

/**
 * `processingDaysMin` / `processingDaysMax` pass when the actual value is
 * within +/- this fraction of the expected value…
 */
export const PROCESSING_DAYS_TOLERANCE = 0.2;

/** …or within this many days, whichever is larger (so 0 / small values aren't impossible). */
export const PROCESSING_DAYS_MIN_TOLERANCE_DAYS = 1;

// ----- Field weights -----

/**
 * Weight of each scored field in a route's score. A route score is
 * sum(weight x fieldScore) / sum(weight) over its fields, in [0, 1]; the
 * overall score is the same weighted sum over every field of every route.
 *
 * Fees weigh most (they become `baseCostUsd`, shown to users, and are also a
 * hard gate); eligibility is the richest free-text field so it weighs double.
 */
export const FIELD_WEIGHTS = {
  name: 1,
  category: 1,
  processingDaysMin: 1,
  processingDaysMax: 1,
  validityPeriod: 1,
  isExtendable: 1,
  eligibility: 2,
  applicationUrlHost: 1,
  feeComponents: 3,
} as const;

/** One scored field name (the keys of FIELD_WEIGHTS). */
export type ScoredField = keyof typeof FIELD_WEIGHTS;

/** Scored fields in report order. */
export const SCORED_FIELDS = Object.keys(FIELD_WEIGHTS) as ScoredField[];

// ----- Golden set location + routes -----

/** functions/src/scrapers/visa-catalog/eval/ (this file's directory, for both tsx and any compiled copy). */
export const EVAL_DIR = __dirname;

/** functions/src/scrapers/visa-catalog/eval/golden/<route>/{guide.json,expected.json} */
export const GOLDEN_DIR = path.join(EVAL_DIR, "golden");

/**
 * functions/src/scrapers/visa-catalog/eval/golden/_linked/<page>/guide.json — recorded LINKED pages
 * (issue #69): pages a route's fee depends on without printing it, e.g. the
 * UK healthcare-surcharge page `healthcare-immigration-application`. `<page>`
 * is the GOV.UK path of LINKED_SURCHARGE_SOURCES[id].url. Not a route: not
 * scored, never sent to the extractor; parsed in code like in a crawl.
 */
export const LINKED_GOLDEN_DIR = path.join(GOLDEN_DIR, "_linked");

/** functions/src/scrapers/visa-catalog/eval/results/<version>__<model>__<timestamp>.json */
export const RESULTS_DIR = path.join(EVAL_DIR, "results");

/** Country label passed to the extractor (as the GB registry row names it). */
export const EVAL_COUNTRY_NAME = "United Kingdom";

/**
 * One golden route: the GOV.UK page and the registry label the crawl uses for
 * it. `route` is both the GOV.UK path (without the leading slash) and the
 * golden directory name. Labels copied from official_visa_links_verified_v3.md
 * (the registry source), so the extractor gets the same context as in a crawl.
 */
export interface EvalRoute {
  route: string; // e.g. "skilled-worker-visa" → src/scrapers/visa-catalog/eval/golden/skilled-worker-visa/
  url: string; // registry page URL, e.g. https://www.gov.uk/skilled-worker-visa
  routeName: string; // registry label, e.g. "Skilled Worker visa"
  shape: string; // what this route exercises (documentation only)
}

/** The v1 golden set: 6 UK routes, each picked for a different fee/length shape. */
export const EVAL_ROUTES: readonly EvalRoute[] = [
  {
    route: "skilled-worker-visa",
    url: "https://www.gov.uk/skilled-worker-visa",
    routeName: "Skilled Worker visa",
    shape: "application fee by length + IHS per year x 5 years",
  },
  {
    route: "standard-visitor",
    url: "https://www.gov.uk/standard-visitor",
    routeName: "Standard Visitor visa",
    shape: "no IHS, short stay",
  },
  {
    route: "student-visa",
    url: "https://www.gov.uk/student-visa",
    routeName: "Student visa",
    shape: "variable length; IHS from the linked surcharge page (#69, assumed 1 year)",
  },
  {
    route: "graduate-visa",
    url: "https://www.gov.uk/graduate-visa",
    routeName: "Graduate visa",
    shape: "IHS, shorter length",
  },
  {
    route: "uk-family-visa",
    url: "https://www.gov.uk/uk-family-visa",
    routeName: "Family visa",
    shape: "one guide, several routes (partner route extracted)",
  },
  {
    route: "global-talent",
    url: "https://www.gov.uk/global-talent",
    routeName: "Global Talent visa",
    shape: "multi-stage fee (endorsement + visa stage)",
  },
];

/** Look up a golden route by its id; undefined when unknown. */
export function findEvalRoute(route: string): EvalRoute | undefined {
  return EVAL_ROUTES.find((r) => r.route === route);
}
