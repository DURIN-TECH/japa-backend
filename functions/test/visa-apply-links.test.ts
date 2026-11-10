// ============================================
// Unit tests — official apply links (issue DURIN-TECH/japa#74)
// ============================================
//
// Run with `npm test`. No network, no Firestore.
//
// Covers:
//  - host pattern matching (exact / strict subdomain, no suffix tricks)
//  - the validator keeping `applicationUrl` only on official hosts
//  - htmlFragmentToText link rendering (opt-in; default output unchanged)
//  - the GOV.UK adapter printing apply-service links as `text (url)` on the
//    recorded golden fixtures, and nothing else
//  - the generic-html adapter (text + hash) NOT changing for a page that
//    carries the same apply-service links (#58 guarantee)
//  - the registry seed writing `officialHosts`

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";

import {
  VISA_SOURCE_OFFICIAL_HOSTS,
  hostMatchesPattern,
  isOfficialHost,
  officialHostsFor,
  officialHttpsUrl,
  resolveOfficialHosts,
} from "../src/services/visa-catalog-official-hosts";
import {
  sanitizeApplicationUrl,
  validateExtractedVisa,
} from "../src/services/visa-catalog-extract.service";
import {
  VisaCatalogFetchService,
  htmlFragmentToText,
  type VisaCatalogHttpClient,
} from "../src/services/visa-catalog-fetch.service";
import {
  GenericHtmlAdapter,
  GovukContentApiAdapter,
  govukApplyLinkUrl,
} from "../src/services/visa-source-adapters";
import { VISA_SOURCE_OVERRIDES, buildSeededVisaSource } from "../src/data/seed-visa-sources";
import { EVAL_ROUTES, GOLDEN_DIR } from "../eval/config";
import { fixtureFetchService, loadExpected, loadGuide } from "../eval/golden";
import type { VisaSourcePage } from "../src/types/visa-catalog";

/** GB patterns, as registered. */
const GB = officialHostsFor("GB");

/** sha256 hex, independently of the service. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ----- Host matching -----

describe("official host matching", () => {
  test("GB registry has the guidance site and both apply-service families", () => {
    assert.deepEqual([...VISA_SOURCE_OFFICIAL_HOSTS.GB], [
      "www.gov.uk",
      "*.service.gov.uk",
      "*.homeoffice.gov.uk",
    ]);
    assert.deepEqual([...officialHostsFor("gb")], [...GB]); // case-insensitive code
    assert.deepEqual([...officialHostsFor("CA")], []); // unregistered → none
    assert.deepEqual([...officialHostsFor(undefined)], []);
  });

  test("exact and strict-subdomain matches pass", () => {
    for (const host of [
      "www.gov.uk",
      "WWW.GOV.UK",
      "www.gov.uk.", // trailing dot (FQDN) normalised
      "visas-immigration.service.gov.uk",
      "apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk",
      "a.b.service.gov.uk",
    ]) {
      assert.equal(isOfficialHost(host, GB), true, host);
    }
  });

  test("suffix tricks, apexes and look-alikes fail", () => {
    for (const host of [
      "evilservice.gov.uk", // no label boundary
      "service.gov.uk", // bare apex of a wildcard
      "homeoffice.gov.uk",
      "gov.uk", // only www.gov.uk is listed exactly
      "x.service.gov.uk.attacker.com",
      "evilservice.gov.uk.attacker.com",
      "www.gov.uk.attacker.com",
      "wwwgov.uk",
      "notwww.gov.uk",
      "",
    ]) {
      assert.equal(isOfficialHost(host, GB), false, host);
    }
  });

  test("malformed patterns never match (a typo can't allow every host)", () => {
    assert.equal(hostMatchesPattern("evil.com", "*"), false);
    assert.equal(hostMatchesPattern("evil.com", "*."), false);
    // A wildcard over a single-label apex (a whole TLD: "*.com", "*.uk") is refused.
    assert.equal(hostMatchesPattern("evil.com", "*.com"), false);
    assert.equal(hostMatchesPattern("a.uk", "*.uk"), false);
    // Wildcards only as a leading "*." label.
    assert.equal(hostMatchesPattern("evil.com", "*com"), false);
    assert.equal(hostMatchesPattern("x.service.gov.uk", "x.*.gov.uk"), false);
    assert.equal(hostMatchesPattern("x.y.gov.uk", "*.*.gov.uk"), false);
    assert.equal(hostMatchesPattern("evil.com", ""), false);
  });

  test("officialHttpsUrl: https only, parsed hostname, no credentials", () => {
    assert.ok(officialHttpsUrl("https://visas-immigration.service.gov.uk/apply-visa-type/visit", GB));
    assert.equal(officialHttpsUrl("http://visas-immigration.service.gov.uk/x", GB), undefined);
    assert.equal(officialHttpsUrl("javascript:alert(1)", GB), undefined);
    assert.equal(officialHttpsUrl("not a url", GB), undefined);
    // Userinfo trick: the real host is evil.com.
    assert.equal(officialHttpsUrl("https://www.gov.uk@evil.com/apply", GB), undefined);
    // Credentials on an official host are rejected too.
    assert.equal(officialHttpsUrl("https://u:p@www.gov.uk/apply", GB), undefined);
    assert.equal(officialHttpsUrl("https://x.service.gov.uk.attacker.com/apply", GB), undefined);
  });
});

describe("review fixes (round 1)", () => {
  test("(a) any explicit non-default port is rejected; :443 normalises away", () => {
    assert.equal(officialHttpsUrl("https://visas-immigration.service.gov.uk:8443/x", GB), undefined);
    assert.equal(officialHttpsUrl("https://www.gov.uk:80/x", GB), undefined);
    assert.ok(officialHttpsUrl("https://www.gov.uk:443/x", GB)); // default port → "" after parse
    assert.equal(govukApplyLinkUrl("https://visas-immigration.service.gov.uk:8443/x"), undefined);
    assert.equal(
      validateExtractedVisa(rawVisa("https://visas-immigration.service.gov.uk:8443/x"), { officialHosts: GB })
        .applicationUrl,
      undefined
    );
  });

  test("(b) stored officialHosts used only when a non-empty string array, else the code map", () => {
    assert.deepEqual([...resolveOfficialHosts(["*.example.gov"], "GB")], ["*.example.gov"]);
    for (const bad of [undefined, null, [], "www.gov.uk", [""], ["www.gov.uk", 3], [" "], {}]) {
      assert.deepEqual([...resolveOfficialHosts(bad, "GB")], [...GB], JSON.stringify(bad));
    }
    assert.deepEqual([...resolveOfficialHosts(undefined, "CA")], []);
  });

  test("(c) anchor text equal to the URL (raw or normalised, +/- trailing slash) is not doubled", () => {
    const opts = { baseUrl: "https://www.gov.uk", renderLinkUrl: govukApplyLinkUrl };
    // href without path → normalised URL gains a "/"; text is the raw href.
    assert.equal(
      htmlFragmentToText("<p><a href=\"https://visas-immigration.service.gov.uk\">https://visas-immigration.service.gov.uk</a></p>", opts),
      "https://visas-immigration.service.gov.uk"
    );
    // text has a trailing slash, href doesn't.
    assert.equal(
      htmlFragmentToText("<p><a href=\"https://x.service.gov.uk/apply\">https://x.service.gov.uk/apply/</a></p>", opts),
      "https://x.service.gov.uk/apply/"
    );
    // text is the normalised form of an upper-case-host href.
    assert.equal(
      htmlFragmentToText("<p><a href=\"https://X.SERVICE.GOV.UK/apply\">https://x.service.gov.uk/apply</a></p>", opts),
      "https://x.service.gov.uk/apply"
    );
  });

  test("(d) the validator stores the normalised URL, not the raw string", () => {
    assert.equal(
      validateExtractedVisa(rawVisa("https://VISAS-IMMIGRATION.service.gov.uk/a/../apply-visa-type/visit"), {
        officialHosts: GB,
      }).applicationUrl,
      "https://visas-immigration.service.gov.uk/apply-visa-type/visit"
    );
    assert.equal(sanitizeApplicationUrl("https://www.gov.uk", GB), "https://www.gov.uk/");
    assert.equal(sanitizeApplicationUrl("https://ircc.canada.ca", undefined), "https://ircc.canada.ca/");
  });
});

describe("link rendering: query-string entities stay literal (blocking review fix)", () => {
  const opts = { baseUrl: "https://www.gov.uk", renderLinkUrl: govukApplyLinkUrl };
  for (const [label, hrefAttr, expectedUrl] of [
    ["&amp; in the attribute", "https://x.service.gov.uk/apply?a=1&amp;b=2", "https://x.service.gov.uk/apply?a=1&b=2"],
    ["raw &param=", "https://x.service.gov.uk/apply?a=1&param=2", "https://x.service.gov.uk/apply?a=1&param=2"],
    ["raw &copy=", "https://x.service.gov.uk/apply?a=1&copy=2", "https://x.service.gov.uk/apply?a=1&copy=2"],
    ["&amp;copy= in the attribute", "https://x.service.gov.uk/apply?a=1&amp;copy=2", "https://x.service.gov.uk/apply?a=1&copy=2"],
  ] as const) {
    test(label, () => {
      const text = htmlFragmentToText(`<p><a href="${hrefAttr}">Apply</a></p>`, opts);
      assert.equal(text, `Apply (${expectedUrl})`);
      assert.equal(text.includes("¶"), false);
      assert.equal(text.includes("©"), false);
    });
  }
});

// ----- Validator -----

/** A minimal valid raw LLM payload (no fee), plus `applicationUrl`. */
function rawVisa(applicationUrl: unknown): Record<string, unknown> {
  return {
    name: "Standard Visitor visa",
    code: "SVV",
    description: "Visit the UK.",
    category: "tourist",
    processingTime: "3 weeks",
    processingDaysMin: 0,
    processingDaysMax: 21,
    validityPeriod: "6 months",
    isExtendable: false,
    eligibilityCriteria: ["Leave at the end of your visit"],
    confidence: 0.9,
    feeComponents: [],
    citations: {},
    applicationUrl,
  };
}

describe("validateExtractedVisa — applicationUrl official-host gate", () => {
  test("keeps an apply-service URL on an official host", () => {
    const url = "https://apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/sort/start/skilled_worker_out_uk";
    assert.equal(validateExtractedVisa(rawVisa(url), { officialHosts: GB }).applicationUrl, url);
    // The guidance site is official too (exact host).
    assert.equal(
      validateExtractedVisa(rawVisa("https://www.gov.uk/standard-visitor"), { officialHosts: GB }).applicationUrl,
      "https://www.gov.uk/standard-visitor"
    );
  });

  test("drops off-registry / tricked URLs but keeps the rest of the extraction", () => {
    for (const bad of [
      "https://evilservice.gov.uk.attacker.com/apply",
      "https://visas-immigration.service.gov.uk.attacker.com/apply",
      "https://www.gov.uk@evil.com/apply",
      "https://uk-visa-agent.example.com/apply",
      "http://visas-immigration.service.gov.uk/apply-visa-type/visit", // not https
      "javascript:alert(1)",
      "",
    ]) {
      const v = validateExtractedVisa(rawVisa(bad), { officialHosts: GB });
      assert.equal(v.applicationUrl, undefined, bad);
      assert.equal(v.name, "Standard Visitor visa"); // soft failure: visa kept
    }
  });

  test("no host list (unregistered country): http(s) kept as before, other schemes dropped", () => {
    assert.equal(
      validateExtractedVisa(rawVisa("https://ircc.canada.ca/apply")).applicationUrl,
      "https://ircc.canada.ca/apply"
    );
    assert.equal(sanitizeApplicationUrl("javascript:alert(1)", undefined), undefined);
    assert.equal(sanitizeApplicationUrl("data:text/html,x", []), undefined);
    assert.equal(sanitizeApplicationUrl(42, GB), undefined);
    assert.equal(sanitizeApplicationUrl("  https://www.gov.uk/x  ", GB), "https://www.gov.uk/x"); // trimmed
  });
});

// ----- htmlFragmentToText link rendering -----

const FRAGMENT = [
  "<p>You must <a href=\"https://visas-immigration.service.gov.uk/apply-visa-type/visit\">apply online</a>.</p>",
  "<p>Read <a href=\"/standard-visitor/visit-on-business\">the business rules</a> and",
  " <a href=\"https://qls.ecctis.com/\">Ecctis</a>.</p>",
].join("");

describe("htmlFragmentToText link rendering", () => {
  test("default (no options) output is unchanged: links are plain text", () => {
    assert.equal(
      htmlFragmentToText(FRAGMENT),
      "You must apply online.\nRead the business rules and Ecctis."
    );
  });

  test("with the GOV.UK filter only the apply-service link gets its URL", () => {
    const text = htmlFragmentToText(FRAGMENT, { baseUrl: "https://www.gov.uk", renderLinkUrl: govukApplyLinkUrl });
    assert.equal(
      text,
      "You must apply online (https://visas-immigration.service.gov.uk/apply-visa-type/visit).\n" +
        "Read the business rules and Ecctis."
    );
  });

  test("govukApplyLinkUrl: apply services only (no www.gov.uk, relative, http, third-party)", () => {
    assert.equal(
      govukApplyLinkUrl("https://apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/sort/start/x"),
      "https://apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/sort/start/x"
    );
    assert.equal(govukApplyLinkUrl("https://www.gov.uk/skilled-worker-visa"), undefined);
    assert.equal(govukApplyLinkUrl("http://visas-immigration.service.gov.uk/x"), undefined);
    assert.equal(govukApplyLinkUrl("https://qls.ecctis.com/"), undefined);
    assert.equal(govukApplyLinkUrl("https://x.service.gov.uk.attacker.com/"), undefined);
  });

  test("relative hrefs resolve against the base (and an anchor whose text is the URL isn't doubled)", () => {
    const seen: string[] = [];
    htmlFragmentToText("<a href=\"/apply\">a</a><a href=\"next\">b</a>", {
      baseUrl: "https://www.gov.uk",
      renderLinkUrl: (u) => {
        seen.push(u);
        return undefined;
      },
    });
    assert.deepEqual(seen, ["https://www.gov.uk/apply", "https://www.gov.uk/next"]);
    const url = "https://visas-immigration.service.gov.uk/x";
    assert.equal(
      htmlFragmentToText(`<p><a href="${url}">${url}</a></p>`, { renderLinkUrl: govukApplyLinkUrl }),
      url
    );
  });
});

// ----- GOV.UK adapter on the golden fixtures -----

/** The registry page for an eval route (with its section overrides). */
function routePage(url: string, routeName: string): VisaSourcePage {
  return { url, routeName, validation: "text_verified", ...(VISA_SOURCE_OVERRIDES[url] ?? {}) };
}

describe("govuk-content-api adapter: apply-service links", () => {
  for (const route of EVAL_ROUTES) {
    test(`${route.route}: the expected apply host appears as a rendered URL; only apply hosts are printed`, async () => {
      const guide = loadGuide(route.route, GOLDEN_DIR);
      const expected = loadExpected(route.route, GOLDEN_DIR);
      const doc = await new GovukContentApiAdapter(fixtureFetchService(route.url, guide)).fetch(
        routePage(route.url, route.routeName)
      );
      // The golden apply URL (the raw href quoted in expected.json) is in the text.
      assert.ok(
        doc.text.includes(`(${expected.applicationUrlHost.source})`),
        `missing (${expected.applicationUrlHost.source})`
      );
      // Every printed `(https://…)` is an apply service — never www.gov.uk or a third party.
      const printed = [...doc.text.matchAll(/\((https:\/\/[^)\s]+)\)/g)].map((m) => new URL(m[1]).hostname);
      assert.ok(printed.length > 0);
      for (const host of printed) {
        assert.ok(host !== "www.gov.uk" && isOfficialHost(host, GB), host);
      }
    });
  }
});

// ----- generic-html: unchanged (#58 guarantee) -----

/** Stub HTTP client serving fixed responses (404 when absent). */
function stubService(routes: Record<string, string>): VisaCatalogFetchService {
  const http: VisaCatalogHttpClient = {
    async get(url) {
      const body = routes[url];
      return body === undefined
        ? { status: 404, data: "", headers: {} }
        : { status: 200, data: body, headers: { "content-type": "text/html" } };
    },
  };
  return new VisaCatalogFetchService({ http, minIntervalMs: 0 });
}

// A non-GB page whose content carries the SAME kind of apply-service links the
// GOV.UK adapter now renders. generic-html must keep reading them as text only.
const GENERIC_HTML = `<!doctype html><html><body><main><h1>Visit visa</h1>
<p>You must <a href="https://visas-immigration.service.gov.uk/apply-visa-type/visit">apply online</a>
before you travel. <a href="https://apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/sort/start/x">Start now</a>.</p>
<p>${"Details about who can apply and what you need. ".repeat(8)}</p></main></body></html>`;

// The cleaned text BEFORE #74, written out literally — if generic-html ever
// started printing hrefs, this (and the pinned hash) would change.
const GENERIC_TEXT_BEFORE_74 =
  "Visit visa\n\nYou must apply online\nbefore you travel. Start now.\n\n" +
  "Details about who can apply and what you need. ".repeat(8).trim();

describe("generic-html adapter: output + hash unchanged by #74", () => {
  test("apply-service links stay plain text; hash is sha256 of the pre-#74 text", async () => {
    const url = "https://immi.example.gov/visit";
    const doc = await new GenericHtmlAdapter(
      stubService({ [url]: GENERIC_HTML, "https://immi.example.gov/robots.txt": "" })
    ).fetch({ url, routeName: "Visit", validation: "text_verified" });
    assert.equal(doc.text, GENERIC_TEXT_BEFORE_74);
    assert.equal(doc.text.includes("https://"), false);
    assert.equal(doc.contentHash, sha256(GENERIC_TEXT_BEFORE_74));
  });
});

// ----- Registry seed -----

describe("buildSeededVisaSource: officialHosts", () => {
  const now = Timestamp.fromMillis(1_800_000_000_000);

  test("GB gets the registry officialHosts; an unregistered country gets no field", () => {
    const gb = buildSeededVisaSource({
      country: { countryCode: "GB", countryName: "United Kingdom", pages: [] },
      existing: undefined,
      now,
    });
    assert.deepEqual(gb.doc.officialHosts, [...GB]);
    const ca = buildSeededVisaSource({
      country: { countryCode: "CA", countryName: "Canada", pages: [] },
      existing: { officialHosts: ["stale.example"] },
      now,
    });
    assert.equal("officialHosts" in ca.doc, false);
  });
});
