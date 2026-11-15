// ============================================
// Unit tests — the stricter optional auth, `optionalAuthFresh` (issue #289)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firebase Auth is
// replaced by an in-memory fake (a token table plus an account table), and
// the middleware is called directly with a minimal request.
//
// The bug being pinned: `optionalAuth` trusts the ID token's claims with no
// revocation check, and a token lives up to an hour. On the public routes
// that serve signed-in callers MORE than a guest sees (the three single-visa
// reads), a suspended admin / agency member and a demoted admin therefore
// kept their old access until the token expired.
//
// Covers, on `optionalAuthFresh`:
//  - agent-side token (role admin / owner / agent, legacy `admin` / `agent`):
//    verified with checkRevoked, and the principal is built from the
//    account's CURRENT custom claims;
//  - revoked token, disabled Firebase user, `disabled: true` current claim:
//    guest, with no identity left on the request;
//  - token says admin, current claims say client: `req.authz.role` is client
//    (and `req.user` carries no stale admin claim);
//  - the lookup or the revocation check throws (network, user deleted):
//    guest, never an error and never the token's claims;
//  - client token and a token with no role: the cheap path, NO `getUser` and
//    no checkRevoked;
//  - no header, non-Bearer header, invalid token, `disabled` token claim:
//    guest (the #286 rules).
// And on the cheap path:
//  - plain `optionalAuth` makes no extra lookup even for an admin token;
//  - the pricing-only public routes (agencies, agents, news) still mount
//    `optionalAuth`, and the three single-visa reads mount the strict one.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "@durin-tech/authz";

import { installFakes } from "../helpers/fake-firestore";
import type { AuthenticatedRequest } from "../../src/middleware/auth";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fake Firebase Auth
// ============================================

/** What the fake Auth knows about one account. */
interface FakeAccount {
  /** The account's CURRENT custom claims. */
  customClaims?: Record<string, unknown>;
  /** Firebase's own "user disabled" switch. */
  disabled?: boolean;
  /** True once refresh tokens were revoked (old ID tokens fail checkRevoked). */
  revoked?: boolean;
}

/** token string -> the claims that were baked into it when it was issued. */
let tokens: Record<string, Record<string, unknown>> = {};
/** uid -> current account state. A missing uid is a deleted user. */
let accounts: Record<string, FakeAccount> = {};
/** When set, `getUser` rejects with it (a network / quota failure). */
let getUserFailure: Error | null = null;

/** Every call the middleware made, so "no extra lookup" can be asserted. */
let verifyCalls: Array<{ token: string; checkRevoked: boolean }> = [];
let getUserCalls: string[] = [];

/** An error shaped like the Admin SDK's (a `code` such as auth/id-token-revoked). */
function authError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** The middleware under test, imported after the fakes are in place. */
let optionalAuth: (req: any, res: any, next: () => void) => Promise<void>;
let optionalAuthFresh: (req: any, res: any, next: () => void) => Promise<void>;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");

  // verifyIdToken: the token table; with checkRevoked it also consults the
  // account, as the real SDK does (revoked, disabled or deleted user: throws).
  firebase.auth.verifyIdToken = async (token: string, checkRevoked = false) => {
    verifyCalls.push({ token, checkRevoked });
    const decoded = tokens[token];
    if (!decoded) throw authError("auth/argument-error");
    if (checkRevoked) {
      const account = accounts[decoded.uid as string];
      if (!account) throw authError("auth/user-not-found");
      if (account.disabled) throw authError("auth/user-disabled");
      if (account.revoked) throw authError("auth/id-token-revoked");
    }
    return decoded;
  };
  firebase.auth.getUser = async (uid: string) => {
    getUserCalls.push(uid);
    if (getUserFailure) throw getUserFailure;
    const account = accounts[uid];
    if (!account) throw authError("auth/user-not-found");
    return { uid, customClaims: account.customClaims, disabled: account.disabled === true };
  };

  // attachAuthz collaborators: no entitlements cache; the DB role resolver is
  // only reached for an account with no role claim, and answers client.
  const { entitlementService }: any = await import("../../src/services/entitlement.service");
  entitlementService.getEntitlements = async () => null;
  const { claimsService }: any = await import("../../src/services/claims.service");
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  ({ optionalAuth, optionalAuthFresh } = (await import("../../src/middleware/auth")) as any);
});

beforeEach(() => {
  tokens = {};
  accounts = {};
  getUserFailure = null;
  verifyCalls = [];
  getUserCalls = [];
  // The middleware logs each guest fallback; keep the test output quiet.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
});

// ============================================
// Helpers
// ============================================

/** Result of running a middleware: the request it left behind + whether next() ran. */
interface Ran {
  req: AuthenticatedRequest;
  nextCalls: number;
  /** True when the middleware tried to answer itself (it never may). */
  responded: boolean;
}

/** Run `mw` on a request carrying `authorization` (raw header value, optional). */
async function run(
  mw: (req: any, res: any, next: () => void) => Promise<void>,
  authorization?: string
): Promise<Ran> {
  const out: Ran = { req: { headers: authorization ? { authorization } : {} } as any, nextCalls: 0, responded: false };
  const res = {
    status() {
      out.responded = true;
      return res;
    },
    json() {
      out.responded = true;
      return res;
    },
  };
  await mw(out.req, res, () => {
    out.nextCalls++;
  });
  return out;
}

/** Assert the request is served as a guest: passed on, with NO identity at all. */
function assertGuest(r: Ran, label = ""): void {
  assert.equal(r.nextCalls, 1, `${label} next() must run exactly once`);
  assert.equal(r.responded, false, `${label} optional auth never answers the request`);
  for (const key of ["user", "userId", "authz", "ability", "entitlements"] as const) {
    assert.equal(r.req[key], undefined, `${label} req.${key} must not be set for a guest`);
  }
}

/** True when any verifyIdToken call asked for the revocation check. */
const checkedRevocation = () => verifyCalls.some((c) => c.checkRevoked);

/** Issue a token for `uid` with `claims`, and register the account with the same claims. */
function signedIn(token: string, uid: string, claims: Record<string, unknown>): void {
  tokens[token] = { uid, ...claims };
  accounts[uid] = { customClaims: { ...claims } };
}

// ============================================
// Strict path: agent-side tokens
// ============================================

describe("optionalAuthFresh: agent-side tokens are answered from the account's current state", () => {
  test("a current admin: checkRevoked + getUser, served as admin", async () => {
    signedIn("tok", "uid-admin", { role: ROLES.ADMIN, admin: true });
    const r = await run(optionalAuthFresh, "Bearer tok");
    assert.equal(r.nextCalls, 1);
    assert.equal(r.req.userId, "uid-admin");
    assert.deepEqual(r.req.authz, { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null });
    assert.ok(r.req.ability, "ability attached");
    assert.equal(checkedRevocation(), true, "the token must be verified with checkRevoked");
    assert.deepEqual(getUserCalls, ["uid-admin"]);
  });

  test("a current owner and agent keep their role and agency", async () => {
    for (const role of [ROLES.OWNER, ROLES.AGENT]) {
      signedIn(`tok-${role}`, `uid-${role}`, { role, agencyId: "agency-a" });
      const r = await run(optionalAuthFresh, `Bearer tok-${role}`);
      assert.deepEqual(r.req.authz, { uid: `uid-${role}`, role, agencyId: "agency-a" }, role);
    }
    assert.equal(checkedRevocation(), true);
  });

  test("revoked token (suspension revoked the refresh tokens): guest", async () => {
    signedIn("tok", "uid-admin", { role: ROLES.ADMIN });
    accounts["uid-admin"].revoked = true;
    assertGuest(await run(optionalAuthFresh, "Bearer tok"));
  });

  test("`disabled: true` in the CURRENT claims, token not (yet) revoked: guest", async () => {
    // A token minted in the same second as the revocation passes the
    // revocation check; the current claim still makes the caller a guest.
    for (const role of [ROLES.ADMIN, ROLES.OWNER, ROLES.AGENT]) {
      signedIn("tok", "uid-x", { role, agencyId: "agency-a" });
      accounts["uid-x"].customClaims!.disabled = true;
      assertGuest(await run(optionalAuthFresh, "Bearer tok"), role);
    }
  });

  test("a disabled Firebase user: guest (whichever of the two lookups reports it)", async () => {
    signedIn("tok", "uid-admin", { role: ROLES.ADMIN });
    accounts["uid-admin"].disabled = true;
    assertGuest(await run(optionalAuthFresh, "Bearer tok"), "checkRevoked reports it");

    // Even if the revocation check let it through, getUser().disabled decides.
    const firebase: any = await import("../../src/utils/firebase");
    const realVerify = firebase.auth.verifyIdToken;
    firebase.auth.verifyIdToken = async (token: string) => tokens[token];
    try {
      assertGuest(await run(optionalAuthFresh, "Bearer tok"), "getUser reports it");
    } finally {
      firebase.auth.verifyIdToken = realVerify;
    }
  });

  test("token says admin, current claims say client (demotion): role is client", async () => {
    tokens["tok"] = { uid: "uid-ex", role: ROLES.ADMIN, admin: true };
    // What setAdmin(uid, false) leaves behind: nothing is revoked.
    accounts["uid-ex"] = { customClaims: { role: ROLES.CLIENT, agencyId: null, admin: false } };
    const r = await run(optionalAuthFresh, "Bearer tok");
    assert.equal(r.nextCalls, 1);
    assert.equal(r.req.userId, "uid-ex");
    assert.deepEqual(r.req.authz, { uid: "uid-ex", role: ROLES.CLIENT, agencyId: null });
    // No stale admin claim is left on req.user for a later check to trust.
    assert.equal((r.req.user as any).role, ROLES.CLIENT);
    assert.equal((r.req.user as any).admin, false);
    // The ability is the client's: no blanket `manage all`.
    assert.equal((r.req.ability as any).can("manage", "all"), false);
  });

  test("token says admin, current claims say agent of an agency: served as that agent", async () => {
    tokens["tok"] = { uid: "uid-ex", role: ROLES.ADMIN, admin: true };
    accounts["uid-ex"] = { customClaims: { role: ROLES.AGENT, agencyId: "agency-b", admin: false } };
    const r = await run(optionalAuthFresh, "Bearer tok");
    assert.deepEqual(r.req.authz, { uid: "uid-ex", role: ROLES.AGENT, agencyId: "agency-b" });
  });

  test("an agent moved to another agency is served with the CURRENT agency", async () => {
    tokens["tok"] = { uid: "uid-agent", role: ROLES.AGENT, agencyId: "agency-a" };
    accounts["uid-agent"] = { customClaims: { role: ROLES.AGENT, agencyId: null } };
    const r = await run(optionalAuthFresh, "Bearer tok");
    assert.deepEqual(r.req.authz, { uid: "uid-agent", role: ROLES.AGENT, agencyId: null });
    assert.equal((r.req.user as any).agencyId, null);
  });

  test("legacy `admin: true` / `agent: true` token claims (no role) take the strict path too", async () => {
    for (const legacy of [{ admin: true }, { agent: true }]) {
      verifyCalls = [];
      getUserCalls = [];
      tokens["tok"] = { uid: "uid-legacy", ...legacy };
      // Suspended since: must be a guest, which only the strict path notices.
      accounts["uid-legacy"] = { customClaims: { ...legacy, disabled: true }, revoked: true };
      assertGuest(await run(optionalAuthFresh, "Bearer tok"), JSON.stringify(legacy));
      assert.equal(checkedRevocation(), true, JSON.stringify(legacy));
    }
  });

  test("the account lookup throws (network): guest, not an error, not the token's claims", async () => {
    signedIn("tok", "uid-admin", { role: ROLES.ADMIN });
    getUserFailure = new Error("ECONNRESET");
    assertGuest(await run(optionalAuthFresh, "Bearer tok"));
  });

  test("the user was deleted: guest", async () => {
    tokens["tok"] = { uid: "uid-gone", role: ROLES.ADMIN };
    assertGuest(await run(optionalAuthFresh, "Bearer tok"));
  });

  test("the revocation check itself fails for another reason: guest", async () => {
    signedIn("tok", "uid-admin", { role: ROLES.ADMIN });
    const firebase: any = await import("../../src/utils/firebase");
    const realVerify = firebase.auth.verifyIdToken;
    firebase.auth.verifyIdToken = async (token: string, checkRevoked = false) => {
      if (checkRevoked) throw new Error("quota exceeded");
      return tokens[token];
    };
    try {
      assertGuest(await run(optionalAuthFresh, "Bearer tok"));
      assert.deepEqual(getUserCalls, [], "no claims are read once the revocation check failed");
    } finally {
      firebase.auth.verifyIdToken = realVerify;
    }
  });
});

// ============================================
// Cheap path on the strict middleware
// ============================================

describe("optionalAuthFresh: client tokens and guests cost nothing extra", () => {
  test("a client token: no getUser, no checkRevoked, served as the client", async () => {
    signedIn("tok", "uid-client", { role: ROLES.CLIENT });
    const r = await run(optionalAuthFresh, "Bearer tok");
    assert.equal(r.nextCalls, 1);
    assert.deepEqual(r.req.authz, { uid: "uid-client", role: ROLES.CLIENT, agencyId: null });
    assert.equal(r.req.userId, "uid-client");
    assert.deepEqual(getUserCalls, []);
    assert.deepEqual(verifyCalls, [{ token: "tok", checkRevoked: false }]);
  });

  test("a token with no role claim: the same lazy resolution as before, no strict lookup", async () => {
    signedIn("tok", "uid-new", {});
    const r = await run(optionalAuthFresh, "Bearer tok");
    // resolveRoleFromDb is faked above (client); the middleware itself makes
    // no getUser call and no revocation check.
    assert.deepEqual(r.req.authz, { uid: "uid-new", role: ROLES.CLIENT, agencyId: null });
    assert.deepEqual(getUserCalls, []);
    assert.equal(checkedRevocation(), false);
  });

  test("no header, a non-Bearer header, an invalid token: guest, no lookup", async () => {
    for (const header of [undefined, "Basic abc", "Bearer not-a-token"]) {
      assertGuest(await run(optionalAuthFresh, header), String(header));
    }
    assert.deepEqual(getUserCalls, []);
    assert.equal(checkedRevocation(), false);
  });

  test("a token already carrying `disabled`: guest without any lookup (#286)", async () => {
    signedIn("tok", "uid-admin", { role: ROLES.ADMIN, disabled: true });
    assertGuest(await run(optionalAuthFresh, "Bearer tok"));
    assert.deepEqual(getUserCalls, []);
    assert.equal(checkedRevocation(), false);
  });
});

// ============================================
// The cheap middleware and where each one is mounted
// ============================================

describe("optionalAuth (pricing-only routes) is unchanged", () => {
  test("no getUser and no checkRevoked, even for an admin, owner or agent token", async () => {
    for (const role of [ROLES.ADMIN, ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT]) {
      signedIn(`tok-${role}`, `uid-${role}`, { role, agencyId: null });
      const r = await run(optionalAuth, `Bearer tok-${role}`);
      assert.equal(r.req.authz?.role, role);
    }
    assert.deepEqual(getUserCalls, [], "optionalAuth must not look the account up");
    assert.equal(checkedRevocation(), false, "optionalAuth must not check revocation");
    assert.equal(verifyCalls.length, 4);
  });

  test("it still trusts the token's claims (which is why it must not guard extra data)", async () => {
    // Suspended since the token was issued: the cheap path cannot know.
    signedIn("tok", "uid-admin", { role: ROLES.ADMIN });
    accounts["uid-admin"].revoked = true;
    accounts["uid-admin"].customClaims!.disabled = true;
    const r = await run(optionalAuth, "Bearer tok");
    assert.equal(r.req.authz?.role, ROLES.ADMIN);
    assert.deepEqual(getUserCalls, []);
  });

  /** The middleware functions mounted on `GET path` of an Express router. */
  function mounted(router: any, path: string): unknown[] {
    const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods.get);
    assert.ok(layer, `GET ${path} is not registered`);
    return layer.route.stack.map((l: any) => l.handle);
  }

  test("agencies, agents and news mount optionalAuth, never the strict one", async () => {
    const { agencyRoutes }: any = await import("../../src/routes/agency.routes");
    const { agentRoutes }: any = await import("../../src/routes/agent.routes");
    const newsModule: any = await import("../../src/routes/news.routes");
    const newsRoutes = newsModule.newsRoutes ?? newsModule.default;
    const cheap: Array<[any, string]> = [
      [agencyRoutes, "/public/:slug"],
      [agencyRoutes, "/browse"],
      [agencyRoutes, "/browse/:id"],
      [agencyRoutes, "/browse/:id/agents"],
      [agentRoutes, "/"],
      [agentRoutes, "/top"],
      [agentRoutes, "/visa/:visaTypeId"],
      [agentRoutes, "/:id"],
      [newsRoutes, "/"],
      [newsRoutes, "/:id"],
    ];
    for (const [router, path] of cheap) {
      const handlers = mounted(router, path);
      assert.ok(handlers.includes(optionalAuth), `GET ${path} must use optionalAuth`);
      assert.ok(!handlers.includes(optionalAuthFresh), `GET ${path} must not use optionalAuthFresh`);
    }
  });

  test("the three single-visa reads mount optionalAuthFresh", async () => {
    const { countryRoutes }: any = await import("../../src/routes/visa.routes");
    for (const path of ["/:code/visas/:visaId", "/:code/visas/:visaId/full", "/:code/visas/:visaId/requirements"]) {
      const handlers = mounted(countryRoutes, path);
      assert.ok(handlers.includes(optionalAuthFresh), `GET ${path} must use optionalAuthFresh`);
      assert.ok(!handlers.includes(optionalAuth), `GET ${path} must not use the cheap optionalAuth`);
    }
  });
});
