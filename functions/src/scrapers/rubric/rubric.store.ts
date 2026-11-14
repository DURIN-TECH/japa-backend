import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../utils/firebase";
import type { RubricExtractionRun, RubricHead, VisaRubric } from "../../types/rubric";
import { applyExclusions } from "./rubric-exclusions";
import { keyFieldsOf, rulebookPartsOf, rulebookTargetOf, withKeyParts } from "./rubric-key";

// ============================================
// RUBRIC — FIRESTORE STORE (issue #40)
// ============================================
//
// Layout (all backend-only: no firestore.rules match, clients are denied):
//
//   visaRubrics/{authorityId}_{routeSlug}                  RubricHead
//     (#233: for a country authority that is `{countryCode}_{visaTypeId}`,
//     every key that existed before; for a bloc or treaty it is
//     `{issuingAuthorityId}_{sharedRouteId}`. See rubric-key.ts.)
//   visaRubrics/{routeKey}/rubricVersions/{version}        VisaRubric
//   rubricExtractionRuns/{runId}                           RubricExtractionRun
//
// Two guarantees live here, in the only module that touches these paths:
//
//  1. GOVERNANCE. `writePendingVersion` is the only way extraction writes a
//     rubric, and it refuses anything that is not `pending_review` with every
//     review field at its initial value. It never sets `approvedVersion`.
//     There is no method here that approves, publishes or edits a version:
//     review is #125.
//  2. CONSUMERS ONLY SEE APPROVED RUBRICS. `getApprovedRubric` is the one
//     read a consumer (the assessment engine, intake, the checklist) may use.
//     It follows the head's `approvedVersion` and then RE-CHECKS the version
//     doc's own `reviewStatus`, so a head pointing at a pending or rejected
//     version (a bug, a half-finished write) still yields nothing. The
//     `...ForReview` reads return any status and are for the admin review API
//     only; they must never be wired to a client-facing route.
//
// Immutable versions: a version doc is only ever created. A version number
// that already exists is refused, never overwritten.
//
// (#233) NO DATA MOVE. Every read below passes the document through
// `withKeyParts`, so a head or version written before #233 (only
// `countryCode` + `visaTypeId`) reads with `authorityId` + `routeSlug` filled
// in from them, in memory. Nothing is ever rewritten to add them.

/**
 * Head doc id of a route. Both parts are checked so neither can carry a `/`.
 * The country code must be two UPPER-CASE letters, as the catalogue stores
 * it: a lower-case code is refused rather than folded, so one route can
 * never end up under two keys.
 */
export function rubricRouteKey(countryCode: string, visaTypeId: string): string {
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error(`Invalid country code (two upper-case letters expected): ${JSON.stringify(countryCode)}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(visaTypeId)) throw new Error(`Invalid visa type id: ${JSON.stringify(visaTypeId)}`);
  return `${countryCode}_${visaTypeId}`;
}

/**
 * (#233) Head doc id of ANY rulebook: `{authorityId}_{routeSlug}`, checked by
 * the authority id rules (authorities/authority-ids.ts), so neither part can
 * carry a `/` or an extra `_` in the authority. For a country authority this
 * equals `rubricRouteKey(countryCode, visaTypeId)`.
 * @throws Error for invalid parts.
 */
export function rulebookKeyOf(authorityId: string, routeSlug: string): string {
  return rulebookTargetOf({ authorityId, routeSlug }).routeKey;
}

/** Thrown when a write would break the governance or immutability rules. */
export class RubricStoreError extends Error {
  constructor(
    readonly code: "not_pending" | "version_exists" | "route_mismatch",
    message: string
  ) {
    super(message);
    this.name = "RubricStoreError";
  }
}

/** What `writePendingVersion` did. */
export type PendingWriteResult =
  | { written: true; version: number }
  // The head already records a version for this exact set of snapshots
  // (another run got there first): nothing was written.
  | { written: false; version: number }
  // (#216) The caller's `guard.read` refused inside the transaction (the
  // background job had already finished, was cancelled, or lost its lease):
  // nothing was written. `version` is the head's newest version.
  | { written: false; version: number; guarded: true };

/**
 * (#216) A caller's own writes joined to the version write, in the SAME
 * transaction. The background job uses it to make "write the version" and
 * "mark the job done" ONE atomic step: a re-delivered trigger or a resumed job
 * finds the job already done and writes nothing, so a version can never be
 * written twice for one job (a forced draft would otherwise take the next
 * version number every time).
 */
export interface PendingWriteGuard {
  // Runs after the head is read and before anything is written (a Firestore
  // transaction reads first). Return false to abort the write.
  read: (tx: Transaction) => Promise<boolean>;
  // Runs once the version is certain to be written; add the caller's writes.
  commit: (tx: Transaction, version: number) => void;
}

/** A rubric as built by extraction: everything but the version number. */
export type RubricDraft = Omit<VisaRubric, "version">;

export class RubricStore {
  // Transaction runner; a property so tests can swap in an in-memory one.
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** The head of a route, or null when the route has no rubric yet. */
  async getHead(routeKey: string): Promise<RubricHead | null> {
    const snap = await collections.visaRubrics.doc(routeKey).get();
    // (#233) Old heads read with authorityId / routeSlug filled in (no data move).
    return snap.exists ? withKeyParts(snap.data() as RubricHead) : null;
  }

  /** Every head (the registry of routes that have a rubric). Small. */
  async listHeads(): Promise<RubricHead[]> {
    const snap = await collections.visaRubrics.get();
    return snap.docs.map((d) => withKeyParts(d.data() as RubricHead));
  }

  /**
   * The rubric consumers may use for a route: its APPROVED version, or null.
   * Null when the route has no rubric, when nothing has been approved, and
   * when the version the head points at is not itself marked approved.
   * A pending or rejected version is never returned.
   *
   * The rubric comes back WITHOUT the criteria the reviewer excluded, and
   * without the intake questions and evidence items only those criteria
   * justified (`applyExclusions`, #161). Its `version` is unchanged: the
   * exclusions were decided in the approval that made this version current,
   * so a new set of exclusions is always a new version number, which is what
   * the assessments' staleness check keys on.
   */
  async getApprovedRubric(countryCode: string, visaTypeId: string): Promise<VisaRubric | null> {
    return this.getApprovedRubricByKey(rubricRouteKey(countryCode, visaTypeId));
  }

  /**
   * (#233) The same read for ANY rulebook key (`{authorityId}_{routeSlug}`):
   * a country's own layer or a bloc/treaty's shared layer. The stack loader
   * (rubric-stack.ts) reads every layer through this, so each layer gets
   * exactly the guarantees above (approved only, re-checked, exclusions
   * applied). Throws on a malformed key, like `getApprovedRubric`.
   */
  async getApprovedRubricByKey(routeKey: string): Promise<VisaRubric | null> {
    if (!rulebookPartsOf({ routeKey })) throw new Error(`Invalid rulebook key: ${JSON.stringify(routeKey)}`);
    const head = await this.getHead(routeKey);
    if (!head || head.approvedVersion === null || head.approvedVersion === undefined) return null;
    const snap = await subcollections.rubricVersions(routeKey).doc(String(head.approvedVersion)).get();
    if (!snap.exists) return null;
    // (#233) A version written before #233 reads with its key parts filled in.
    const rubric = withKeyParts(snap.data() as VisaRubric);
    // Belt and braces: trust the version's own status, not just the pointer.
    if (rubric.reviewStatus !== "approved") return null;
    // THE one read-side filter (#161): what the reviewer excluded at approval
    // never reaches a consumer (intake, checklist, assessment, chat, upload
    // check, refusal letter, templates), whichever of them is asking.
    return applyExclusions(rubric);
  }

  /**
   * One version, whatever its review status, UNFILTERED: every criterion the
   * extractor found, plus the stored exclusion fields, so a reviewer always
   * sees everything. ADMIN REVIEW ONLY (#125): never return this from a route
   * a client can call. A background reader that needs a version's EFFECTIVE
   * content must check `reviewStatus === "approved"` and pass it through
   * `applyExclusions` (the bulk re-assessment and rule-change services do).
   */
  async getVersionForReview(routeKey: string, version: number): Promise<VisaRubric | null> {
    const snap = await subcollections.rubricVersions(routeKey).doc(String(version)).get();
    return snap.exists ? withKeyParts(snap.data() as VisaRubric) : null;
  }

  /**
   * Write a freshly extracted rubric as the route's next version, in one
   * transaction with the head:
   *  - the version number is the head's `latestVersion + 1` (1 for a new
   *    route), read inside the transaction, so two runs cannot share one;
   *  - unless `force`, nothing is written when the head already records a
   *    version for the same `sourceSetHash` (the hash gate, re-checked here
   *    against a concurrent run);
   *  - the head's `approvedVersion` is left exactly as it is (null for a new
   *    route): the previously approved version keeps serving.
   *
   * @throws RubricStoreError("not_pending") when the draft is not a pristine
   *   `pending_review` rubric. Extraction can never write an approved one.
   */
  async writePendingVersion(draft: RubricDraft, sourceIds: string[], opts: { force?: boolean; now?: Timestamp; guard?: PendingWriteGuard } = {}): Promise<PendingWriteResult> {
    // Governance guard. Checked on the draft itself, so no caller can slip
    // a decided rubric through this path.
    if (
      draft.reviewStatus !== "pending_review" ||
      draft.intentPolarity !== null ||
      draft.reviewedBy !== null ||
      draft.reviewedAt !== null ||
      draft.rejectReason !== null ||
      draft.supersededAt !== null ||
      draft.revision !== 0 ||
      // Exclusions are an admin decision made at approval (#161): extraction
      // can never hand over a rubric that arrives with some already made.
      draft.excludedCriterionIds !== undefined ||
      draft.exclusionNote !== undefined
    ) {
      throw new RubricStoreError("not_pending", "extraction may only write a pending_review rubric with untouched review fields");
    }
    // (#233) The draft names its rulebook by authorityId + routeSlug (any
    // authority) or, as before, countryCode + visaTypeId; both must agree with
    // its routeKey. A country draft keeps both pairs; a bloc/treaty draft has
    // no country fields.
    let target;
    try {
      target = rulebookTargetOf(draft);
    } catch (err) {
      throw new RubricStoreError("route_mismatch", (err as Error).message);
    }
    const routeKey = target.routeKey;
    if (draft.routeKey !== routeKey) throw new RubricStoreError("route_mismatch", "routeKey does not match authorityId and routeSlug (countryCode and visaTypeId)");

    const now = opts.now ?? Timestamp.now();
    const headRef = collections.visaRubrics.doc(routeKey);
    return this.runTransaction(async (tx) => {
      const headSnap = await tx.get(headRef);
      const head = headSnap.exists ? (headSnap.data() as RubricHead) : null;
      // (#216) The caller's own read comes first: it may veto the whole write.
      if (opts.guard && !(await opts.guard.read(tx))) return { written: false as const, version: head?.latestVersion ?? 0, guarded: true as const };
      if (head && !opts.force && head.latestSourceSetHash === draft.sourceSetHash) {
        return { written: false as const, version: head.latestVersion };
      }
      const version = (head?.latestVersion ?? 0) + 1;
      const versionRef = subcollections.rubricVersions(routeKey).doc(String(version));
      // Immutability guard: a version doc is created once, never replaced.
      const existing = await tx.get(versionRef);
      if (existing.exists) throw new RubricStoreError("version_exists", `rubric version ${routeKey}/${version} already exists`);

      // (#233) Every new version carries authorityId + routeSlug (and the country pair for a country).
      const rubric: VisaRubric = { ...draft, ...keyFieldsOf(target), version };
      tx.set(versionRef, rubric as unknown as Record<string, unknown>);
      opts.guard?.commit(tx, version);
      if (head) {
        // Only the "newest" pointers move. approvedVersion is not in this
        // update at all, so it cannot change here.
        tx.update(headRef, { latestVersion: version, latestSourceSetHash: draft.sourceSetHash, sourceIds, updatedAt: now });
      } else {
        const newHead: RubricHead = {
          // (#233) routeKey + authorityId + routeSlug, and countryCode + visaTypeId for a country only.
          ...keyFieldsOf(target),
          sourceIds,
          approvedVersion: null,
          latestVersion: version,
          latestSourceSetHash: draft.sourceSetHash,
          createdAt: now,
          updatedAt: now,
        };
        tx.set(headRef, newHead as unknown as Record<string, unknown>);
      }
      return { written: true as const, version };
    });
  }

  /** Store a run record under its id. */
  async writeRun(run: RubricExtractionRun): Promise<void> {
    await collections.rubricExtractionRuns.doc(run.runId).set(run as unknown as Record<string, unknown>);
  }

  /**
   * How many runs since `since` REACHED THE MODEL (`reachedModel: true`):
   * still running (`started`), finished either way, or died mid-way. A run
   * refused or failed before its first call is not counted.
   * One range filter on one field: served by the automatic single-field
   * index, no composite index needed. Runs are few, so they are counted here.
   */
  async countRunsSince(since: Timestamp): Promise<number> {
    const snap = await collections.rubricExtractionRuns.where("startedAt", ">=", since).get();
    return snap.docs.filter((d) => (d.data() as RubricExtractionRun).reachedModel === true).length;
  }
}

/** Singleton over the project's Firestore. */
export const rubricStore = new RubricStore();
