import { auth, collections } from "../utils/firebase";
import { Agent } from "../types";
import { Role } from "@durin-tech/authz";

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
  }

  /** Promote/demote a user to admin (used by the admin role-management endpoint). */
  async setAdmin(uid: string, isAdmin: boolean): Promise<void> {
    if (isAdmin) {
      await this.setRoleClaims(uid, "admin");
    } else {
      // Drop back to whatever the DB says they otherwise are.
      const resolved = await this.resolveRoleFromDb(uid);
      await this.setRoleClaims(uid, resolved.role, resolved.agencyId);
    }
  }

  /**
   * Resolve a user's effective role from current Firestore state — the canonical
   * resolver used for migration, lazy backfill, and admin demotion.
   *
   * Precedence: admin (legacy user-doc field or existing claim) > agency member
   * (owner/agent from the `agents` collection) > independent agent > client.
   */
  async resolveRoleFromDb(
    uid: string
  ): Promise<{ role: Role; agencyId: string | null }> {
    // 1. Admin — honor the legacy user-doc field or an existing admin claim.
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
}

export const claimsService = new ClaimsService();
