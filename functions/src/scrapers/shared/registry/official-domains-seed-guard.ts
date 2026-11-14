// ============================================
// OFFICIAL DOMAINS IMPORT — PROJECT GUARD (issue #215, pure)
// ============================================
//
// Decides whether the import script may start, so a stray shell variable can
// never aim it at a real project. A real project can only be written when a
// human names it twice (the environment and `--confirm-project=`). Nothing here
// knows any project name: the rule is the `demo-` prefix, Firebase's convention
// for a project id that can never be a real one.

/** What the guard looks at. */
export interface SeedGuardInput {
  gcloudProject?: string;
  firestoreEmulatorHost?: string;
  confirmProject?: string;
  // True when the run would write (`--apply`).
  writes: boolean;
}

/** Why the run must not start (empty = it may). */
export function projectGuardProblems(input: SeedGuardInput): string[] {
  const problems: string[] = [];
  const id = (input.gcloudProject ?? "").trim();
  if (!id) return ["GCLOUD_PROJECT is not set: name the project explicitly (there is no default)"];
  const demo = id.startsWith("demo-");
  const emulated = Boolean((input.firestoreEmulatorHost ?? "").trim());
  if (demo && !emulated) problems.push(`"${id}" is a demo project id, but FIRESTORE_EMULATOR_HOST is not set`);
  if (!demo && emulated) problems.push(`FIRESTORE_EMULATOR_HOST is set but "${id}" is not a demo- project id`);
  if (input.writes && !demo && input.confirmProject !== id) {
    problems.push(`writing to "${id}" needs --confirm-project=${id}`);
  }
  if (input.confirmProject !== undefined && input.confirmProject !== id) {
    problems.push(`--confirm-project=${input.confirmProject} does not match GCLOUD_PROJECT=${id}`);
  }
  return problems;
}
