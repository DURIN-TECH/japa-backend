// ============================================
// Risk signals: input validation and limits (issue #119)
// ============================================
//
// Pure functions (no Firestore, no logging), used by
// services/risk-signal.service.ts before anything is written.
//
// Why this is strict: raiseRiskSignal() is called by rule code with data
// that started as user input. A signal must hold REFERENCES and short
// structured facts, never a copy of a document, a message body or free-form
// personal data. So every field has an allowed shape and a size cap, unknown
// keys are refused (nothing can be smuggled in beside the known fields), and
// refs may not look like an email address or contain spaces.
//
// Error messages name the FIELD that is wrong and never repeat its value, so
// a rejected input cannot end up in a log line.

import {
  RISK_SIGNAL_CATEGORIES,
  RISK_SIGNAL_SEVERITIES,
  RISK_SIGNAL_SOURCE_KINDS,
  RISK_SIGNAL_SUBJECT_TYPES,
  type RaiseRiskSignalInput,
  type RiskSignalEvidence,
  type RiskSignalMoney,
  type RiskSignalSource,
} from "../types/risk-signal";

// ============================================
// LIMITS
// ============================================

/** Caps on what a signal may hold. Exported so tests and docs quote one list. */
export const RISK_SIGNAL_LIMITS = {
  /** Evidence items accepted by ONE raiseRiskSignal() call. */
  maxEvidencePerRaise: 20,
  /** Evidence items a signal keeps in total (merges beyond this are dropped). */
  maxEvidencePerSignal: 50,
  /** Characters in a key (`type`, evidence `kind`, `ruleId`). */
  maxKeyLength: 64,
  /** Characters in a subject id or an evidence `ref`. */
  maxRefLength: 200,
  /** Characters in `dedupeKey`. */
  maxDedupeKeyLength: 200,
  /** Characters in an evidence `note`. */
  maxEvidenceNoteLength: 200,
  /** Characters in `source.version`. */
  maxVersionLength: 40,
  /** Characters in `source.sourceUrl`. */
  maxSourceUrlLength: 500,
  /** Characters in `source.sourceQuote`. */
  maxSourceQuoteLength: 500,
  /** Characters in an admin's status-change note. */
  maxStatusNoteLength: 2000,
  /** Signals created for one dedupe key over time (a runaway rule stops here). */
  maxGenerations: 50,
} as const;

/** A lower-case key: `shared_contact`, `payment`, `listing_mismatch`. */
const KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * A reference: a document path or a hashed value. Letters, digits and the
 * separators `_ . : / # = -` only. No spaces, no `@` and no `+`, so an email
 * address, a phone number or a sentence cannot be stored as a ref (a rule
 * that matches on a contact detail must pass its hash).
 */
const REF_RE = /^[A-Za-z0-9_.:/#=-]+$/;

/** Rule / prompt version: `1`, `1.2.0`, `2026-11-10`. */
const VERSION_RE = /^[A-Za-z0-9_.-]+$/;

/** ISO 4217 currency code. */
const CURRENCY_RE = /^[A-Z]{3}$/;

/** ASCII control characters (incl. newlines and tabs): not allowed in notes / quotes. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// ============================================
// ERROR
// ============================================

/**
 * Thrown for an input that breaks a rule above. `field` names what is wrong
 * (e.g. `evidence[2].ref`); the offending value is never included.
 */
export class RiskSignalValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(public readonly field: string, problem: string) {
    super(`${field} ${problem}`);
    this.name = "RiskSignalValidationError";
  }
}

// ============================================
// SMALL CHECKS
// ============================================

/** True for a plain `{}` object (not null, not an array, not a class instance). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** Require a plain object and refuse any key outside `allowed`. */
function requireObject(v: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(v)) throw new RiskSignalValidationError(field, "is required and must be an object");
  for (const key of Object.keys(v)) {
    // The key itself may be attacker-chosen text: report only that one exists.
    if (!allowed.includes(key)) throw new RiskSignalValidationError(field, "has a field that is not allowed");
  }
  return v;
}

/** Require a non-empty string within `max`, matching `re` when given. */
function requireString(v: unknown, field: string, max: number, re?: RegExp): string {
  if (typeof v !== "string" || v.length === 0) throw new RiskSignalValidationError(field, "is required and must be a non-empty string");
  if (v.length > max) throw new RiskSignalValidationError(field, `must be at most ${max} characters`);
  if (re && !re.test(v)) throw new RiskSignalValidationError(field, "has characters that are not allowed");
  return v;
}

/** Require one of a fixed list of values. */
function requireOneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new RiskSignalValidationError(field, `must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

/** Single-line free text within `max` (trimmed; no control characters). */
function requireLine(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new RiskSignalValidationError(field, "must be a string");
  const text = v.trim();
  if (text.length === 0) throw new RiskSignalValidationError(field, "must not be empty");
  if (text.length > max) throw new RiskSignalValidationError(field, `must be at most ${max} characters`);
  if (CONTROL_RE.test(text)) throw new RiskSignalValidationError(field, "must be a single line with no control characters");
  return text;
}

/** True for an absolute http(s) URL. Shared with nothing else: a URL that is not http(s) is refused. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ============================================
// FIELD VALIDATORS
// ============================================

/** Validate a labelled money amount. */
function validateMoney(v: unknown, field: string): RiskSignalMoney {
  const o = requireObject(v, field, ["value", "currency", "unit"]);
  if (typeof o.value !== "number" || !Number.isFinite(o.value) || o.value < 0) {
    throw new RiskSignalValidationError(`${field}.value`, "must be a finite number, 0 or more");
  }
  return {
    value: o.value,
    currency: requireString(o.currency, `${field}.currency`, 3, CURRENCY_RE),
    unit: requireOneOf(o.unit, `${field}.unit`, ["major", "minor"] as const),
  };
}

/** Validate one evidence item and return a clean copy (known keys only). */
function validateEvidenceItem(v: unknown, field: string): RiskSignalEvidence {
  const o = requireObject(v, field, ["kind", "ref", "note", "count", "amount"]);
  const item: RiskSignalEvidence = {
    kind: requireString(o.kind, `${field}.kind`, RISK_SIGNAL_LIMITS.maxKeyLength, KEY_RE),
    ref: requireString(o.ref, `${field}.ref`, RISK_SIGNAL_LIMITS.maxRefLength, REF_RE),
  };
  if (o.note !== undefined) item.note = requireLine(o.note, `${field}.note`, RISK_SIGNAL_LIMITS.maxEvidenceNoteLength);
  if (o.count !== undefined) {
    if (typeof o.count !== "number" || !Number.isInteger(o.count) || o.count < 0) {
      throw new RiskSignalValidationError(`${field}.count`, "must be a whole number, 0 or more");
    }
    item.count = o.count;
  }
  if (o.amount !== undefined) item.amount = validateMoney(o.amount, `${field}.amount`);
  return item;
}

/** Validate `source` and return a clean copy. */
function validateSource(v: unknown): RiskSignalSource {
  const o = requireObject(v, "source", ["kind", "ruleId", "version", "sourceUrl", "sourceQuote"]);
  const source: RiskSignalSource = { kind: requireOneOf(o.kind, "source.kind", RISK_SIGNAL_SOURCE_KINDS) };
  if (o.ruleId !== undefined) source.ruleId = requireString(o.ruleId, "source.ruleId", RISK_SIGNAL_LIMITS.maxKeyLength, KEY_RE);
  if (o.version !== undefined) {
    source.version = requireString(o.version, "source.version", RISK_SIGNAL_LIMITS.maxVersionLength, VERSION_RE);
  }
  if (o.sourceUrl !== undefined) {
    const url = requireString(o.sourceUrl, "source.sourceUrl", RISK_SIGNAL_LIMITS.maxSourceUrlLength);
    // Only http(s): the portal renders this as a link.
    if (!isHttpUrl(url)) throw new RiskSignalValidationError("source.sourceUrl", "must be an http or https URL");
    source.sourceUrl = url;
  }
  if (o.sourceQuote !== undefined) {
    source.sourceQuote = requireLine(o.sourceQuote, "source.sourceQuote", RISK_SIGNAL_LIMITS.maxSourceQuoteLength);
  }
  return source;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Validate a raiseRiskSignal() input. Returns a clean deep copy holding only
 * the known fields; throws RiskSignalValidationError (and so writes nothing)
 * on the first problem.
 *
 * Evidence items repeated inside one call (same kind + ref) are collapsed to
 * the first one.
 */
export function validateRaiseInput(input: unknown): RaiseRiskSignalInput {
  const o = requireObject(input, "input", ["subject", "category", "type", "severity", "evidence", "source", "dedupeKey"]);

  // ---- subject ----
  const s = requireObject(o.subject, "subject", ["type", "id"]);
  const subject = {
    type: requireOneOf(s.type, "subject.type", RISK_SIGNAL_SUBJECT_TYPES),
    id: requireString(s.id, "subject.id", RISK_SIGNAL_LIMITS.maxRefLength, REF_RE),
  };

  // ---- evidence ----
  if (!Array.isArray(o.evidence)) throw new RiskSignalValidationError("evidence", "is required and must be an array");
  if (o.evidence.length === 0) throw new RiskSignalValidationError("evidence", "must have at least one item");
  if (o.evidence.length > RISK_SIGNAL_LIMITS.maxEvidencePerRaise) {
    throw new RiskSignalValidationError("evidence", `must have at most ${RISK_SIGNAL_LIMITS.maxEvidencePerRaise} items`);
  }
  const evidence: RiskSignalEvidence[] = [];
  const seen = new Set<string>();
  o.evidence.forEach((raw, i) => {
    const item = validateEvidenceItem(raw, `evidence[${i}]`);
    const key = evidenceKey(item);
    if (seen.has(key)) return; // same fact twice in one call
    seen.add(key);
    evidence.push(item);
  });

  return {
    subject,
    category: requireOneOf(o.category, "category", RISK_SIGNAL_CATEGORIES),
    type: requireString(o.type, "type", RISK_SIGNAL_LIMITS.maxKeyLength, KEY_RE),
    severity: requireOneOf(o.severity, "severity", RISK_SIGNAL_SEVERITIES),
    evidence,
    source: validateSource(o.source),
    dedupeKey: requireString(o.dedupeKey, "dedupeKey", RISK_SIGNAL_LIMITS.maxDedupeKeyLength, REF_RE),
  };
}

/** Identity of an evidence item for merging: same kind + same ref = same fact. */
export function evidenceKey(item: Pick<RiskSignalEvidence, "kind" | "ref">): string {
  return `${item.kind}|${item.ref}`;
}

/**
 * Validate an admin's status-change note. Returns the trimmed note, or null
 * when none was given. Multi-line text is allowed here (an admin writes it),
 * within the length cap.
 */
export function validateStatusNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== "string") throw new RiskSignalValidationError("note", "must be a string");
  const text = note.trim();
  if (text.length === 0) return null;
  if (text.length > RISK_SIGNAL_LIMITS.maxStatusNoteLength) {
    throw new RiskSignalValidationError("note", `must be at most ${RISK_SIGNAL_LIMITS.maxStatusNoteLength} characters`);
  }
  return text;
}
