// ============================================
// Risk signals: stored shapes (issue #119)
// ============================================
//
// A risk signal is a note for a platform admin: "a rule (or later a model)
// saw something about this subject that a person should look at". It is NOT
// a verdict, and it never does anything to the subject on its own: nothing
// in this feature notifies, blocks or changes the subject's records.
//
// Storage (both backend-only: no firestore.rules match, clients are denied):
//   riskSignals/{signalId}                 one signal (RiskSignal)
//   riskSignals/{signalId}/events/{seq}    append-only audit trail (RiskSignalEvent)
//
// Visibility: admins only, through /admin/risk-signals. No other serializer
// may include a signal, a count of signals or a flag derived from one.
//
// Evidence hygiene: a signal holds REFERENCES (ids, rule keys, counts, short
// structured facts). It never holds a copy of a document, a message body or
// free-form personal data. The limits are enforced in
// services/risk-signal.validation.ts.
//
// Generic by design: subject types, categories and signal types are data.
// Nothing here names a country, a nationality or a visa route.
//
// This file carries no runtime dependency on Firestore beyond the Timestamp
// type, so rule code (#120, #121) can import the input types freely.

import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// ENUMS (as const arrays, so validation and types share one list)
// ============================================

/** What a signal can be about. `visa` is a visa listing (catalog entry). */
export const RISK_SIGNAL_SUBJECT_TYPES = ["user", "application", "agency", "visa"] as const;
export type RiskSignalSubjectType = (typeof RISK_SIGNAL_SUBJECT_TYPES)[number];

/** The broad harm a signal relates to. */
export const RISK_SIGNAL_CATEGORIES = ["trafficking", "scam"] as const;
export type RiskSignalCategory = (typeof RISK_SIGNAL_CATEGORIES)[number];

/** How strongly the rule rates what it saw (ordered low < medium < high). */
export const RISK_SIGNAL_SEVERITIES = ["low", "medium", "high"] as const;
export type RiskSignalSeverity = (typeof RISK_SIGNAL_SEVERITIES)[number];

/** What produced the signal. */
export const RISK_SIGNAL_SOURCE_KINDS = ["rule", "model", "manual"] as const;
export type RiskSignalSourceKind = (typeof RISK_SIGNAL_SOURCE_KINDS)[number];

/**
 * Review state.
 *  - open:      raised, nobody has picked it up
 *  - in_review: an admin is looking at it
 *  - actioned:  an admin decided it needed action (taken OUTSIDE this tool;
 *               the status only records the decision)
 *  - dismissed: an admin decided it needed none
 */
export const RISK_SIGNAL_STATUSES = ["open", "in_review", "actioned", "dismissed"] as const;
export type RiskSignalStatus = (typeof RISK_SIGNAL_STATUSES)[number];

/** Statuses in which a re-raise merges into the signal instead of making a new one. */
export const RISK_SIGNAL_ACTIVE_STATUSES: readonly RiskSignalStatus[] = ["open", "in_review"];

/** Statuses that mean an admin has decided (a note is required to get here). */
export const RISK_SIGNAL_RESOLVED_STATUSES: readonly RiskSignalStatus[] = ["actioned", "dismissed"];

/** What an audit event records. */
export const RISK_SIGNAL_EVENT_ACTIONS = ["raised", "evidence_added", "status_changed", "reopened"] as const;
export type RiskSignalEventAction = (typeof RISK_SIGNAL_EVENT_ACTIONS)[number];

// ============================================
// EVIDENCE
// ============================================

/**
 * A money amount inside an evidence item. Always labelled, so a number is
 * never read in the wrong unit: `unit: "major"` is the currency's main unit
 * (naira for NGN, which is how Seli stores money), `"minor"` its hundredth
 * (kobo for NGN).
 */
export interface RiskSignalMoney {
  value: number; // finite, >= 0
  currency: string; // ISO 4217, upper case, e.g. "NGN"
  unit: "major" | "minor";
}

/**
 * One structured evidence item: a pointer to where the fact lives, not a
 * copy of it.
 */
export interface RiskSignalEvidence {
  /** What kind of fact this is, as a key (e.g. `shared_contact`, `payment`). */
  kind: string;
  /**
   * Reference to the record the fact comes from: a document path
   * (`applications/abc`) or a hashed value (`sha256:...`). Never the raw
   * personal value itself (no emails, phone numbers or names).
   */
  ref: string;
  /** Short single-line structured note from the rule. Optional. */
  note?: string;
  /** A count the rule measured (e.g. how many accounts share the ref). */
  count?: number;
  /** A money amount, labelled with currency and unit. */
  amount?: RiskSignalMoney;
}

/** Evidence `kind` the service adds to link a new signal to an earlier resolved one. */
export const RISK_SIGNAL_EVIDENCE_KIND_RELATED = "related_signal";
/** Evidence `kind` the service adds when a re-raise names a different subject. */
export const RISK_SIGNAL_EVIDENCE_KIND_SUBJECT = "subject";

// ============================================
// SIGNAL
// ============================================

/** Who or what the signal is about. */
export interface RiskSignalSubject {
  type: RiskSignalSubjectType;
  id: string; // the subject's document id (for `visa`: "{countryCode}__{visaTypeId}" or the visa id the rule uses)
}

/** What produced the signal, and the published source behind the rule, if any. */
export interface RiskSignalSource {
  kind: RiskSignalSourceKind;
  /** The rule's key (kind "rule"), or the model id (kind "model"). */
  ruleId?: string;
  /** Version of the rule / prompt that fired. */
  version?: string;
  /** Published guidance the rule is based on (http/https only). */
  sourceUrl?: string;
  /** Verbatim quote from that guidance. Never a quote of the subject. */
  sourceQuote?: string;
}

/** The admin decision on a resolved signal. */
export interface RiskSignalResolution {
  by: string; // admin uid
  at: Timestamp;
  note: string; // the reason (required)
}

/** A `riskSignals/{signalId}` document. */
export interface RiskSignal {
  /** Doc id: `{hash of dedupeKey}-{generation}` (see riskSignalId()). */
  id: string;
  subject: RiskSignalSubject;
  category: RiskSignalCategory;
  /** Signal type as a key (e.g. `shared_contact`). Data, not an enum: later issues add types. */
  type: string;
  severity: RiskSignalSeverity;
  evidence: RiskSignalEvidence[];
  source: RiskSignalSource;
  status: RiskSignalStatus;
  /** Caller-supplied key: one ACTIVE signal per key at any time. */
  dedupeKey: string;
  /**
   * 1 for the first signal raised for a dedupe key; +1 each time a new signal
   * is created for the same key after an admin resolved the previous one.
   */
  generation: number;
  /**
   * Bumped by every write to the signal. A status change must quote the
   * revision the admin looked at (optimistic concurrency -> 409 when stale).
   */
  revision: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Set when status is actioned / dismissed; removed by a reopen. */
  resolution?: RiskSignalResolution;
}

/**
 * A `riskSignals/{signalId}/events/{seq}` document. Append-only: the service
 * only ever creates these (no update, no delete).
 */
export interface RiskSignalEvent {
  /** Doc id: the zero-padded `seq`. */
  id: string;
  /** The signal's revision after this change; orders the trail. */
  seq: number;
  at: Timestamp;
  /** Admin uid for a status change; RISK_SIGNAL_SYSTEM_ACTOR for raise / merge. */
  actorId: string;
  /** The actor's role (`admin`), or RISK_SIGNAL_SYSTEM_ACTOR. */
  actorRole: string;
  action: RiskSignalEventAction;
  fromStatus: RiskSignalStatus | null; // null on `raised`
  toStatus: RiskSignalStatus;
  /** The admin's reason, or a short system summary ("2 evidence items added"). */
  note: string | null;
}

/** actorId / actorRole of events written by the backend itself (raise, merge). */
export const RISK_SIGNAL_SYSTEM_ACTOR = "system";

// ============================================
// raiseRiskSignal() contract (called by #120, #121)
// ============================================

/** What a rule passes to riskSignalService.raiseRiskSignal(). */
export interface RaiseRiskSignalInput {
  subject: RiskSignalSubject;
  category: RiskSignalCategory;
  type: string;
  severity: RiskSignalSeverity;
  evidence: RiskSignalEvidence[];
  source: RiskSignalSource;
  /**
   * Stable key for "the same finding" (e.g. `{ruleId}:{subjectType}:{subjectId}`).
   * Raising again with the same key never makes a second active signal.
   */
  dedupeKey: string;
}

/**
 * What raiseRiskSignal() did.
 *  - created:    a new signal (and its `raised` event) was written
 *  - merged:     an active signal with this key existed; new evidence was
 *                added (one `evidence_added` event)
 *  - unchanged:  an active signal existed and the raise added nothing new;
 *                nothing was written
 *  - suppressed: an admin already resolved a signal with this key and the
 *                raise brought no new subject / ref; nothing was written
 */
export type RaiseRiskSignalResult =
  | { outcome: "created"; signalId: string; revision: number }
  | { outcome: "merged"; signalId: string; revision: number; evidenceAdded: number }
  | { outcome: "unchanged"; signalId: string }
  | { outcome: "suppressed"; signalId: string };
