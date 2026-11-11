// ============================================
// Shared helpers for the emulator tests (test/emulator/*.emu.ts)
// ============================================
//
// Everything here talks ONLY to the local Auth + Firestore emulators that
// `npm run test:emulator` starts (test/emulator/setup.ts refuses to run
// otherwise). Three kinds of actor are modelled:
//
//  - a REAL signed-in user: created through the Auth emulator's sign-up REST
//    endpoint, so the ID token is minted exactly as for a new account (no
//    custom claims at all) and is verified by the real middleware/auth.ts;
//  - the same user's Firestore CLIENT: `clientDb(uid)` returns a Firestore
//    handle that is subject to firestore.rules (via
//    @firebase/rules-unit-testing), i.e. what the web/mobile SDK could do;
//  - the BACKEND: the Admin SDK from src/utils/firebase, which bypasses rules.
//
// The API under test is the real Express app (src/app.ts) listening on an
// ephemeral local port in this process.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Environment
// ============================================

/** The demo project id the emulators run under (vetted by setup.ts). */
export const PROJECT_ID = process.env.GCLOUD_PROJECT as string;

/** host:port of the Auth emulator. */
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST as string;

/** host and port of the Firestore emulator, split for rules-unit-testing. */
const [FS_HOST, FS_PORT] = (process.env.FIRESTORE_EMULATOR_HOST as string).split(":");

/** Password used for every throwaway test account. */
const TEST_PASSWORD = "emulator-only-password";

// ============================================
// Rules test environment (client-side Firestore, subject to firestore.rules)
// ============================================

let env: RulesTestEnvironment | undefined;

/**
 * The shared rules test environment. No `rules` are passed on purpose: the
 * emulator already loaded the repo's real firestore.rules (see
 * ../firebase.emulator-test.json), and that file is what must be tested.
 */
export async function rulesEnv(): Promise<RulesTestEnvironment> {
  if (!env) {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: FS_HOST, port: Number(FS_PORT) },
    });
  }
  return env;
}

/**
 * Firestore as the signed-in user `uid` would see it from a client SDK:
 * every read and write goes through firestore.rules. `claims` are the custom
 * claims on the token (none by default, like a brand-new account).
 */
export async function clientDb(uid: string, claims: Record<string, unknown> = {}): Promise<any> {
  return (await rulesEnv()).authenticatedContext(uid, claims).firestore();
}

/** Firestore as a signed-out visitor (rules still apply). */
export async function anonymousDb(): Promise<any> {
  return (await rulesEnv()).unauthenticatedContext().firestore();
}

/**
 * Run `fn` with rules switched off. Used to put a document in place that a
 * client could not (or could no longer) write, e.g. data from before the
 * rules were tightened, or what a backend flow would have written.
 */
export async function withoutRules(fn: (db: any) => Promise<void>): Promise<void> {
  await (await rulesEnv()).withSecurityRulesDisabled(async (ctx) => {
    await fn(ctx.firestore());
  });
}

// ============================================
// Real accounts (Auth emulator)
// ============================================

/** A throwaway account created through the Auth emulator. */
export interface TestAccount {
  uid: string;
  email: string;
  /** ID token as minted at sign-up: carries NO custom claims. */
  idToken: string;
  refreshToken: string;
}

/**
 * Sign up a new account the way a client app does (email + password against
 * the Identity Toolkit REST API, here the emulator's copy of it). Addresses
 * use Resend's test domain, per the project rule for test users.
 */
export async function signUp(name: string): Promise<TestAccount> {
  const email = `delivered+${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@resend.dev`;
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true }),
    }
  );
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Auth emulator sign-up failed: ${JSON.stringify(json)}`);
  return { uid: json.localId, email, idToken: json.idToken, refreshToken: json.refreshToken };
}

/**
 * Exchange the refresh token for a fresh ID token, which picks up whatever
 * custom claims the account holds NOW (what a client gets after a refresh).
 */
export async function refreshIdToken(account: TestAccount): Promise<string> {
  const res = await fetch(`http://${AUTH_HOST}/securetoken.googleapis.com/v1/token?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: account.refreshToken }),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Auth emulator token refresh failed: ${JSON.stringify(json)}`);
  return json.id_token as string;
}

/** Delete every account in the Auth emulator and every Firestore document. */
export async function resetEmulators(): Promise<void> {
  await (await rulesEnv()).clearFirestore();
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: "DELETE" });
}

// ============================================
// The API (real Express app, in this process)
// ============================================

/** A running copy of the API. */
export interface RunningApi {
  /** Call an endpoint; returns the HTTP status and the parsed JSON body. */
  call: (method: string, path: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

/**
 * Start src/app.ts on an ephemeral local port. Imported lazily so the
 * emulator environment (checked by setup.ts) is in place before
 * src/utils/firebase initialises the Admin SDK.
 */
export async function startApi(): Promise<RunningApi> {
  const { app } = await import("../../src/app");
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async call(method, path, token, body) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON (should not happen for this API): keep the raw text.
      }
      return { status: res.status, body: parsed };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ============================================
// Backend-side reads
// ============================================

/** The account's current custom claims, read with the Admin SDK. */
export async function claimsOf(uid: string): Promise<Record<string, unknown>> {
  const { auth } = await import("../../src/utils/firebase");
  return (await auth.getUser(uid)).customClaims ?? {};
}

/**
 * Wait until the account carries a `role` claim (the middleware writes it in
 * the background after the first request) and return the claims. Gives up
 * after ~5s and returns whatever is there.
 */
export async function claimsAfterBackfill(uid: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const claims = await claimsOf(uid);
    if (claims.role) return claims;
    await new Promise((r) => setTimeout(r, 100));
  }
  return claimsOf(uid);
}

/** True when the promise rejects with a Firestore permission error. */
export async function isDenied(write: Promise<unknown>): Promise<boolean> {
  try {
    await write;
    return false;
  } catch (e: any) {
    if (e?.code === "permission-denied" || /PERMISSION_DENIED|permission/i.test(String(e?.message))) {
      return true;
    }
    throw e;
  }
}
