// ============================================
// Test preload — keeps `npm test` hermetic (issue #94)
// ============================================
//
// Loaded by the `npm test` script with `--import ./test/helpers/setup.ts`
// (after `--import tsx`), so it runs in the test runner AND in every
// per-file test process, BEFORE any test file imports src/utils/firebase.
//
// What it does, in order:
//  1. Project id: sets GCLOUD_PROJECT=demo-unit-test when unset (Admin init
//     needs one: utils/firebase derives the storage bucket from it), and
//     REFUSES to run (exit 1) when any project id in the environment does not
//     start with `demo-`. The `demo-` prefix is Firebase's convention for a
//     project that can never be a real one, so a stray shell export such as
//     GCLOUD_PROJECT=durin-seli-dev cannot point the tests at real data.
//  2. No ambient credentials: drops GOOGLE_APPLICATION_CREDENTIALS and
//     disables GCE metadata-server detection, so nothing waits ~20s on
//     169.254.169.254 (what made CI's Test step take 21 minutes).
//  3. Emulator hosts point at a refusing local port (127.0.0.1:1), so even a
//     call that slipped past step 4 fails with ECONNREFUSED instead of
//     reaching a real project or a developer's running emulator.
//  4. Fail fast: the Firestore client's request layer
//     (Firestore.prototype.request / requestStream, which every get, query,
//     write and transaction goes through) and outbound HTTP(S) / fetch to
//     Google hosts are stubbed to reject AT ONCE with a clear message.
//  5. Fail the test: services under test often catch and log Firestore
//     errors ("never throws" paths like the stale run sweep), which would
//     hide the call. So every blocked call is also recorded, and a root
//     afterEach hook fails the test that made it, naming the call. A process
//     exit backstop fails the file for calls made outside any test.
//
// Tests must fake every Firestore ref / transaction runner they reach (see
// test/helpers/fake-firestore.ts) — this file only makes forgetting obvious.

import { afterEach } from "node:test";
// Default imports on purpose: they are the real, mutable module objects that
// gaxios / node-fetch / the Admin SDK call into. A namespace import
// (`* as http`) is a read-only view, so patching it would silently do nothing.
import http from "node:http";
import https from "node:https";
import { Firestore } from "firebase-admin/firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// 1. Project id: default demo-unit-test, refuse anything not `demo-`
// ============================================

/** Default project id for the unit tests (never a real project). */
const DEFAULT_TEST_PROJECT = "demo-unit-test";

if (!process.env.GCLOUD_PROJECT) process.env.GCLOUD_PROJECT = DEFAULT_TEST_PROJECT;

/** Every place firebase-admin / google-cloud may read a project id from. */
function projectIdsInEnv(): { source: string; id: string }[] {
  const ids: { source: string; id: string }[] = [];
  for (const key of ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
    const v = process.env[key];
    if (v) ids.push({ source: key, id: v });
  }
  if (process.env.FIREBASE_CONFIG) {
    try {
      const id = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
      if (id) ids.push({ source: "FIREBASE_CONFIG.projectId", id: String(id) });
    } catch {
      // Not JSON (it may be a file path): firebase-admin would read a project
      // from that file, which we cannot vet here — refuse below.
      ids.push({ source: "FIREBASE_CONFIG", id: "(unparseable)" });
    }
  }
  return ids;
}

const badIds = projectIdsInEnv().filter(({ id }) => !id.startsWith("demo-"));
if (badIds.length > 0) {
  console.error(
    "Refusing to run the unit tests: the project id must start with `demo-` " +
      `(got ${badIds.map((b) => `${b.source}=${b.id}`).join(", ")}). ` +
      `Unset it (the tests default to ${DEFAULT_TEST_PROJECT}) or use a demo- id.`
  );
  process.exit(1);
}

// ============================================
// 2. No ambient credentials / metadata server
// ============================================

delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
// google-auth-library / gcp-metadata: never probe the GCE metadata server.
process.env.METADATA_SERVER_DETECTION = "none";

// ============================================
// 3. Emulator hosts -> a refusing local port
// ============================================

/** A local port nothing listens on: connections are refused at once. */
export const REFUSING_HOST = "127.0.0.1:1";
// Overridden unconditionally: unit tests never use an emulator, and a
// developer's running emulator must not leak state into them.
process.env.FIRESTORE_EMULATOR_HOST = REFUSING_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = REFUSING_HOST;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = REFUSING_HOST;

// ============================================
// 4 + 5. Fail-fast stubs that also fail the calling test
// ============================================

/**
 * Blocked calls not yet reported by the afterEach hook. Kept on globalThis
 * (under a registry symbol) so test/test-guard.test.ts can read and drain it
 * without importing this module a second time (tsx may load a test's import
 * as a separate CommonJS instance of the ESM preload).
 */
export const GUARD_VIOLATIONS_KEY = Symbol.for("seli.test.guardViolations");
const violations: string[] = ((globalThis as any)[GUARD_VIOLATIONS_KEY] ??= []);

/** Record a blocked call and build the error it rejects with. */
function blocked(what: string): Error {
  const msg =
    `Unfaked ${what} in a unit test (issue #94). Fake it: swap the collection ref / ` +
    "transaction runner (test/helpers/fake-firestore.ts) or inject a stub.";
  violations.push(what);
  return new Error(msg);
}

// ---- Firestore: every RPC goes through request() (unary: get, commit,
// beginTransaction, ...) or requestStream() (runQuery, batchGetDocuments,
// listen). Reject before any channel is opened.
const fsProto = Firestore.prototype as any;
fsProto.request = function (methodName: string) {
  return Promise.reject(blocked(`Firestore call "${methodName}"`));
};
fsProto.requestStream = function (methodName: string) {
  return Promise.reject(blocked(`Firestore call "${methodName}"`));
};

/** Hosts a unit test must never reach (Google APIs, auth, metadata). */
function isGoogleHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const h = host.replace(/:\d+$/, "").toLowerCase();
  return (
    h === "metadata.google.internal" ||
    h === "metadata" ||
    h === "169.254.169.254" ||
    h.endsWith(".googleapis.com") ||
    h === "googleapis.com" ||
    h.endsWith(".google.com") ||
    h.endsWith(".firebaseio.com") ||
    h.endsWith(".firebaseapp.com") ||
    h.endsWith(".cloudfunctions.net")
  );
}

/** Host of an http.request()/get() call, whatever its argument shape. */
function hostOf(args: any[]): string | undefined {
  const a = args[0];
  if (typeof a === "string") {
    try {
      return new URL(a).host;
    } catch {
      return undefined;
    }
  }
  if (a instanceof URL) return a.host;
  if (a && typeof a === "object") return a.hostname ?? a.host;
  return undefined;
}

// ---- node:http / node:https (gaxios -> node-fetch, the Admin SDK's own
// HTTP clients for Auth / Messaging / Storage, gcp-metadata).
for (const mod of [http, https] as any[]) {
  for (const fn of ["request", "get"]) {
    const original = mod[fn];
    mod[fn] = function (...args: any[]) {
      const host = hostOf(args);
      if (isGoogleHost(host)) throw blocked(`HTTP request to ${host}`);
      return original.apply(this, args);
    };
  }
}

// ---- global fetch (undici): same rule.
const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = function (input: any, init?: any) {
    let host: string | undefined;
    try {
      host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).host;
    } catch {
      host = undefined;
    }
    if (isGoogleHost(host)) return Promise.reject(blocked(`fetch to ${host}`));
    return originalFetch(input, init);
  } as typeof fetch;
}

// ---- Fail the test that made a blocked call (root hook: applies to every
// test and suite in the file). Calls made in a before() hook are reported
// by the first test after it.
afterEach(() => {
  if (violations.length === 0) return;
  const seen = violations.splice(0);
  throw new Error(`Unfaked Google / Firestore call(s) during this test: ${[...new Set(seen)].join(", ")}`);
});

// ---- Backstop: calls after the last test (or outside any test) fail the file.
process.on("exit", () => {
  if (violations.length === 0) return;
  console.error(`Unfaked Google / Firestore call(s) outside a test: ${[...new Set(violations)].join(", ")}`);
  process.exitCode = 1;
});
