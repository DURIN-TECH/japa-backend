// ============================================
// Unit tests — the shared visa data file, its loader, and the re-seeded record (issue #239)
// ============================================
// Pure: no Firestore. Every id, name and country code below is made up (user-assigned
// codes XA..XC): no real bloc, member, quote or fee appears anywhere, EXCEPT the two
// "#306" tests on the shipped file, which check the real members and records the
// issue names (comparing them with the file's own NL entry, never a typed-out fact),
// and the "#322" tests, which compare the twenty members #322 added with a copy of
// the issue's JSON block (fixtures/schengen-members-322.json, written by script),
// and the "#331" tests, which compare Italy and Austria with the file's own DK
// entry (no quote, link or date typed out here beyond the one date the issue names).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Timestamp } from "firebase-admin/firestore";

import {
  type DataMember,
  EMPTY_SHARED_VISA_DATA,
  inheritsFromFor,
  loadSharedVisaData,
  SharedVisaDataError,
  validateSharedVisaData,
} from "../../src/data/shared-visa-data-format";
import { buildVisaTypeDoc, type SeedVisaFields } from "../../src/data/seed-visa-doc";
import { FIXTURE_DATA, FIXTURE_FEE, fixtureDataWithFee } from "../helpers/shared-visa-fixture";
import { routeFeesFor } from "../../src/data/shared-visa-data-format";
import { seedFeeProblems } from "../../src/data/seed-sourced-fee";
// #306: the seed module calls getFirestore() when it loads, so the Admin app
// must be initialised first (no Firestore call is made: the test guard would fail it).
import "../../src/utils/firebase";
import { SEED_COUNTRIES, SEED_VISA_TYPES } from "../../src/data/seed-countries-visas";

// ---- #322: the expected member data, as the issue gives it ----
// The JSON block of issue #322, copied into the fixture BY SCRIPT (never typed):
// one entry per group of members, with the group's official sentence, link and
// date. This test states no legal fact of its own beyond this file.
interface MemberGroup {
  countryCodes: string[];
  joinedOn: string;
  sourceUrl: string;
  sourceQuote: string;
}
const GROUPS_322: MemberGroup[] = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "schengen-members-322.json"), "utf8"));
/** The twenty #322 member codes, in the issue's order (taken from the fixture). */
const CODES_322 = GROUPS_322.flatMap((g) => g.countryCodes);
/** The country names #322 seeds (names and flags are not legal facts). */
const NAMES_322: Record<string, string> = {
  GR: "Greece", DK: "Denmark", FI: "Finland", SE: "Sweden", IS: "Iceland", NO: "Norway", CZ: "Czechia",
  EE: "Estonia", LV: "Latvia", LT: "Lithuania", HU: "Hungary", MT: "Malta", PL: "Poland", SI: "Slovenia",
  SK: "Slovakia", CH: "Switzerland", LI: "Liechtenstein", HR: "Croatia", BG: "Bulgaria", RO: "Romania",
};
/** The seven members recorded before #322 (#239 + #306). */
const CODES_306 = ["NL", "BE", "DE", "FR", "LU", "ES", "PT"];
// ---- #331: the last two members, Italy and Austria ----
// Recorded with the DK entry's quote, link and date (owner decision of
// 2026-11-15). Names and flags are not legal facts.
const CODES_331 = ["IT", "AT"];
const NAMES_331: Record<string, string> = { IT: "Italy", AT: "Austria" };

/* eslint-disable @typescript-eslint/no-explicit-any */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("shared visa data: the shipped file", () => {
  test("is valid, and every member carries a word-for-word quote and an https address", () => {
    // The file holds real entries now (filled from official pages, issue #239), so
    // this checks the SHAPE of whatever is in it, never specific legal facts.
    const data = loadSharedVisaData();
    for (const authority of data.authorities) {
      for (const member of authority.members) {
        assert.ok(member.sourceQuote.length > 0, `${authority.id}/${member.countryCode} has a quote`);
        assert.match(member.sourceUrl, /^https:\/\//, `${authority.id}/${member.countryCode} has an https address`);
        assert.match(member.joinedOn, /^\d{4}-\d{2}-\d{2}$/);
      }
    }
    // Every inheriting record belongs to a member country listed in this same file.
    for (const route of data.sharedRoutes) {
      const issuer = data.authorities.find((a) => a.id === route.issuingAuthorityId);
      assert.ok(issuer, `${route.id} is issued by an authority in this file`);
      for (const x of route.inheritedBy) assert.ok(issuer.members.some((m) => m.countryCode === x.countryCode));
    }
  });

  // ---- #306: the six other first members, and their short-stay records ----
  // This one test names real country codes and record ids, because the issue
  // asks for exactly these. It still states no legal fact of its own: the
  // quote, link and date of the new members are compared with the NL entry
  // that is already in the file, never typed out here.
  // #322: the counts are now 27 members and 27 inheriting records (the seven
  // of #306 plus the twenty of #322); the #306 checks on the seven are kept.
  // #331: and now 29 of each (plus IT and AT).
  test("#306/#322/#331: 29 members and 29 inheriting records, each matching the seed", () => {
    const data = loadSharedVisaData();
    const bloc = data.authorities.find((a) => a.id === "schengen-area");
    assert.ok(bloc, "the bloc is in the file");
    assert.deepEqual(bloc.members.map((m) => m.countryCode).sort(), [...CODES_306, ...CODES_322, ...CODES_331].sort());
    assert.equal(bloc.members.length, 29);
    const nl = bloc.members.find((m) => m.countryCode === "NL")!;
    for (const m of bloc.members.filter((x) => CODES_306.includes(x.countryCode) && x.countryCode !== "NL")) {
      assert.equal(m.joinedOn, nl.joinedOn, `${m.countryCode} joinedOn`);
      assert.equal(m.joinedOn, "1995-03-26", `${m.countryCode} joinedOn`);
      assert.equal(m.sourceQuote, nl.sourceQuote, `${m.countryCode} quote is NL's, character for character`);
      assert.equal(m.sourceUrl, "https://publications.europa.eu/resource/celex/41994D0029", `${m.countryCode} sourceUrl`);
    }

    const route = data.sharedRoutes.find((r) => r.id === "schengen-area-short-stay");
    assert.ok(route, "the route is in the file");
    assert.deepEqual(
      route.inheritedBy.map((x) => `${x.countryCode}/${x.visaTypeId}`).sort(),
      [
        "BE/be-visitor", "DE/de-visitor", "ES/es-visitor", "FR/fr-visitor", "LU/lu-visitor", "NL/nl-visitor", "PT/pt-visitor",
        ...CODES_322.map((cc) => `${cc}/${cc.toLowerCase()}-visitor`),
        // #331
        ...CODES_331.map((cc) => `${cc}/${cc.toLowerCase()}-visitor`),
      ].sort()
    );
    assert.equal(route.inheritedBy.length, 29);
    // The route itself is unchanged by #306, #322 and #331 (its fee came with #299).
    assert.equal(route.name, "Schengen short-stay visa");
    assert.equal(route.category, "tourist");
    assert.equal(route.fee?.amount, 90);
    assert.equal(route.fee?.currency, "EUR");
    assert.equal(route.id, "schengen-area-short-stay");
    assert.deepEqual(route.destinations, { mode: "members_of", authorityId: "schengen-area" });

    // Every member is a seed country; every inheriting record is a seed visa of that country.
    const countryCodes = new Set(SEED_COUNTRIES.map((c) => c.code));
    for (const m of bloc.members) assert.ok(countryCodes.has(m.countryCode), `${m.countryCode} is a seed country`);
    for (const x of route.inheritedBy) {
      const v = SEED_VISA_TYPES.find((s) => s.id === x.visaTypeId);
      assert.ok(v, `${x.visaTypeId} is a seed visa`);
      assert.equal(v.countryCode, x.countryCode, `${x.visaTypeId} belongs to ${x.countryCode}`);
      assert.equal("baseCostUsd" in v, false, `${x.visaTypeId} has no fee of its own`);
    }
    // ...so the seed's fee check finds no record with two fee sources.
    assert.deepEqual(seedFeeProblems(SEED_VISA_TYPES, data), []);
  });

  test("#306: the six new short-stay records state no unsourced fact", () => {
    const UNSOURCED = ["baseCostUsd", "validityPeriod", "maxExtensions", "applicationUrl", "applicationInstructions", "processingTime", "processingDaysMin", "processingDaysMax", "isExtendable"];
    const names: Record<string, string> = { BE: "Belgium", DE: "Germany", FR: "France", LU: "Luxembourg", ES: "Spain", PT: "Portugal" };
    for (const [cc, name] of Object.entries(names)) {
      const v = SEED_VISA_TYPES.find((s) => s.id === `${cc.toLowerCase()}-visitor`);
      assert.ok(v, `${cc} record exists`);
      for (const key of UNSOURCED) assert.equal(key in v, false, `${v.id} has no ${key}`);
      assert.deepEqual(v.eligibilityCriteria, []);
      assert.equal(v.countryCode, cc);
      assert.equal(v.name, "Short Stay Visa");
      assert.equal(v.code, "SHORT-STAY");
      assert.equal(v.category, "tourist");
      assert.equal(v.description, `Short stay visa for ${name}.`);
    }
    // The five new countries are listed with a flag; NL and DE keep their entries.
    for (const cc of ["BE", "FR", "LU", "ES", "PT"]) {
      const c = SEED_COUNTRIES.find((x) => x.code === cc);
      assert.ok(c, `${cc} is a seed country`);
      assert.equal(c.flagUrl, `https://flagcdn.com/w320/${cc.toLowerCase()}.png`);
      assert.equal(c.isSupported, true);
    }
    // No two countries share a rank (the new ranks did not displace an existing one).
    const ranks = SEED_COUNTRIES.map((c) => c.popularityRank);
    assert.equal(new Set(ranks).size, ranks.length);
  });

  // ---- #322: the twenty members, compared with the issue's JSON block ----
  test("#322: each new member carries its group's date, link and quote, character for character", () => {
    const bloc = loadSharedVisaData().authorities.find((a) => a.id === "schengen-area");
    assert.ok(bloc, "the bloc is in the file");
    // The fixture is the issue's block: seven groups, twenty distinct codes, no IT, no AT.
    assert.equal(GROUPS_322.length, 7);
    assert.equal(new Set(CODES_322).size, 20);
    assert.deepEqual(Object.keys(NAMES_322), CODES_322, "the names list follows the fixture's order");
    // #331: IT and AT are members now (checked by the #331 test), but the
    // #322 block still names neither of them.
    for (const cc of CODES_331) assert.equal(CODES_322.includes(cc), false, `${cc} is not in the #322 block`);
    for (const g of GROUPS_322) {
      // The shipped entries of this group's members, in the group's order.
      const members: DataMember[] = bloc.members;
      const shipped: DataMember[] = [];
      for (const cc of g.countryCodes) {
        const found: DataMember | undefined = members.find((x: DataMember) => x.countryCode === cc);
        assert.ok(found, `${cc} is a member`);
        shipped.push(found);
      }
      for (const [i, m] of shipped.entries() as Iterable<[number, DataMember]>) {
        const cc = g.countryCodes[i];
        assert.ok(m, `${cc} is a member`);
        assert.equal(m.joinedOn, g.joinedOn, `${cc} joinedOn`);
        assert.equal(m.sourceUrl, g.sourceUrl, `${cc} sourceUrl`);
        assert.equal(m.sourceQuote, g.sourceQuote, `${cc} sourceQuote, character for character`);
        // Members of one group share the same three values.
        assert.deepEqual([m.joinedOn, m.sourceUrl, m.sourceQuote], [shipped[0].joinedOn, shipped[0].sourceUrl, shipped[0].sourceQuote]);
      }
    }
    // The Liechtenstein quote keeps its typographic apostrophe (U+2019).
    const li = bloc.members.find((m) => m.countryCode === "LI")!;
    assert.ok(li.sourceQuote.includes("\u2019"), "LI quote keeps U+2019");
    assert.equal(li.sourceQuote.includes("'"), false, "no straight apostrophe in its place");
    // Every quote fits the validator's limit (SOURCE_QUOTE_MAX = 2000).
    for (const m of bloc.members) assert.ok(m.sourceQuote.length < 2000, `${m.countryCode} quote length ${m.sourceQuote.length}`);
  });

  test("#322: the twenty new short-stay records and countries state no unsourced fact", () => {
    const UNSOURCED = ["baseCostUsd", "validityPeriod", "maxExtensions", "applicationUrl", "applicationInstructions", "processingTime", "processingDaysMin", "processingDaysMax", "isExtendable"];
    for (const [i, cc] of CODES_322.entries()) {
      const name = NAMES_322[cc];
      // The record: same shape as be-visitor, nothing beyond the visa and country name.
      const v = SEED_VISA_TYPES.find((s) => s.id === `${cc.toLowerCase()}-visitor`);
      assert.ok(v, `${cc} record exists`);
      for (const key of UNSOURCED) assert.equal(key in v, false, `${v.id} has no ${key}`);
      assert.deepEqual(v.eligibilityCriteria, [], `${v.id} eligibilityCriteria`);
      assert.equal(v.countryCode, cc);
      assert.equal(v.name, "Short Stay Visa");
      assert.equal(v.code, "SHORT-STAY");
      assert.equal(v.category, "tourist");
      assert.equal(v.description, `Short stay visa for ${name}.`);
      // The country: a name, a flag, supported, ranks 15-34 in the issue's order.
      const c = SEED_COUNTRIES.find((x) => x.code === cc);
      assert.ok(c, `${cc} is a seed country`);
      assert.equal(c.name, name);
      assert.equal(c.flagUrl, `https://flagcdn.com/w320/${cc.toLowerCase()}.png`);
      assert.equal(c.isSupported, true);
      assert.equal(c.popularityRank, 15 + i, `${cc} rank`);
    }
    // Exactly twenty new records shaped like be-visitor (one per new member, no more).
    assert.equal(SEED_VISA_TYPES.filter((v) => CODES_322.includes(v.countryCode)).length, 20);
    // #331: IT and AT are seeded now; the "#331" test checks them instead.
    // The countries seeded before #322 keep their ranks. (The issue says
    // "fourteen"; the seed on origin/dev has seventeen: twelve from before
    // #306 plus #306's five. All seventeen are checked, ranks as on origin/dev.)
    const BEFORE_322: Record<string, number> = {
      IE: 1, GB: 2, US: 3, CA: 4, AU: 5, DE: 6, NL: 7, AE: 8, ZA: 9, NG: 99, GH: 100, KE: 101,
      BE: 10, FR: 11, LU: 12, ES: 13, PT: 14,
    };
    // #331: IT and AT are left out here (the "#331" test checks their ranks).
    const others = SEED_COUNTRIES.filter((c) => !CODES_322.includes(c.code) && !CODES_331.includes(c.code));
    assert.deepEqual(Object.fromEntries(others.map((c) => [c.code, c.popularityRank])), BEFORE_322);
    // No two countries share a rank.
    const ranks = SEED_COUNTRIES.map((c) => c.popularityRank);
    assert.equal(new Set(ranks).size, ranks.length);
  });

  // ---- #331: Italy and Austria, compared with the file's own DK entry ----
  // No quote or link is typed here: both are read from the DK entry, so the
  // test states no legal fact beyond the one date the issue names.
  test("#331: IT and AT carry exactly the DK entry's quote and link, and the 2001-03-25 date", () => {
    const bloc = loadSharedVisaData().authorities.find((a) => a.id === "schengen-area");
    assert.ok(bloc, "the bloc is in the file");
    // Typed explicitly for the test type check (as in the #322 test).
    const members: DataMember[] = bloc.members;
    const dk: DataMember | undefined = members.find((x: DataMember) => x.countryCode === "DK");
    assert.ok(dk, "DK is a member");
    for (const cc of CODES_331) {
      const m: DataMember[] = members.filter((x: DataMember) => x.countryCode === cc);
      assert.equal(m.length, 1, `${cc} is listed once`);
      assert.equal(m[0].joinedOn, "2001-03-25", `${cc} joinedOn`);
      assert.equal(m[0].joinedOn, dk.joinedOn, `${cc} joinedOn is DK's`);
      assert.equal(m[0].sourceQuote, dk.sourceQuote, `${cc} quote is DK's, character for character`);
      assert.equal(m[0].sourceUrl, dk.sourceUrl, `${cc} sourceUrl is DK's`);
    }
  });

  test("#331: the two new short-stay records and countries state no unsourced fact", () => {
    const UNSOURCED = ["baseCostUsd", "validityPeriod", "maxExtensions", "applicationUrl", "applicationInstructions", "processingTime", "processingDaysMin", "processingDaysMax", "isExtendable"];
    for (const [i, cc] of CODES_331.entries()) {
      const name = NAMES_331[cc];
      // The record: same shape as be-visitor, nothing beyond the visa and country name.
      const v = SEED_VISA_TYPES.find((s) => s.id === `${cc.toLowerCase()}-visitor`);
      assert.ok(v, `${cc} record exists`);
      for (const key of UNSOURCED) assert.equal(key in v, false, `${v.id} has no ${key}`);
      assert.deepEqual(v.eligibilityCriteria, [], `${v.id} eligibilityCriteria`);
      assert.equal(v.countryCode, cc);
      assert.equal(v.name, "Short Stay Visa");
      assert.equal(v.code, "SHORT-STAY");
      assert.equal(v.category, "tourist");
      assert.equal(v.description, `Short stay visa for ${name}.`);
      // The country: a name, a flag, supported, ranks 35 (IT) and 36 (AT).
      const c = SEED_COUNTRIES.find((x) => x.code === cc);
      assert.ok(c, `${cc} is a seed country`);
      assert.equal(c.name, name);
      assert.equal(c.flagUrl, `https://flagcdn.com/w320/${cc.toLowerCase()}.png`);
      assert.equal(c.isSupported, true);
      assert.equal(c.popularityRank, 35 + i, `${cc} rank`);
    }
    // Exactly one record per new country (no more).
    assert.equal(SEED_VISA_TYPES.filter((v) => CODES_331.includes(v.countryCode)).length, 2);
    // The countries seeded before #331 keep their ranks: the seventeen of
    // before #322 (as on origin/dev) plus #322's twenty at 15-34.
    const BEFORE_331: Record<string, number> = {
      IE: 1, GB: 2, US: 3, CA: 4, AU: 5, DE: 6, NL: 7, AE: 8, ZA: 9, NG: 99, GH: 100, KE: 101,
      BE: 10, FR: 11, LU: 12, ES: 13, PT: 14,
      ...Object.fromEntries(CODES_322.map((cc, i) => [cc, 15 + i])),
    };
    const others = SEED_COUNTRIES.filter((c) => !CODES_331.includes(c.code));
    assert.deepEqual(Object.fromEntries(others.map((c) => [c.code, c.popularityRank])), BEFORE_331);
    // No two countries share a rank.
    const ranks = SEED_COUNTRIES.map((c) => c.popularityRank);
    assert.equal(new Set(ranks).size, ranks.length);
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

// ============================================
// Issue #299: the optional fee of a shared route
// ============================================
describe("validateSharedVisaData: a route's fee (#299)", () => {
  /** The errors of the fixture with one fee field replaced (or removed with `undefined`). */
  const errorsWith = (field: string, value: unknown): string[] => {
    const d: any = fixtureDataWithFee();
    if (value === undefined) delete d.sharedRoutes[0].fee[field];
    else d.sharedRoutes[0].fee[field] = value;
    const r = validateSharedVisaData(d);
    return r.ok ? [] : r.errors;
  };

  test("a complete fee is valid and kept as written; a route with no fee stays valid", () => {
    const r = validateSharedVisaData(fixtureDataWithFee());
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.data.sharedRoutes[0].fee, FIXTURE_FEE);
    const none = validateSharedVisaData(FIXTURE_DATA);
    assert.equal(none.ok, true);
    if (none.ok) assert.equal("fee" in none.data.sharedRoutes[0], false);
  });

  test("the rule reference is optional, and absent stays absent", () => {
    const d: any = fixtureDataWithFee();
    delete d.sharedRoutes[0].fee.ruleRef;
    const r = validateSharedVisaData(d);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal("ruleRef" in r.data.sharedRoutes[0].fee!, false);
    assert.ok(errorsWith("ruleRef", { routeKey: "", version: 0, criterionId: "" }).length >= 3);
  });

  test("the amount must be a finite number above 0", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "250", undefined]) {
      assert.ok(errorsWith("amount", bad).some((e) => e.includes("fee.amount")), `amount=${String(bad)}`);
    }
  });

  test("the currency must be a known ISO 4217 code", () => {
    for (const bad of ["XXQ", "sek", "", 5, undefined]) {
      assert.ok(errorsWith("currency", bad).some((e) => e.includes("fee.currency")), `currency=${String(bad)}`);
    }
  });

  test("the quote must state both the amount and the currency code, as written", () => {
    // The amount is missing, or only appears inside another number.
    assert.ok(errorsWith("quote", "Placeholder sentence stating that the fee is SEK 1250.").some((e) => e.includes("does not state the amount")));
    assert.ok(errorsWith("quote", "Placeholder sentence stating that the fee is SEK 250.50.").some((e) => e.includes("does not state the amount")));
    assert.ok(errorsWith("quote", "Placeholder sentence stating a fee in SEK.").some((e) => e.includes("does not state the amount")));
    // The currency code is missing, or only appears inside another word.
    assert.ok(errorsWith("quote", "Placeholder sentence stating that the fee is 250.").some((e) => e.includes("does not state the currency")));
    assert.ok(errorsWith("quote", "Placeholder sentence: SEKTOR fee 250.").some((e) => e.includes("does not state the currency")));
    assert.ok(errorsWith("quote", "").some((e) => e.includes("fee.quote")));
    // Thousands separators and trailing decimals are read as the source writes them.
    const d: any = fixtureDataWithFee();
    d.sharedRoutes[0].fee.amount = 1500;
    d.sharedRoutes[0].fee.quote = "Placeholder sentence stating that the fee is SEK 1,500.00.";
    assert.equal(validateSharedVisaData(d).ok, true);
  });

  test("the address must be https, and the source id must not be empty", () => {
    for (const bad of ["http://bloc.example.org/fees", "not a url", "", undefined]) {
      assert.ok(errorsWith("url", bad).some((e) => e.includes("fee.url")), `url=${String(bad)}`);
    }
    for (const bad of ["", "   ", undefined]) {
      assert.ok(errorsWith("guidanceSourceId", bad).some((e) => e.includes("fee.guidanceSourceId")), `id=${String(bad)}`);
    }
  });

  test("every problem of a fee is listed at once, and the file is refused", () => {
    const d: any = fixtureDataWithFee();
    d.sharedRoutes[0].fee = { amount: -1, currency: "nope", label: "", quote: "", url: "http://x.example.org", guidanceSourceId: "", surprise: 1 };
    const r = validateSharedVisaData(d);
    assert.equal(r.ok, false);
    if (!r.ok) {
      for (const field of ["amount", "currency", "label", "quote", "url", "guidanceSourceId", "surprise"]) {
        assert.ok(r.errors.some((e) => e.includes(`fee.${field}`)), `${field} is listed: ${r.errors.join(" | ")}`);
      }
    }
    assert.throws(() => loadSharedVisaData(d), SharedVisaDataError);
    const notObject: any = fixtureDataWithFee();
    notObject.sharedRoutes[0].fee = "250 SEK";
    assert.equal(validateSharedVisaData(notObject).ok, false);
  });

  test("the shipped file: any fee in it passes the same checks (shape only, no legal fact asserted)", () => {
    for (const route of loadSharedVisaData().sharedRoutes) {
      if (!route.fee) continue;
      assert.ok(route.fee.amount > 0);
      assert.match(route.fee.url, /^https:\/\//);
      assert.ok(route.fee.quote.includes(route.fee.currency));
    }
  });
});

describe("routeFeesFor (#299)", () => {
  test("gives the fee only to a record the data file lists under a route that has one", () => {
    const data = loadSharedVisaData(fixtureDataWithFee());
    assert.deepEqual(routeFeesFor(data, "XA", "xa-visitor"), [{ sharedRouteId: "example-short-stay", fee: FIXTURE_FEE }]);
    assert.deepEqual(routeFeesFor(data, "XA", "xa-work"), []);
    assert.deepEqual(routeFeesFor(data, "XB", "xa-visitor"), []);
    // The same record, but the route has no fee.
    assert.deepEqual(routeFeesFor(loadSharedVisaData(FIXTURE_DATA), "XA", "xa-visitor"), []);
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

  // #306: an entry with no processing time and no extension flag on record.
  test("#306: processing fields and isExtendable the entry does not state are omitted, and no key is undefined", () => {
    const { processingTime, processingDaysMin, processingDaysMax, isExtendable, ...bare } = visa;
    void processingTime; void processingDaysMin; void processingDaysMax; void isExtendable;
    const doc = buildVisaTypeDoc(bare, undefined, NOW);
    for (const key of ["processingTime", "processingDaysMin", "processingDaysMax", "isExtendable"]) {
      assert.equal(key in doc, false, `${key} is omitted`);
    }
    assert.deepEqual(Object.entries(doc).filter(([, v]) => v === undefined), []);
    // An entry that states them is written exactly as before (false stays false).
    const full = buildVisaTypeDoc(visa, undefined, NOW);
    assert.equal(full.processingTime, "2-4 weeks");
    assert.equal(full.processingDaysMin, 14);
    assert.equal(full.processingDaysMax, 28);
    assert.equal(full.isExtendable, false);
  });

  test("inheritsFrom comes from the data file only for a record that has none, and is never an empty list", () => {
    assert.deepEqual(buildVisaTypeDoc(visa, undefined, NOW, [{ sharedRouteId: "from-data" }]).inheritsFrom, [{ sharedRouteId: "from-data" }]);
    assert.deepEqual(buildVisaTypeDoc(visa, { inheritsFrom: [] }, NOW, [{ sharedRouteId: "from-data" }]).inheritsFrom, [{ sharedRouteId: "from-data" }]);
    assert.equal("inheritsFrom" in buildVisaTypeDoc(visa, undefined, NOW, []), false);
    assert.equal("inheritsFrom" in buildVisaTypeDoc(visa, { inheritsFrom: [] }, NOW, []), false);
  });
});

describe("buildVisaTypeDoc with a sourced fee (#299)", () => {
  const NOW = Timestamp.fromMillis(Date.parse("2026-11-14T10:00:00Z"));
  const visa: SeedVisaFields = {
    id: "xa-visitor", countryCode: "XA", name: "Short Stay Visa", code: "SHORT-STAY", description: "d", category: "tourist",
    processingTime: "2-4 weeks", processingDaysMin: 14, processingDaysMax: 28, isExtendable: false, eligibilityCriteria: [],
  };
  const sourced = {
    baseCostUsd: 27,
    sourcedFee: {
      sharedRouteId: "example-short-stay", quote: FIXTURE_FEE.quote, url: FIXTURE_FEE.url, guidanceSourceId: FIXTURE_FEE.guidanceSourceId,
      fee: { components: [], totals: [], totalUsd: 27.2 },
    },
  };
  /** Every key of a value, at any depth, whose value is `undefined`. */
  const undefinedKeys = (v: unknown, at = ""): string[] =>
    v && typeof v === "object" && !(v instanceof Timestamp)
      ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (x === undefined ? [`${at}${k}`] : undefinedKeys(x, `${at}${k}.`)))
      : [];

  test("writes baseCostUsd and sourcedFee together, keeps inheritsFrom, and has no undefined key", () => {
    const stored = { inheritsFrom: [{ sharedRouteId: "example-short-stay" }], isActive: true, agentIds: [], createdAt: NOW };
    const doc = buildVisaTypeDoc(visa, stored, NOW, [{ sharedRouteId: "example-short-stay" }], sourced);
    assert.equal(doc.baseCostUsd, 27);
    assert.deepEqual(doc.sourcedFee, sourced.sourcedFee);
    assert.deepEqual(doc.inheritsFrom, [{ sharedRouteId: "example-short-stay" }]);
    assert.deepEqual(undefinedKeys(doc), []);
  });

  test("without a sourced fee neither field is written (a re-seed drops a stored one), and no key is undefined", () => {
    const stored = { baseCostUsd: 27, sourcedFee: sourced.sourcedFee, inheritsFrom: [{ sharedRouteId: "example-short-stay" }] };
    const doc = buildVisaTypeDoc(visa, stored, NOW, [{ sharedRouteId: "example-short-stay" }], undefined);
    assert.equal("baseCostUsd" in doc, false);
    assert.equal("sourcedFee" in doc, false);
    assert.deepEqual(doc.inheritsFrom, [{ sharedRouteId: "example-short-stay" }]);
    assert.deepEqual(undefinedKeys(doc), []);
  });

  test("a record with its own seed fee and no sourced fee is written exactly as before", () => {
    const doc = buildVisaTypeDoc({ ...visa, baseCostUsd: 5 }, undefined, NOW);
    assert.equal(doc.baseCostUsd, 5);
    assert.equal("sourcedFee" in doc, false);
  });
});
