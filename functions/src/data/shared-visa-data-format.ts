import { checkAuthorityIdForKind, isCountryCode } from "../authorities/authority-ids";
import { readMemberInput } from "../authorities/authority.service";
import { MEMBERSHIP_KINDS, type MembershipKind } from "../types/authority";
import type { SharedRouteDestinations, SharedRouteRef } from "../types/shared-route";
import type { VisaCategory } from "../types/index";
import { readCategory, readDestinations } from "../shared-routes/shared-route.service";
import { checkSharedRouteId } from "../shared-routes/shared-route-rules";
import { SHARED_VISA_DATA } from "./shared-visa-data";

// ============================================
// SHARED VISA DATA FILE — FORMAT, VALIDATION, LOADER (issue #239, P10 of #228)
// ============================================
//
// WHY THIS EXISTS
// A bloc (for example a visa-free travel area), its member countries and the
// shared visa route they offer are LEGAL FACTS. Code must never contain them:
// a wrong member list would silently send applicants through the wrong rules.
// So the seed and the migration script name no bloc, no country and no route.
// They read one data file, `src/data/shared-visa-data.ts`, which an admin
// fills in FROM OFFICIAL PAGES, with, for every member country:
//   - the verbatim sentence from the official page that states the
//     membership (`sourceQuote`), and
//   - that page's address (`sourceUrl`, https).
// A member without both is refused by this validator before anything is
// written (the same rules the admin API applies: `readMemberInput`).
//
// WHAT THE FILE HOLDS
//   authorities   blocs / treaties, each with its members
//   sharedRoutes  the shared visa routes those authorities issue, and which
//                 visa records (country + visa id) inherit each one
//
// The file shipped in the repo is EMPTY (`{ authorities: [], sharedRoutes: [] }`):
// the real contents are entered by the owner, never invented by code. The
// tests use a made-up fixture (made-up ids, user-assigned country codes).
//
// This module is pure apart from importing the validators of the admin API
// (so file rules and API rules can never drift apart).

/** One member country of a bloc or treaty, as an admin writes it. */
export interface DataMember {
  /** Upper-case two-letter country code (must exist in `countries` when applied). */
  countryCode: string;
  /** First day of membership, "YYYY-MM-DD". */
  joinedOn: string;
  /** First day it is no longer a member, "YYYY-MM-DD" (absent while a member). */
  leftOn?: string;
  /** The sentence from the official page that states the membership, word for word. */
  sourceQuote: string;
  /** The official page the quote is from (https). Its host must be a confirmed official website when applied. */
  sourceUrl: string;
}

/** A bloc or treaty and its members. */
export interface DataAuthority {
  /** Lower-case id, at least 3 characters, no underscore (see authorities/authority-ids.ts). */
  id: string;
  kind: MembershipKind;
  /** Name as the official source writes it. */
  name: string;
  members: DataMember[];
}

/** A visa record (the through-country record) that inherits a shared route. */
export interface DataInheritor {
  countryCode: string;
  visaTypeId: string;
}

/** A shared visa route and the records that inherit it. */
export interface DataSharedRoute {
  id: string;
  name: string;
  category: VisaCategory;
  /** Must be one of this file's `authorities`. */
  issuingAuthorityId: string;
  destinations: SharedRouteDestinations;
  /** Records that inherit this route, e.g. the seed's visitor visa of one member. */
  inheritedBy: DataInheritor[];
}

/** The whole file. */
export interface SharedVisaData {
  authorities: DataAuthority[];
  sharedRoutes: DataSharedRoute[];
}

/** The data when nothing was supplied. */
export const EMPTY_SHARED_VISA_DATA: SharedVisaData = { authorities: [], sharedRoutes: [] };

/** Thrown by `loadSharedVisaData` for an invalid file. The message lists every problem. */
export class SharedVisaDataError extends Error {
  constructor(readonly errors: string[]) {
    super(`shared-visa-data is invalid:\n - ${errors.join("\n - ")}`);
    this.name = "SharedVisaDataError";
  }
}

export type SharedVisaDataCheck = { ok: true; data: SharedVisaData } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Visa record id shape (same as the shared route service). */
const VISA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Message of any thrown value (the API validators throw RegistryError). */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Validate a raw data file. Collects EVERY problem (an admin fixes them in one
 * pass). Normalises: surrounding spaces trimmed from quotes, URLs in their
 * canonical form. Never reads Firestore: whether a country exists or a host
 * is confirmed is checked when the data is applied.
 */
export function validateSharedVisaData(raw: unknown): SharedVisaDataCheck {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["the data must be an object { authorities, sharedRoutes }"] };
  for (const k of Object.keys(raw)) if (k !== "authorities" && k !== "sharedRoutes") errors.push(`"${k}" is not a known top-level field`);
  const rawAuthorities = raw.authorities ?? [];
  const rawRoutes = raw.sharedRoutes ?? [];
  // Not lists: nothing below can run. (An unknown top-level field alone does not stop the checks.)
  if (!Array.isArray(rawAuthorities) || !Array.isArray(rawRoutes)) {
    if (!Array.isArray(rawAuthorities)) errors.push("authorities must be a list");
    if (!Array.isArray(rawRoutes)) errors.push("sharedRoutes must be a list");
    return { ok: false, errors };
  }

  const authorities: DataAuthority[] = [];
  // ---- Authorities and their members ----
  (rawAuthorities as unknown[]).forEach((a, i) => {
    const at = `authorities[${i}]`;
    if (!isObject(a)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const kind = a.kind;
    if (typeof kind !== "string" || !(MEMBERSHIP_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${at}.kind must be one of: ${MEMBERSHIP_KINDS.join(", ")}`);
      return;
    }
    const idCheck = checkAuthorityIdForKind(a.id, kind as MembershipKind);
    if (!idCheck.ok) {
      errors.push(`${at}.id: ${idCheck.message}`);
      return;
    }
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (!name) errors.push(`${at}.name is required (the name as the official source writes it)`);
    if (authorities.some((x) => x.id === idCheck.id)) errors.push(`${at}.id "${idCheck.id}" is listed twice`);
    const rawMembers = a.members ?? [];
    if (!Array.isArray(rawMembers)) {
      errors.push(`${at}.members must be a list`);
      return;
    }
    const members: DataMember[] = [];
    rawMembers.forEach((m, j) => {
      const mt = `${at}.members[${j}]`;
      if (!isObject(m)) {
        errors.push(`${mt} must be an object`);
        return;
      }
      if (!isCountryCode(m.countryCode)) {
        errors.push(`${mt}.countryCode must be a two-letter country code in capitals`);
        return;
      }
      if (members.some((x) => x.countryCode === m.countryCode)) errors.push(`${mt}.countryCode ${m.countryCode} is listed twice`);
      try {
        // The admin API's own rules: real dates, a non-empty verbatim quote, an https address.
        const input = readMemberInput(m);
        members.push({ countryCode: m.countryCode, joinedOn: input.joinedOn, ...(input.leftOn ? { leftOn: input.leftOn } : {}), sourceQuote: input.sourceQuote, sourceUrl: input.sourceUrl });
      } catch (e) {
        errors.push(`${mt} (${m.countryCode}): ${messageOf(e)}`);
      }
    });
    authorities.push({ id: idCheck.id, kind: kind as MembershipKind, name, members });
  });

  // ---- Shared routes ----
  const sharedRoutes: DataSharedRoute[] = [];
  (rawRoutes as unknown[]).forEach((r, i) => {
    const rt = `sharedRoutes[${i}]`;
    if (!isObject(r)) {
      errors.push(`${rt} must be an object`);
      return;
    }
    const idCheck = checkSharedRouteId(r.id);
    if (!idCheck.ok) {
      errors.push(`${rt}.id: ${idCheck.message}`);
      return;
    }
    if (sharedRoutes.some((x) => x.id === idCheck.id)) errors.push(`${rt}.id "${idCheck.id}" is listed twice`);
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) errors.push(`${rt}.name is required`);
    let category: VisaCategory | undefined;
    try {
      category = readCategory(r.category);
    } catch (e) {
      errors.push(`${rt}.category: ${messageOf(e)}`);
    }
    const issuer = authorities.find((a) => a.id === r.issuingAuthorityId);
    if (!issuer) errors.push(`${rt}.issuingAuthorityId "${String(r.issuingAuthorityId)}" must be the id of one of this file's authorities`);
    let destinations: SharedRouteDestinations | undefined;
    try {
      destinations = readDestinations(r.destinations);
    } catch (e) {
      errors.push(`${rt}.destinations: ${messageOf(e)}`);
    }
    // A members_of destination must name an authority of this file (so its members are known here).
    if (destinations?.mode === "members_of" && !authorities.some((a) => a.id === destinations!.authorityId)) {
      errors.push(`${rt}.destinations.authorityId "${destinations.authorityId}" must be the id of one of this file's authorities`);
    }
    const rawInheritors = r.inheritedBy ?? [];
    if (!Array.isArray(rawInheritors)) {
      errors.push(`${rt}.inheritedBy must be a list`);
      return;
    }
    const inheritedBy: DataInheritor[] = [];
    rawInheritors.forEach((x, j) => {
      const xt = `${rt}.inheritedBy[${j}]`;
      if (!isObject(x)) {
        errors.push(`${xt} must be an object { countryCode, visaTypeId }`);
        return;
      }
      if (!isCountryCode(x.countryCode)) {
        errors.push(`${xt}.countryCode must be a two-letter country code in capitals`);
        return;
      }
      if (typeof x.visaTypeId !== "string" || !VISA_ID_RE.test(x.visaTypeId)) {
        errors.push(`${xt}.visaTypeId is not a valid visa record id`);
        return;
      }
      // The inheriting country must be covered by the route as written in this file.
      if (destinations?.mode === "listed" && !destinations.countryCodes.includes(x.countryCode)) {
        errors.push(`${xt}: ${x.countryCode} is not in the route's listed destinations`);
      }
      if (destinations?.mode === "members_of") {
        const auth = authorities.find((a) => a.id === destinations!.authorityId);
        if (auth && !auth.members.some((m) => m.countryCode === x.countryCode)) errors.push(`${xt}: ${x.countryCode} is not a member of "${auth.id}" in this file`);
      }
      inheritedBy.push({ countryCode: x.countryCode, visaTypeId: x.visaTypeId });
    });
    if (idCheck.ok && name && category && issuer && destinations) {
      sharedRoutes.push({ id: idCheck.id, name, category, issuingAuthorityId: issuer.id, destinations, inheritedBy });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, data: { authorities, sharedRoutes } };
}

/**
 * Validate and return the data, or throw `SharedVisaDataError` listing every
 * problem. Called with no argument it reads the repo's data file.
 */
export function loadSharedVisaData(raw?: unknown): SharedVisaData {
  // No argument: the repo's data file. A test passes its own data instead.
  const source = raw === undefined ? SHARED_VISA_DATA : raw;
  const check = validateSharedVisaData(source);
  if (!check.ok) throw new SharedVisaDataError(check.errors);
  return check.data;
}

/**
 * The shared routes a visa record inherits, according to the data file:
 * `[{ sharedRouteId }]` or `[]`. The seed uses this and nothing else, so it
 * never names a bloc or a route itself.
 */
export function inheritsFromFor(data: SharedVisaData, countryCode: string, visaTypeId: string): SharedRouteRef[] {
  return data.sharedRoutes.filter((r) => r.inheritedBy.some((x) => x.countryCode === countryCode && x.visaTypeId === visaTypeId)).map((r) => ({ sharedRouteId: r.id }));
}
