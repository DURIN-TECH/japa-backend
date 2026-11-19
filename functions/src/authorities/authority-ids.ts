import type { AuthorityKind, AuthorityMember, RulebookKeyParts } from "../types/authority";

// ============================================
// AUTHORITIES — PURE RULES (issue #230, P1 of #228)
// ============================================
//
// Everything here is pure (no Firebase, no clock unless passed in), so the
// rules that keep keys unambiguous and membership dates honest are unit
// tested directly:
//
//   - authority id shapes (country code vs bloc/treaty id),
//   - splitting a rulebook key `{authorityId}_{routeSlug}`,
//   - calendar dates "YYYY-MM-DD" and "is this member current on date D".
//
// WHY the id rules matter (overview risk R5): `_` separates the parts of a
// rulebook key, so an authority id must never contain one; and a bloc id must
// never look like a country code, or `xx_route` would be ambiguous. A country
// id is UPPER-case two letters and a bloc/treaty id is lower-case with at
// least three characters, so the two shapes can never overlap.
//
// No country, bloc or nationality is named here: ids are data.

// ============================================
// Id shapes
// ============================================

/** A country authority id: exactly two upper-case letters (the catalogue's form). */
export const COUNTRY_AUTHORITY_ID_RE = /^[A-Z]{2}$/;

/**
 * A bloc or treaty id: lower-case letters, digits and hyphens, at least 3
 * characters. It must start and end with a letter or digit (a leading or
 * trailing hyphen reads as a typo and would make ugly keys). No underscore,
 * ever (it is the rulebook key separator).
 */
export const GROUP_AUTHORITY_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Shortest bloc/treaty id (two characters would collide with country codes). */
export const GROUP_AUTHORITY_ID_MIN = 3;
/** Longest bloc/treaty id (keeps document ids and keys readable). */
export const GROUP_AUTHORITY_ID_MAX = 64;

/** Result of checking an id: its shape, or a plain-words refusal. */
export type AuthorityIdCheck =
  | { ok: true; id: string; shape: "country" | "group" }
  | { ok: false; code: "INVALID_AUTHORITY_ID"; message: string };

/** What a refusal says, in one place so every caller words it the same. */
const ID_RULES_MESSAGE =
  "An authority id is either a two-letter country code in capitals, or (for a bloc or treaty) at least 3 lower-case letters, digits or hyphens, with no underscore";

/**
 * Check an authority id on its own (no kind given): which shape is it?
 * Used for path parameters and for splitting keys, where any valid id is
 * acceptable. Never folds case: `ab` and `AB` are not the same id, and a
 * lower-case two-letter id is refused rather than guessed to be a country.
 */
export function checkAuthorityId(raw: unknown): AuthorityIdCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: "The authority id is missing" };
  }
  if (raw.includes("_")) {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: "An authority id cannot contain an underscore (_), because it separates the parts of a rulebook key" };
  }
  if (COUNTRY_AUTHORITY_ID_RE.test(raw)) return { ok: true, id: raw, shape: "country" };
  if (raw.length < GROUP_AUTHORITY_ID_MIN) {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: `${ID_RULES_MESSAGE}. "${raw}" is too short` };
  }
  if (raw.length > GROUP_AUTHORITY_ID_MAX) {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: `A bloc or treaty id is at most ${GROUP_AUTHORITY_ID_MAX} characters` };
  }
  if (!GROUP_AUTHORITY_ID_RE.test(raw)) {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: ID_RULES_MESSAGE };
  }
  // Defensive: by length a group id can never equal a two-letter code, but the
  // rule "cannot equal a country code" is stated outright so a future change to
  // the minimum length cannot silently break it.
  if (/^[a-z]{2}$/i.test(raw)) {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: "A bloc or treaty id cannot be a country code" };
  }
  return { ok: true, id: raw, shape: "group" };
}

/**
 * Check an id AGAINST the kind it is being created with: a `country`
 * authority needs the country-code shape, a `bloc`/`treaty` the group shape.
 * (Whether the country exists in `countries` is the service's job: it needs a
 * read.)
 */
export function checkAuthorityIdForKind(raw: unknown, kind: AuthorityKind): AuthorityIdCheck {
  const check = checkAuthorityId(raw);
  if (!check.ok) return check;
  if (kind === "country" && check.shape !== "country") {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: "A country authority's id is its two-letter country code in capitals" };
  }
  if (kind !== "country" && check.shape !== "group") {
    return { ok: false, code: "INVALID_AUTHORITY_ID", message: `A ${kind} id must be at least 3 lower-case letters, digits or hyphens; a two-letter code is kept for countries` };
  }
  return check;
}

/** True for a member/country code shape (two upper-case letters). */
export function isCountryCode(raw: unknown): raw is string {
  return typeof raw === "string" && COUNTRY_AUTHORITY_ID_RE.test(raw);
}

// ============================================
// Rulebook keys
// ============================================

/** Result of splitting a key. */
export type RulebookKeySplit = ({ ok: true } & RulebookKeyParts) | { ok: false; code: "INVALID_RULEBOOK_KEY"; message: string };

/** A route slug: what follows the first `_` (today's visa type id shape, see rubricRouteKey). */
const ROUTE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Split a rulebook key `{authorityId}_{routeSlug}` into its parts.
 *
 * The split is at the FIRST underscore: authority ids never contain one, but
 * a route slug may (today's visa type ids allow `_`), so AB_a_b is
 * authority AB, route a_b. For a country authority this reads every
 * existing key `{countryCode}_{visaTypeId}` unchanged. Anything that does not
 * give a valid authority id and a non-empty, slash-free route slug is refused.
 */
export function splitRulebookKey(raw: unknown): RulebookKeySplit {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "INVALID_RULEBOOK_KEY", message: "The rulebook key is missing" };
  }
  const at = raw.indexOf("_");
  if (at < 0) {
    return { ok: false, code: "INVALID_RULEBOOK_KEY", message: "A rulebook key is an authority id, an underscore, then the route (for example AB_route-id)" };
  }
  const authority = checkAuthorityId(raw.slice(0, at));
  if (!authority.ok) return { ok: false, code: "INVALID_RULEBOOK_KEY", message: authority.message };
  const routeSlug = raw.slice(at + 1);
  if (!ROUTE_SLUG_RE.test(routeSlug)) {
    return { ok: false, code: "INVALID_RULEBOOK_KEY", message: "The route part of the rulebook key is empty or has characters other than letters, digits, hyphens and underscores" };
  }
  return { ok: true, authorityId: authority.id, authorityIdKind: authority.shape, routeSlug };
}

/** Build a rulebook key from valid parts (the inverse of splitRulebookKey). Throws on bad input. */
export function buildRulebookKey(authorityId: string, routeSlug: string): string {
  const key = `${authorityId}_${routeSlug}`;
  const split = splitRulebookKey(key);
  if (!split.ok || split.authorityId !== authorityId || split.routeSlug !== routeSlug) {
    throw new Error(`Invalid rulebook key parts: ${JSON.stringify({ authorityId, routeSlug })}`);
  }
  return key;
}

// ============================================
// Calendar dates
// ============================================

/** "YYYY-MM-DD". */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a calendar date. Returns the same string when it is a real date
 * ("2026-02-30" is refused, not rolled over to March), else undefined.
 */
export function parseCalendarDate(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = DATE_RE.exec(raw);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return raw;
}

/** Today as "YYYY-MM-DD" in UTC (the default "on" date). `nowMs` is injectable for tests. */
export function todayUtc(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Is a member current ON `date`? Membership is the half-open range
 * [joinedOn, leftOn): a member that joined after `date` is not yet a member,
 * and one whose `leftOn` is on or before `date` has left. All three values
 * are "YYYY-MM-DD", so plain string comparison is date order.
 */
export function isMemberOn(member: Pick<AuthorityMember, "joinedOn" | "leftOn">, date: string): boolean {
  if (member.joinedOn > date) return false;
  if (member.leftOn !== undefined && member.leftOn <= date) return false;
  return true;
}

/** The members current on `date`, sorted by country code (stable output for callers and tests). */
export function membersOn<M extends Pick<AuthorityMember, "countryCode" | "joinedOn" | "leftOn">>(members: readonly M[], date: string): M[] {
  return members.filter((m) => isMemberOn(m, date)).sort((a, b) => a.countryCode.localeCompare(b.countryCode));
}
