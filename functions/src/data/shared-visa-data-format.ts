import { checkAuthorityIdForKind, isCountryCode } from "../authorities/authority-ids";
import { readMemberInput } from "../authorities/authority.service";
import { MEMBERSHIP_KINDS, type MembershipKind } from "../types/authority";
import type { SharedRouteDestinations, SharedRouteRef } from "../types/shared-route";
import type { VisaCategory } from "../types/index";
import { readCategory, readDestinations } from "../shared-routes/shared-route.service";
import { checkSharedRouteId } from "../shared-routes/shared-route-rules";
// #299: the fee's currency is checked against the SAME ISO 4217 list the visa-catalog fee
// conversion uses (through the scrapers module's public entry point, its boundary rule).
import { isIso4217 } from "../scrapers";
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
//                 visa records (country + visa id) inherit each one; and,
//                 optionally, the government FEE the route's source sets
//                 for every member (issue #299), with its verbatim quote
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

/**
 * Where in a published rulebook the fee's quote was read from (issue #299).
 * Optional provenance only: nothing reads the rulebook through it.
 */
export interface DataFeeRuleRef {
  /** The rulebook's key (the `visaRubrics/{routeKey}` document id). */
  routeKey: string;
  /** The published rulebook version the rule was read from (whole number, 1 or more). */
  version: number;
  /** The rule's id in that version (`criteria[].criterionId`). */
  criterionId: string;
}

/**
 * The government fee a shared route's official source sets for EVERY member
 * (issue #299). Recorded ONCE, on the route, in the source's own currency.
 * The seed converts it to USD with the stored exchange rate and writes the
 * result on each record listed under `inheritedBy` (see seed-sourced-fee.ts).
 *
 * A fee is a legal fact like a membership: `quote` and `url` are copied from
 * the official source, never written from memory, and the validator refuses
 * a quote that does not itself state the amount and the currency.
 */
export interface DataRouteFee {
  /** The figure the quote states, in `currency`. A finite number above 0. */
  amount: number;
  /** ISO 4217 code of the figure, in capitals, as the quote writes it. */
  currency: string;
  /** The source's own name for the fee. */
  label: string;
  /** The sentence of the official source that states the fee, word for word. */
  quote: string;
  /** The official document the quote is from (https). */
  url: string;
  /** The stored official source the quote is in (`guidanceSources/{id}`). The seed writes no fee while that document does not exist. */
  guidanceSourceId: string;
  /** Optional: the published rule the quote was read from. */
  ruleRef?: DataFeeRuleRef;
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
  /** #299: the fee the route's source sets for every member. Absent when none is recorded (the field is never written empty). */
  fee?: DataRouteFee;
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

// ---- The fee of a shared route (issue #299) ----

/** The only fields a `fee` may have (a misspelt one is reported, not silently dropped). */
const FEE_FIELDS = ["amount", "currency", "label", "quote", "url", "guidanceSourceId", "ruleRef"];
/** The only fields a `fee.ruleRef` may have. */
const RULE_REF_FIELDS = ["routeKey", "version", "criterionId"];

/**
 * True when `quote` states `amount` as a number of its own.
 *
 * Every number in the quote is read as the source writes it: plain ("90"),
 * with decimals ("90.00") or with comma thousands separators ("1,500"). The
 * amount must equal one of them EXACTLY, so 90 is not found inside "190" or
 * "90.50". This is what stops a figure being typed next to a quote that
 * states a different one.
 */
export function quoteStatesAmount(quote: string, amount: number): boolean {
  const numbers = quote.match(/\d+(?:[.,]\d+)*/g) ?? [];
  return numbers.some((n) => Number(n.replace(/,/g, "")) === amount);
}

/** True when `quote` contains the currency code as a word of its own (not inside a longer word). */
export function quoteStatesCurrency(quote: string, currency: string): boolean {
  return new RegExp(`(?<![A-Za-z])${currency}(?![A-Za-z])`).test(quote);
}

/**
 * Check one route's `fee`. Pushes EVERY problem onto `errors` (prefixed with
 * `at`) and returns the normalised fee, or undefined when it has a problem.
 * Normalising only trims surrounding spaces: the quote and the address are
 * kept exactly as copied from the source.
 */
function readRouteFee(raw: unknown, at: string, errors: string[]): DataRouteFee | undefined {
  if (!isObject(raw)) {
    errors.push(`${at} must be an object { amount, currency, label, quote, url, guidanceSourceId }`);
    return undefined;
  }
  const before = errors.length;
  for (const k of Object.keys(raw)) if (!FEE_FIELDS.includes(k)) errors.push(`${at}.${k} is not a known field`);

  // The figure: a real number above 0 (a free route records no fee at all).
  const amount = raw.amount;
  const amountOk = typeof amount === "number" && Number.isFinite(amount) && amount > 0;
  if (!amountOk) errors.push(`${at}.amount must be a number above 0`);

  // The currency: a known ISO 4217 code, exact and in capitals.
  const currency = raw.currency;
  const currencyOk = typeof currency === "string" && isIso4217(currency);
  if (!currencyOk) errors.push(`${at}.currency must be an ISO 4217 currency code in capitals`);

  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label) errors.push(`${at}.label is required (the source's own name for the fee)`);

  // The quote must itself state the figure and the currency. Each half is
  // checked only when that field is itself valid, so one mistake is reported once.
  const quote = typeof raw.quote === "string" ? raw.quote.trim() : "";
  if (!quote) errors.push(`${at}.quote is required (the sentence of the official source that states the fee, word for word)`);
  else {
    if (amountOk && !quoteStatesAmount(quote, amount as number)) errors.push(`${at}.quote does not state the amount ${String(amount)}`);
    if (currencyOk && !quoteStatesCurrency(quote, currency as string)) errors.push(`${at}.quote does not state the currency ${String(currency)}`);
  }

  // The address: https only (the same rule as a member's source address).
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  let urlOk = false;
  try {
    urlOk = new URL(url).protocol === "https:";
  } catch {
    urlOk = false;
  }
  if (!urlOk) errors.push(`${at}.url must be an https address`);

  const guidanceSourceId = typeof raw.guidanceSourceId === "string" ? raw.guidanceSourceId.trim() : "";
  if (!guidanceSourceId) errors.push(`${at}.guidanceSourceId is required (the id of the stored official source the quote is in)`);

  // Optional rule reference: when given, it must be complete.
  let ruleRef: DataFeeRuleRef | undefined;
  if (raw.ruleRef !== undefined) {
    const rr = raw.ruleRef;
    if (!isObject(rr)) errors.push(`${at}.ruleRef must be an object { routeKey, version, criterionId }`);
    else {
      for (const k of Object.keys(rr)) if (!RULE_REF_FIELDS.includes(k)) errors.push(`${at}.ruleRef.${k} is not a known field`);
      const routeKey = typeof rr.routeKey === "string" ? rr.routeKey.trim() : "";
      const criterionId = typeof rr.criterionId === "string" ? rr.criterionId.trim() : "";
      const versionOk = typeof rr.version === "number" && Number.isInteger(rr.version) && rr.version >= 1;
      if (!routeKey) errors.push(`${at}.ruleRef.routeKey is required`);
      if (!versionOk) errors.push(`${at}.ruleRef.version must be a whole number, 1 or more`);
      if (!criterionId) errors.push(`${at}.ruleRef.criterionId is required`);
      if (routeKey && versionOk && criterionId) ruleRef = { routeKey, version: rr.version as number, criterionId };
    }
  }

  if (errors.length > before) return undefined;
  return { amount: amount as number, currency: currency as string, label, quote, url, guidanceSourceId, ...(ruleRef ? { ruleRef } : {}) };
}

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
    // #299: the optional fee. Absent stays absent; a present one must be complete
    // (any problem is in `errors`, so the whole file is refused).
    const fee = r.fee === undefined ? undefined : readRouteFee(r.fee, `${rt}.fee`, errors);
    if (idCheck.ok && name && category && issuer && destinations) {
      sharedRoutes.push({ id: idCheck.id, name, category, issuingAuthorityId: issuer.id, destinations, inheritedBy, ...(fee ? { fee } : {}) });
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

/** One shared route's fee together with the route it belongs to (issue #299). */
export interface RouteFeeFor {
  sharedRouteId: string;
  fee: DataRouteFee;
}

/**
 * The route fees a visa record takes on, according to the data file: one entry
 * per shared route that lists the record under `inheritedBy` AND has a `fee`.
 * `[]` for every other record, so the seed's fee logic never touches a record
 * the data file does not list (issue #299).
 */
export function routeFeesFor(data: SharedVisaData, countryCode: string, visaTypeId: string): RouteFeeFor[] {
  return data.sharedRoutes
    .filter((r) => r.fee !== undefined && r.inheritedBy.some((x) => x.countryCode === countryCode && x.visaTypeId === visaTypeId))
    .map((r) => ({ sharedRouteId: r.id, fee: r.fee as DataRouteFee }));
}
