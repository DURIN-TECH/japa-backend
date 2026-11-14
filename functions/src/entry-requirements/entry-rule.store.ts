import { Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../utils/firebase";
import { assertStorableEntryRule } from "./entry-rule-validate";
import type { EntryRule, EntryRuleHead, EntryRuleRun } from "../types/entry-requirements";

// ============================================
// ENTRY RULES — STORAGE (issue #236, P7 of #228)
// ============================================
//
// Three backend-only collections (no firestore.rules match, so every client
// is denied; pinned by test/emulator/backend-only-collections.emu.ts):
//   - entryRules/{ruleId}        one sourced rule;
//   - entryRuleHeads/{authority} which run is SERVED for an issuing authority;
//   - entryRuleRuns/{runId}      one record per drafting run (admin review data).
//
// PUBLISHING IS ONE WRITE. A run's rules are written first (status
// `published` on a run that passed every safeguard), and they are served only
// once the head's `publishedRunId` names that run. The head switch is a single
// document write, so the lookup sees either the old run or the new one, never
// a mix. The previous run's rules are then marked `superseded` (history; the
// lookup already ignores them because the head moved on).
//
// EVERY RULE WRITE IS VALIDATED (`assertStorableEntryRule`): a rule without a
// verbatim quote and its official URL never reaches Firestore.
//
// Queries and their indexes (firestore.indexes.json):
//   - destinationCodes array-contains + status ==   (composite index)
//   - destination.kind == + status ==               (equality only: merged single-field indexes)
//   - runId == + status ==                          (equality only)
//   - startedOn ==                                  (single field)
//   - issuingAuthorityId == + status ==             (admin list; equality only)

/** Most writes in one Firestore batch (the limit is 500; leave room). */
const BATCH_WRITES = 400;

/** Firestore rejects `undefined`: drop those keys (one level is enough for our shapes). */
function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** What the drafting pipeline and the lookup need from storage (faked in tests). */
export interface EntryRuleStore {
  /** Published rules whose `countries` scope lists `countryCode`. */
  publishedForCountry(countryCode: string): Promise<EntryRule[]>;
  /** Published rules whose scope is "every member of an authority". */
  publishedMembersOfScopes(): Promise<EntryRule[]>;
  /** The heads of these authorities (missing ones are absent from the map). */
  heads(authorityIds: readonly string[]): Promise<Map<string, EntryRuleHead>>;
  /** Drafting runs started on a UTC day (the per-day cap). */
  runsStartedOn(day: string): Promise<number>;
  /** Number of rules the authority serves now (the shrink guard). */
  servedCount(authorityId: string): Promise<number>;
  /** Store a run, its rules and (when `publish`) switch the head to it. */
  saveRun(run: EntryRuleRun, rules: EntryRule[], opts: { publish: boolean; sourceUrls: string[] }): Promise<void>;
  /** Admin review: rules of an authority (any status), newest run first. */
  listRules(filter: { authorityId?: string; status?: string; limit: number }): Promise<EntryRule[]>;
  /** Admin review: the latest runs. */
  listRuns(filter: { authorityId?: string; limit: number }): Promise<EntryRuleRun[]>;
}

/** Firestore implementation. */
export class FirestoreEntryRuleStore implements EntryRuleStore {
  /** @inheritdoc */
  async publishedForCountry(countryCode: string): Promise<EntryRule[]> {
    const snap = await collections.entryRules
      .where("destinationCodes", "array-contains", countryCode)
      .where("status", "==", "published")
      .get();
    return snap.docs.map((d) => d.data() as EntryRule);
  }

  /** @inheritdoc */
  async publishedMembersOfScopes(): Promise<EntryRule[]> {
    const snap = await collections.entryRules.where("destination.kind", "==", "members_of").where("status", "==", "published").get();
    return snap.docs.map((d) => d.data() as EntryRule);
  }

  /** @inheritdoc */
  async heads(authorityIds: readonly string[]): Promise<Map<string, EntryRuleHead>> {
    const out = new Map<string, EntryRuleHead>();
    // One read per authority; a destination involves a handful at most.
    const snaps = await Promise.all([...new Set(authorityIds)].map((id) => collections.entryRuleHeads.doc(id).get()));
    for (const s of snaps) if (s.exists) out.set(s.id, s.data() as EntryRuleHead);
    return out;
  }

  /** @inheritdoc */
  async runsStartedOn(day: string): Promise<number> {
    const snap = await collections.entryRuleRuns.where("startedOn", "==", day).get();
    return snap.size;
  }

  /** @inheritdoc */
  async servedCount(authorityId: string): Promise<number> {
    const head = (await this.heads([authorityId])).get(authorityId);
    return head?.publishedRunId ? head.publishedRuleCount : 0;
  }

  /** @inheritdoc */
  async saveRun(run: EntryRuleRun, rules: EntryRule[], opts: { publish: boolean; sourceUrls: string[] }): Promise<void> {
    // ---- 1. validate EVERY rule before anything is written (all or nothing) ----
    for (const r of rules) assertStorableEntryRule(r);
    // ---- 2. the rules, in batches ----
    for (let i = 0; i < rules.length; i += BATCH_WRITES) {
      const batch = db.batch();
      for (const r of rules.slice(i, i + BATCH_WRITES)) batch.set(collections.entryRules.doc(r.id), clean(r));
      await batch.commit();
    }
    // ---- 3. the run record ----
    await collections.entryRuleRuns.doc(run.id).set(clean(run));
    // ---- 4. the head: the ONE write that makes a run served ----
    const headRef = collections.entryRuleHeads.doc(run.authorityId);
    const before = await headRef.get();
    const prev = before.exists ? (before.data() as EntryRuleHead) : null;
    const now = Timestamp.now();
    const head: EntryRuleHead = {
      authorityId: run.authorityId,
      publishedRunId: opts.publish ? run.id : prev?.publishedRunId ?? null,
      publishedAt: opts.publish ? now : prev?.publishedAt ?? null,
      publishedRuleCount: opts.publish ? rules.filter((r) => r.status === "published").length : prev?.publishedRuleCount ?? 0,
      lastRunId: run.id,
      lastRunStatus: run.status,
      // Registered pages are kept even for a held run: they are the official
      // pages an `unknown` answer links to.
      sourceUrls: [...new Set([...opts.sourceUrls, ...(prev?.sourceUrls ?? [])])],
      updatedAt: now,
    };
    await headRef.set(head);
    // ---- 5. history: the previous run's rules are no longer served ----
    if (opts.publish && prev?.publishedRunId && prev.publishedRunId !== run.id) {
      const old = await collections.entryRules.where("runId", "==", prev.publishedRunId).where("status", "==", "published").get();
      for (let i = 0; i < old.docs.length; i += BATCH_WRITES) {
        const batch = db.batch();
        for (const d of old.docs.slice(i, i + BATCH_WRITES)) batch.update(d.ref, { status: "superseded" });
        await batch.commit();
      }
    }
  }

  /** @inheritdoc */
  async listRules(filter: { authorityId?: string; status?: string; limit: number }): Promise<EntryRule[]> {
    let q: FirebaseFirestore.Query = collections.entryRules;
    if (filter.authorityId) q = q.where("issuingAuthorityId", "==", filter.authorityId);
    if (filter.status) q = q.where("status", "==", filter.status);
    const snap = await q.limit(filter.limit).get();
    return snap.docs.map((d) => d.data() as EntryRule);
  }

  /** @inheritdoc */
  async listRuns(filter: { authorityId?: string; limit: number }): Promise<EntryRuleRun[]> {
    let q: FirebaseFirestore.Query = collections.entryRuleRuns;
    if (filter.authorityId) q = q.where("authorityId", "==", filter.authorityId);
    const snap = await q.limit(filter.limit).get();
    // Newest first (sorted in code: no extra index for an admin list).
    return snap.docs.map((d) => d.data() as EntryRuleRun).sort((a, b) => b.startedAt.toMillis() - a.startedAt.toMillis());
  }
}

/** The shared instance. */
export const entryRuleStore: EntryRuleStore = new FirestoreEntryRuleStore();
