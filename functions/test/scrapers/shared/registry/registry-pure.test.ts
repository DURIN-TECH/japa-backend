// ============================================
// Source registry: pure helpers and genericness (issue #215)
// ============================================

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROLES } from "@durin-tech/authz";
import { lookupRegionName, parseRegistryHost, parseRegistryUrl } from "../../../../src/scrapers/shared/registry/registry-address";
import { DEFAULT_REGISTRY_SETTINGS, resolveRegistrySettings } from "../../../../src/scrapers/shared/registry/registry-settings";
import { leastLoadedWeekday, parseRegisterRouteBody } from "../../../../src/scrapers/shared/registry/route-registration.service";

describe("parseRegistryUrl / parseRegistryHost", () => {
  test("a plain https address passes and is normalised; query strings are kept", () => {
    const r = parseRegistryUrl("  https://WWW.Example.org/a/b?x=1 ");
    assert.ok(r.ok);
    assert.equal(r.host, "www.example.org");
    assert.equal(r.url.href, "https://www.example.org/a/b?x=1");
  });
  test("punycode hosts are fine", () => {
    assert.ok(parseRegistryUrl("https://xn--bcher-kva.example.org/").ok);
  });
  test("hosts: lowercased, exact, wildcard and ip refused", () => {
    assert.deepEqual(parseRegistryHost("WWW.Example.ORG"), { ok: true, host: "www.example.org" });
    for (const h of ["*.example.org", "1.2.3.4", "::1", "a", "a..b", "-a.example.org", "a-.example.org", "a b.example.org", ""]) {
      assert.equal(parseRegistryHost(h).ok, false, h);
    }
  });
});

describe("lookupRegionName", () => {
  test("names come from the platform's region data; unknown and malformed codes are undefined", () => {
    assert.deepEqual(lookupRegionName("sv"), { code: "SV", name: "El Salvador" });
    for (const c of ["ZZ", "XX", "S", "SVX", "1A", "", undefined, 5, null]) assert.equal(lookupRegionName(c), undefined, String(c));
  });
});

describe("leastLoadedWeekday", () => {
  test("the emptiest weekday; ties go to the earliest", () => {
    assert.equal(leastLoadedWeekday([0, 0, 0, 0, 0, 0, 0]), 1);
    assert.equal(leastLoadedWeekday([2, 1, 1, 3, 1, 4, 4]), 2);
    assert.equal(leastLoadedWeekday([1, 1, 1, 1, 1, 1, 0]), 7);
  });
});

describe("registry settings", () => {
  test("defaults, ranges and fail-safe fallbacks", () => {
    assert.deepEqual(resolveRegistrySettings(undefined).settings, DEFAULT_REGISTRY_SETTINGS);
    assert.deepEqual(DEFAULT_REGISTRY_SETTINGS.supportedLanguages, ["en"]);
    const r = resolveRegistrySettings({ supportedLanguages: [], previewsPerHour: 0, registrationsPerHour: "x", previewMaxAgeMinutes: 5, extra: 1 });
    assert.deepEqual(r.settings.supportedLanguages, ["en"]);
    assert.equal(r.settings.previewsPerHour, 20);
    assert.equal(r.settings.registrationsPerHour, 30);
    assert.equal(r.settings.previewMaxAgeMinutes, 5);
    assert.equal(r.problems.length, 3);
    assert.deepEqual(resolveRegistrySettings({ supportedLanguages: ["en", "es", "pt-br"] }).settings.supportedLanguages, ["en", "es", "pt-br"]);
    assert.deepEqual(resolveRegistrySettings({ supportedLanguages: ["EN!"] }).settings.supportedLanguages, ["en"]);
  });
});

describe("parseRegisterRouteBody", () => {
  const good = () => ({
    countryCode: "sv",
    routeName: "Visit",
    visaPage: { url: "https://a.example.org/v", language: "EN" },
    guidance: [{ url: "https://a.example.org/g", title: "Rules", role: "primary", docType: "html", language: "en" }],
    crawlTimeZone: "Etc/UTC",
  });
  test("normalises country code and language", () => {
    const b = parseRegisterRouteBody(good());
    assert.equal(b.countryCode, "SV");
    assert.equal(b.visaPage.language, "en");
  });
  test("rejects a bad time zone and a bad check interval", () => {
    assert.throws(() => parseRegisterRouteBody({ ...good(), crawlTimeZone: "Nowhere/Land" }), /time zone/);
    const g = good();
    (g.guidance[0] as any).checkIntervalHours = 0.5;
    assert.throws(() => parseRegisterRouteBody(g), /whole number/);
  });
});

// ============================================
// Genericness: nothing in the new code names a country, publisher or route
// ============================================

describe("the registry code is generic", () => {
  const SRC = path.join(__dirname, "..", "..", "..", "..", "src");
  const REG = path.join(SRC, "scrapers", "shared", "registry");
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
  const files = walk(REG);
  const text = new Map(files.map((f) => [path.relative(SRC, f), fs.readFileSync(f, "utf8")]));
  const offenders = (re: RegExp) => [...text].filter(([, t]) => re.test(t)).map(([f]) => f);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Every `key: "value"` of a data file. */
  const values = (file: string, keys: string[]) => {
    const t = fs.readFileSync(path.join(SRC, file), "utf8");
    return [...new Set(keys.flatMap((k) => [...t.matchAll(new RegExp(`\\b${k}:\\s*"([^"]+)"`, "g"))].map((m) => m[1])))];
  };

  test("no country name, code or visa id from the seed data", () => {
    const names = values(path.join("data", "seed-countries-visas.ts"), ["name"]).filter((n) => /^[A-Z][A-Za-z .'-]+$/.test(n));
    assert.ok(names.length >= 12);
    for (const n of names) assert.deepEqual(offenders(new RegExp(`\\b${esc(n)}\\b`, "i")), [], n);
    const codes = values(path.join("data", "seed-countries-visas.ts"), ["code", "countryCode"]).filter((c) => /^[A-Z]{2}$/.test(c));
    for (const c of codes) assert.deepEqual(offenders(new RegExp(`\\b${c}\\b`)), [], c);
    const md = fs.readFileSync(path.join(SRC, "scrapers", "visa-catalog", "data", "official_visa_links_verified_v3.md"), "utf8");
    for (const m of md.matchAll(/^##\s+\d+\.\s+(.+?)\s*$/gm)) assert.deepEqual(offenders(new RegExp(`\\b${esc(m[1])}\\b`, "i")), [], m[1]);
  });

  test("no publisher host or guidance title, and no URL in the code", () => {
    for (const v of values(path.join("scrapers", "guidance", "data", "seed-guidance-sources.ts"), ["id", "title"]).filter((x) => x.length >= 5 && !/^\w+$/.test(x))) {
      assert.deepEqual(offenders(new RegExp(esc(v), "i")), [], v);
    }
    const hosts = Object.values((fs.readFileSync(path.join(SRC, "scrapers", "visa-catalog", "visa-catalog-official-hosts.ts"), "utf8").match(/"[a-z*.]+\.[a-z.]+"/g) ?? []));
    for (const h of hosts) assert.deepEqual(offenders(new RegExp(esc(h.replace(/"/g, "")), "i")), [], h);
    // (The reserved documentation host example.org may appear in an admin-facing example.)
    assert.deepEqual(offenders(/https?:\/\/(?![a-z0-9.-]*example\.org)[a-z0-9.-]+\.[a-z]{2,}/i), []);
  });

  test("no role is written as a string literal (the constants are used)", () => {
    for (const role of Object.values(ROLES)) assert.deepEqual(offenders(new RegExp(`["'\`]${role}["'\`]`)), [], role);
  });

  test("no model call", () => {
    assert.deepEqual(offenders(/llm-provider|anthropic|LlmProvider/i), []);
  });
});
