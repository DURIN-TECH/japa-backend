// ============================================
// Contact detail normalisation (issue #121)
// ============================================
//
// Pure helpers that turn a stored phone / email into a comparison key, decide
// whether a value is a placeholder, and hash it so a signal never has to hold
// the raw value. Nothing here is specific to a country or an applicant.

import { createHash } from "crypto";

/**
 * Email: exact match after trim + lower case. Plus-addressing is NOT stripped,
 * so `delivered+a@resend.dev` and `delivered+b@resend.dev` stay different
 * addresses (test users rely on this). Returns "" for a non-string.
 */
export function normaliseEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Phone: drop spaces, dashes, dots and brackets; a leading `00` becomes `+`.
 * We do NOT guess a country code (the rule is generic), so `0803...` and
 * `+234803...` are different keys. That under-matches, which is the safe
 * direction for a "prompt for review" rule. Returns "" for a non-string.
 */
export function normalisePhone(value: unknown): string {
  if (typeof value !== "string") return "";
  let v = value.trim().replace(/[\s\-.()]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  // Anything other than digits (and one leading +) is not a usable phone.
  return /^\+?\d+$/.test(v) ? v : "";
}

/** Fewest digits a phone key needs to be treated as a real number. */
const MIN_PHONE_DIGITS = 7;

/** Domains that only ever appear as filler on sign-up forms and in docs. */
const PLACEHOLDER_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net", "test.com", "email.com", "domain.com", "none.com", "na.com"]);

/** Local parts that are filler, not a person. */
const PLACEHOLDER_EMAIL_LOCALS = new Set(["test", "none", "na", "n/a", "noemail", "no-email", "noreply", "no-reply", "nil", "null", "unknown"]);

/**
 * Empty or placeholder phone values are ignored by the rule: all one digit
 * ("0000000000"), a plain run ("1234567890") or too short to be a number.
 * Takes a NORMALISED key.
 */
export function isPlaceholderPhone(key: string): boolean {
  const digits = key.replace(/^\+/, "");
  if (digits.length < MIN_PHONE_DIGITS) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  if ("01234567890123456789".includes(digits) || "98765432109876543210".includes(digits)) return true;
  return false;
}

/** Empty or placeholder email values are ignored. Takes a NORMALISED key. */
export function isPlaceholderEmail(key: string): boolean {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return true; // empty or not an address
  const local = key.slice(0, at);
  const domain = key.slice(at + 1);
  return PLACEHOLDER_EMAIL_LOCALS.has(local) || PLACEHOLDER_EMAIL_DOMAINS.has(domain) || !domain.includes(".");
}

/** The two contact fields the rule watches. */
export type ContactKind = "phone" | "email";

/** Normalised key, or "" when the value is empty, malformed or a placeholder. */
export function contactKey(kind: ContactKind, raw: unknown): string {
  if (kind === "phone") {
    const key = normalisePhone(raw);
    return key && !isPlaceholderPhone(key) ? key : "";
  }
  const key = normaliseEmail(raw);
  return key && !isPlaceholderEmail(key) ? key : "";
}

/**
 * Hash of a normalised value for evidence and dedupe keys: `sha256:` + 32 hex
 * characters. The kind is part of the hashed text so a phone and an email can
 * never collide. The result has no `@`, space or `+`, so it passes the evidence
 * `ref` check in #119. (Admin-only data; an unsalted hash of a short phone
 * number can in principle be brute-forced, which is why signals are admin-only.)
 */
export function hashContact(kind: ContactKind, key: string): string {
  return `sha256:${createHash("sha256").update(`${kind}:${key}`).digest("hex").slice(0, 32)}`;
}
