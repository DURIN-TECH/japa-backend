// ============================================
// Agency visas: request-body validation (issue #100)
// ============================================
//
// Pure functions (no I/O), unit-tested in test/agency-visas/.
//
// The agency endpoints accept ONLY the content fields of a `VisaType`
// (AGENCY_VISA_CONTENT_FIELDS below). Everything else is refused with a 400
// that names the field:
//  - a key in `VISA_PROTECTED_FIELDS` (@durin-tech/authz: review state,
//    visibility, activation, ownership) -> PROTECTED_FIELD. These are set by
//    the server only; the request can never write them;
//  - any other key that is not a content field (`agentIds`, `scrapeMeta`,
//    `id`, `createdAt`, `lastVerifiedAt`, ...) -> UNKNOWN_FIELD.
// Refusing (rather than silently dropping) makes tampering visible to the
// caller and keeps the rule simple: what is not on the allow-list is never
// persisted.
//
// Full-set rule: create requires every required field (the default named in
// the issue: no partial drafts). Updates are partial (PATCH semantics for
// both PUT and PATCH), but the visa they produce must still be complete, so
// `assertCompleteContent` runs on the merged result, and submit runs it again.

import { VISA_PROTECTED_FIELDS } from "@durin-tech/authz";
import type { VisaCategory, VisaSponsor, VisaType } from "../types";

// ============================================
// Field lists
// ============================================

/**
 * Content fields an agency must send on create (and that a visa must have to
 * be submitted). Same structure as the scraped / seed visas.
 */
export const AGENCY_VISA_REQUIRED_FIELDS = [
  "countryCode",
  "name",
  "code",
  "description",
  "category",
  "processingTime",
  "processingDaysMin",
  "processingDaysMax",
  "validityPeriod",
  "isExtendable",
  "eligibilityCriteria",
] as const;

/**
 * Optional content fields. Sending `null` for one of these on an update
 * removes it from the visa.
 *
 * `baseCostUsd` is the GOVERNMENT fee in USD (not the agency's own service
 * price, which is #103). Note for #101: the admin approval guard
 * (`assertVisaApprovable`) refuses a visa without a finite `baseCostUsd`, so
 * an agency visa needs one before it can be approved.
 */
export const AGENCY_VISA_OPTIONAL_FIELDS = [
  "baseCostUsd",
  "applicationUrl",
  "applicationInstructions",
  "sourceUrl",
  "maxExtensions",
  "sponsor",
] as const;

/** A required content field name. */
export type AgencyVisaRequiredField = (typeof AGENCY_VISA_REQUIRED_FIELDS)[number];
/** An optional content field name. */
export type AgencyVisaOptionalField = (typeof AGENCY_VISA_OPTIONAL_FIELDS)[number];
/** Any field the agency endpoints accept in a request body. */
export type AgencyVisaContentField = AgencyVisaRequiredField | AgencyVisaOptionalField;

/** Every accepted body key (required + optional), in a stable order. */
export const AGENCY_VISA_CONTENT_FIELDS: readonly AgencyVisaContentField[] = [
  ...AGENCY_VISA_REQUIRED_FIELDS,
  ...AGENCY_VISA_OPTIONAL_FIELDS,
];

/** The content part of a visa: what an agency may write. */
export type AgencyVisaContent = Pick<VisaType, AgencyVisaContentField>;

/**
 * Valid `category` values. A Record keyed by `VisaCategory` so the compiler
 * fails here if the union gains or loses a member.
 */
const CATEGORY_SET: Record<VisaCategory, true> = {
  work: true,
  student: true,
  tourist: true,
  business: true,
  family: true,
  investor: true,
  transit: true,
  other: true,
};
/** `category` values as a list (for messages). */
export const VISA_CATEGORY_VALUES = Object.keys(CATEGORY_SET) as VisaCategory[];

/** Accepted keys of the `sponsor` object (VisaSponsor, issue #99). */
const SPONSOR_FIELDS: readonly (keyof VisaSponsor)[] = [
  "organisationName",
  "website",
  "sponsorLicenceNumber",
  "contact",
];

/** Length caps, so a body can't store megabytes of text in one field. */
const MAX_LEN = {
  short: 200, // name, code, processingTime, validityPeriod, sponsor fields
  url: 2048,
  long: 5000, // description, applicationInstructions
  criterion: 1000, // one eligibility criterion
};
/** At most this many eligibility criteria. */
const MAX_CRITERIA = 100;

// ============================================
// Errors
// ============================================

/**
 * A typed error the controller turns into an HTTP response:
 * `{ success: false, error: code, message, field? }` with `httpStatus`.
 * Thrown by validation (400) and by the service (404 / 409).
 */
export class AgencyVisaError extends Error {
  constructor(
    /** Machine-readable code, e.g. VALIDATION_ERROR, PROTECTED_FIELD. */
    readonly code: string,
    message: string,
    /** HTTP status to answer with. */
    readonly httpStatus: number,
    /** The request field the error is about, when there is one. */
    readonly field?: string
  ) {
    super(message);
    this.name = "AgencyVisaError";
  }
}

/** Shorthand for a 400 VALIDATION_ERROR on one field. */
function invalid(field: string, message: string): AgencyVisaError {
  return new AgencyVisaError("VALIDATION_ERROR", `${field}: ${message}`, 400, field);
}

// ============================================
// Per-value checks
// ============================================

/** Plain JSON object (not null, not an array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A trimmed, non-empty string of at most `max` chars, or throw. */
function requireText(field: string, v: unknown, max: number): string {
  if (typeof v !== "string") throw invalid(field, "must be a string");
  const t = v.trim();
  if (t.length === 0) throw invalid(field, "must not be empty");
  if (t.length > max) throw invalid(field, `must be at most ${max} characters`);
  return t;
}

/** A non-negative integer, or throw. */
function requireNonNegInt(field: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw invalid(field, "must be a non-negative integer");
  }
  return v;
}

/**
 * An absolute http(s) URL, or throw. Other schemes (javascript:, data:,
 * ftp:) are refused: these URLs are shown as links to applicants.
 */
export function requireHttpUrl(field: string, v: unknown): string {
  const t = requireText(field, v, MAX_LEN.url);
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    throw invalid(field, "must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(field, "must be a valid http(s) URL");
  }
  return t;
}

/** Validate the `sponsor` object (VisaSponsor). */
function parseSponsor(v: unknown): VisaSponsor {
  if (!isPlainObject(v)) throw invalid("sponsor", "must be an object");
  // Unknown sponsor keys are refused like unknown top-level keys.
  for (const key of Object.keys(v)) {
    if (!(SPONSOR_FIELDS as readonly string[]).includes(key)) {
      throw new AgencyVisaError(
        "UNKNOWN_FIELD",
        `sponsor.${key} is not an accepted field`,
        400,
        `sponsor.${key}`
      );
    }
  }
  const sponsor: VisaSponsor = {
    organisationName: requireText("sponsor.organisationName", v.organisationName, MAX_LEN.short),
  };
  // Optional sponsor fields: absent or null = not set.
  if (v.website != null) sponsor.website = requireHttpUrl("sponsor.website", v.website);
  if (v.sponsorLicenceNumber != null) {
    sponsor.sponsorLicenceNumber = requireText(
      "sponsor.sponsorLicenceNumber",
      v.sponsorLicenceNumber,
      MAX_LEN.short
    );
  }
  if (v.contact != null) sponsor.contact = requireText("sponsor.contact", v.contact, MAX_LEN.short);
  return sponsor;
}

/**
 * Validate and normalise ONE content field's value (not null). Returns the
 * value to store. Cross-field rules (min <= max) are in assertCompleteContent.
 */
function parseField(field: AgencyVisaContentField, v: unknown): unknown {
  switch (field) {
  case "countryCode": {
    const t = requireText(field, v, 2).toUpperCase();
    // ISO 3166-1 alpha-2; existence is checked against `countries` by the service.
    if (!/^[A-Z]{2}$/.test(t)) throw invalid(field, "must be a 2-letter country code");
    return t;
  }
  case "code":
    // Stored upper-case, like the admin createVisaType.
    return requireText(field, v, MAX_LEN.short).toUpperCase();
  case "name":
  case "processingTime":
  case "validityPeriod":
    return requireText(field, v, MAX_LEN.short);
  case "description":
  case "applicationInstructions":
    return requireText(field, v, MAX_LEN.long);
  case "category":
    if (typeof v !== "string" || !(v in CATEGORY_SET)) {
      throw invalid(field, `must be one of ${VISA_CATEGORY_VALUES.join(", ")}`);
    }
    return v;
  case "processingDaysMin":
  case "processingDaysMax":
  case "maxExtensions":
    return requireNonNegInt(field, v);
  case "isExtendable":
    if (typeof v !== "boolean") throw invalid(field, "must be true or false");
    return v;
  case "eligibilityCriteria": {
    if (!Array.isArray(v)) throw invalid(field, "must be an array of strings");
    if (v.length > MAX_CRITERIA) throw invalid(field, `must have at most ${MAX_CRITERIA} items`);
    return v.map((item, i) => requireText(`${field}[${i}]`, item, MAX_LEN.criterion));
  }
  case "baseCostUsd":
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw invalid(field, "must be a finite number >= 0");
    }
    return v;
  case "applicationUrl":
  case "sourceUrl":
    return requireHttpUrl(field, v);
  case "sponsor":
    return parseSponsor(v);
  }
}

// ============================================
// Body parsing
// ============================================

/** Result of parsing a request body. */
export interface ParsedAgencyVisaBody {
  /** Validated, normalised values to write. */
  fields: Partial<AgencyVisaContent>;
  /** Optional fields the body set to `null` (update only): remove them. */
  cleared: AgencyVisaOptionalField[];
}

/**
 * Parse a create / update request body.
 *
 * Order of checks (first failure wins, so the 400 names one field):
 *  1. the body is a JSON object;
 *  2. every key: protected (VISA_PROTECTED_FIELDS) -> 400 PROTECTED_FIELD;
 *     not a content field -> 400 UNKNOWN_FIELD;
 *  3. every present value is valid for its field (null only clears an
 *     optional field, and only on update);
 *  4. create: every required field is present, then assertCompleteContent.
 *
 * @param body the raw `req.body`
 * @param mode "create" (full set required) or "update" (partial)
 * @throws AgencyVisaError (400) naming the offending field
 */
export function parseAgencyVisaBody(body: unknown, mode: "create" | "update"): ParsedAgencyVisaBody {
  if (!isPlainObject(body)) {
    throw new AgencyVisaError("VALIDATION_ERROR", "Request body must be a JSON object", 400);
  }

  // ---- 2. Key allow-list (protected first: the more specific message) ----
  for (const key of Object.keys(body)) {
    if ((VISA_PROTECTED_FIELDS as readonly string[]).includes(key)) {
      throw new AgencyVisaError(
        "PROTECTED_FIELD",
        `${key} is set by Seli and cannot be sent`,
        400,
        key
      );
    }
    if (!(AGENCY_VISA_CONTENT_FIELDS as readonly string[]).includes(key)) {
      throw new AgencyVisaError("UNKNOWN_FIELD", `${key} is not an accepted field`, 400, key);
    }
  }

  // ---- 3. Values ----
  const fields: Partial<AgencyVisaContent> = {};
  const cleared: AgencyVisaOptionalField[] = [];
  for (const field of AGENCY_VISA_CONTENT_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v === undefined) continue;
    if (v === null) {
      // null = "remove this optional field" (update only). A required field
      // can never be null, and on create there is nothing to remove.
      if (mode === "update" && (AGENCY_VISA_OPTIONAL_FIELDS as readonly string[]).includes(field)) {
        cleared.push(field as AgencyVisaOptionalField);
        continue;
      }
      throw invalid(field, "is required");
    }
    (fields as Record<string, unknown>)[field] = parseField(field, v);
  }

  // ---- 4. Create: the full set ----
  if (mode === "create") assertCompleteContent(fields);

  return { fields, cleared };
}

/**
 * Throw a 400 unless `content` is a complete, consistent visa: every required
 * field present, and `processingDaysMin <= processingDaysMax`. Runs on create,
 * on the merged result of an update, and on submit (a draft stored before a
 * rule change is re-checked).
 *
 * Values already in the doc are re-validated too, so a doc written by an
 * older version (or by hand) can't be submitted with a bad value.
 *
 * @throws AgencyVisaError 400 naming the first missing / bad field
 */
export function assertCompleteContent(content: Partial<AgencyVisaContent>): void {
  for (const field of AGENCY_VISA_REQUIRED_FIELDS) {
    const v = (content as Record<string, unknown>)[field];
    if (v === undefined || v === null) throw invalid(field, "is required");
    parseField(field, v);
  }
  for (const field of AGENCY_VISA_OPTIONAL_FIELDS) {
    const v = (content as Record<string, unknown>)[field];
    if (v !== undefined && v !== null) parseField(field, v);
  }
  if ((content.processingDaysMin as number) > (content.processingDaysMax as number)) {
    throw invalid("processingDaysMin", "must be less than or equal to processingDaysMax");
  }
}

/**
 * The content fields of a stored visa (drops review / ownership / meta
 * fields). Used to merge an update and to diff a revision against the live
 * visa.
 */
export function pickContent(visa: Partial<VisaType>): Partial<AgencyVisaContent> {
  const out: Record<string, unknown> = {};
  for (const field of AGENCY_VISA_CONTENT_FIELDS) {
    const v = (visa as Record<string, unknown>)[field];
    if (v !== undefined && v !== null) out[field] = v;
  }
  return out as Partial<AgencyVisaContent>;
}

/**
 * Apply a parsed body on top of existing content (pure): set `fields`,
 * remove `cleared`.
 */
export function mergeContent(
  base: Partial<AgencyVisaContent>,
  parsed: ParsedAgencyVisaBody
): Partial<AgencyVisaContent> {
  const out: Record<string, unknown> = { ...base, ...parsed.fields };
  for (const field of parsed.cleared) delete out[field];
  return out as Partial<AgencyVisaContent>;
}

/** Order-sensitive deep equality for JSON-like values (arrays, objects, scalars). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

/**
 * The content fields where `proposed` differs from `live`, for a revision's
 * `changes` map. A field present live but absent in `proposed` maps to
 * `null` (= remove it on approval).
 */
export function diffContent(
  live: Partial<AgencyVisaContent>,
  proposed: Partial<AgencyVisaContent>
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of AGENCY_VISA_CONTENT_FIELDS) {
    const a = (live as Record<string, unknown>)[field];
    const b = (proposed as Record<string, unknown>)[field];
    if (!sameValue(a, b)) changes[field] = b === undefined ? null : b;
  }
  return changes;
}
