// ============================================
// Storage helpers for the emulator tests (issue #141)
// ============================================
//
// Companion to ./helpers.ts for the tests that involve Cloud Storage. Like
// everything under test/emulator, this only ever talks to the local emulators
// that `npm run test:emulator` starts (./setup.ts refuses to run otherwise and
// checks FIREBASE_STORAGE_EMULATOR_HOST is a local address).
//
// Three things live here:
//  - BACKEND-side object access (Admin SDK, bypasses storage.rules): put an
//    object in place, check whether one exists, empty the bucket;
//  - CLIENT-side storage (subject to storage.rules, through
//    @firebase/rules-unit-testing), i.e. what the web / mobile Storage SDK
//    could do with a given ID token;
//  - a SIGNING RECORDER. The emulator has no service-account key, so the real
//    `File#getSignedUrl` throws ("Cannot sign data without client_email").
//    `recordSigning()` replaces that one method with a fake that records which
//    object each signature was requested for and returns a recognisable,
//    non-working URL. A test can then assert exactly which paths REACHED the
//    signing call — which is the security-relevant fact — without a key.
//    Nothing in src/ is changed by this; it patches the library prototype for
//    the duration of a test file.

import { File } from "@google-cloud/storage";
import { initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";

import { PROJECT_ID, refreshIdToken, TestAccount } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Environment
// ============================================

/** host and port of the Storage emulator (vetted as local by setup.ts). */
const [ST_HOST, ST_PORT] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST as string).split(":");

/**
 * The bucket the backend uses in this run. utils/firebase derives it from the
 * project id, so the client-side handle below must name the same bucket.
 */
export const BUCKET = `${PROJECT_ID}.firebasestorage.app`;

// ============================================
// Backend-side object access (Admin SDK, no rules)
// ============================================

/** The Admin SDK bucket (lazy import: the Admin app must initialise after setup.ts ran). */
async function adminBucket(): Promise<any> {
  const { storage } = await import("../../src/utils/firebase");
  return storage.bucket();
}

/**
 * Put an object at `path`. Stands in for either a client's PUT to a signed
 * upload URL (which cannot be minted on the emulator) or a backend job writing
 * its own files.
 */
export async function putObject(path: string, contents = "test-bytes", contentType = "application/pdf"): Promise<void> {
  const bucket = await adminBucket();
  // Non-resumable: one request, which is all the emulator needs.
  await bucket.file(path).save(contents, { resumable: false, contentType });
}

/** True when an object exists at `path`. */
export async function objectExists(path: string): Promise<boolean> {
  const bucket = await adminBucket();
  const [exists] = await bucket.file(path).exists();
  return exists;
}

/** Delete every object in the test bucket. */
export async function clearBucket(): Promise<void> {
  const bucket = await adminBucket();
  await bucket.deleteFiles({ force: true });
}

// ============================================
// Client-side storage (subject to storage.rules)
// ============================================

let storageEnv: RulesTestEnvironment | undefined;

/**
 * Rules test environment for Storage. No `rules` are passed on purpose: the
 * emulator already loaded the repo's real storage.rules (see
 * ../firebase.emulator-test.json), and that file is what must be tested.
 */
export async function storageRulesEnv(): Promise<RulesTestEnvironment> {
  if (!storageEnv) {
    storageEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      storage: { host: ST_HOST, port: Number(ST_PORT) },
    });
  }
  return storageEnv;
}

/** Storage as the signed-in user `uid` would reach it from a client SDK. */
export async function clientStorage(uid: string, claims: Record<string, unknown> = {}): Promise<any> {
  return (await storageRulesEnv()).authenticatedContext(uid, claims).storage(`gs://${BUCKET}`);
}

/** Storage as a signed-out visitor (rules still apply). */
export async function anonymousStorage(): Promise<any> {
  return (await storageRulesEnv()).unauthenticatedContext().storage(`gs://${BUCKET}`);
}

/** True when the promise rejects with a Storage "not allowed" error. */
export async function isStorageDenied(op: Promise<unknown>): Promise<boolean> {
  try {
    await op;
    return false;
  } catch (e: any) {
    if (e?.code === "storage/unauthorized" || /unauthorized|permission/i.test(String(e?.message))) return true;
    throw e;
  }
}

// ============================================
// Signing recorder
// ============================================

/** One recorded request for a signed URL. */
export interface SigningCall {
  /** Object name the signature was requested for. */
  path: string;
  /** "read" (download) or "write" (upload). */
  action: string;
}

/** Handle returned by `recordSigning()`. */
export interface SigningRecorder {
  /** Every signing request since the recorder was installed or last cleared. */
  calls: SigningCall[];
  /** Object names of the DOWNLOAD signatures requested so far. */
  readPaths: () => string[];
  /** Forget what was recorded so far. */
  clear: () => void;
  /** Put the real method back. */
  restore: () => void;
}

/** Prefix of the fake URLs the recorder hands out (never resolvable). */
export const FAKE_SIGNED_PREFIX = "https://signed.invalid/";

/**
 * Replace `File#getSignedUrl` with a recorder for the rest of the test file.
 * The fake returns `https://signed.invalid/<object>?action=<action>` so a
 * response can be matched to the object it was signed for.
 */
export function recordSigning(): SigningRecorder {
  const original = File.prototype.getSignedUrl;
  const calls: SigningCall[] = [];
  (File.prototype as any).getSignedUrl = async function (this: File, config: { action: string }) {
    calls.push({ path: this.name, action: config.action });
    return [`${FAKE_SIGNED_PREFIX}${this.name}?action=${config.action}`];
  };
  return {
    calls,
    readPaths: () => calls.filter((c) => c.action === "read").map((c) => c.path),
    clear: () => {
      calls.length = 0;
    },
    restore: () => {
      File.prototype.getSignedUrl = original;
    },
  };
}

// ============================================
// Roles (server-written custom claims)
// ============================================

/**
 * Give an account its role the way the backend does (custom claims written
 * with the Admin SDK), then return a fresh ID token that carries them. Claims
 * are the only place the API reads a role from once they exist (#135).
 */
export async function withClaims(account: TestAccount, claims: Record<string, unknown>): Promise<string> {
  const { auth } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  return refreshIdToken(account);
}
