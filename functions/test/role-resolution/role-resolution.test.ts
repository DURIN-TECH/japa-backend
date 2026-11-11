// ============================================
// Unit tests — role resolution trusts server-written data only (issue #135)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firestore is the
// in-memory fake (test/helpers/fake-firestore.ts); Firebase Auth is a small
// in-memory stand-in defined below. (The end-to-end version of these checks,
// with real rules and real tokens, is test/emulator/role-resolution.emu.ts.)
//
// What is pinned:
//  - claimsService.resolveRoleFromDb: admin comes from custom claims only (the
//    profile document's `admin` field grants nothing, and a mismatch is
//    logged); ownership needs the agency's own record to agree; membership
//    needs an existing agency; `ignoreAdmin` still yields the non-admin role;
//  - claimsService.setRoleClaims / setAdmin: the legacy profile flag is set on
//    promotion, cleared on a real demotion, and otherwise left untouched;
//  - the profile update services copy only allow-listed fields.

import { test, describe, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "@durin-tech/authz";

import { fakeCollection, resetStore, store } from "../helpers/fake-firestore";
import { claimsService } from "../../src/services/claims.service";
import { userService, USER_SELF_EDITABLE_FIELDS } from "../../src/services/user.service";
import { agentService, AGENT_SELF_EDITABLE_FIELDS } from "../../src/services/agent.service";
import { pickAllowedFields } from "../../src/utils/pick-allowed-fields";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fakes
// ============================================

/** uid -> custom claims: the in-memory stand-in for Firebase Auth. */
const claims = new Map<string, Record<string, unknown>>();

/** When true, every Auth lookup fails with a non-"not found" error. */
let authOutage = false;

/** Put a Firestore document in the fake store. */
const put = (path: string, data: Record<string, unknown>) => store.set(path, data);

/** The profile document's `admin` field (undefined when absent / no doc). */
const profileAdmin = (uid: string) => store.get(`users/${uid}`)?.admin;

before(async () => {
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.users = fakeCollection("users");
  firebase.collections.agents = fakeCollection("agents");
  firebase.collections.agencies = fakeCollection("agencies");
  // Auth: only the calls the claims service makes.
  firebase.auth.getUser = async (uid: string) => {
    if (authOutage) throw Object.assign(new Error("backend unavailable"), { code: "auth/internal-error" });
    if (!claims.has(uid)) throw Object.assign(new Error("no such user"), { code: "auth/user-not-found" });
    return { uid, customClaims: claims.get(uid) };
  };
  firebase.auth.listUsers = async () => ({
    users: [...claims.entries()].map(([uid, customClaims]) => ({ uid, customClaims })),
    pageToken: undefined,
  });
  firebase.auth.setCustomUserClaims = async (uid: string, next: Record<string, unknown>) => {
    claims.set(uid, next);
  };
});

beforeEach(() => {
  resetStore();
  claims.clear();
  authOutage = false;
  mock.restoreAll();
});

/** Capture console.warn output for the duration of one test. */
function captureWarnings(): string[] {
  const seen: string[] = [];
  mock.method(console, "warn", (...args: unknown[]) => {
    seen.push(args.join(" "));
  });
  return seen;
}

// ============================================
// resolveRoleFromDb — admin
// ============================================

describe("resolveRoleFromDb: admin comes from custom claims only", () => {
  test("profile document says admin, no claim -> NOT admin, and the mismatch is logged", async () => {
    claims.set("u1", {});
    put("users/u1", { id: "u1", admin: true });
    const warnings = captureWarnings();

    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.CLIENT, agencyId: null });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /users\/u1\.admin is true but the account has no admin custom claim/);
  });

  test("role claim admin -> admin, with no profile flag at all", async () => {
    claims.set("u1", { role: "admin" });
    put("users/u1", { id: "u1" });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.ADMIN, agencyId: null });
  });

  test("legacy `admin: true` claim (no role claim) -> admin", async () => {
    claims.set("u1", { admin: true });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.ADMIN, agencyId: null });
  });

  test("no warning for an ordinary user", async () => {
    claims.set("u1", {});
    put("users/u1", { id: "u1" });
    const warnings = captureWarnings();
    await claimsService.resolveRoleFromDb("u1");
    assert.deepEqual(warnings, []);
  });

  test("an account that does not exist in Auth has no claims -> client", async () => {
    assert.deepEqual(await claimsService.resolveRoleFromDb("ghost"), { role: ROLES.CLIENT, agencyId: null });
  });

  test("any other Auth failure is rethrown: a transient error can never resolve an admin to a lower role", async () => {
    claims.set("u1", { role: "admin", admin: true });
    authOutage = true;
    await assert.rejects(claimsService.resolveRoleFromDb("u1"), /backend unavailable/);
    // ...so syncClaimsFromDb writes nothing and the admin claim survives.
    await assert.rejects(claimsService.syncClaimsFromDb("u1"), /backend unavailable/);
    assert.deepEqual(claims.get("u1"), { role: "admin", admin: true });
  });

  test("listAdminUids returns claim holders only, never profile-flagged accounts", async () => {
    claims.set("a1", { role: "admin" });
    claims.set("a2", { admin: true });
    claims.set("u1", { role: "client" });
    put("users/u1", { id: "u1", admin: true });
    assert.deepEqual((await claimsService.listAdminUids()).sort(), ["a1", "a2"]);
  });

  test("ignoreAdmin: an admin who also owns an agency resolves to owner (demotion path)", async () => {
    claims.set("u1", { role: "admin", admin: true });
    put("agencies/ag1", { id: "ag1", ownerId: "u1" });
    put("agents/a1", { id: "a1", userId: "u1", agencyId: "ag1", agencyRole: "owner" });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1", { ignoreAdmin: true }), {
      role: ROLES.OWNER,
      agencyId: "ag1",
    });
  });

  test("ignoreAdmin: an admin with no agent profile resolves to client", async () => {
    claims.set("u1", { role: "admin", admin: true });
    put("users/u1", { id: "u1", admin: true });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1", { ignoreAdmin: true }), {
      role: ROLES.CLIENT,
      agencyId: null,
    });
  });
});

// ============================================
// resolveRoleFromDb — agency membership
// ============================================

describe("resolveRoleFromDb: agency membership is checked against the agency", () => {
  beforeEach(() => {
    claims.set("u1", {});
    put("agencies/ag1", { id: "ag1", ownerId: "real-owner" });
  });

  test("owner: agent document and agency record agree -> owner", async () => {
    put("agencies/ag2", { id: "ag2", ownerId: "u1" });
    put("agents/a1", { id: "a1", userId: "u1", agencyId: "ag2", agencyRole: "owner" });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.OWNER, agencyId: "ag2" });
  });

  test("owner: the agency names somebody else -> independent agent, logged", async () => {
    put("agents/a1", { id: "a1", userId: "u1", agencyId: "ag1", agencyRole: "owner" });
    const warnings = captureWarnings();
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.AGENT, agencyId: null });
    assert.match(warnings.join("\n"), /names a different owner/);
  });

  test("member of an existing agency -> agent of that agency", async () => {
    put("agents/a1", { id: "a1", userId: "u1", agencyId: "ag1", agencyRole: "agent" });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.AGENT, agencyId: "ag1" });
  });

  test("agent document names an agency that does not exist -> independent agent, logged", async () => {
    put("agents/a1", { id: "a1", userId: "u1", agencyId: "nope", agencyRole: "agent" });
    const warnings = captureWarnings();
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.AGENT, agencyId: null });
    assert.match(warnings.join("\n"), /does not exist/);
  });

  test("malformed agencyId (not a string, or a path) -> independent agent, logged, nothing thrown", async () => {
    const warnings = captureWarnings();
    for (const bad of [42, { id: "ag1" }, ["ag1"], "ag1/agents/x", true]) {
      put("agents/a1", { id: "a1", userId: "u1", agencyId: bad, agencyRole: "owner" });
      assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.AGENT, agencyId: null });
    }
    assert.equal(warnings.filter((w) => /malformed agencyId/.test(w)).length, 5);
  });

  test("independent agent profile (no agency) -> agent, no agency", async () => {
    put("agents/a1", { id: "a1", userId: "u1" });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.AGENT, agencyId: null });
  });

  test("several agent documents: an unconfirmed owner claim never beats the confirmed one", async () => {
    put("agencies/ag2", { id: "ag2", ownerId: "u1" });
    put("agents/a0", { id: "a0", userId: "u1", agencyId: "ag1", agencyRole: "owner" }); // not confirmed
    put("agents/a1", { id: "a1", userId: "u1", agencyId: "ag2", agencyRole: "owner" }); // confirmed
    mock.method(console, "warn", () => undefined);
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.OWNER, agencyId: "ag2" });
  });

  test("no agent document -> client", async () => {
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.CLIENT, agencyId: null });
  });

  test("somebody else's agent document is never read as mine", async () => {
    put("agents/a1", { id: "a1", userId: "real-owner", agencyId: "ag1", agencyRole: "owner" });
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.CLIENT, agencyId: null });
  });
});

// ============================================
// setRoleClaims / setAdmin — the legacy profile flag
// ============================================

describe("setRoleClaims: the legacy profile admin flag", () => {
  test("promotion sets the claim and the profile flag", async () => {
    claims.set("u1", { other: "kept" });
    put("users/u1", { id: "u1" });
    await claimsService.setRoleClaims("u1", ROLES.ADMIN);
    assert.deepEqual(claims.get("u1"), { other: "kept", role: "admin", agencyId: null, admin: true });
    assert.equal(profileAdmin("u1"), true);
  });

  test("a non-admin write for a non-admin account leaves a stray profile flag untouched (kept for the audit)", async () => {
    claims.set("u1", {});
    put("users/u1", { id: "u1", admin: true });
    await claimsService.setRoleClaims("u1", ROLES.CLIENT);
    assert.deepEqual(claims.get("u1"), { role: "client", agencyId: null, admin: false });
    assert.equal(profileAdmin("u1"), true);
  });

  test("a non-admin write does not add the field to a profile that lacks it", async () => {
    claims.set("u1", {});
    put("users/u1", { id: "u1" });
    await claimsService.setRoleClaims("u1", ROLES.AGENT, "ag1");
    assert.equal("admin" in (store.get("users/u1") as object), false);
  });

  test("setAdmin(false) on a real admin clears the claim AND the profile flag, landing on their agency role", async () => {
    claims.set("u1", { role: "admin", agencyId: null, admin: true });
    put("users/u1", { id: "u1", admin: true });
    put("agencies/ag1", { id: "ag1", ownerId: "u1" });
    put("agents/a1", { id: "a1", userId: "u1", agencyId: "ag1", agencyRole: "owner" });

    await claimsService.setAdmin("u1", false);

    assert.deepEqual(claims.get("u1"), { role: "owner", agencyId: "ag1", admin: false });
    assert.equal(profileAdmin("u1"), false);
    // And nothing re-promotes them afterwards.
    assert.deepEqual(await claimsService.resolveRoleFromDb("u1"), { role: ROLES.OWNER, agencyId: "ag1" });
  });

  test("syncClaimsFromDb never turns a profile flag into an admin claim", async () => {
    claims.set("u1", {});
    put("users/u1", { id: "u1", admin: true });
    mock.method(console, "warn", () => undefined);
    assert.deepEqual(await claimsService.syncClaimsFromDb("u1"), { role: ROLES.CLIENT, agencyId: null });
    assert.equal(claims.get("u1")?.admin, false);
    assert.equal(claims.get("u1")?.role, "client");
  });

  test("no profile document: the claim is written and nothing throws", async () => {
    claims.set("u1", {});
    await claimsService.setRoleClaims("u1", ROLES.ADMIN);
    assert.equal(claims.get("u1")?.role, "admin");
    assert.equal(store.has("users/u1"), false);
  });
});

// ============================================
// Profile updates copy allow-listed fields only
// ============================================

describe("profile update allow-lists", () => {
  test("pickAllowedFields keeps listed own keys, drops the rest, tolerates non-objects", () => {
    const body = JSON.parse("{\"a\":1,\"b\":2,\"__proto__\":{\"c\":3},\"constructor\":\"x\"}");
    assert.deepEqual(pickAllowedFields(body, ["a", "c", "constructor"]), { a: 1, constructor: "x" });
    assert.deepEqual(pickAllowedFields({ a: undefined, b: null }, ["a", "b"]), { b: null });
    for (const junk of [null, undefined, "str", 7, ["a"]]) {
      assert.deepEqual(pickAllowedFields(junk, ["a"]), {});
    }
  });

  test("the user allow-list holds no authority-bearing field", () => {
    for (const field of ["admin", "role", "agencyId", "agencyRole", "identityVerification", "isProvisional", "email", "id", "fcmTokens", "onboardingCompleted"]) {
      assert.equal((USER_SELF_EDITABLE_FIELDS as readonly string[]).includes(field), false, field);
    }
  });

  test("the agent allow-list holds no membership, verification, identity or stats field", () => {
    for (const field of ["agencyId", "agencyRole", "verificationStatus", "verifiedAt", "verifiedBy", "verificationDocuments", "userId", "id", "rating", "totalReviews", "totalApplications", "successRate"]) {
      assert.equal((AGENT_SELF_EDITABLE_FIELDS as readonly string[]).includes(field), false, field);
    }
  });

  test("userService.updateUser writes profile fields and ignores everything else", async () => {
    put("users/u1", { id: "u1", email: "delivered+u1@resend.dev", firstName: "Old" });
    await userService.updateUser("u1", {
      firstName: "New",
      notificationPreferences: { email: false },
      admin: true,
      role: "admin",
      email: "delivered+other@resend.dev",
      identityVerification: { status: "verified" },
    } as any);
    const saved = store.get("users/u1") as any;
    assert.equal(saved.firstName, "New");
    assert.deepEqual(saved.notificationPreferences, { email: false });
    assert.equal(saved.email, "delivered+u1@resend.dev");
    for (const field of ["admin", "role", "identityVerification"]) assert.equal(field in saved, false, field);
  });

  test("agentService.updateAgent writes profile fields and ignores everything else", async () => {
    put("agents/a1", { id: "a1", userId: "u1", bio: "old", verificationStatus: "pending", rating: 0 });
    await agentService.updateAgent("a1", {
      bio: "new",
      agencyId: "ag1",
      agencyRole: "owner",
      verificationStatus: "verified",
      userId: "someone-else",
      rating: 5,
    } as any);
    const saved = store.get("agents/a1") as any;
    assert.equal(saved.bio, "new");
    assert.equal(saved.userId, "u1");
    assert.equal(saved.verificationStatus, "pending");
    assert.equal(saved.rating, 0);
    for (const field of ["agencyId", "agencyRole"]) assert.equal(field in saved, false, field);
  });
});
