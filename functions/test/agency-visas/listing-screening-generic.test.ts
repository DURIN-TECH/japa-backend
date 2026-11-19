// ============================================
// Static check — listing screening is generic (issue #120)
// ============================================
//
// Run with `npm test`. Reads the SOURCE of the screening code, the prompt
// builder, the comparison rules and the language rule entries, and fails on
// any country name, ISO country code, route name, visa id or visa code. The
// term lists are loaded from DATA (the countries and visa-type seed, and the
// scraper registry), never typed here. Only fixtures are allow-listed (they
// are not scanned: this test scans an explicit list of non-fixture files).
//
// URLs are stripped before scanning: a rule's source URL is DATA on its entry
// (the issue's own "Sources and indicator phrasing are data on the rule
// entries"), not a jurisdiction named in logic or in a prompt.
//
// Nationality names are not in the seed data. Country names are checked,
// which also covers "<Country> visa" style wording; the prompts for two
// routes are additionally asserted equal apart from the listing's own text
// (listing-screening-rules.test.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");

/** The files that make up listing screening (never fixtures). */
const SCANNED = [
  "agency-visas/agency-visa-screening.service.ts",
  "services/ai/listing-screening-prompt.ts",
  "services/risk-rules/listing-comparison.rules.ts",
  "services/risk-rules/listing-language.rules.ts",
  "types/listing-screening.ts",
];

/** Load the seed file as text (importing it would initialise Firestore) and pull its data out. */
function seedTerms(): { names: string[]; codes: string[]; visaIds: string[]; visaCodes: string[] } {
  const text = fs.readFileSync(path.join(SRC, "data/seed-countries-visas.ts"), "utf8");
  const names = [...text.matchAll(/^\s{4}name: "([A-Z][A-Za-z ]+)",\s*\n\s{4}flagUrl/gm)].map((m) => m[1]);
  const codes = [...text.matchAll(/^\s{4}code: "([A-Z]{2})",\s*\n\s{4}name:/gm)].map((m) => m[1]);
  const visaIds = [...text.matchAll(/^\s{4}id: "([a-z0-9-]+)",\s*\n\s{4}countryCode:/gm)].map((m) => m[1]);
  const visaCodes = [...text.matchAll(/^\s{4}countryCode: "[A-Z]{2}",\s*\n\s{4}name: [^\n]+\n\s{4}code: "([^"]+)"/gm)].map((m) => m[1]);
  return { names, codes, visaIds, visaCodes };
}

/**
 * The scraper registry, read as text (its internals are not importable from
 * tests under the scrapers import rule): country names and codes from the
 * COUNTRY_CODES table, pinned visa ids and visa codes from the source pins.
 */
function registryTerms(): { names: string[]; codes: string[]; visaIds: string[]; visaCodes: string[] } {
  const text = fs.readFileSync(path.join(SRC, "scrapers/visa-catalog/data/seed-visa-sources.ts"), "utf8");
  const table = text.slice(text.indexOf("export const COUNTRY_CODES"), text.indexOf("};", text.indexOf("export const COUNTRY_CODES")));
  const pairs = [...table.matchAll(/^\s+"?([a-z][a-z ]+)"?: "([A-Z]{2})",/gm)];
  return {
    names: pairs.map((m) => m[1]),
    codes: pairs.map((m) => m[2]),
    visaIds: [...text.matchAll(/visaId: "([a-z0-9-]+)"/g)].map((m) => m[1]),
    visaCodes: [...text.matchAll(/visaCode: "([^"]+)"/g)].map((m) => m[1]),
  };
}

/** Everything the scanner forbids, from data. */
function forbidden() {
  const seed = seedTerms();
  const registry = registryTerms();
  const registryNames = registry.names;
  const registryCodes = registry.codes;
  const registryVisaIds = registry.visaIds;
  const registryVisaCodes = registry.visaCodes;
  const uniq = (xs: string[]) => [...new Set(xs.filter((x) => x.length >= 2))];
  return {
    names: uniq([...seed.names, ...registryNames]),
    codes: uniq([...seed.codes, ...registryCodes.map((c) => c.toUpperCase())]),
    visaIds: uniq([...seed.visaIds, ...registryVisaIds]),
    visaCodes: uniq([...seed.visaCodes, ...registryVisaCodes]),
  };
}

/** Source with URLs removed (data on the rule entries). */
const withoutUrls = (text: string) => text.replace(/https?:\/\/\S+/g, "");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("listing screening names no country, route or visa", () => {
  const terms = forbidden();

  test("the term lists really came from data", () => {
    assert.ok(terms.names.length >= 12, `country names: ${terms.names.length}`);
    assert.ok(terms.codes.length >= 12, `country codes: ${terms.codes.length}`);
    assert.ok(terms.visaIds.length >= 20, `visa ids: ${terms.visaIds.length}`);
    assert.ok(terms.visaCodes.length >= 5, `visa codes: ${terms.visaCodes.length}`);
  });

  for (const file of SCANNED) {
    test(`${file}`, () => {
      const text = withoutUrls(fs.readFileSync(path.join(SRC, file), "utf8"));
      // Country names and visa ids: as whole words, any case.
      for (const term of [...terms.names, ...terms.visaIds]) {
        assert.ok(!new RegExp(`(^|[^A-Za-z0-9-])${escape(term)}($|[^A-Za-z0-9-])`, "i").test(text), `names "${term}"`);
      }
      // ISO country codes and visa codes: as quoted string literals (a bare
      // "IN" or "ID" in a comment is ordinary English, not a country).
      for (const term of [...terms.codes, ...terms.visaCodes]) {
        assert.ok(!new RegExp(`["'\`]${escape(term)}["'\`]`).test(text), `uses the literal "${term}"`);
      }
    });
  }

  test("the scan can fail: it catches a planted country name and a planted code literal", () => {
    const name = terms.names[0];
    const code = terms.codes[0];
    assert.match(`prompt text for ${name} applicants`, new RegExp(`(^|[^A-Za-z0-9-])${escape(name)}($|[^A-Za-z0-9-])`, "i"));
    assert.match(`const c = "${code}";`, new RegExp(`["'\`]${escape(code)}["'\`]`));
  });
});
