import type { GuidanceCrawlSummary } from "./guidance-crawl.service";

// ============================================
// GUIDANCE — SEED RUN GUARDS (issue #111)
// ============================================
//
// The decisions the seed script (scripts/seed-guidance-sources.ts) makes
// about whether a run may START and whether it SUCCEEDED, as pure functions
// so each is unit-tested without a project, an emulator or the network:
//
//  - projectGuardProblems: which project a run may touch. A run can only
//    reach a real project when a human names it twice (the environment and
//    `--confirm-project=`), and a half-configured emulator setup is refused
//    outright, so a local run can never spill into a real project;
//  - unknownSourceIds: an `--only=` id that is not a seed entry is an error,
//    not "nothing to do";
//  - crawlTargetProblems: after a crawl, every source the run was FOR must
//    have ended with a stored snapshot. "Skipped" is not success.
//
// Nothing here knows any project name, source, publisher or route: the
// project rule is the `demo-` prefix (Firebase's convention for a project id
// that can never be a real one).

/** Prefix of a project id that only ever exists in the local emulators. */
export const DEMO_PROJECT_PREFIX = "demo-";

/** What the project guard looks at. */
export interface ProjectGuardInput {
  // GCLOUD_PROJECT and GOOGLE_CLOUD_PROJECT as set ("" / undefined = unset).
  gcloudProject?: string;
  googleCloudProject?: string;
  // FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST as set.
  firestoreEmulatorHost?: string;
  storageEmulatorHost?: string;
  // Value of `--confirm-project=<id>`, when passed.
  confirmProject?: string;
  // True when the run would WRITE (`--apply`, with or without `--crawl`).
  writes: boolean;
}

/** The project a run targets and where it lives. */
export interface ProjectTarget {
  projectId: string;
  // True when both emulators are in use (and the project id is a demo one).
  emulated: boolean;
}

/**
 * Why this run must not start (empty = it may), and the target it resolved.
 *
 * Rules, in order:
 *  1. a project id is required, and the two environment variables must not
 *     disagree (the Admin SDK and the storage bucket name read different ones);
 *  2. the emulators come as a PAIR: the registry lives in Firestore and the
 *     snapshot text in Storage, so one emulator host without the other would
 *     send half the run to a real service;
 *  3. an emulator host with a non-demo project id is refused: emulator runs
 *     use a `demo-` id, so a typo cannot aim real credentials at real data;
 *  4. a `demo-` project id without the emulators is refused: there is no such
 *     real project to talk to;
 *  5. WRITING to a non-demo (real) project needs `--confirm-project=<id>`
 *     equal to the project id. Read-only runs (dry run, `--check-quotes`) do
 *     not need it.
 */
export function projectGuardProblems(input: ProjectGuardInput): { problems: string[]; target: ProjectTarget | null } {
  const problems: string[] = [];
  const gcloud = (input.gcloudProject ?? "").trim();
  const google = (input.googleCloudProject ?? "").trim();
  const firestore = (input.firestoreEmulatorHost ?? "").trim();
  const storage = (input.storageEmulatorHost ?? "").trim();
  const confirm = (input.confirmProject ?? "").trim();

  // 1. One project id.
  const projectId = gcloud || google;
  if (!projectId) {
    return { problems: ["set GCLOUD_PROJECT to the target project (there is no default)"], target: null };
  }
  if (gcloud && google && gcloud !== google) {
    problems.push(`GCLOUD_PROJECT (${gcloud}) and GOOGLE_CLOUD_PROJECT (${google}) name different projects: set one, or make them equal`);
  }
  const demo = projectId.startsWith(DEMO_PROJECT_PREFIX);

  // 2. Both emulators or neither.
  if (!!firestore !== !!storage) {
    const [set, unset] = firestore
      ? ["FIRESTORE_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]
      : ["FIREBASE_STORAGE_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST"];
    problems.push(
      `${set} is set but ${unset} is not: the registry (Firestore) and the snapshot text (Storage) must both be ` +
        "emulated or both be real, never one of each"
    );
  }
  // 3. Emulators only with a demo project id.
  if ((firestore || storage) && !demo) {
    problems.push(
      `an emulator host is set but the project id (${projectId}) does not start with "${DEMO_PROJECT_PREFIX}": ` +
        `use a ${DEMO_PROJECT_PREFIX}* project id with the emulators`
    );
  }
  // 4. A demo project id only with the emulators.
  if (demo && !firestore && !storage) {
    problems.push(
      `the project id (${projectId}) is a ${DEMO_PROJECT_PREFIX}* id but no emulator host is set: ` +
        "set FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST"
    );
  }
  // 5. Writing to a real project is confirmed by naming it again.
  if (!demo && input.writes && confirm !== projectId) {
    problems.push(
      confirm
        ? `--confirm-project=${confirm} does not match the target project (${projectId}): nothing written`
        : `refusing to write to ${projectId}: it is not a ${DEMO_PROJECT_PREFIX}* project. ` +
          `To write to it on purpose, pass --confirm-project=${projectId}`
    );
  }
  // A confirmation that names another project is a mistake even on a
  // read-only or emulator run: say so rather than ignore it.
  if (confirm && confirm !== projectId && (demo || !input.writes)) {
    problems.push(`--confirm-project=${confirm} does not match the target project (${projectId})`);
  }

  return { problems, target: problems.length === 0 ? { projectId, emulated: demo } : null };
}

/** The ids in `only` that are not seed entries (empty = all known). */
export function unknownSourceIds(only: readonly string[] | undefined, seedIds: Iterable<string>): string[] {
  if (!only) return [];
  const known = new Set(seedIds);
  return [...new Set(only)].filter((id) => !known.has(id));
}

/** Outcomes that mean "this source is fine as far as this run is concerned". */
const COMPLETED_OUTCOMES: readonly string[] = ["changed", "unchanged", "not_due"];

/**
 * Why a crawl did not do its job for the sources it was FOR (empty = it did).
 *
 * Every targeted source must have a result line whose outcome is `changed`,
 * `unchanged` or `not_due`, AND a stored snapshot (`latestSnapshotId`). So a
 * source that was skipped (unverified, paused, retired, failing), deferred,
 * failed, hit an infrastructure error, was dropped after an unexpected error
 * (a warning, and no result line) or has simply never been fetched makes the
 * run fail, each with its reason.
 *
 * @param summary           the crawl's summary
 * @param targetIds         the seed ids the run was for (`--only`, or all)
 * @param latestSnapshotIds each target's `latestSnapshotId` AFTER the crawl
 *   (missing or null = no snapshot)
 */
export function crawlTargetProblems(
  summary: Pick<GuidanceCrawlSummary, "results" | "warnings">,
  targetIds: readonly string[],
  latestSnapshotIds: ReadonlyMap<string, string | null>
): string[] {
  const problems: string[] = [];
  for (const id of targetIds) {
    const result = summary.results.find((r) => r.sourceId === id);
    // Warnings about this source (the crawl writes them as "source <id>: ...").
    const warnings = summary.warnings.filter((w) => w.startsWith(`source ${id}:`));
    if (!result) {
      problems.push(`${id}: the crawl produced no result for it${warnings.length ? ` (${warnings.join("; ")})` : ""}`);
      continue;
    }
    if (!COMPLETED_OUTCOMES.includes(result.outcome)) {
      const why = result.error ? `: ${result.error}` : "";
      problems.push(`${id}: outcome ${result.outcome}${result.errorKind ? ` (${result.errorKind})` : ""}${why}`);
      continue;
    }
    if (warnings.length > 0) problems.push(`${id}: ${warnings.join("; ")}`);
    if (!latestSnapshotIds.get(id)) problems.push(`${id}: outcome ${result.outcome} but it has no stored snapshot`);
  }
  return problems;
}
