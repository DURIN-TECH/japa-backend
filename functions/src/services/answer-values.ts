// ============================================
// ANSWER VALUES (issue #187 regroom)
// ============================================
//
// PURE rules for the answer to an INFORMATION checklist item, by the item's
// `answerType` (date | date_range | money | address | list | text). No
// Firebase, no I/O, so the API validates and the tests exercise the same code.
//
// STORED / API SHAPES (the contract mobile builds to):
//   text        string, trimmed, <= 2000 chars
//   date        "YYYY-MM-DD" (a real calendar date)
//   date_range  { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }, to >= from
//   money       { amount: number >= 0 (finite), currency: ISO 4217, upper-case }
//   address     { line1, line2?, city, region?, postcode?, country, note? }
//   list        string[]; <= 20 entries, each trimmed, 1..500 chars
// An EMPTY value of any type clears the answer (see isEmptyAnswer).
//
// Validation errors name the bad field ("value.to", "value.line1", "value[3]")
// and NEVER contain the answer text (it is personal data).

import { isIso4217 } from "../scrapers";
import type { AnswerType } from "../scrapers";

/** Longest text answer, in characters (unchanged from #187). */
export const MAX_ANSWER_LENGTH = 2000;
/** Most entries in a `list` answer. */
export const MAX_LIST_ENTRIES = 20;
/** Longest single `list` entry, in characters. */
export const MAX_LIST_ENTRY_LENGTH = 500;
/** Longest single address field (line1, line2, city, region, postcode, country). */
export const MAX_ADDRESS_FIELD_LENGTH = 200;
/** Longest address note ("how long you've lived there", a phone number). */
export const MAX_ADDRESS_NOTE_LENGTH = 500;

/** A rejected input. The message is safe to show and never contains answer text. */
export class AnswerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerValidationError";
  }
}

/** The structured shapes (see the header). */
export interface DateRangeValue { from: string; to: string }
export interface MoneyValue { amount: number; currency: string }
export interface AddressValue {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postcode?: string;
  country: string;
  note?: string;
}
export type AnswerValue = string | string[] | DateRangeValue | MoneyValue | AddressValue;

/** True for a plain (non-array, non-null) object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `v` is a blank string / null / undefined. */
function blank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * Is `raw` an EMPTY answer for `type` (so the answer is cleared)?
 *  null / undefined / blank string for every type; [] or only-blank entries for
 *  a list; an object whose every field is blank for an object type
 *  (date_range, money, address).
 */
export function isEmptyAnswer(type: AnswerType, raw: unknown): boolean {
  if (blank(raw)) return true;
  if (type === "list") return Array.isArray(raw) && raw.every(blank);
  if (type === "date_range" || type === "money" || type === "address") {
    return isRecord(raw) && Object.values(raw).every(blank);
  }
  return false;
}

/** Real calendar date check for "YYYY-MM-DD" (rejects 2026-02-31). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Validate one ISO date field; `field` names it in the error. */
function dateField(v: unknown, field: string): string {
  if (typeof v !== "string") throw new AnswerValidationError(`"${field}" must be a date as YYYY-MM-DD`);
  const s = v.trim();
  if (!isIsoDate(s)) throw new AnswerValidationError(`"${field}" must be a real date as YYYY-MM-DD`);
  return s;
}

/** Validate a required / optional short string field of an address. */
function addressField(o: Record<string, unknown>, key: string, required: boolean, max: number): string | undefined {
  const raw = o[key];
  if (blank(raw)) {
    if (required) throw new AnswerValidationError(`"value.${key}" is required`);
    return undefined;
  }
  if (typeof raw !== "string") throw new AnswerValidationError(`"value.${key}" must be a string`);
  const s = raw.trim();
  if (s.length > max) throw new AnswerValidationError(`"value.${key}" must be at most ${max} characters`);
  return s;
}

/**
 * Validate a NON-EMPTY answer `raw` for `type` and return its normalised
 * stored form. Callers check isEmptyAnswer first (an empty value clears).
 * @throws AnswerValidationError naming the bad field
 */
export function validateAnswerValue(type: AnswerType, raw: unknown): AnswerValue {
  switch (type) {
  case "text": {
    if (typeof raw !== "string") throw new AnswerValidationError("\"value\" must be a string");
    const text = raw.trim();
    if (text.length > MAX_ANSWER_LENGTH) {
      throw new AnswerValidationError(`"value" must be at most ${MAX_ANSWER_LENGTH} characters`);
    }
    return text;
  }
  case "date":
    return dateField(raw, "value");
  case "date_range": {
    if (!isRecord(raw)) throw new AnswerValidationError("\"value\" must be an object { from, to }");
    const from = dateField(raw.from, "value.from");
    const to = dateField(raw.to, "value.to");
    // ISO dates compare correctly as strings.
    if (to < from) throw new AnswerValidationError("\"value.to\" must be on or after \"value.from\"");
    return { from, to };
  }
  case "money": {
    if (!isRecord(raw)) throw new AnswerValidationError("\"value\" must be an object { amount, currency }");
    const amount = raw.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new AnswerValidationError("\"value.amount\" must be a number, zero or more");
    }
    const cur = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(cur) || !isIso4217(cur)) {
      throw new AnswerValidationError("\"value.currency\" must be a 3-letter ISO 4217 code");
    }
    return { amount, currency: cur };
  }
  case "address": {
    if (!isRecord(raw)) throw new AnswerValidationError("\"value\" must be an object { line1, city, country, ... }");
    const max = MAX_ADDRESS_FIELD_LENGTH;
    const out: AddressValue = {
      line1: addressField(raw, "line1", true, max)!,
      city: addressField(raw, "city", true, max)!,
      country: addressField(raw, "country", true, max)!,
    };
    const line2 = addressField(raw, "line2", false, max);
    const region = addressField(raw, "region", false, max);
    const postcode = addressField(raw, "postcode", false, max);
    const note = addressField(raw, "note", false, MAX_ADDRESS_NOTE_LENGTH);
    if (line2) out.line2 = line2;
    if (region) out.region = region;
    if (postcode) out.postcode = postcode;
    if (note) out.note = note;
    return out;
  }
  case "list": {
    if (!Array.isArray(raw)) throw new AnswerValidationError("\"value\" must be a list of text entries");
    const entries: string[] = [];
    raw.forEach((e, i) => {
      if (blank(e)) return; // a blank row from the UI is dropped, not an error
      if (typeof e !== "string") throw new AnswerValidationError(`"value[${i}]" must be a string`);
      const s = e.trim();
      if (s.length > MAX_LIST_ENTRY_LENGTH) {
        throw new AnswerValidationError(`"value[${i}]" must be at most ${MAX_LIST_ENTRY_LENGTH} characters`);
      }
      entries.push(s);
    });
    if (entries.length > MAX_LIST_ENTRIES) {
      throw new AnswerValidationError(`"value" must have at most ${MAX_LIST_ENTRIES} entries`);
    }
    return entries;
  }
  }
}

/**
 * Plain-text rendering of an answer (for a legacy re-typing, a statement, a
 * review). Never throws; unknown shapes render as "".
 */
export function renderAnswerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join("\n");
  if (isRecord(value)) {
    if (typeof value.from === "string" && typeof value.to === "string") return `${value.from} to ${value.to}`;
    if (typeof value.amount === "number") return `${value.amount} ${String(value.currency ?? "")}`.trim();
    return ["line1", "line2", "city", "region", "postcode", "country", "note"]
      .map((k) => (typeof value[k] === "string" ? (value[k] as string) : ""))
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

/**
 * A LEGACY plain-string answer (saved before the types existed) re-read as the
 * item's current `type`, with no data loss: text/date/date_range/money keep the
 * string as `value`; a list gets a one-entry list; an address gets `{ note }`
 * only (its required fields are absent, so the app treats it as unfilled and
 * shows the note). The caller marks it `legacy: true`.
 */
export function legacyValueFor(type: AnswerType, text: string): unknown {
  if (type === "list") return text.trim() ? [text] : [];
  if (type === "address") return { note: text };
  return text;
}
