// ============================================
// Unit tests — a shared route's sourced processing time and stay limit (issue #339)
// ============================================
// Pure: no Firestore. Two kinds of test:
//   - the RULES (validator, seed decision, two-sources guard, document
//     builder) run on the made-up fixture (made-up ids, user-assigned
//     country codes XA..XC, placeholder quotes);
//   - the SHIPPED file is checked against the stored copy of the official
//     text (fixtures/visa-code-02009R0810-20240628.txt, saved BY SCRIPT by
//     fixtures/fetch-visa-code-text.ts): every quote sentence must appear in
//     it character for character. No quote is typed out in this file; the
//     display values asserted are the ones the issue's criteria state.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Timestamp } from "firebase-admin/firestore";

import { figuresIn, loadSharedVisaData, routeFactsFor, SharedVisaDataError, validateSharedVisaData } from "../../src/data/shared-visa-data-format";
import { planRouteFacts, routeFactFields, seedRouteFactProblems, type RouteFactsDecision } from "../../src/data/seed-route-facts";
import { buildVisaTypeDoc, type SeedVisaFields } from "../../src/data/seed-visa-doc";
import { FIXTURE_DATA, FIXTURE_PROCESSING, FIXTURE_VALIDITY, fixtureDataWithFacts } from "../helpers/shared-visa-fixture";
import { htmlToText, VISA_CODE_FIXTURE, VISA_CODE_URL } from "./fixtures/fetch-visa-code-text";
// The seed module calls getFirestore() when it loads, so the Admin app must be
// initialised first (no Firestore call is made: the test guard would fail it).
import "../../src/utils/firebase";
import { SEED_VISA_TYPES } from "../../src/data/seed-countries-visas";

const NOW = Timestamp.fromDate(new Date("2026-11-15T00:00:00Z"));
/** Every official source is on record. */
const ALL_SOURCES = () => true;

/** Errors of a raw file (asserts that it is refused). */
function errorsOf(raw: unknown): string[] {
  const check = validateSharedVisaData(raw);
  assert.equal(check.ok, false, "the file is refused");
  return check.ok ? [] : check.errors;
}

/** The made-up data with one route field replaced. */
function withRoute(patch: Record<string, unknown>): unknown {
  const data = fixtureDataWithFacts() as unknown as { sharedRoutes: Record<string, unknown>[] };
  Object.assign(data.sharedRoutes[0], patch);
  return data;
}

/** True when no value anywhere in `obj` is `undefined` (Firestore refuses them). */
function noUndefined(obj: unknown): boolean {
  if (obj === undefined) return false;
  if (Array.isArray(obj)) return obj.every(noUndefined);
  if (obj && typeof obj === "object" && !(obj instanceof Timestamp)) return Object.values(obj).every(noUndefined);
  return true;
}

// ============================================
// The validator
// ============================================
describe("validateSharedVisaData: a route's processing time and stay limit (#339)", () => {
  test("complete blocks are valid and kept as written; a route without them stays valid", () => {
    const data = loadSharedVisaData(fixtureDataWithFacts());
    assert.deepEqual(data.sharedRoutes[0].processing, FIXTURE_PROCESSING);
    assert.deepEqual(data.sharedRoutes[0].validity, FIXTURE_VALIDITY);
    // An unstated minimum stays absent.
    assert.equal("processingDaysMin" in data.sharedRoutes[0].processing!, false);
    const plain = loadSharedVisaData(FIXTURE_DATA);
    assert.equal("processing" in plain.sharedRoutes[0], false);
    assert.equal("validity" in plain.sharedRoutes[0], false);
  });

  test("the url must be https (processing and validity)", () => {
    const errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, url: "http://bloc.example.org/p" }, validity: { ...FIXTURE_VALIDITY, url: "not a url" } }));
    assert.ok(errors.includes("sharedRoutes[0].processing.url must be an https address"), errors.join("\n"));
    assert.ok(errors.includes("sharedRoutes[0].validity.url must be an https address"), errors.join("\n"));
  });

  test("the guidanceSourceId must not be empty (processing and validity)", () => {
    const errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, guidanceSourceId: " " }, validity: { ...FIXTURE_VALIDITY, guidanceSourceId: undefined } }));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].processing.guidanceSourceId is required")), errors.join("\n"));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].validity.guidanceSourceId is required")), errors.join("\n"));
  });

  test("processing: the quote must state every figure the block writes (text and day counts)", () => {
    // The text's 10 is not in the quote.
    let errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, quote: ["Placeholder sentence stating up to 30 days in some cases."] } }));
    assert.deepEqual(errors, ["sharedRoutes[0].processing.quote does not state the figure 10 that the block writes"]);
    // The day count 31 is in neither the text nor the quote.
    errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, processingDaysMax: 31 } }));
    assert.deepEqual(errors, ["sharedRoutes[0].processing.quote does not state the figure 31 that the block writes"]);
    // A number inside a longer one does not count (30 is not stated by "130").
    errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, quote: ["Placeholder 10 days.", "Placeholder 130 days."] } }));
    assert.deepEqual(errors, ["sharedRoutes[0].processing.quote does not state the figure 30 that the block writes"]);
  });

  test("validity: the quote must state every figure the text writes", () => {
    const errors = errorsOf(withRoute({ validity: { ...FIXTURE_VALIDITY, quote: ["Placeholder sentence stating stays of 30 days."] } }));
    assert.deepEqual(errors, ["sharedRoutes[0].validity.quote does not state the figure 60 that the block writes"]);
  });

  test("the quote is a non-empty list of non-empty sentences", () => {
    let errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, quote: "Placeholder 10 and 30." } }));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].processing.quote is required")), errors.join("\n"));
    errors = errorsOf(withRoute({ validity: { ...FIXTURE_VALIDITY, quote: [] } }));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].validity.quote is required")), errors.join("\n"));
    errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, quote: [...FIXTURE_PROCESSING.quote, " "] } }));
    assert.deepEqual(errors, ["sharedRoutes[0].processing.quote[2] must be a non-empty sentence"]);
  });

  test("day counts: whole numbers of 1 or more, min <= max; a 0 minimum is refused (left out instead)", () => {
    let errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, processingDaysMin: 0 } }));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].processing.processingDaysMin must be a whole number of days, 1 or more")), errors.join("\n"));
    errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, processingDaysMax: 10.5 } }));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].processing.processingDaysMax must be a whole number")), errors.join("\n"));
    errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, processingDaysMin: 30, processingDaysMax: 10 } }));
    assert.ok(errors.includes("sharedRoutes[0].processing.processingDaysMin must be less than or equal to processingDaysMax"), errors.join("\n"));
    // A stated minimum the quote states is valid and kept.
    const ok = loadSharedVisaData(withRoute({ processing: { ...FIXTURE_PROCESSING, processingDaysMin: 10 } }));
    assert.equal(ok.sharedRoutes[0].processing?.processingDaysMin, 10);
  });

  test("the display text is required, and a misspelt field is reported", () => {
    const errors = errorsOf(withRoute({ processing: { ...FIXTURE_PROCESSING, processingTime: "", extension: true }, validity: { ...FIXTURE_VALIDITY, validityPeriod: undefined } }));
    assert.ok(errors.includes("sharedRoutes[0].processing.extension is not a known field"), errors.join("\n"));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].processing.processingTime is required")), errors.join("\n"));
    assert.ok(errors.some((e) => e.startsWith("sharedRoutes[0].validity.validityPeriod is required")), errors.join("\n"));
  });

  test("every problem of both blocks is listed at once, and loadSharedVisaData throws with all of them", () => {
    const raw = withRoute({
      processing: { ...FIXTURE_PROCESSING, url: "http://x.example.org", guidanceSourceId: "", quote: ["Placeholder."] },
      validity: { ...FIXTURE_VALIDITY, url: "ftp://x", quote: ["Placeholder 30."] },
    });
    assert.throws(
      () => loadSharedVisaData(raw),
      (e: unknown) => {
        assert.ok(e instanceof SharedVisaDataError);
        assert.deepEqual(e.errors, [
          "sharedRoutes[0].processing.url must be an https address",
          "sharedRoutes[0].processing.guidanceSourceId is required (the id of the stored official source the quote is in)",
          "sharedRoutes[0].processing.quote does not state the figure 10 that the block writes",
          "sharedRoutes[0].processing.quote does not state the figure 30 that the block writes",
          "sharedRoutes[0].validity.url must be an https address",
          "sharedRoutes[0].validity.quote does not state the figure 60 that the block writes",
        ]);
        return true;
      }
    );
  });

  test("figuresIn reads plain, grouped and decimal numbers, and ends a number at a hyphen", () => {
    assert.deepEqual(figuresIn("Up to 15 calendar days (up to 45 in individual cases)"), [15, 45]);
    assert.deepEqual(figuresIn("in any 180-day period, 1,500 or 2.5"), [180, 1500, 2.5]);
    assert.deepEqual(figuresIn("no figure"), []);
  });
});

// ============================================
// The seed's decision
// ============================================
describe("planRouteFacts (#339)", () => {
  const data = loadSharedVisaData(fixtureDataWithFacts());
  const facts = routeFactsFor(data, "XA", "xa-visitor");

  test("routeFactsFor gives facts only to a record the data file lists under a route that has them", () => {
    assert.equal(facts.length, 1);
    assert.equal(facts[0].sharedRouteId, "example-short-stay");
    assert.deepEqual(routeFactsFor(data, "XB", "xb-visitor"), []);
    assert.deepEqual(routeFactsFor(loadSharedVisaData(FIXTURE_DATA), "XA", "xa-visitor"), []);
  });

  test("a record the data file does not list is untouched ('none')", () => {
    assert.deepEqual(planRouteFacts({ routeFacts: [], existing: undefined, guidanceSourceExists: ALL_SOURCES }), { action: "none" });
  });

  test("writes the route's values exactly, one citation per fact, and no unstated minimum", () => {
    const d = planRouteFacts({ routeFacts: facts, existing: undefined, guidanceSourceExists: ALL_SOURCES });
    assert.equal(d.action, "write");
    const f = routeFactFields(d)!;
    assert.equal(f.processingTime, FIXTURE_PROCESSING.processingTime);
    assert.equal(f.processingDaysMax, FIXTURE_PROCESSING.processingDaysMax);
    assert.equal("processingDaysMin" in f, false);
    assert.equal(f.validityPeriod, FIXTURE_VALIDITY.validityPeriod);
    assert.deepEqual(f.sourcedFacts, {
      processing: { sharedRouteId: "example-short-stay", quote: FIXTURE_PROCESSING.quote, url: FIXTURE_PROCESSING.url, guidanceSourceId: FIXTURE_PROCESSING.guidanceSourceId },
      validity: { sharedRouteId: "example-short-stay", quote: FIXTURE_VALIDITY.quote, url: FIXTURE_VALIDITY.url, guidanceSourceId: FIXTURE_VALIDITY.guidanceSourceId },
    });
    assert.ok(noUndefined(f));
  });

  test("the stored inheritsFrom wins: still naming the route -> write; naming only other routes -> omit", () => {
    const still = planRouteFacts({ routeFacts: facts, existing: { inheritsFrom: [{ sharedRouteId: "other-route" }, { sharedRouteId: "example-short-stay" }] }, guidanceSourceExists: ALL_SOURCES });
    assert.equal(still.action, "write");
    const moved = planRouteFacts({ routeFacts: facts, existing: { inheritsFrom: [{ sharedRouteId: "other-route" }] }, guidanceSourceExists: ALL_SOURCES });
    assert.equal(moved.action, "omit");
    assert.equal(routeFactFields(moved), undefined);
    assert.match((moved as { reason: string }).reason, /no longer inherits "example-short-stay"/);
  });

  test("a fact whose official source is not on record is left out; none left -> omit", () => {
    const onlyStay = planRouteFacts({ routeFacts: facts, existing: undefined, guidanceSourceExists: (id) => id === FIXTURE_VALIDITY.guidanceSourceId });
    assert.equal(onlyStay.action, "write");
    const f = routeFactFields(onlyStay)!;
    for (const k of ["processingTime", "processingDaysMin", "processingDaysMax"]) assert.equal(k in f, false, k);
    assert.equal(f.validityPeriod, FIXTURE_VALIDITY.validityPeriod);
    assert.deepEqual(Object.keys(f.sourcedFacts), ["validity"]);
    assert.deepEqual((onlyStay as { skipped: string[] }).skipped, [`processing: guidanceSources/${FIXTURE_PROCESSING.guidanceSourceId} does not exist`]);

    const none = planRouteFacts({ routeFacts: facts, existing: undefined, guidanceSourceExists: () => false });
    assert.equal(none.action, "omit");
  });

  test("idempotent: a second run over the first run's stored doc decides exactly the same", () => {
    const first = planRouteFacts({ routeFacts: facts, existing: undefined, guidanceSourceExists: ALL_SOURCES });
    const visa: SeedVisaFields = { id: "xa-visitor", countryCode: "XA", name: "Example Short Stay", code: "SHORT", description: "Made up.", category: "tourist", eligibilityCriteria: [] };
    const stored = buildVisaTypeDoc(visa, undefined, NOW, [{ sharedRouteId: "example-short-stay" }], undefined, routeFactFields(first));
    const second = planRouteFacts({ routeFacts: facts, existing: stored, guidanceSourceExists: ALL_SOURCES });
    assert.deepEqual(second, first);
    const again = buildVisaTypeDoc(visa, stored, NOW, [{ sharedRouteId: "example-short-stay" }], undefined, routeFactFields(second));
    assert.deepEqual(again, stored);
  });
});

// ============================================
// The two-sources guard
// ============================================
describe("seedRouteFactProblems (#339)", () => {
  const data = loadSharedVisaData(fixtureDataWithFacts());

  test("an inheriting entry that sets a fact the route also supplies stops the seed, one line per problem", () => {
    const problems = seedRouteFactProblems(
      [
        { id: "xa-visitor", countryCode: "XA", processingTime: "2-4 weeks", processingDaysMin: 14, validityPeriod: "90 days" },
        // Not listed under the route: its own facts are fine.
        { id: "xb-visitor", countryCode: "XB", processingTime: "3 days", validityPeriod: "30 days" },
      ],
      data
    );
    assert.deepEqual(problems, [
      "XA/xa-visitor has its own processingTime, processingDaysMin in the seed and also inherits a shared route with a processing time (\"example-short-stay\"): a fact cannot have two sources",
      "XA/xa-visitor has its own validityPeriod in the seed and also inherits a shared route with a stay limit (\"example-short-stay\"): a fact cannot have two sources",
    ]);
  });

  test("only the fields of the block the route records are guarded", () => {
    const onlyStay = fixtureDataWithFacts() as unknown as { sharedRoutes: Record<string, unknown>[] };
    delete onlyStay.sharedRoutes[0].processing;
    const problems = seedRouteFactProblems([{ id: "xa-visitor", countryCode: "XA", processingDaysMax: 28 }], loadSharedVisaData(onlyStay));
    assert.deepEqual(problems, []);
  });

  test("an entry taking route facts from two routes stops the seed", () => {
    const two = fixtureDataWithFacts() as unknown as { sharedRoutes: Record<string, unknown>[] };
    two.sharedRoutes.push({ ...JSON.parse(JSON.stringify(two.sharedRoutes[0])), id: "example-long-stay", name: "Example Long Stay" });
    const problems = seedRouteFactProblems([{ id: "xa-visitor", countryCode: "XA" }], loadSharedVisaData(two));
    assert.deepEqual(problems, ["XA/xa-visitor inherits more than one shared route with route facts (\"example-short-stay\", \"example-long-stay\"): a fact cannot have two sources"]);
  });

  test("the shipped seed and data file have no conflict", () => {
    assert.deepEqual(seedRouteFactProblems(SEED_VISA_TYPES, loadSharedVisaData()), []);
  });
});

// ============================================
// The document builder
// ============================================
describe("buildVisaTypeDoc with sourced route facts (#339)", () => {
  test("a record that inherits no route is written exactly as before (the shipped ae-tourist entry)", () => {
    const ae = SEED_VISA_TYPES.find((v) => v.id === "ae-tourist")!;
    assert.ok(ae, "ae-tourist is a seed record");
    const data = loadSharedVisaData();
    assert.deepEqual(routeFactsFor(data, ae.countryCode, ae.id), []);
    const decision = planRouteFacts({ routeFacts: routeFactsFor(data, ae.countryCode, ae.id), existing: undefined, guidanceSourceExists: ALL_SOURCES });
    assert.deepEqual(decision, { action: "none" });
    const before = buildVisaTypeDoc(ae, undefined, NOW, []);
    const after = buildVisaTypeDoc(ae, undefined, NOW, [], undefined, routeFactFields(decision));
    assert.deepEqual(after, before);
    assert.equal("sourcedFacts" in after, false);
    assert.equal(after.processingTime, ae.processingTime);
    assert.equal(after.processingDaysMin, ae.processingDaysMin);
    assert.equal(after.validityPeriod, ae.validityPeriod);
  });

  test("without a decision a re-seed drops stored route facts (whole-document set)", () => {
    const visa: SeedVisaFields = { id: "xa-visitor", countryCode: "XA", name: "Example", code: "X", description: "Made up.", category: "tourist", eligibilityCriteria: [] };
    const stored = { processingTime: "old", processingDaysMax: 3, validityPeriod: "old", sourcedFacts: { validity: {} }, inheritsFrom: [{ sharedRouteId: "other-route" }] };
    const doc = buildVisaTypeDoc(visa, stored, NOW, [], undefined, undefined);
    for (const k of ["processingTime", "processingDaysMax", "validityPeriod", "sourcedFacts"]) assert.equal(k in doc, false, k);
    assert.ok(noUndefined(doc));
  });
});

// ============================================
// The shipped file against the official text
// ============================================
describe("the shipped route facts (#339)", () => {
  const data = loadSharedVisaData();
  const route = data.sharedRoutes.find((r) => r.id === "schengen-area-short-stay")!;
  /** The stored copy of the official text (saved by script, never typed). */
  const officialText = fs.readFileSync(VISA_CODE_FIXTURE, "utf8");

  test("the route carries both blocks, citing the same document and stored source as its fee", () => {
    assert.ok(route?.processing && route.validity && route.fee);
    for (const block of [route.processing, route.validity]) {
      assert.equal(block.url, route.fee.url);
      assert.equal(block.url, VISA_CODE_URL);
      assert.equal(block.guidanceSourceId, route.fee.guidanceSourceId);
    }
  });

  test("every quote sentence appears in the stored official text, character for character", () => {
    const sentences = [...route.processing!.quote, ...route.validity!.quote];
    assert.equal(sentences.length, 3);
    for (const s of sentences) assert.ok(officialText.includes(s), `not found in the official text: ${JSON.stringify(s)}`);
    // Each sentence ENDS its paragraph in the source (a quote is never cut
    // off mid-paragraph; the paragraph's own number, e.g. "1.", may precede it).
    const lines = officialText.split("\n");
    for (const s of sentences) assert.ok(lines.some((l) => l.endsWith(s)), `does not end a paragraph of the official text: ${JSON.stringify(s)}`);
  });

  test("all 29 inheriting records get exactly the issue's values, with citations and no made-up minimum or extension", () => {
    assert.equal(route.inheritedBy.length, 29);
    for (const x of route.inheritedBy) {
      const visa = SEED_VISA_TYPES.find((v) => v.id === x.visaTypeId && v.countryCode === x.countryCode)!;
      assert.ok(visa, `${x.visaTypeId} is a seed record`);
      const decision: RouteFactsDecision = planRouteFacts({ routeFacts: routeFactsFor(data, x.countryCode, x.visaTypeId), existing: undefined, guidanceSourceExists: ALL_SOURCES });
      const doc = buildVisaTypeDoc(visa, undefined, NOW, [{ sharedRouteId: route.id }], undefined, routeFactFields(decision));
      assert.equal(doc.processingTime, "Up to 15 calendar days (up to 45 in individual cases)", x.visaTypeId);
      assert.equal(doc.processingDaysMax, 45, x.visaTypeId);
      assert.equal(doc.validityPeriod, "Stays of up to 90 days in any 180-day period", x.visaTypeId);
      for (const k of ["processingDaysMin", "isExtendable", "maxExtensions"]) assert.equal(k in doc, false, `${x.visaTypeId} has no ${k}`);
      const cited = doc.sourcedFacts as Record<string, { sharedRouteId: string; quote: string[]; url: string; guidanceSourceId: string }>;
      assert.deepEqual(Object.keys(cited).sort(), ["processing", "validity"]);
      assert.deepEqual(cited.processing, { sharedRouteId: route.id, quote: route.processing!.quote, url: VISA_CODE_URL, guidanceSourceId: route.fee!.guidanceSourceId });
      assert.deepEqual(cited.validity, { sharedRouteId: route.id, quote: route.validity!.quote, url: VISA_CODE_URL, guidanceSourceId: route.fee!.guidanceSourceId });
      assert.deepEqual(doc.eligibilityCriteria, [], `${x.visaTypeId} eligibilityCriteria`);
      assert.ok(noUndefined(doc));
    }
  });

  test("the NL seed entry states no processing time, extension or eligibility of its own", () => {
    const nl = SEED_VISA_TYPES.find((v) => v.id === "nl-visitor")!;
    for (const k of ["processingTime", "processingDaysMin", "processingDaysMax", "isExtendable", "validityPeriod", "maxExtensions", "baseCostUsd"]) assert.equal(k in nl, false, `nl-visitor has no ${k}`);
    assert.deepEqual(nl.eligibilityCriteria, []);
  });
});

// ============================================
// The fixture script's text conversion
// ============================================
describe("fetch-visa-code-text: htmlToText (#339)", () => {
  test("one line per block element, tags removed, entities decoded, non-breaking spaces kept", () => {
    const html = "<html><head><title>T</title></head><body><p class=\"a\">One  <span>two</span>\n three&#160;4.</p><div>A &amp; B</div><p> </p><script>x()</script></body></html>";
    assert.equal(htmlToText(html), "One two three 4.\nA & B\n");
  });
});
