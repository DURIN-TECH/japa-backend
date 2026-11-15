// ============================================
// E2E FIXTURE — EMULATOR-ONLY SAFETY GUARD (issue #361)
// ============================================
//
// The mobile end-to-end suite runs the Firebase emulators under the project id
// `durin-seli-dev`, because the simulator dev build's native Firebase config
// mints Auth-emulator tokens for that id (a `demo-*` id answers 401). That is
// the REAL dev project's id, so any script that seeds for the suite must be
// unable to reach the real project.
//
// firebase-admin sends Firestore, Auth and Storage calls to an emulator only
// while the matching `*_EMULATOR_HOST` variable is set; without one it talks
// to Google with whatever credentials it can find. So the fixture script
// refuses to start unless ALL THREE variables are set and every one of them
// points at this machine (`localhost` or `127.0.0.1`). It also refuses a
// project id other than the dev id or a `demo-*` id, and an environment that
// names a different project than the one asked for (no silent override).
//
// PURE: no Firebase import, no network, no clock. The entry script
// (scripts/seed-e2e.ts) calls `checkEmulatorOnly` BEFORE it loads any Firebase
// module, and exits non-zero with the problems listed when it refuses.

/** The emulator variables that must ALL be set, in the order they are reported. */
export const REQUIRED_EMULATOR_ENV = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_STORAGE_EMULATOR_HOST",
] as const;

/** Which emulator each variable points at (for the refusal message). */
const EMULATOR_LABEL: Record<(typeof REQUIRED_EMULATOR_ENV)[number], string> = {
  FIRESTORE_EMULATOR_HOST: "Firestore",
  FIREBASE_AUTH_EMULATOR_HOST: "Auth",
  FIREBASE_STORAGE_EMULATOR_HOST: "Storage",
};

/** The only host names an emulator variable may name. */
export const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

/** The project the e2e suite runs the emulators under (see the file header). */
export const E2E_DEFAULT_PROJECT = "durin-seli-dev";

/** Production project id(s): refused whatever else the environment says. */
const PROD_PROJECT_IDS: readonly string[] = ["japa-platform"];

/** Environment variables that can name the Google project firebase-admin uses. */
const PROJECT_ENV = ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"] as const;

/** What the guard decided. `problems` lists every reason for a refusal. */
export type GuardResult = { ok: true; project: string } | { ok: false; problems: string[] };

/**
 * Parse an emulator host value (`host:port`, optionally with an `http://`
 * prefix, as the Storage SDK also accepts). Returns null for anything else:
 * an empty value, a path, a missing or non-numeric port, credentials, etc.
 */
export function parseEmulatorHost(value: string | undefined): { host: string; port: number } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Strip one optional scheme; anything after host:port (a path, a query) is refused.
  const bare = trimmed.replace(/^http:\/\//i, "");
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(bare);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1].toLowerCase(), port };
}

/** True when the value is a well-formed `host:port` on this machine. */
export function isLocalEmulatorHost(value: string | undefined): boolean {
  const parsed = parseEmulatorHost(value);
  return parsed !== null && LOCAL_HOSTS.includes(parsed.host);
}

/** True for the project ids the fixture may write under (on the emulators). */
export function isAllowedE2eProject(project: string): boolean {
  if (PROD_PROJECT_IDS.includes(project)) return false;
  return project === E2E_DEFAULT_PROJECT || /^demo-[a-z0-9-]+$/.test(project);
}

/**
 * Decide whether the e2e fixture may run in this environment.
 *
 * @param env the process environment (passed in so tests need no globals).
 * @param requestedProject the `--project` value, if any. Defaults to
 *   `durin-seli-dev`.
 * @returns ok with the project to use, or every problem found.
 */
export function checkEmulatorOnly(env: Record<string, string | undefined>, requestedProject?: string): GuardResult {
  const problems: string[] = [];

  // 1. Every emulator variable is set and names this machine.
  for (const name of REQUIRED_EMULATOR_ENV) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      problems.push(`${name} is not set (it must point at the local ${EMULATOR_LABEL[name]} emulator, e.g. 127.0.0.1:<port>)`);
    } else if (!parseEmulatorHost(value)) {
      problems.push(`${name}=${JSON.stringify(value)} is not host:port`);
    } else if (!isLocalEmulatorHost(value)) {
      problems.push(`${name}=${JSON.stringify(value)} does not point at localhost or 127.0.0.1`);
    }
  }

  // 2. The project is the dev id or a demo-* id, never production.
  const project = (requestedProject ?? "").trim() || E2E_DEFAULT_PROJECT;
  if (!isAllowedE2eProject(project)) {
    problems.push(`project ${JSON.stringify(project)} is not allowed (only ${E2E_DEFAULT_PROJECT} or a demo-* id, on the emulators)`);
  }

  // 3. No environment variable names a different project (no silent override).
  for (const name of PROJECT_ENV) {
    const value = env[name]?.trim();
    if (value && value !== project) problems.push(`${name}=${JSON.stringify(value)} names a different project than ${JSON.stringify(project)}`);
  }

  return problems.length === 0 ? { ok: true, project } : { ok: false, problems };
}

/** The message printed on a refusal (one line per problem). */
export function refusalMessage(problems: readonly string[]): string {
  return [
    "",
    "Refused: the e2e fixture only runs against the LOCAL Firebase emulators.",
    ...problems.map((p) => `  - ${p}`),
    "Start the emulators with firebase.e2e.json and export the three *_EMULATOR_HOST variables",
    "(see seli-backend docs/e2e-emulators.md). Nothing was written.",
    "",
  ].join("\n");
}
