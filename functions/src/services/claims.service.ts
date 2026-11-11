import { auth, collections } from "../utils/firebase";
import { Agent, Agency } from "../types";
import { Role, ROLES } from "@durin-tech/authz";

/**
 * The legacy admin signals on a set of custom claims: the canonical `role`
 * claim, or the older `admin: true` boolean that predates it (the seeder and
 * early grants wrote only that). Custom claims can be written only with the
 * Admin SDK, so either one is a server-side decision.
 */
function claimsSayAdmin(claims: Record<string, unknown> | undefined | null): boolean {
  return claims?.role === ROLES.ADMIN || claims?.admin === true;
}

/**
 * Claims service — the single source of truth for a user's RBAC role.
 *
 * Role (and the owning agencyId) live in Firebase custom claims so they ride in
 * the ID token and require no DB lookup to enforce. This replaces the previous
 * ad-hoc model where `admin` was checked two different ways (claim vs a
 * `users/{id}.admin` field) and agent/owner was re-derived by querying the
 * `agents` collection on every request.
 *
 * All role changes go through here so claims stay consistent, and the client is
 * told to refresh its token after a change.
 */
class ClaimsService {
  /**
   * Set a user's role + agencyId claims, preserving any unrelated claims. Keeps
   * the legacy `admin` boolean claim in sync (admin === role "admin") during the
   * migration window so older checks keep working.
   */
  async setRoleClaims(
    uid: string,
    role: Role,
    agencyId?: string | null
  ): Promise<void> {
    const user = await auth.getUser(uid);
    const existing = user.customClaims || {};
    await auth.setCustomUserClaims(uid, {
      ...existing,
      role,
      agencyId: agencyId ?? null,
      admin: role === ROLES.ADMIN, // legacy compatibility
    });

    // Mirror the admin decision onto the legacy Firestore `users/{uid}.admin`
    // field. That field is NOT a source of the role any more (issue #135:
    // resolveRoleFromDb reads the claim only); it is kept because two readers
    // still use it to pick who receives admin notifications (compliance
    // submissions, scraper alerts) and seed data sets it. Rules:
    //  - promotion: set it to true;
    //  - a real demotion (the account held the admin claim until this call):
    //    clear it, so the ex-admin stops receiving admin notifications;
    //  - any other non-admin write (lazy backfill, sign-up, bulk backfill):
    //    leave the field ALONE. If it says `true` on an account that never
    //    held the claim, that is exactly what the audit script
    //    (scripts/audit-role-trust.ts) reports for a human to look at, and
    //    silently overwriting it here would destroy that evidence.
    // update() (not set/merge) on purpose: it no-ops when the user has no
    // profile doc, so a backfill over auth-only users never creates empty
    // `{admin: ...}` docs. With no doc to sync, the claim stands on its own.
    const isAdminNow = role === ROLES.ADMIN;
    if (isAdminNow || claimsSayAdmin(existing)) {
      await collections.users
        .doc(uid)
        .update({ admin: isAdminNow })
        .catch(() => {
          /* no profile doc yet — claim is authoritative, nothing to sync */
        });
    }
  }

  /** Promote/demote a user to admin (used by the admin role-management endpoint). */
  async setAdmin(uid: string, isAdmin: boolean): Promise<void> {
    if (isAdmin) {
      await this.setRoleClaims(uid, "admin");
    } else {
      // Real demotion. resolveRoleFromDb(ignoreAdmin) computes the role the user would
      // have WITHOUT admin — otherwise the still-present admin claim/field would resolve
      // them straight back to admin. setRoleClaims then rewrites the claim AND clears the
      // legacy Firestore `admin` field (see there), so no later backfill can re-promote.
      const resolved = await this.resolveRoleFromDb(uid, { ignoreAdmin: true });
      await this.setRoleClaims(uid, resolved.role, resolved.agencyId);
    }
  }

  /**
   * Suspend or restore a user's account access.
   *
   * Sets a `disabled` custom claim (hard-checked by verifyAuth to block every
   * request) and, when disabling, REVOKES the user's refresh tokens so their
   * live session dies on the very next request: the existing ID token fails the
   * checkRevoked verification (→ 401), and any token re-issued after this call
   * carries `disabled: true` (→ 403). Restoring just clears the claim; the user
   * signs in again to obtain a clean token. Best-effort/idempotent.
   */
  async setAccountDisabled(uid: string, disabled: boolean): Promise<void> {
    const user = await auth.getUser(uid);
    const existing = user.customClaims || {};
    await auth.setCustomUserClaims(uid, { ...existing, disabled });
    if (disabled) {
      // Kill the live session immediately — forces re-auth on the next request.
      await auth.revokeRefreshTokens(uid);
    }
  }

  /**
   * Resolve a user's effective role from SERVER-WRITTEN state only — the
   * canonical resolver used for migration, lazy backfill (a token with no role
   * claim yet, e.g. right after sign-up), and admin demotion.
   *
   * Trust rule (issue #135): nothing a user can write themselves may decide
   * their role or agency. So:
   *  - ADMIN comes only from the account's custom claims (`role: "admin"` or
   *    the older `admin: true`), which only the Admin SDK can write. The
   *    `users/{uid}.admin` document field is NOT consulted: a profile document
   *    is not an authority. When that field says admin but the claims do not,
   *    a warning is logged (so a legacy admin who was only ever flagged on the
   *    document is noticed, not silently demoted) and admin is not granted.
   *    Fix for a real admin: `npm run admin:grant`.
   *  - OWNER requires two server-written records to agree: the user's agent
   *    document says `agencyRole: "owner"` of an agency, AND that agency's own
   *    document names this user as `ownerId`. An agent document alone is not
   *    enough to own an agency.
   *  - AGENT of an agency requires the agent document's `agencyId` to name an
   *    agency that exists. `agencyId` / `agencyRole` on agent documents are
   *    written only by the backend (firestore.rules and the profile endpoints
   *    both refuse them from a client).
   *  - An agent document whose agency claim does not check out still makes the
   *    user an agent, but an INDEPENDENT one (no agency), with a warning.
   *
   * Precedence: admin > owner > agency agent > independent agent > client.
   *
   * Pass `ignoreAdmin: true` to skip the admin short-circuit — used by the
   * demotion path, which needs the role the user would have *without* admin
   * (otherwise the still-present admin claim would resolve them right back).
   */
  async resolveRoleFromDb(
    uid: string,
    opts: { ignoreAdmin?: boolean } = {}
  ): Promise<{ role: Role; agencyId: string | null }> {
    // 1. Admin — custom claims only, unless the caller asked us to ignore
    //    admin (demotion).
    if (!opts.ignoreAdmin) {
      // Only "this account does not exist" means "no claims". Any other Auth
      // failure (network, quota, permission) is rethrown: treating it as "not
      // an admin" would let a transient error resolve a real admin to a lower
      // role, and the lazy backfill would then write that role into their
      // claims. The request-time caller (middleware/auth.ts) already falls
      // back to least privilege for THAT request without writing anything.
      const authUser = await auth.getUser(uid).catch((error: unknown) => {
        if ((error as { code?: string })?.code === "auth/user-not-found") return null;
        throw error;
      });
      if (claimsSayAdmin(authUser?.customClaims)) {
        return { role: ROLES.ADMIN, agencyId: null };
      }
      // Not an admin by claim. If the legacy document field says otherwise,
      // say so loudly (never grant): see the method comment.
      await this.warnIfLegacyAdminFieldOnly(uid);
    }

    // 2. Agent or owner — from the user's agent document(s), each checked
    //    against the agency's own record. A user normally has exactly one
    //    agent document; if there are several, the best VERIFIED claim wins
    //    (never "whichever the query returned first").
    const agentSnap = await collections.agents.where("userId", "==", uid).get();
    if (!agentSnap.empty) {
      let memberOf: string | null = null;
      for (const doc of agentSnap.docs) {
        const agent = doc.data() as Agent;
        if (!agent.agencyId) continue; // independent profile: nothing to check
        // `agencyId` must be a usable document id. Anything else (a number, an
        // object, a path with a slash) is malformed data, never a membership:
        // skip it explicitly rather than let doc() throw.
        if (typeof agent.agencyId !== "string" || agent.agencyId.includes("/")) {
          console.warn(
            `[authz] agent document ${doc.id} has a malformed agencyId; ` +
              `not granting agency access to user ${uid}`
          );
          continue;
        }

        const agencyDoc = await collections.agencies.doc(agent.agencyId).get();
        if (!agencyDoc.exists) {
          console.warn(
            `[authz] agent document ${doc.id} names agency ${agent.agencyId}, which does not exist; ` +
              `not granting agency access to user ${uid}`
          );
          continue;
        }
        const agency = agencyDoc.data() as Agency;

        if (agent.agencyRole === ROLES.OWNER) {
          // Ownership must be confirmed by the agency document itself.
          if (agency.ownerId === uid) {
            return { role: ROLES.OWNER, agencyId: agent.agencyId };
          }
          console.warn(
            `[authz] agent document ${doc.id} says user ${uid} owns agency ${agent.agencyId}, ` +
              "but the agency names a different owner; not granting agency access"
          );
          continue;
        }

        // A member (non-owner) of an existing agency.
        memberOf = memberOf ?? agent.agencyId;
      }
      return { role: ROLES.AGENT, agencyId: memberOf };
    }

    // 3. Default — client.
    return { role: ROLES.CLIENT, agencyId: null };
  }

  /**
   * Log a warning when `users/{uid}.admin === true` on an account that holds
   * no admin claim. Purely informational: the field never grants anything.
   * It exists so a legacy admin who was flagged only on the document (before
   * roles moved to custom claims) shows up in the logs instead of quietly
   * becoming a client. Never throws.
   */
  private async warnIfLegacyAdminFieldOnly(uid: string): Promise<void> {
    try {
      const userDoc = await collections.users.doc(uid).get();
      if (userDoc.exists && userDoc.data()?.admin === true) {
        console.warn(
          `[authz] users/${uid}.admin is true but the account has no admin custom claim; ` +
            "admin NOT granted (issue #135). If this is a real admin, run `npm run admin:grant`; " +
            "otherwise clear the field. See scripts/audit-role-trust.ts."
        );
      }
    } catch {
      // A failed read must never block role resolution.
    }
  }

  /** Recompute and write a user's claims from current DB state (idempotent). */
  async syncClaimsFromDb(uid: string): Promise<{ role: Role; agencyId: string | null }> {
    const resolved = await this.resolveRoleFromDb(uid);
    await this.setRoleClaims(uid, resolved.role, resolved.agencyId);
    return resolved;
  }

  /**
   * Whether a user currently holds the admin role. Reads the live custom claims
   * (the source of truth) and honors the legacy `admin` boolean during migration.
   * Returns false if the user doesn't exist.
   */
  async isAdmin(uid: string): Promise<boolean> {
    const user = await auth.getUser(uid).catch(() => null);
    return claimsSayAdmin(user?.customClaims);
  }

  /**
   * The uids of every account that currently holds the admin role, read from
   * custom claims (the only source of the role, issue #135). Used to decide
   * who receives admin notifications, so that a `users/{uid}.admin` document
   * field can never put someone on that list. A full scan of Auth users, like
   * countAdmins below: fine for the rare events that notify admins.
   */
  async listAdminUids(): Promise<string[]> {
    const uids: string[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, nextPageToken);
      for (const user of page.users) {
        if (claimsSayAdmin(user.customClaims)) uids.push(user.uid);
      }
      nextPageToken = page.pageToken;
    } while (nextPageToken);
    return uids;
  }

  /**
   * Count how many users currently hold the admin role, by paging through every
   * Firebase Auth user and inspecting their custom claims. Admin claims can't be
   * queried directly (custom claims aren't indexed), so this is a full scan — fine
   * because it's only called on the rare admin-demotion path as a last-admin guard.
   */
  async countAdmins(): Promise<number> {
    let count = 0;
    let nextPageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, nextPageToken);
      for (const user of page.users) {
        if (claimsSayAdmin(user.customClaims)) count++;
      }
      nextPageToken = page.pageToken;
    } while (nextPageToken);
    return count;
  }
}

export const claimsService = new ClaimsService();
