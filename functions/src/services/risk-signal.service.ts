// ============================================
// Risk signals: store, raise and review (issue #119)
// ============================================
//
// The plumbing other issues write to (#120 visa listing screening, #121
// exploitation indicators). It contains NO detection rule and NO AI.
//
// What it does:
//  - raiseRiskSignal(input): the ONLY way a signal is created. There is no
//    HTTP route that creates one. Idempotent on the caller's `dedupeKey`.
//  - listSignals / getSignal / changeStatus: back the admin queue at
//    /admin/risk-signals (routes/risk-signal.routes.ts).
//
// What it never does (plan rule 5: "screening flags go to a human"):
//  - it never notifies anyone. This file imports no notification, email or
//    push code, on purpose;
//  - it never writes outside `riskSignals/{id}` and `riskSignals/{id}/events`.
//    The subject's user / application / agency / visa document is not read
//    and not changed, whatever the status;
//  - it never deletes a signal or an event, and never updates an event.
//
// One active signal per dedupe key, without a second collection:
//   the document id is `{sha256(dedupeKey) prefix}-{generation}`. A raise
//   reads generation 1, 2, ... in a transaction until it finds the first id
//   that does not exist; the one before it is the latest signal for the key.
//   Because the id is derived from the key, two raises at the same moment
//   read and write the SAME document, so Firestore's transaction makes one
//   of them retry and merge instead of creating a duplicate.
//
// Logging: ids, enum values and counts only. Evidence contents, notes and
// quotes are never logged.

import { createHash } from "crypto";
import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { collections, db } from "../utils/firebase";
import {
  RISK_SIGNAL_ACTIVE_STATUSES,
  RISK_SIGNAL_EVIDENCE_KIND_RELATED,
  RISK_SIGNAL_EVIDENCE_KIND_SUBJECT,
  RISK_SIGNAL_RESOLVED_STATUSES,
  RISK_SIGNAL_SEVERITIES,
  RISK_SIGNAL_SYSTEM_ACTOR,
  type RaiseRiskSignalInput,
  type RaiseRiskSignalResult,
  type RiskSignal,
  type RiskSignalCategory,
  type RiskSignalEvent,
  type RiskSignalEventAction,
  type RiskSignalEvidence,
  type RiskSignalSeverity,
  type RiskSignalStatus,
  type RiskSignalSubject,
  type RiskSignalSubjectType,
} from "../types/risk-signal";
import {
  RISK_SIGNAL_LIMITS,
  RiskSignalValidationError,
  evidenceKey,
  validateRaiseInput,
  validateStatusNote,
} from "./risk-signal.validation";

// ============================================
// CONSTANTS
// ============================================

/** Default and maximum page size of the admin list. */
export const RISK_SIGNAL_LIST_DEFAULT_LIMIT = 25;
export const RISK_SIGNAL_LIST_MAX_LIMIT = 100;

/** Events returned with one signal (a signal has one event per change; this is a safety cap). */
const MAX_EVENTS_RETURNED = 500;

/** Name of the audit subcollection under a signal. */
const EVENTS_SUBCOLLECTION = "events";

/** Shape of a signal id: 32 hex characters of the key hash, a dash, the generation. */
export const RISK_SIGNAL_ID_RE = /^[a-f0-9]{32}-[1-9][0-9]{0,2}$/;

/**
 * Status changes an admin may make with a plain status change.
 * (Reopening a resolved signal is separate and explicit: see changeStatus.)
 */
const ALLOWED_TRANSITIONS: Record<RiskSignalStatus, readonly RiskSignalStatus[]> = {
  open: ["in_review", "actioned", "dismissed"],
  in_review: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

// ============================================
// TYPES
// ============================================

/** A signal as the admin API returns it: dates are ISO-8601 strings. */
export interface RiskSignalJson {
  id: string;
  subject: RiskSignalSubject;
  category: RiskSignalCategory;
  type: string;
  severity: RiskSignalSeverity;
  evidence: RiskSignalEvidence[];
  source: RiskSignal["source"];
  status: RiskSignalStatus;
  dedupeKey: string;
  generation: number;
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
  resolution: { by: string; at: string | null; note: string } | null;
}

/** An audit event as the admin API returns it. */
export interface RiskSignalEventJson {
  id: string;
  seq: number;
  at: string | null;
  actorId: string;
  actorRole: string;
  action: RiskSignalEventAction;
  fromStatus: RiskSignalStatus | null;
  toStatus: RiskSignalStatus;
  note: string | null;
}

/** Filters of the admin list (already validated by the controller). */
export interface ListRiskSignalsQuery {
  status?: RiskSignalStatus;
  category?: RiskSignalCategory;
  type?: string;
  subjectType?: RiskSignalSubjectType;
  severity?: RiskSignalSeverity;
  limit: number;
  /** The last signal id of the previous page (its `nextCursor`). */
  cursor?: string;
}

/** A status change requested by an admin. */
export interface ChangeRiskSignalStatusInput {
  status: RiskSignalStatus;
  /** The reason. Required for actioned, dismissed and a reopen. */
  note?: unknown;
  /** The signal revision the admin was looking at. */
  expectedRevision: number;
  /** Must be true to move a resolved signal back to open. */
  reopen?: boolean;
}

/** Who is making a status change (from the verified token, never the body). */
export interface RiskSignalActor {
  uid: string;
  role: string;
}

/**
 * A refused operation, with the HTTP status the controller should send.
 *  - NOT_FOUND 404, INVALID_CURSOR 400
 *  - NOTE_REQUIRED 400, INVALID_TRANSITION 400
 *  - REVISION_MISMATCH 409 (someone else changed the signal first)
 *  - SUPERSEDED 409 (a newer signal exists for the same key)
 */
export class RiskSignalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number
  ) {
    super(message);
    this.name = "RiskSignalError";
  }
}

/** One structured log line. Ids, enums and counts only: never evidence. */
interface RiskSignalLogEntry {
  event: "risk_signal";
  action: "created" | "merged" | "unchanged" | "suppressed" | RiskSignalEventAction;
  signalId: string;
  category?: RiskSignalCategory;
  type?: string;
  severity?: RiskSignalSeverity;
  fromStatus?: RiskSignalStatus | null;
  toStatus?: RiskSignalStatus;
  evidenceCount?: number;
  revision?: number;
}

// ============================================
// PURE HELPERS
// ============================================

/**
 * Document id of the signal for `dedupeKey` at `generation`. The key is
 * hashed because it may contain `/` and `:` (not valid in a doc id), and so
 * the id reveals nothing about the key.
 */
export function riskSignalId(dedupeKey: string, generation: number): string {
  const hash = createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
  return `${hash}-${generation}`;
}

/** Event doc id for a sequence number: zero-padded so ids sort in order. */
function eventId(seq: number): string {
  return String(seq).padStart(6, "0");
}

/** Reference string for a subject, used when a subject appears as evidence. */
function subjectRef(subject: RiskSignalSubject): string {
  return `${subject.type}/${subject.id}`;
}

/** Position of a severity in low < medium < high. */
function severityRank(severity: RiskSignalSeverity): number {
  return RISK_SIGNAL_SEVERITIES.indexOf(severity);
}

/** Firestore Timestamp -> ISO string (null for anything else). */
function iso(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

/**
 * A stored signal -> API JSON. Built field by field (a whitelist), so a
 * field added to the document later is not exposed by accident.
 */
function signalJson(id: string, data: RiskSignal): RiskSignalJson {
  return {
    id,
    subject: { type: data.subject.type, id: data.subject.id },
    category: data.category,
    type: data.type,
    severity: data.severity,
    evidence: (data.evidence ?? []).map((e) => ({ ...e })),
    source: { ...data.source },
    status: data.status,
    dedupeKey: data.dedupeKey,
    generation: data.generation,
    revision: data.revision,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    resolution: data.resolution
      ? { by: data.resolution.by, at: iso(data.resolution.at), note: data.resolution.note }
      : null,
  };
}

/** A stored event -> API JSON. */
function eventJson(id: string, data: RiskSignalEvent): RiskSignalEventJson {
  return {
    id,
    seq: data.seq,
    at: iso(data.at),
    actorId: data.actorId,
    actorRole: data.actorRole,
    action: data.action,
    fromStatus: data.fromStatus ?? null,
    toStatus: data.toStatus,
    note: data.note ?? null,
  };
}

// ============================================
// SERVICE
// ============================================

export class RiskSignalService {
  /** Transaction runner. Swapped for an in-memory one in the unit tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Clock (ms). Swappable in tests. */
  realClock: () => number = Date.now;

  /** Structured log writer. Swappable in tests (which assert nothing sensitive is logged). */
  log: (entry: RiskSignalLogEntry) => void = (entry) => logger.info("risk_signal", entry);

  // ---------- Refs ----------

  /** The `riskSignals/{id}` doc ref. */
  private signalRef(id: string) {
    return collections.riskSignals.doc(id);
  }

  /** The `riskSignals/{id}/events/{seq}` doc ref for a new event. */
  private eventRef(signalId: string, seq: number) {
    return this.signalRef(signalId).collection(EVENTS_SUBCOLLECTION).doc(eventId(seq));
  }

  /**
   * Build an audit event. Events are only ever CREATED (tx.set on a new
   * `seq` id, inside the same transaction as the change they record).
   */
  private newEvent(
    seq: number,
    at: Timestamp,
    actor: RiskSignalActor,
    action: RiskSignalEventAction,
    fromStatus: RiskSignalStatus | null,
    toStatus: RiskSignalStatus,
    note: string | null
  ): RiskSignalEvent {
    return { id: eventId(seq), seq, at, actorId: actor.uid, actorRole: actor.role, action, fromStatus, toStatus, note };
  }

  // ============================================
  // RAISE (internal callers only)
  // ============================================

  /**
   * Raise a risk signal for an admin to review.
   *
   * Idempotent on `input.dedupeKey`:
   *  - no signal for the key yet -> a new `open` signal + a `raised` event;
   *  - the latest signal for the key is open / in_review -> evidence not yet
   *    on it is merged in (one `evidence_added` event); nothing new -> no
   *    write at all;
   *  - the latest signal was resolved by an admin (dismissed or actioned) ->
   *    it is NOT reopened. Only when the raise names a subject or an evidence
   *    ref that no earlier signal for this key had is a NEW signal created,
   *    carrying a `related_signal` evidence item that points at the resolved
   *    one. Otherwise nothing is written.
   *
   * Throws RiskSignalValidationError (nothing written) for a bad input.
   * Sends no notification and touches no document outside `riskSignals`.
   */
  async raiseRiskSignal(input: RaiseRiskSignalInput): Promise<RaiseRiskSignalResult> {
    // Validate first: a throw here means no read and no write happened.
    const clean = validateRaiseInput(input);
    const now = Timestamp.fromMillis(this.realClock());
    const system: RiskSignalActor = { uid: RISK_SIGNAL_SYSTEM_ACTOR, role: RISK_SIGNAL_SYSTEM_ACTOR };

    const { result, logEntry } = await this.runTransaction(async (tx) => {
      // ---- Reads (all before any write, as Firestore requires) ----
      // Walk the generations for this key until the first id that is free.
      const generations: RiskSignal[] = [];
      let nextGeneration: number | null = null;
      for (let g = 1; g <= RISK_SIGNAL_LIMITS.maxGenerations; g++) {
        const snap = await tx.get(this.signalRef(riskSignalId(clean.dedupeKey, g)));
        if (!snap.exists) {
          nextGeneration = g;
          break;
        }
        generations.push(snap.data() as RiskSignal);
      }
      const latest = generations[generations.length - 1];

      // ---- Case 1: an active signal exists -> merge into it ----
      if (latest && RISK_SIGNAL_ACTIVE_STATUSES.includes(latest.status)) {
        return this.mergeIntoActive(tx, latest, clean, now, system);
      }

      // ---- Case 2: resolved by an admin -> only new facts make a new signal ----
      if (latest) {
        // Everything any earlier signal for this key already referred to.
        const knownRefs = new Set<string>();
        for (const g of generations) {
          knownRefs.add(subjectRef(g.subject));
          for (const e of g.evidence ?? []) knownRefs.add(e.ref);
        }
        const hasNewFact =
          !knownRefs.has(subjectRef(clean.subject)) || clean.evidence.some((e) => !knownRefs.has(e.ref));
        if (!hasNewFact) {
          return {
            result: { outcome: "suppressed" as const, signalId: latest.id },
            logEntry: { event: "risk_signal" as const, action: "suppressed" as const, signalId: latest.id },
          };
        }
      }

      // ---- Case 3: create a new signal (first one, or after a resolved one) ----
      if (nextGeneration === null) {
        // Every generation slot is used: a rule is re-raising far too often.
        throw new RiskSignalError(
          "TOO_MANY_SIGNALS",
          `A dedupe key may have at most ${RISK_SIGNAL_LIMITS.maxGenerations} signals`,
          409
        );
      }
      const id = riskSignalId(clean.dedupeKey, nextGeneration);
      const evidence = [...clean.evidence];
      // Link to the resolved signal this one follows, so the admin sees the history.
      if (latest) evidence.push({ kind: RISK_SIGNAL_EVIDENCE_KIND_RELATED, ref: `riskSignals/${latest.id}` });
      const doc: RiskSignal = {
        id,
        subject: clean.subject,
        category: clean.category,
        type: clean.type,
        severity: clean.severity,
        evidence,
        source: clean.source,
        status: "open",
        dedupeKey: clean.dedupeKey,
        generation: nextGeneration,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      tx.set(this.signalRef(id), doc);
      // The note names what raised it (rule key + version): ids only.
      const raisedBy = [clean.source.kind, clean.source.ruleId, clean.source.version ? `v${clean.source.version}` : undefined]
        .filter(Boolean)
        .join(" ");
      tx.set(this.eventRef(id, 1), this.newEvent(1, now, system, "raised", null, "open", `Raised by ${raisedBy}`));
      return {
        result: { outcome: "created" as const, signalId: id, revision: 1 },
        logEntry: {
          event: "risk_signal" as const,
          action: "created" as const,
          signalId: id,
          category: doc.category,
          type: doc.type,
          severity: doc.severity,
          toStatus: doc.status,
          evidenceCount: evidence.length,
          revision: 1,
        },
      };
    });

    // Log after the transaction committed (a retried transaction logs once).
    this.log(logEntry);
    return result;
  }

  /**
   * Merge a re-raise into the active signal for its key (inside the raise
   * transaction). Adds evidence items the signal does not have yet (same
   * kind + ref = same fact), keeps the higher severity, and writes ONE
   * `evidence_added` event. Writes nothing when the raise adds nothing.
   */
  private mergeIntoActive(
    tx: Transaction,
    existing: RiskSignal,
    clean: RaiseRiskSignalInput,
    now: Timestamp,
    system: RiskSignalActor
  ): { result: RaiseRiskSignalResult; logEntry: RiskSignalLogEntry } {
    const current = existing.evidence ?? [];
    const have = new Set(current.map(evidenceKey));
    const incoming = [...clean.evidence];
    // A re-raise with the same key about a different subject: keep the
    // signal's subject and record the other one as evidence.
    if (subjectRef(clean.subject) !== subjectRef(existing.subject)) {
      incoming.push({ kind: RISK_SIGNAL_EVIDENCE_KIND_SUBJECT, ref: subjectRef(clean.subject) });
    }
    const fresh = incoming.filter((e) => !have.has(evidenceKey(e)));
    // Respect the per-signal cap: what does not fit is dropped (and counted in the event note).
    const room = Math.max(0, RISK_SIGNAL_LIMITS.maxEvidencePerSignal - current.length);
    const added = fresh.slice(0, room);
    const dropped = fresh.length - added.length;
    const severityRaised = severityRank(clean.severity) > severityRank(existing.severity);

    if (added.length === 0 && !severityRaised) {
      return {
        result: { outcome: "unchanged", signalId: existing.id },
        logEntry: { event: "risk_signal", action: "unchanged", signalId: existing.id },
      };
    }

    const revision = existing.revision + 1;
    const severity = severityRaised ? clean.severity : existing.severity;
    tx.update(this.signalRef(existing.id), {
      evidence: [...current, ...added],
      severity,
      revision,
      updatedAt: now,
    });
    // System-written summary: counts and enum values only.
    const parts = [`${added.length} evidence item(s) added`];
    if (dropped > 0) parts.push(`${dropped} not stored (limit ${RISK_SIGNAL_LIMITS.maxEvidencePerSignal})`);
    if (severityRaised) parts.push(`severity ${existing.severity} -> ${clean.severity}`);
    tx.set(
      this.eventRef(existing.id, revision),
      this.newEvent(revision, now, system, "evidence_added", existing.status, existing.status, parts.join("; "))
    );
    return {
      result: { outcome: "merged", signalId: existing.id, revision, evidenceAdded: added.length },
      logEntry: {
        event: "risk_signal",
        action: "merged",
        signalId: existing.id,
        category: existing.category,
        type: existing.type,
        severity,
        toStatus: existing.status,
        evidenceCount: current.length + added.length,
        revision,
      },
    };
  }

  // ============================================
  // ADMIN QUEUE: READS
  // ============================================

  /**
   * One page of signals, newest first (createdAt desc).
   *
   * Every filter is an equality on one field followed by the same sort, so
   * firestore.indexes.json carries a composite index (equality fields in
   * query order, then createdAt DESC) for each combination the admin UI can
   * send: status, category, type, subject.type, severity, and the
   * status+category, status+type, status+subject.type, status+severity,
   * category+type and status+category+type combinations. No filter at all
   * uses the automatic single-field index on createdAt.
   *
   * Cursor = the last signal id of the previous page.
   */
  async listSignals(q: ListRiskSignalsQuery): Promise<{ items: RiskSignalJson[]; nextCursor: string | null }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = collections.riskSignals;
    if (q.status) query = query.where("status", "==", q.status);
    if (q.category) query = query.where("category", "==", q.category);
    if (q.type) query = query.where("type", "==", q.type);
    if (q.subjectType) query = query.where("subject.type", "==", q.subjectType);
    if (q.severity) query = query.where("severity", "==", q.severity);
    query = query.orderBy("createdAt", "desc");
    if (q.cursor) {
      const cursorSnap = await this.signalRef(q.cursor).get();
      if (!cursorSnap.exists) throw new RiskSignalError("INVALID_CURSOR", "cursor does not match a signal", 400);
      query = query.startAfter(cursorSnap);
    }
    // One extra row tells us whether another page exists.
    const snap = await query.limit(q.limit + 1).get();
    const docs = snap.docs.slice(0, q.limit) as { id: string; data: () => unknown }[];
    return {
      items: docs.map((d) => signalJson(d.id, d.data() as RiskSignal)),
      nextCursor: snap.docs.length > q.limit ? docs[docs.length - 1].id : null,
    };
  }

  /** One signal with its audit trail (oldest event first), or null when it does not exist. */
  async getSignal(id: string): Promise<{ signal: RiskSignalJson; events: RiskSignalEventJson[] } | null> {
    const ref = this.signalRef(id);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const eventsSnap = await ref.collection(EVENTS_SUBCOLLECTION).orderBy("seq", "asc").limit(MAX_EVENTS_RETURNED).get();
    return {
      signal: signalJson(snap.id, snap.data() as RiskSignal),
      events: eventsSnap.docs.map((d) => eventJson(d.id, d.data() as RiskSignalEvent)),
    };
  }

  // ============================================
  // ADMIN QUEUE: STATUS CHANGE
  // ============================================

  /**
   * Record an admin's decision on a signal. This ONLY records it: nothing is
   * sent to the subject and no other document is written.
   *
   * Allowed: open -> in_review; open | in_review -> actioned | dismissed
   * (note required). A resolved signal goes back to open only with
   * `reopen: true` and a note, and only while it is the newest signal for
   * its key.
   *
   * Concurrency: `expectedRevision` must equal the stored revision, checked
   * inside the transaction. When two admins decide at once the second gets
   * 409 REVISION_MISMATCH and nothing is written.
   *
   * Every successful change writes exactly one event with the admin's uid.
   */
  async changeStatus(id: string, input: ChangeRiskSignalStatusInput, actor: RiskSignalActor): Promise<RiskSignalJson> {
    // ---- Checks that need no read ----
    let note: string | null;
    try {
      note = validateStatusNote(input.note);
    } catch (error) {
      if (error instanceof RiskSignalValidationError) throw new RiskSignalError("VALIDATION_ERROR", error.message, 400);
      throw error;
    }
    const target = input.status;
    const isReopen = input.reopen === true;
    const needsNote = RISK_SIGNAL_RESOLVED_STATUSES.includes(target) || isReopen;
    if (needsNote && !note) {
      throw new RiskSignalError("NOTE_REQUIRED", "A note giving the reason is required for this change", 400);
    }
    if (isReopen && target !== "open") {
      throw new RiskSignalError("INVALID_TRANSITION", "A reopen must set the status to open", 400);
    }

    const now = Timestamp.fromMillis(this.realClock());
    const ref = this.signalRef(id);

    const { updated, logEntry } = await this.runTransaction(async (tx) => {
      // ---- Reads ----
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RiskSignalError("NOT_FOUND", "Signal not found", 404);
      const signal = snap.data() as RiskSignal;
      // For a reopen, also read the next generation's slot (must be empty).
      const nextSnap = isReopen ? await tx.get(this.signalRef(riskSignalId(signal.dedupeKey, signal.generation + 1))) : null;

      // ---- Optimistic concurrency: the admin must have seen this revision ----
      if (signal.revision !== input.expectedRevision) {
        throw new RiskSignalError(
          "REVISION_MISMATCH",
          "This signal was changed by someone else. Reload it and try again.",
          409
        );
      }

      // ---- Is the change allowed? ----
      const from = signal.status;
      if (isReopen) {
        if (!RISK_SIGNAL_RESOLVED_STATUSES.includes(from)) {
          throw new RiskSignalError("INVALID_TRANSITION", "Only an actioned or dismissed signal can be reopened", 400);
        }
        // A newer signal for the same key exists: reopening this one would
        // leave two for one key. The admin should review the newer one.
        if (nextSnap?.exists) {
          throw new RiskSignalError("SUPERSEDED", "A newer signal exists for the same finding. Review that one.", 409);
        }
      } else if (!ALLOWED_TRANSITIONS[from].includes(target)) {
        throw new RiskSignalError("INVALID_TRANSITION", `A signal cannot go from ${from} to ${target}`, 400);
      }

      // ---- Writes: the signal + exactly one event, nothing else ----
      const revision = signal.revision + 1;
      const resolved = RISK_SIGNAL_RESOLVED_STATUSES.includes(target);
      const resolution = resolved ? { by: actor.uid, at: now, note: note as string } : undefined;
      tx.update(ref, {
        status: target,
        revision,
        updatedAt: now,
        // Set on a decision; removed on any other change (a reopen clears it,
        // the decision itself stays in the event trail).
        resolution: resolution ?? FieldValue.delete(),
      });
      const action: RiskSignalEventAction = isReopen ? "reopened" : "status_changed";
      tx.set(this.eventRef(id, revision), this.newEvent(revision, now, actor, action, from, target, note));

      const next: RiskSignal = { ...signal, status: target, revision, updatedAt: now };
      if (resolution) next.resolution = resolution;
      else delete next.resolution;
      return {
        updated: next,
        logEntry: {
          event: "risk_signal" as const,
          action,
          signalId: id,
          fromStatus: from,
          toStatus: target,
          revision,
        },
      };
    });

    this.log(logEntry);
    return signalJson(id, updated);
  }
}

/** The shared instance. Rules call `riskSignalService.raiseRiskSignal(input)`. */
export const riskSignalService = new RiskSignalService();
