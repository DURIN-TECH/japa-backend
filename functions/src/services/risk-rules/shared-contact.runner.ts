// ============================================
// Rule 1 runner: load data, run the pure rule, raise a signal (issue #121)
// ============================================
//
// SAFETY (non-negotiable, see #121):
//  - The only write this file can cause is riskSignalService.raiseRiskSignal().
//  - It never calls notifyUser, writes `notifications`, sends email or push,
//    changes a user / application / agency field, blocks anything, or reads
//    `messages`. It reads `users`, `applications`, `agents` and `agencies`.
//  - It never throws to its caller: a failure is logged WITHOUT personal data
//    (no value, no email, no phone) and swallowed, so the write that triggered
//    it is never affected.

import * as logger from "firebase-functions/logger";
import { collections } from "../../utils/firebase";
import { riskSignalService } from "../risk-signal.service";
import type { RaiseRiskSignalInput, RiskSignalEvidence } from "../../types/risk-signal";
import { ContactKind, contactKey, hashContact } from "./contact-normalise";
import { assertRegistryValid } from "./registry";
import {
  SHARED_CONTACT_SIGNAL_TYPE,
  SharedContactAccount,
  SharedContactFinding,
  sharedContactRule,
} from "./shared-contact.rule";

/** Firestore `in` queries take at most 30 values (we stay under it). */
const IN_CHUNK = 30;

/** User fields that carry a contact value, and the kind each one is. */
export const CONTACT_FIELDS: ReadonlyArray<{ field: "phone" | "email"; kind: ContactKind }> = [
  { field: "phone", kind: "phone" },
  { field: "email", kind: "email" },
];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ============================================
// LOADING
// ============================================

/**
 * Load the accounts for the given user ids: which are staff, and which
 * applications each is the applicant on. Reads only; single-field queries, so
 * no composite index is needed.
 */
export async function loadSharedContactAccounts(userIds: string[]): Promise<SharedContactAccount[]> {
  const ids = [...new Set(userIds)];
  const staff = new Set<string>();
  const apps = new Map<string, string[]>();

  for (const part of chunk(ids, IN_CHUNK)) {
    const [agents, agencies, applications] = await Promise.all([
      collections.agents.where("userId", "in", part).get(), // agents (incl. agency members)
      collections.agencies.where("ownerId", "in", part).get(), // agency owners
      collections.applications.where("userId", "in", part).get(), // applicant accounts
    ]);
    for (const d of agents.docs) staff.add((d.data() as { userId: string }).userId);
    for (const d of agencies.docs) staff.add((d.data() as { ownerId: string }).ownerId);
    for (const d of applications.docs) {
      const uid = (d.data() as { userId: string }).userId;
      apps.set(uid, [...(apps.get(uid) ?? []), d.id]);
    }
  }

  return ids.map((userId) => ({ userId, isStaff: staff.has(userId), applicationIds: apps.get(userId) ?? [] }));
}

/**
 * Ids of every user whose profile carries this value, found by an equality
 * query on the stored field. Candidates are the normalised key plus any raw
 * stored forms the caller knows about (the triggering document's own value),
 * so differently formatted copies of one number are found when they were
 * written the same way. The backfill script scans every user and normalises
 * in memory, so it catches the rest.
 */
export async function findUserIdsByContact(field: "phone" | "email", candidates: string[]): Promise<string[]> {
  const values = [...new Set(candidates.filter(Boolean))].slice(0, 10); // `in` allows 10 here
  if (values.length === 0) return [];
  const snap = await collections.users.where(field, "in", values).get();
  return snap.docs.map((d) => d.id);
}

// ============================================
// RAISING
// ============================================

/**
 * Evidence for a finding: ids, the count and the hash, never the raw value.
 * One raise carries at most 20 items (#119): the hash, a count item, then ids.
 * The count item's ref includes the count, so when a cluster grows from N to
 * N+1 the new count is NEW evidence and the one signal is updated.
 */
export function buildSharedContactEvidence(f: SharedContactFinding): RiskSignalEvidence[] {
  const evidence: RiskSignalEvidence[] = [
    { kind: "shared_contact", ref: f.hash, note: `${f.kind} value shared by several accounts`, count: f.accountCount },
    { kind: "account_count", ref: `${f.hash}#n${f.accountCount}`, count: f.accountCount },
  ];
  for (const id of f.userIds.slice(0, 9)) evidence.push({ kind: "user", ref: `users/${id}` });
  for (const id of f.applicationIds.slice(0, 9)) evidence.push({ kind: "application", ref: `applications/${id}` });
  return evidence;
}

/** Build the #119 input for a finding. Exported so a test can inspect it. */
export function buildSharedContactSignalInput(f: SharedContactFinding): RaiseRiskSignalInput {
  return {
    // A cluster has no single subject; use the first account (sorted). Other
    // accounts are evidence, and the service records a differing subject on
    // a later raise as evidence too.
    subject: { type: "user", id: f.userIds[0] },
    category: sharedContactRule.category,
    type: SHARED_CONTACT_SIGNAL_TYPE,
    severity: "medium",
    evidence: buildSharedContactEvidence(f),
    source: {
      kind: "rule",
      ruleId: sharedContactRule.ruleId,
      version: sharedContactRule.version,
      sourceUrl: sharedContactRule.sourceUrl,
      sourceQuote: sharedContactRule.sourceQuote,
    },
    // Derived from the hash of the value only: a growing cluster updates one signal.
    dedupeKey: `${sharedContactRule.ruleId}:${f.kind}:${f.hash.replace("sha256:", "")}`,
  };
}

/**
 * Evaluate one contact value across the given users and raise a signal when
 * the rule fires. Returns what happened for logging / the backfill summary.
 * NEVER throws.
 */
export async function evaluateSharedContact(
  kind: ContactKind,
  key: string,
  userIds: string[]
): Promise<"raised" | "none" | "error"> {
  try {
    assertRegistryValid(); // no rule runs without a source quote + URL
    if (!key) return "none";
    const accounts = await loadSharedContactAccounts(userIds);
    const finding = sharedContactRule.evaluate({ kind, key, accounts });
    if (!finding) return "none";
    await riskSignalService.raiseRiskSignal(buildSharedContactSignalInput(finding));
    return "raised";
  } catch (error) {
    // PII-free log: rule, field kind, error class. Not the value, not the message
    // (a Firestore message can echo query values).
    logger.error("risk_rule_failed", {
      ruleId: sharedContactRule.ruleId,
      kind,
      error: error instanceof Error ? error.name : "unknown",
      code: (error as { code?: string | number } | undefined)?.code,
    });
    return "error";
  }
}

/**
 * Trigger entry point: a `users/{id}` document changed. For each contact field
 * whose value changed (or is new), look for the cluster and evaluate it.
 * `before` / `after` are the plain document data (before is undefined on create).
 * NEVER throws.
 */
export async function onUserContactWritten(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): Promise<void> {
  try {
    if (!after) return; // deleted: nothing to look for
    for (const { field, kind } of CONTACT_FIELDS) {
      if (before && before[field] === after[field]) continue; // unchanged field
      const key = contactKey(kind, after[field]);
      if (!key) continue; // empty, malformed or placeholder
      const raw = typeof after[field] === "string" ? (after[field] as string) : "";
      const ids = await findUserIdsByContact(field, [key, raw.trim(), raw]);
      await evaluateSharedContact(kind, key, ids);
    }
  } catch (error) {
    logger.error("risk_rule_failed", {
      ruleId: sharedContactRule.ruleId,
      stage: "trigger",
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export { hashContact };
