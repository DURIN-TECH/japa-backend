// ============================================
// MIGRATION PROJECT GUARD (issue #239, P10 of #228) — pure, no Firebase import
// ============================================
//
// The shared-visa migration rewrites data, so it must NEVER run against the
// wrong project. Rules, all enforced before any Firebase module is loaded:
//
//  1. A project must be named with `--project <id>` (or `--project=<id>`).
//     No flag, no run. The machine's default project is NEVER used: on the
//     owner's machine that default is production.
//  2. Production (`japa-platform`) is refused outright. There is no override
//     flag: production is migrated by a separate, deliberate decision (the
//     issue's out-of-scope list), with a different change to this script.
//  3. Only the shared dev project and emulator/demo projects are allowed:
//     `durin-seli-dev`, or an id starting with `demo-` (Firebase's convention
//     for a project that cannot be a real one).
//  4. If the environment already names a project (GCLOUD_PROJECT,
//     GOOGLE_CLOUD_PROJECT, or the projectId inside FIREBASE_CONFIG) it must
//     be the SAME as the flag. A disagreement is refused, so an exported
//     production project cannot be silently overridden or silently win.
//
// This file imports nothing, so it can run (and be unit tested) with no
// Firebase credentials and no network.

/** Production project ids: refused, always. */
export const PRODUCTION_PROJECT_IDS: readonly string[] = ["japa-platform"];
/** The only real (non-demo) project the migration may touch. */
export const ALLOWED_REAL_PROJECT_IDS: readonly string[] = ["durin-seli-dev"];

/** Parsed command line. */
export interface MigrationArgs {
  /** The value of `--project`, if given. */
  project?: string;
  /** True unless `--apply` is given without `--dry-run`. */
  dryRun: boolean;
}

/**
 * Parse `--project <id>`, `--project=<id>`, `--apply`, `--dry-run`.
 * Dry run unless `--apply` is present; `--dry-run` wins over `--apply`
 * (same convention as the other one-off scripts).
 */
export function parseMigrationArgs(argv: string[]): MigrationArgs {
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") project = argv[i + 1];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
  }
  const apply = argv.includes("--apply");
  const explicitDryRun = argv.includes("--dry-run");
  return { ...(project !== undefined ? { project } : {}), dryRun: explicitDryRun || !apply };
}

/** The result of the guard: the project to use, or the plain-words refusal. */
export type ProjectCheck = { ok: true; project: string } | { ok: false; message: string };

/** The project ids the environment already names (empty strings dropped). */
function envProjects(env: Record<string, string | undefined>): string[] {
  const out = [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT].filter((v): v is string => !!v);
  if (env.FIREBASE_CONFIG) {
    try {
      const id = (JSON.parse(env.FIREBASE_CONFIG) as { projectId?: unknown }).projectId;
      if (typeof id === "string" && id) out.push(id);
    } catch {
      // FIREBASE_CONFIG may also be a path to a file: nothing to compare.
    }
  }
  return out;
}

/**
 * Decide whether the migration may run for `project`.
 * @param project the `--project` value (undefined when not given)
 * @param env     the process environment (passed in so tests need no real one)
 */
export function checkMigrationProject(project: string | undefined, env: Record<string, string | undefined>): ProjectCheck {
  if (!project || !project.trim()) {
    return { ok: false, message: "No project named. Pass --project <id> (for example --project durin-seli-dev). The machine's default project is never used." };
  }
  const id = project.trim();
  if (PRODUCTION_PROJECT_IDS.includes(id)) {
    return { ok: false, message: `Refusing to run against PRODUCTION project "${id}". This migration is for dev data only.` };
  }
  if (!ALLOWED_REAL_PROJECT_IDS.includes(id) && !id.startsWith("demo-")) {
    return { ok: false, message: `Refusing project "${id}": only ${ALLOWED_REAL_PROJECT_IDS.join(", ")} or an emulator project (demo-...) is allowed.` };
  }
  const conflicting = envProjects(env).filter((p) => p !== id);
  if (conflicting.length > 0) {
    return {
      ok: false,
      message: `The environment names project "${conflicting[0]}" but --project is "${id}". Unset GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT / FIREBASE_CONFIG or make them match, so there is no doubt which project is written.`,
    };
  }
  return { ok: true, project: id };
}
