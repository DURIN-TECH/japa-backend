// ============================================
// Golden set — environment guard for the LIVE refresh (issue #35)
// ============================================
//
// Imported FIRST by record.ts, so it runs before any module that initialises
// the Firebase Admin SDK. The refresh sends fixture text to the model provider
// but must never be able to touch a real Firebase project: the assessment job
// runs over the in-memory fake store, and this file makes sure that even a call
// that slipped past the fakes would have no project and no credentials.
//
//  - the project id is forced to a `demo-` id (Firebase's convention for a
//    project that cannot exist), whatever the shell exported;
//  - ambient Google credentials are dropped;
//  - the emulator hosts point at a refusing local port.
// The Anthropic key is NOT touched here: it is read by the provider from the
// environment (`--env-file-if-exists=.env.local` in the npm script) and is never
// printed, logged or written anywhere by this module.

process.env.GCLOUD_PROJECT = "demo-golden-record";
process.env.GOOGLE_CLOUD_PROJECT = "demo-golden-record";
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:1";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:1";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:1";
process.env.GCE_METADATA_HOST = "127.0.0.1:1";
