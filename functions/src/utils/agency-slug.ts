/**
 * Agency slug rules — the single source of truth for what a public agency slug
 * may look like.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An agency's `slug` is no longer just a path segment (`/a/<slug>`); it is also
 * a DNS label, because every approved agency is served on its own vanity
 * subdomain (`https://<slug>.weareseli.com`). That promotes the slug from
 * "URL-safe string" to "must survive DNS + TLS + wildcard routing", which adds
 * hard constraints the original `slugifyName()` did not enforce:
 *
 *   • 63 characters or fewer          — RFC 1035 max label length
 *   • only `a-z`, `0-9` and `-`       — RFC 1123 preferred label syntax
 *   • never starts or ends with `-`   — RFC 1123
 *   • never starts with `xn--`        — that prefix is reserved for punycode
 *                                       (IDNA); a literal `xn--` label makes
 *                                       browsers and CAs try to decode it
 *   • never a reserved infrastructure label (see RESERVED_AGENCY_SLUGS) — an
 *     agency called "Portal" must not be able to claim `portal.weareseli.com`
 *     and hijack the actual portal host.
 *
 * Everything here is PURE (no Firestore, no firebase-admin) so it can be unit
 * tested in isolation and mirrored on the portal side (see
 * `japa-portal/src/lib/agency-domain.ts`, which keeps a copy of the reserved
 * list so edge middleware can refuse to treat `portal.` as a tenant host).
 */

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/** RFC 1035 maximum length of a single DNS label. */
export const MAX_DNS_LABEL_LENGTH = 63;

/**
 * Labels that must never be handed to an agency, because the platform (or the
 * internet at large) already means something specific by them. Split into
 * commented groups so it is obvious why each entry is here and so future
 * additions land in the right bucket.
 *
 * NOTE: this list is duplicated in `japa-portal/src/lib/agency-domain.ts`.
 * There is no shared package between the backend and the portal for plain
 * constants (`@durin-tech/authz` is scoped to RBAC), so the portal keeps a
 * mirror. Keep the two in sync — a label missing from the portal copy would be
 * routed as a tenant host; a label missing here could be handed out as a slug.
 */
export const RESERVED_AGENCY_SLUGS: readonly string[] = [
  // --- Platform hosts we already serve, or intend to -----------------------
  "www",
  "portal",
  "api",
  "app",
  "admin",
  "auth",
  "login",
  // --- Mail / DNS infrastructure -------------------------------------------
  "mail",
  "smtp",
  "imap",
  "webmail",
  "mx",
  "ns1",
  "ns2",
  // --- Static / content delivery -------------------------------------------
  "cdn",
  "static",
  "assets",
  // --- Marketing + support surfaces ----------------------------------------
  "docs",
  "blog",
  "help",
  "support",
  "status",
  // --- Environments ---------------------------------------------------------
  "dev",
  "staging",
  "test",
  // --- Mobile ---------------------------------------------------------------
  "m",
  "mobile",
  // --- Brand ----------------------------------------------------------------
  "seli",
  "weareseli",
];

/** Fast lookup for `isReservedAgencySlug`. */
const RESERVED_SET = new Set(RESERVED_AGENCY_SLUGS);

/**
 * Strict DNS-label shape check (RFC 1123, lowercase-only variant).
 * Length is checked first so a pathological 10k-character input short-circuits
 * before the regex runs.
 */
export function isValidDnsLabel(label: string): boolean {
  if (!label) return false;
  if (label.length > MAX_DNS_LABEL_LENGTH) return false;
  // `xn--` is the IDNA "A-label" prefix — reserved, never valid for us.
  if (label.startsWith("xn--")) return false;
  // Single alphanumeric, or alphanumeric-bounded with hyphens in the middle.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label);
}

/** True when the label is on the platform's reserved list. */
export function isReservedAgencySlug(slug: string): boolean {
  return RESERVED_SET.has(slug.toLowerCase());
}

/**
 * The one check callers should use: is this slug safe to serve as
 * `<slug>.weareseli.com`? Combines shape + reservation.
 */
export function isUsableAgencySlug(slug: string | undefined | null): boolean {
  if (!slug) return false;
  return isValidDnsLabel(slug) && !isReservedAgencySlug(slug);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Trim a base slug so that `base + suffix` still fits inside a DNS label, and
 * so the join never produces a leading/trailing/doubled hyphen.
 *
 * Used by the uniqueness loop: a 63-character base plus `-2` would otherwise
 * produce a 65-character (invalid) label, and naively slicing a base that ends
 * mid-hyphen would produce `foo--2`.
 *
 * @param base   already-slugified base (assumed lowercase, DNS-safe characters)
 * @param suffix the discriminator to append, INCLUDING its leading hyphen (`-2`)
 */
export function withSlugSuffix(base: string, suffix: string): string {
  const room = MAX_DNS_LABEL_LENGTH - suffix.length;
  // Truncate, then strip any hyphen left dangling at the cut point so the
  // suffix's own hyphen isn't doubled.
  const trimmed = base.slice(0, Math.max(1, room)).replace(/-+$/, "");
  return `${trimmed || "agency"}${suffix}`;
}

/**
 * Turn an agency name into a DNS-safe base slug.
 *
 * Steps, in order:
 *   1. lowercase + NFKD normalize so accents decompose ("Café" → "cafe")
 *   2. collapse every run of non-`[a-z0-9]` to a single hyphen
 *   3. trim leading/trailing hyphens
 *   4. fall back to "agency" when nothing slug-able survived (e.g. "≈≈≈")
 *   5. defuse a literal `xn--` prefix by namespacing it (step 2 already
 *      collapses `--`, but this guards names/slugs that arrive pre-hyphenated)
 *   6. truncate to 63 characters, re-trimming any hyphen exposed by the cut
 *
 * The result always satisfies `isValidDnsLabel()`. It may still be RESERVED —
 * `generateUniqueAgencySlug` handles that, because avoiding a reserved word
 * requires a suffix and therefore a uniqueness check.
 */
export function slugifyAgencyName(name: string): string {
  let base = (name || "")
    .toLowerCase()
    .normalize("NFKD") // decompose accents so diacritics can be dropped
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!base) base = "agency";

  // `xn--` is reserved for punycode; namespace it rather than reject the name.
  if (base.startsWith("xn--")) base = `agency-${base}`;

  if (base.length > MAX_DNS_LABEL_LENGTH) {
    base = base.slice(0, MAX_DNS_LABEL_LENGTH).replace(/-+$/, "");
  }

  return base || "agency";
}

// ---------------------------------------------------------------------------
// Vanity-domain URLs
// ---------------------------------------------------------------------------

/**
 * Build the canonical public origin for an agency.
 *
 * UNSET-SAFE by design: with no `baseDomain` configured (local dev, or before
 * the wildcard DNS record exists) this returns the path-based URL the platform
 * has always used, so nothing breaks when the env var is missing.
 *
 * @param slug        the agency's canonical slug
 * @param baseDomain  tenant base domain, e.g. "weareseli.com". Empty ⇒ fallback
 * @param fallbackOrigin origin to hang `/a/<slug>` off when baseDomain is unset
 * @returns an absolute URL with NO trailing slash
 */
export function buildAgencyPageUrl(
  slug: string,
  baseDomain: string | undefined,
  fallbackOrigin: string
): string {
  if (baseDomain && isUsableAgencySlug(slug)) {
    return `https://${slug}.${baseDomain}`;
  }
  return `${fallbackOrigin.replace(/\/+$/, "")}/a/${slug}`;
}

/**
 * Decide where Paystack should send a guest back after paying for a consultation.
 *
 * The public agency page is now reachable on TWO hosts — the vanity subdomain
 * (`https://<slug>.weareseli.com`) and the portal path (`https://portal.weareseli.com/a/<slug>`)
 * — and a visitor must never be teleported to the other one mid-payment. So the
 * booking request carries its own `window.location.origin` and we honour it…
 * but only against a strict ALLOWLIST. `callbackUrl` is attacker-controllable
 * input otherwise, and an open redirect on a payment return is exactly the
 * primitive a phishing flow wants.
 *
 * Resolution order:
 *   1. origin is the agency's own vanity host  → `<origin>/confirm`
 *   2. origin is the portal host               → `<origin>/a/<slug>/confirm`
 *   3. anything else (absent, localhost, spoofed) → the canonical default:
 *      the vanity host when configured, else today's portal path URL.
 *
 * @param slug           the agency's canonical slug
 * @param requestOrigin  origin claimed by the booking request; untrusted
 * @param baseDomain     tenant base domain (`AGENCY_PAGE_DOMAIN`); may be unset
 * @param portalUrl      the portal's own absolute origin (`APP_URL`)
 */
export function resolveBookingCallbackUrl(
  slug: string,
  requestOrigin: string | undefined,
  baseDomain: string | undefined,
  portalUrl: string
): string {
  const portalOrigin = portalUrl.replace(/\/+$/, "");
  const tenantOrigin =
    baseDomain && isUsableAgencySlug(slug)
      ? `https://${slug}.${baseDomain}`
      : null;

  const claimed = (requestOrigin || "").trim().replace(/\/+$/, "").toLowerCase();

  if (tenantOrigin && claimed === tenantOrigin) return `${tenantOrigin}/confirm`;
  if (claimed === portalOrigin.toLowerCase()) {
    return `${portalOrigin}/a/${slug}/confirm`;
  }

  // Not on the allowlist → fall back to the canonical public URL for the agency.
  return tenantOrigin
    ? `${tenantOrigin}/confirm`
    : `${portalOrigin}/a/${slug}/confirm`;
}
