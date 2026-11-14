// ============================================
// Unit tests — the shared visa data file, its loader, and the re-seeded record (issue #239)
// ============================================
// Pure: no Firestore. Every id, name and country code below is made up (user-assigned
// codes XA..XC): no real bloc, member, quote or fee appears anywhere.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Timestamp } from "firebase-admin/firestore";

import {
  EMPTY_SHARED_VISA_DATA,
  inheritsFromFor,
  loadSharedVisaData,
  SharedVisaDataError,
  validateSharedVisaData,
} from "../../src/data/shared-visa-data-format";
import { buildVisaTypeDoc, type SeedVisaFields } from "../../src/data/seed-visa-doc";
import { FIXTURE_DATA } from "../helpers/shared-visa-fixture";

/* eslint-disable @typescript-eslint/no-explicit-any */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("shared visa data: the shipped file", () => {
  test("is empty: real bloc data is entered by an admin from official pages, never by code", () => {
    assert.deepEqual(loadSharedVisaData(), EMPTY_SHARED_VISA_DATA);
  });

  test("the seed names no bloc (the data file does)", () => {
    const seed = fs.readFileSync(path.join(__dirname, "../../src/data/seed-countries-visas.ts"), "utf8");
    assert.equal(/schengen/i.test(seed), false);
  });
});

describe("validateSharedVisaData", () => {
  test("the example-shaped fixture is valid and normalised", () => {
    const r = validateSharedVisaData(FIXTURE_DATA);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.authorities[0].members.length, 2);
      assert.equal(r.data.sharedRoutes[0].issuingAuthorityId, "example-area");
    }
  });

  test("a member needs a verbatim quote AND an official https address", () => {
    for (const [field, value] of [["sourceQuote", ""], ["sourceQuote", "   "], ["sourceUrl", ""], ["sourceUrl", "http://bloc.example.org/x"], ["sourceUrl", "not a url"]] as const) {
      const d: any = clone(FIXTURE_DATA);
      d.authorities[0].members[0][field] = value;
      const r = validateSharedVisaData(d);
      assert.equal(r.ok, false, `${field}=${JSON.stringify(value)}`);
    }
    const missing: any = clone(FIXTURE_DATA);
    delete missing.authorities[0].members[1].sourceQuote;
    delete missing.authorities[0].members[1].sourceUrl;
    const r = validateSharedVisaData(missing);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("authorities[0].members[1]")));
  });

  test("lists every problem at once, and refuses bad ids, dates, duplicates and strangers", () => {
    const d: any = clone(FIXTURE_DATA);
    d.authorities[0].id = "has_underscore";
    d.authorities[0].members[0].joinedOn = "2020-13-45";
    d.authorities[0].members.push(clone(d.authorities[0].members[1]));
    d.sharedRoutes[0].category = "nonsense";
    d.sharedRoutes[0].inheritedBy.push({ countryCode: "XC", visaTypeId: "xc-visitor" });
    d.surprise = true;
    const r = validateSharedVisaData(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.length >= 4, r.errors.join("\n"));
  });

  test("a route's inheriting country must be covered by the route as written in the file", () => {
    const d: any = clone(FIXTURE_DATA);
    d.sharedRoutes[0].inheritedBy = [{ countryCode: "XC", visaTypeId: "xc-visitor" }]; // XC is not a member
    const r = validateSharedVisaData(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes("not a member")));
  });

  test("a route must be issued by an authority in the same file", () => {
    const d: any = clone(FIXTURE_DATA);
    d.sharedRoutes[0].issuingAuthorityId = "someone-else";
    assert.equal(validateSharedVisaData(d).ok, false);
  });

  test("loadSharedVisaData throws one error listing the problems", () => {
    assert.throws(() => loadSharedVisaData({ authorities: "x" }), SharedVisaDataError);
    assert.throws(() => loadSharedVisaData(null), /invalid/);
  });
});

describe("inheritsFromFor", () => {
  test("names the shared route only for the record the data file lists", () => {
    const data = loadSharedVisaData(FIXTURE_DATA);
    assert.deepEqual(inheritsFromFor(data, "XA", "xa-visitor"), [{ sharedRouteId: "example-short-stay" }]);
    assert.deepEqual(inheritsFromFor(data, "XA", "xa-work"), []);
    assert.deepEqual(inheritsFromFor(data, "XB", "xa-visitor"), []);
    assert.deepEqual(inheritsFromFor(EMPTY_SHARED_VISA_DATA, "XA", "xa-visitor"), []);
  });
});

describe("buildVisaTypeDoc (the seed's whole-document write)", () => {
  const NOW = Timestamp.fromMillis(Date.parse("2026-11-14T10:00:00Z"));
  const visa: SeedVisaFields = {
    id: "xa-visitor",
    countryCode: "XA",
    name: "Short Stay Visa",
    code: "SHORT-STAY",
    description: "d",
    category: "tourist",
    processingTime: "2-4 weeks",
    processingDaysMin: 14,
    processingDaysMax: 28,
    isExtendable: false,
    eligibilityCriteria: ["Valid passport"],
  };

  test("a fee or validity the seed does not state is omitted, not written as 0 or empty", () => {
    const doc = buildVisaTypeDoc(visa, undefined, NOW);
    assert.equal("baseCostUsd" in doc, false);
    assert.equal("validityPeriod" in doc, false);
    const withBoth = buildVisaTypeDoc({ ...visa, baseCostUsd: 5, validityPeriod: "x" }, undefined, NOW);
    assert.equal(withBoth.baseCostUsd, 5);
    assert.equal(withBoth.validityPeriod, "x");
  });

  test("a re-seed keeps the stored inheritsFrom (a whole-document set would drop it)", () => {
    const stored = { isActive: false, agentIds: ["a1"], createdAt: Timestamp.fromMillis(1), inheritsFrom: [{ sharedRouteId: "kept-route" }] };
    const doc = buildVisaTypeDoc(visa, stored, NOW, [{ sharedRouteId: "from-data" }]);
    assert.deepEqual(doc.inheritsFrom, [{ sharedRouteId: "kept-route" }]); // stored wins
    assert.equal(doc.isActive, false);
    assert.deepEqual(doc.agentIds, ["a1"]);
    assert.equal((doc.createdAt as Timestamp).toMillis(), 1);
  });

  test("inheritsFrom comes from the data file only for a record that has none, and is never an empty list", () => {
    assert.deepEqual(buildVisaTypeDoc(visa, undefined, NOW, [{ sharedRouteId: "from-data" }]).inheritsFrom, [{ sharedRouteId: "from-data" }]);
    assert.deepEqual(buildVisaTypeDoc(visa, { inheritsFrom: [] }, NOW, [{ sharedRouteId: "from-data" }]).inheritsFrom, [{ sharedRouteId: "from-data" }]);
    assert.equal("inheritsFrom" in buildVisaTypeDoc(visa, undefined, NOW, []), false);
    assert.equal("inheritsFrom" in buildVisaTypeDoc(visa, { inheritsFrom: [] }, NOW, []), false);
  });
});
