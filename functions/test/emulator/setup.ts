// ============================================
// Emulator test preload — refuses anything that is not a local emulator
// ============================================
//
// Loaded with `--import ./test/emulator/setup.ts` by `npm run test:emulator`
// (which starts the Auth + Firestore emulators through `firebase
// emulators:exec` with ../firebase.emulator-test.json, i.e. on ports that do
// not collide with a developer's normal emulators).
//
// These tests are the OPPOSITE of the hermetic unit tests in test/**/*.test.ts
// (see test/helpers/setup.ts): they need a real Firestore rules engine and a
// real Auth token round trip, so they talk to the emulators. This preload
// makes sure that is ALL they can talk to. It exits 1, before any test file
// is imported, unless:
//  1. every project id in the environment starts with `demo-` (Firebase's
//     prefix for a project that can never be a real one), and
//  2. FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST are both set
//     and both point at this machine.
// It also drops ambient credentials, so even a bug could not authenticate
// against a real project.
//
// The files are named *.emu.ts (not *.test.ts) on purpose: the `npm test`
// glob must never pick them up, because that run points the emulator hosts
// at a refusing port.

/** Hosts that mean "this machine". */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True when `hostPort` (e.g. "127.0.0.1:8782") names a local address. */
function isLocal(hostPort: string | undefined): boolean {
  if (!hostPort) return false;
  const host = hostPort.replace(/:\d+$/, "");
  return LOCAL_HOSTS.has(host);
}

/** Print why we refuse to run, then stop the process. */
function refuse(reason: string): never {
  console.error(
    `Refusing to run the emulator tests: ${reason}\n` +
      "Run them with `npm run test:emulator` (from functions/), which starts " +
      "the emulators with a demo- project id."
  );
  process.exit(1);
}

// ---- 1. Project id: must be a demo- project everywhere it can be read from.
const projectIds = [process.env.GCLOUD_PROJECT, process.env.GOOGLE_CLOUD_PROJECT].filter(
  (v): v is string => Boolean(v)
);
if (process.env.FIREBASE_CONFIG) {
  try {
    const id = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
    if (id) projectIds.push(String(id));
  } catch {
    refuse("FIREBASE_CONFIG is not JSON, so its project id cannot be checked.");
  }
}
if (projectIds.length === 0) refuse("no project id is set (GCLOUD_PROJECT).");
const bad = projectIds.filter((id) => !id.startsWith("demo-"));
if (bad.length > 0) refuse(`project id must start with demo- (got ${bad.join(", ")}).`);

// ---- 2. Both emulators must be configured, and local.
if (!isLocal(process.env.FIRESTORE_EMULATOR_HOST)) {
  refuse(`FIRESTORE_EMULATOR_HOST must be a local address (got ${process.env.FIRESTORE_EMULATOR_HOST}).`);
}
if (!isLocal(process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
  refuse(`FIREBASE_AUTH_EMULATOR_HOST must be a local address (got ${process.env.FIREBASE_AUTH_EMULATOR_HOST}).`);
}

// ---- 3. No ambient credentials, no metadata-server probing.
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
process.env.METADATA_SERVER_DETECTION = "none";

// utils/firebase reads GCLOUD_PROJECT to derive the bucket name; make sure the
// one variable it prefers is the vetted demo id.
process.env.GCLOUD_PROJECT = projectIds[0];
