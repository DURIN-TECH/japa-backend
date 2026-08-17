/**
 * Unit tests for the agency slug / vanity-domain rules.
 *
 * Uses Node's BUILT-IN test runner (`node:test` + `node:assert`) — the repo has
 * no test framework and the issue forbids new libraries, and the functions
 * runtime is already Node 22, which ships both modules.
 *
 * These run against the COMPILED output (`npm run build` → `lib/`), which is why
 * the npm script is `npm run build && node --test lib/__tests__/`. The module
 * under test is deliberately pure — no Firestore, no firebase-admin — so nothing
 * has to be stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DNS_LABEL_LENGTH,
  RESERVED_AGENCY_SLUGS,
  isValidDnsLabel,
  isReservedAgencySlug,
  isUsableAgencySlug,
  slugifyAgencyName,
  withSlugSuffix,
  buildAgencyPageUrl,
  resolveBookingCallbackUrl,
} from "../utils/agency-slug";

// ---------------------------------------------------------------------------
// isValidDnsLabel — RFC 1123 label shape
// ---------------------------------------------------------------------------

test("isValidDnsLabel accepts ordinary labels", () => {
  assert.equal(isValidDnsLabel("lagosvisas"), true);
  assert.equal(isValidDnsLabel("lagos-visas"), true);
  assert.equal(isValidDnsLabel("a"), true);
  assert.equal(isValidDnsLabel("9"), true);
  assert.equal(isValidDnsLabel("a1-b2-c3"), true);
});

test("isValidDnsLabel rejects empty, uppercase and illegal characters", () => {
  assert.equal(isValidDnsLabel(""), false);
  assert.equal(isValidDnsLabel("LagosVisas"), false);
  assert.equal(isValidDnsLabel("lagos_visas"), false);
  assert.equal(isValidDnsLabel("lagos visas"), false);
  assert.equal(isValidDnsLabel("lagos.visas"), false, "a dot is a second label");
  assert.equal(isValidDnsLabel("café"), false);
});

test("isValidDnsLabel rejects leading/trailing hyphens", () => {
  assert.equal(isValidDnsLabel("-lagos"), false);
  assert.equal(isValidDnsLabel("lagos-"), false);
  assert.equal(isValidDnsLabel("-"), false);
});

test("isValidDnsLabel enforces the 63-character maximum", () => {
  assert.equal(isValidDnsLabel("a".repeat(MAX_DNS_LABEL_LENGTH)), true);
  assert.equal(isValidDnsLabel("a".repeat(MAX_DNS_LABEL_LENGTH + 1)), false);
});

test("isValidDnsLabel rejects the punycode xn-- prefix", () => {
  assert.equal(isValidDnsLabel("xn--80ak6aa92e"), false);
  // Only the prefix is special — the letters themselves are fine elsewhere.
  assert.equal(isValidDnsLabel("axn--b"), true);
  assert.equal(isValidDnsLabel("xn-travels"), true);
});

// ---------------------------------------------------------------------------
// Reserved words
// ---------------------------------------------------------------------------

test("the reserved list contains every label the platform depends on", () => {
  // Exactly the minimum set the acceptance criteria name.
  const required = [
    "www", "portal", "api", "app", "admin", "auth", "login",
    "mail", "smtp", "imap", "webmail", "mx", "ns1", "ns2",
    "cdn", "static", "assets",
    "docs", "blog", "help", "support", "status",
    "dev", "staging", "test",
    "m", "mobile",
    "seli", "weareseli",
  ];
  for (const label of required) {
    assert.ok(
      RESERVED_AGENCY_SLUGS.includes(label),
      `"${label}" must be reserved`
    );
  }
});

test("isReservedAgencySlug is case-insensitive and precise", () => {
  assert.equal(isReservedAgencySlug("portal"), true);
  assert.equal(isReservedAgencySlug("PORTAL"), true);
  // Only the WHOLE label is reserved — a prefix match is not enough.
  assert.equal(isReservedAgencySlug("portal-immigration"), false);
  assert.equal(isReservedAgencySlug("lagosvisas"), false);
});

test("isUsableAgencySlug combines shape and reservation", () => {
  assert.equal(isUsableAgencySlug("lagosvisas"), true);
  assert.equal(isUsableAgencySlug("portal"), false, "reserved");
  assert.equal(isUsableAgencySlug("lagos-"), false, "trailing hyphen");
  assert.equal(isUsableAgencySlug("a".repeat(64)), false, "too long");
  assert.equal(isUsableAgencySlug(undefined), false);
  assert.equal(isUsableAgencySlug(""), false);
});

// ---------------------------------------------------------------------------
// slugifyAgencyName — the generator's base step
// ---------------------------------------------------------------------------

test("slugifyAgencyName produces DNS-safe slugs for ordinary names", () => {
  assert.equal(slugifyAgencyName("Lagos Visas"), "lagos-visas");
  assert.equal(slugifyAgencyName("WWW Travels"), "www-travels");
  assert.equal(slugifyAgencyName("Portal Immigration"), "portal-immigration");
  assert.equal(slugifyAgencyName("API Consulting"), "api-consulting");
  assert.equal(slugifyAgencyName("Café Migration"), "cafe-migration");
  assert.equal(slugifyAgencyName("  A & B  Travel!! "), "a-b-travel");
});

test("slugifyAgencyName falls back to 'agency' when nothing survives", () => {
  assert.equal(slugifyAgencyName("≈≈≈"), "agency");
  assert.equal(slugifyAgencyName("---"), "agency");
  assert.equal(slugifyAgencyName(""), "agency");
});

test("slugifyAgencyName truncates a 90-character name to a valid label", () => {
  // The acceptance-criteria scenario: create an agency with a 90-char name.
  const name = "Trans Atlantic Global Immigration And Relocation Advisory Services Group International";
  assert.ok(name.length >= 63);
  const slug = slugifyAgencyName(name);
  assert.ok(slug.length <= MAX_DNS_LABEL_LENGTH, `got ${slug.length} chars`);
  assert.equal(isValidDnsLabel(slug), true);
});

test("slugifyAgencyName never leaves a hyphen exposed by truncation", () => {
  // 62 chars, then a space → naive slicing would end on "-".
  const name = `${"a".repeat(62)} bravo`;
  const slug = slugifyAgencyName(name);
  assert.equal(slug.endsWith("-"), false);
  assert.equal(isValidDnsLabel(slug), true);
});

test("slugifyAgencyName defuses a literal xn-- prefix", () => {
  // Hyphen runs collapse, so this normally can't happen — assert the guard anyway.
  assert.equal(isValidDnsLabel(slugifyAgencyName("xn-- Travels")), true);
  assert.equal(slugifyAgencyName("xn-- Travels").startsWith("xn--"), false);
});

test("slugifyAgencyName output is always a valid DNS label", () => {
  const names = [
    "Lagos Visas", "≈≈≈", "A".repeat(200), "Ünïcödé Rëïsen", "123",
    "-leading", "trailing-", "xn--fiqs8s", "a  b   c", "🚀 Rocket Travel",
  ];
  for (const n of names) {
    assert.equal(isValidDnsLabel(slugifyAgencyName(n)), true, `failed for "${n}"`);
  }
});

// ---------------------------------------------------------------------------
// withSlugSuffix — the collision/reserved discriminator
// ---------------------------------------------------------------------------

test("withSlugSuffix appends without exceeding the label limit", () => {
  assert.equal(withSlugSuffix("lagos-visas", "-2"), "lagos-visas-2");

  const long = "a".repeat(MAX_DNS_LABEL_LENGTH);
  const suffixed = withSlugSuffix(long, "-2");
  assert.equal(suffixed.length, MAX_DNS_LABEL_LENGTH);
  assert.equal(isValidDnsLabel(suffixed), true);
});

test("withSlugSuffix never produces a doubled hyphen at the cut point", () => {
  // Truncation lands exactly on a hyphen → it must be stripped, not doubled.
  const base = `${"a".repeat(60)}-bbbb`;
  const suffixed = withSlugSuffix(base, "-2");
  assert.equal(suffixed.includes("--"), false);
  assert.equal(isValidDnsLabel(suffixed), true);
});

test("withSlugSuffix namespaces a reserved base into a valid slug", () => {
  const result = withSlugSuffix("portal", "-agency");
  assert.equal(result, "portal-agency");
  assert.equal(isUsableAgencySlug(result), true);
});

// ---------------------------------------------------------------------------
// buildAgencyPageUrl — unset-safe URL construction
// ---------------------------------------------------------------------------

test("buildAgencyPageUrl uses the vanity host when a base domain is configured", () => {
  assert.equal(
    buildAgencyPageUrl("lagosvisas", "weareseli.com", "https://portal.weareseli.com"),
    "https://lagosvisas.weareseli.com"
  );
});

test("buildAgencyPageUrl falls back to the path URL when unset", () => {
  assert.equal(
    buildAgencyPageUrl("lagosvisas", undefined, "http://localhost:3000"),
    "http://localhost:3000/a/lagosvisas"
  );
  assert.equal(
    buildAgencyPageUrl("lagosvisas", "", "http://localhost:3000/"),
    "http://localhost:3000/a/lagosvisas",
    "a trailing slash on the origin must not double up"
  );
});

test("buildAgencyPageUrl refuses to build a vanity host from an unusable slug", () => {
  // A legacy slug that hasn't been migrated yet must not be advertised as DNS.
  assert.equal(
    buildAgencyPageUrl("a".repeat(70), "weareseli.com", "https://portal.weareseli.com"),
    `https://portal.weareseli.com/a/${"a".repeat(70)}`
  );
});

// ---------------------------------------------------------------------------
// resolveBookingCallbackUrl — Paystack must return to the SAME host
// ---------------------------------------------------------------------------

const DOMAIN = "weareseli.com";
const PORTAL = "https://portal.weareseli.com";

test("a booking from the vanity host returns to the vanity host", () => {
  assert.equal(
    resolveBookingCallbackUrl("lagosvisas", "https://lagosvisas.weareseli.com", DOMAIN, PORTAL),
    "https://lagosvisas.weareseli.com/confirm"
  );
});

test("a booking from the portal host returns to the portal path", () => {
  assert.equal(
    resolveBookingCallbackUrl("lagosvisas", PORTAL, DOMAIN, PORTAL),
    "https://portal.weareseli.com/a/lagosvisas/confirm"
  );
});

test("an unrecognised origin is ignored (no open redirect)", () => {
  for (const evil of [
    "https://evil.example.com",
    "https://lagosvisas.weareseli.com.evil.example",
    "javascript:alert(1)",
    "",
    undefined,
  ]) {
    assert.equal(
      resolveBookingCallbackUrl("lagosvisas", evil, DOMAIN, PORTAL),
      "https://lagosvisas.weareseli.com/confirm",
      `origin "${String(evil)}" must not be honoured`
    );
  }
});

test("another agency's vanity host is not accepted as this booking's origin", () => {
  assert.equal(
    resolveBookingCallbackUrl("lagosvisas", "https://otheragency.weareseli.com", DOMAIN, PORTAL),
    "https://lagosvisas.weareseli.com/confirm"
  );
});

test("with no base domain configured the callback keeps today's path form", () => {
  assert.equal(
    resolveBookingCallbackUrl("lagosvisas", "http://localhost:3000", undefined, PORTAL),
    "https://portal.weareseli.com/a/lagosvisas/confirm"
  );
  assert.equal(
    resolveBookingCallbackUrl("lagosvisas", PORTAL, undefined, PORTAL),
    "https://portal.weareseli.com/a/lagosvisas/confirm"
  );
});

test("a trailing slash on the claimed origin still matches the allowlist", () => {
  assert.equal(
    resolveBookingCallbackUrl("lagosvisas", "https://lagosvisas.weareseli.com/", DOMAIN, PORTAL),
    "https://lagosvisas.weareseli.com/confirm"
  );
});
