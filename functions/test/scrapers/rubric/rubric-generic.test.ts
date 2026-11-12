// ============================================
// Rubric module is route-agnostic (issue #40) — static checks
// ============================================
//
// A route is DATA. These tests read the SOURCE TEXT of the rubric module (the
// schema, validator, prompt, chunker, store, extraction service and its CLI,
// plus the model-provider files it added) and fail if any of it names a
// country, a visa type or a guidance publisher, or reaches for something the
// issue rules out (approving, scheduling, routes, sampling parameters).
//
// The lists of names are LOADED FROM THE REPO'S OWN DATA (the countries and
// visa types seed, the guidance source seed), not typed in here, so a newly
// seeded country or route is covered without touching this file. Not covered:
// nationality adjectives (no data file lists them), so reviewers still read
// prompt changes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "..", "..", "src");

/** Every .ts file under a directory. */
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(full) : e.name.endsWith(".ts") ? [full] : [];
  });
}

/** The files this issue added: all must stay generic. */
const MODULE_FILES = [
  ...tsFiles(path.join(SRC, "scrapers", "rubric")),
  path.join(SRC, "types", "rubric.ts"),
  path.join(SRC, "services", "ai", "llm-provider.ts"),
  path.join(SRC, "services", "ai", "ai-pricing.ts"),
];

/** file (relative to src) -> its text. */
const sources = new Map(MODULE_FILES.map((f) => [path.relative(SRC, f), fs.readFileSync(f, "utf8")]));

/** Every `key: "value"` string in a seed file, for the given keys. */
function seedValues(file: string, keys: string[]): string[] {
  const text = fs.readFileSync(path.join(SRC, file), "utf8");
  const out: string[] = [];
  for (const key of keys) {
    for (const m of text.matchAll(new RegExp(`\\b${key}:\\s*"([^"]+)"`, "g"))) out.push(m[1]);
  }
  return [...new Set(out)];
}

const COUNTRY_SEED = path.join("data", "seed-countries-visas.ts");
const GUIDANCE_SEED = path.join("scrapers", "guidance", "data", "seed-guidance-sources.ts");

/** Escape a string for use inside a RegExp. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Files whose text matches `pattern`, with the match, for the failure message. */
function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const [file, text] of sources) {
    const m = pattern.exec(text);
    if (m) hits.push(`${file}: "${m[0]}"`);
  }
  return hits;
}

describe("rubric module: names no country, route or publisher", () => {
  test("the module's files were found", () => {
    assert.ok(MODULE_FILES.length >= 10, `only ${MODULE_FILES.length} files`);
    for (const f of MODULE_FILES) assert.ok(fs.existsSync(f), f);
  });

  test("no country name from the countries seed", () => {
    const names = seedValues(COUNTRY_SEED, ["name"]).filter((n) => /^[A-Z][A-Za-z .'-]+$/.test(n));
    // The seed's `name` key is shared by countries and visa types: both lists
    // are names the module must not contain.
    assert.ok(names.length >= 12, "the seed was parsed");
    for (const name of names) {
      assert.deepEqual(offenders(new RegExp(`\\b${esc(name)}\\b`, "i")), [], `country or visa name "${name}"`);
    }
  });

  test("no ISO country code from the countries seed (as an upper-case word)", () => {
    const codes = [...new Set([...seedValues(COUNTRY_SEED, ["code", "countryCode"])].filter((c) => /^[A-Z]{2}$/.test(c)))];
    assert.ok(codes.length >= 12, "the seed was parsed");
    for (const code of codes) {
      // Case-sensitive, whole word: "IE" the code, not "ie" inside a word.
      assert.deepEqual(offenders(new RegExp(`\\b${code}\\b`)), [], `country code ${code}`);
    }
  });

  test("no visa type id or visa code from the visa seed", () => {
    // Ids / codes with a hyphen or a digit are specific enough to search for;
    // one-word ids ("student") are ordinary words.
    const ids = seedValues(COUNTRY_SEED, ["id", "code"]).filter((v) => v.length >= 5 && /[-\d]/.test(v));
    assert.ok(ids.length >= 10, "the seed was parsed");
    for (const id of ids) {
      assert.deepEqual(offenders(new RegExp(`(^|[^a-z0-9-])${esc(id)}([^a-z0-9-]|$)`, "i")), [], `visa id / code "${id}"`);
    }
  });

  test("no guidance source id, jurisdiction, publisher host or title from the guidance seed", () => {
    const values = seedValues(GUIDANCE_SEED, ["id", "title", "jurisdiction"]).filter((v) => v.length >= 2 && !/^\w+$/.test(v) || /^[A-Z]{2}$/.test(v));
    const hosts = seedValues(GUIDANCE_SEED, ["url", "expectedFinalUrl"]).map((u) => {
      try {
        return new URL(u).host;
      } catch {
        return "";
      }
    }).filter(Boolean);
    for (const v of [...values, ...new Set(hosts)]) {
      assert.deepEqual(offenders(new RegExp(/^[A-Z]{2}$/.test(v) ? `\\b${v}\\b` : esc(v), /^[A-Z]{2}$/.test(v) ? "" : "i")), [], `guidance seed value "${v}"`);
    }
  });

  test("no URL of any publisher is written in the module", () => {
    // The only URLs allowed are none at all: sources are data in Firestore.
    assert.deepEqual(offenders(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i), []);
  });
});

describe("rubric module: stays inside the issue's boundaries", () => {
  test("extraction never writes a decided review state", () => {
    // In the extraction service the only review status ever written is the
    // literal "pending_review", and the polarity decision is the literal null.
    const service = sources.get(path.join("scrapers", "rubric", "rubric-extraction.service.ts")) as string;
    assert.match(service, /reviewStatus: "pending_review"/);
    assert.match(service, /intentPolarity: null/);
    // It may talk about approvedVersion in a comment; it never sets it.
    assert.equal(/approvedVersion\s*[:=]/.test(service), false, "the service sets approvedVersion");
    assert.equal(/reviewStatus:\s*"(approved|rejected)"/.test(service), false, "the service writes a decided status");
    // The store mentions approvedVersion only to READ it or to initialise it
    // to null for a new route.
    const store = sources.get(path.join("scrapers", "rubric", "rubric.store.ts")) as string;
    const writes = [...store.matchAll(/approvedVersion:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    assert.deepEqual(writes, ["null"]);
    assert.doesNotMatch(store, /reviewStatus:\s*"approved"/);
  });

  test("no model id literal and no sampling / forced-tool parameter in a request", () => {
    for (const [file, text] of sources) {
      assert.doesNotMatch(text, /["'`]claude-[a-z0-9-]+["'`]/, `${file} writes a model id`);
      // Property syntax only: the words appear in comments explaining why
      // they are absent.
      assert.doesNotMatch(text, /\b(temperature|top_p|top_k|tool_choice|tools)\s*:/, `${file} sets a banned request field`);
      assert.doesNotMatch(text, /\bstrict\s*:/, `${file} sets strict`);
    }
  });

  test("nothing is scheduled and no route serves a rubric", () => {
    const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
    const app = fs.readFileSync(path.join(SRC, "app.ts"), "utf8");
    assert.doesNotMatch(index, /rubric/i, "src/index.ts must not reference the rubric module");
    // Issue #125 added the ADMIN review API (routes/, controllers/, services/
    // rubric-review.* and services/rubric-diff.ts), mounted once under
    // /admin/rubrics. That is the only rubric route, and those four files
    // are the only ones outside the module that may import it.
    assert.deepEqual([...app.matchAll(/app\.use\("([^"]*)"[^)]*rubric[^)]*\)/gi)].map((m) => m[1]), ["/admin/rubrics"], "app.ts mounts only the admin rubric review route");
    const REVIEW_API_FILES = [path.join("services", "rubric-review.service.ts"), path.join("services", "rubric-diff.ts"), path.join("controllers", "rubric-review.controller.ts"), path.join("routes", "rubric-review.routes.ts")];
    // No other file outside the module and the scrapers barrel imports it.
    const outside = tsFiles(SRC).filter((f) => !MODULE_FILES.includes(f) && ![path.join("scrapers", "index.ts"), ...REVIEW_API_FILES].includes(path.relative(SRC, f)));
    const importers = outside.filter((f) => /from "[^"]*(scrapers\/rubric|\/rubric\/|types\/rubric)/.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(importers.map((f) => path.relative(SRC, f)), []);
    for (const [file, text] of sources) {
      assert.doesNotMatch(text, /functions\.(pubsub|https|firestore)|\.schedule\(|express\.Router|Router\(\)/, `${file} defines a trigger or a route`);
    }
  });

  test("the rubric collections have no client rules, and are listed as backend-only", () => {
    const rules = fs.readFileSync(path.join(SRC, "..", "..", "firestore.rules"), "utf8");
    // Mentioned in comments only: never in a `match` statement.
    for (const name of ["visaRubrics", "rubricVersions", "rubricExtractionRuns"]) {
      assert.ok(rules.includes(name), `${name} is documented in the backend-only block`);
      assert.doesNotMatch(rules, new RegExp(`^\\s*match\\s+[^\\n]*${name}`, "m"), `${name} has a match block`);
    }
  });

  test("the module never logs a prompt, an answer, or the provider / client", () => {
    for (const [file, text] of sources) {
      for (const m of text.matchAll(/console\.(log|warn|error)\(([^;]*);/g)) {
        assert.doesNotMatch(m[2], /\b(request|response|provider|client|content|snapshot|chunk)\b(?!\.(sourceId|chunkIndex))/, `${file} logs ${m[2].slice(0, 80)}`);
        assert.doesNotMatch(m[2], /\.(text|user|system|quote)\b/, `${file} logs text: ${m[2].slice(0, 80)}`);
      }
    }
  });
});
