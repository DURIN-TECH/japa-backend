import { auth, collections } from "../utils/firebase";
import { Agent } from "../types";
import { Role, ROLES } from "@durin-tech/authz";

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
      admin: role === "admin", // legacy compatibility
    });

    // Keep the legacy Firestore `users/{uid}.admin` field in lockstep with the claim
    // we just wrote. It's still consulted by resolveRoleFromDb (and any other legacy
    // reader), and seed data sets it — so an admin created here must carry it, and a
    // demotion must clear it, or the two admin signals drift. We use update() (not
    // set/merge) deliberately: it no-ops when the user has no profile doc, so a full
    // backfill over auth-only users never materializes empty `{admin:false}` docs.
    // If there's no doc to sync, the custom claim above is authoritative on its own.
    await collections.users
      .doc(uid)
      .update({ admin: role === "admin" })
      .catch(() => {
        /* no profile doc yet — claim is authoritative, nothing to sync */
      });
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
   * Resolve a user's effective role from current Firestore state — the canonical
   * resolver used for migration, lazy backfill, and admin demotion.
   *
   * Precedence: admin (legacy user-doc field or existing claim) > agency member
   * (owner/agent from the `agents` collection) > independent agent > client.
   *
   * Pass `ignoreAdmin: true` to skip the admin short-circuit — used by the demotion
   * path, which needs the role the user would have *without* admin (otherwise the
   * still-present admin claim/field would resolve them right back to admin).
   */
  async resolveRoleFromDb(
    uid: string,
    opts: { ignoreAdmin?: boolean } = {}
  ): Promise<{ role: Role; agencyId: string | null }> {
    // 1. Admin — honor the legacy user-doc field or an existing admin claim,
    //    unless the caller explicitly asked us to ignore admin (demotion).
    if (!opts.ignoreAdmin) {
      try {
        const [userDoc, authUser] = await Promise.all([
          collections.users.doc(uid).get(),
          auth.getUser(uid).catch(() => null),
        ]);
        const userData = userDoc.exists ? userDoc.data() : null;
        if (userData?.admin === true || authUser?.customClaims?.admin === true) {
          return { role: "admin", agencyId: null };
        }
      } catch {
        // fall through to agent/client resolution
      }
    }

    // 2. Agent or owner — look up the agents collection.
    const agentSnap = await collections.agents
      .where("userId", "==", uid)
      .limit(1)
      .get();
    if (!agentSnap.empty) {
      const agent = agentSnap.docs[0].data() as Agent;
      const role: Role = agent.agencyRole === "owner" ? "owner" : "agent";
      return { role, agencyId: agent.agencyId ?? null };
    }

    // 3. Default — client.
    return { role: "client", agencyId: null };
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
    const claims = user?.customClaims || {};
    return claims.role === ROLES.ADMIN || claims.admin === true;
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
        const claims = user.customClaims || {};
        if (claims.role === ROLES.ADMIN || claims.admin === true) count++;
      }
      nextPageToken = page.pageToken;
    } while (nextPageToken);
    return count;
  }
}

export const claimsService = new ClaimsService();
