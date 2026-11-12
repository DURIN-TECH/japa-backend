/**
 * Target-project guard for `backfill-news-expire-at` (issue #19).
 *
 * The backfill arms irreversible deletes (Firestore TTL removes every doc whose
 * `expireAt` has passed), so it must never run against a project the caller did
 * not name. firebase-admin picks its project from a service-account key's
 * `project_id` FIRST, then GOOGLE_CLOUD_PROJECT, then GCLOUD_PROJECT. A shell
 * that exports a prod key or `GOOGLE_CLOUD_PROJECT=japa-platform` would
 * therefore silently send a `:dev` run to prod if only GCLOUD_PROJECT were set.
 *
 * This module has NO firebase imports on purpose: the CLI must run the guard
 * BEFORE `utils/firebase` initialises the Admin SDK (which happens on import).
 * The decision itself (`decideBackfillTarget`) is pure so it is unit-tested.
 */
import * as fs from "node:fs";

/** Inputs to the pure decision. All come from the environment / argv. */
export interface BackfillTargetInput {
  /** Project the caller asked for (`--project <id>`), if any. */
  asked?: string;
  /** `project_id` read from the GOOGLE_APPLICATION_CREDENTIALS key file, if any. */
  credentialProject?: string;
  /** GOOGLE_CLOUD_PROJECT from the environment. */
  googleCloudProject?: string;
  /** GCLOUD_PROJECT from the environment. */
  gcloudProject?: string;
  /** FIRESTORE_EMULATOR_HOST, when set the SDK talks to the emulator. */
  emulatorHost?: string;
}

/**
 * Wording used in the guard's messages, so another script can reuse the guard
 * and still name ITSELF (issue #148). Defaults keep the expireAt backfill's
 * messages exactly as they were.
 */
export interface GuardWording {
  /** Printed as `<label> ABORTED.` */
  label: string;
  /** The npm command with its arguments, shown in the "no target project" hint. */
  example: string;
}

const NEWS_WORDING: GuardWording = {
  label: "expireAt backfill",
  example:
    "`npm run backfill:expireat -- --project japa-platform` (or use `npm run backfill:expireat:dev`)",
};

/** Outcome of the decision: run (with the project to use) or abort (why). */
export type BackfillTargetDecision =
  | { ok: true; projectId: string; emulator: boolean; message: string }
  | { ok: false; message: string };

/**
 * Decide whether the backfill may run, and against which project.
 *
 *  - Emulator host set: always allowed; the SDK reads the emulator whatever
 *    project is named, and the message says so.
 *  - Otherwise `asked` is mandatory (no silent default to a real project).
 *  - The project the SDK would really use is resolved in firebase-admin's own
 *    order (key file, then GOOGLE_CLOUD_PROJECT, then GCLOUD_PROJECT). If
 *    GCLOUD_PROJECT disagrees with it, that is also a mismatch: the two vars
 *    must not point different tools at different projects.
 *  - Any difference from `asked` aborts. If nothing is set at all the run is
 *    allowed and the caller pins both env vars to `asked` before init.
 */
export function decideBackfillTarget(
  input: BackfillTargetInput,
  wording: GuardWording = NEWS_WORDING
): BackfillTargetDecision {
  if (input.emulatorHost) {
    return {
      ok: true,
      emulator: true,
      projectId: input.asked || input.googleCloudProject || input.gcloudProject || "demo-seli",
      message:
        `Targeting the FIRESTORE EMULATOR (FIRESTORE_EMULATOR_HOST=${input.emulatorHost}). ` +
        "Nothing is written to durin-seli-dev or japa-platform.",
    };
  }

  if (!input.asked) {
    return {
      ok: false,
      message:
        `No target project. Pass --project <id>, e.g. ${wording.example}. Refusing to guess.`,
    };
  }

  // The project firebase-admin would really write to, in its own precedence.
  const resolved = input.credentialProject || input.googleCloudProject || input.gcloudProject;
  const source = input.credentialProject
    ? "the GOOGLE_APPLICATION_CREDENTIALS key file"
    : input.googleCloudProject
      ? "GOOGLE_CLOUD_PROJECT"
      : "GCLOUD_PROJECT";

  if (resolved && resolved !== input.asked) {
    return {
      ok: false,
      message:
        `Project mismatch: you asked for "${input.asked}" but this shell would write to "${resolved}" ` +
        `(taken from ${source}). Aborting before touching anything. ` +
        "Unset GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT or point them at " +
        `"${input.asked}" and run again.`,
    };
  }
  if (input.gcloudProject && input.gcloudProject !== input.asked) {
    return {
      ok: false,
      message:
        `Project mismatch: you asked for "${input.asked}" but GCLOUD_PROJECT is "${input.gcloudProject}". ` +
        "Aborting before touching anything.",
    };
  }

  return {
    ok: true,
    emulator: false,
    projectId: input.asked,
    message: `Targeting project "${input.asked}"${resolved ? ` (confirmed by ${source})` : " (pinned from --project)"}.`,
  };
}

/** Read `project_id` from the service-account key at GOOGLE_APPLICATION_CREDENTIALS, if any. */
export function readCredentialProject(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    return typeof parsed.project_id === "string" ? parsed.project_id : undefined;
  } catch {
    // Unreadable, or not a service-account key (e.g. authorized_user ADC file): no project to read.
    return undefined;
  }
}

/** Parse `--project <id>` / `--project=<id>` / `-p <id>` from argv. */
export function parseProjectArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") return argv[i + 1];
    if (a.startsWith("--project=")) return a.slice("--project=".length);
  }
  return undefined;
}

/**
 * CLI helper: run the guard against the real environment. Prints the target,
 * exits non-zero on a mismatch, and on success pins both env vars to the
 * confirmed project so the Admin SDK (initialised right after) uses it.
 */
export function enforceBackfillTarget(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  wording: GuardWording = NEWS_WORDING
): string {
  const decision = decideBackfillTarget(
    {
      asked: parseProjectArg(argv),
      credentialProject: readCredentialProject(env.GOOGLE_APPLICATION_CREDENTIALS),
      googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
      gcloudProject: env.GCLOUD_PROJECT,
      emulatorHost: env.FIRESTORE_EMULATOR_HOST,
    },
    wording
  );
  if (!decision.ok) {
    console.error(`\n${wording.label} ABORTED. ${decision.message}\n`);
    process.exit(1);
  }
  console.log(`\n${decision.message}\n`);
  env.GCLOUD_PROJECT = decision.projectId;
  env.GOOGLE_CLOUD_PROJECT = decision.projectId;
  return decision.projectId;
}
