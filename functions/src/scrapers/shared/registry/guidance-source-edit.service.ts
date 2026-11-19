import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { GUIDANCE_SOURCE_ROLES, type GuidanceSourceRole } from "../../guidance/types";
import { appendRegistryAudit } from "./registry-audit";
import { RegistryError } from "./registry-errors";
import { officialDomainAuthorityId } from "./official-domains.service";

// ============================================
// GUIDANCE SOURCE EDITS (issue #215)
// ============================================
//
// `PATCH /admin/guidance-sources/:id`: an admin can set a source's `status`
// (active, paused, retired) and its `role`. Nothing else, and nothing is ever
// DELETED: retiring a source is the removal, and it stays in the registry (and
// the audit trail) forever. Every change writes one audit entry in the same
// transaction as the change.
//
// Guard rails:
//  - a portal-added source cannot be set `active` while its host is not a
//    host confirmed FOR THE SOURCE'S AUTHORITY (its `jurisdiction`, issue
//    #232): a revoke paused it, re-confirm the host first; a host confirmed
//    for a different authority does not count;
//  - setting `active` clears the system's `pausedReason`;
//  - a role change that would leave the route (same jurisdiction + route,
//    sources not retired) without a `primary` source is refused: without one,
//    extraction applies no route scoping and cross-route rules would be kept;
//  - a role set here is remembered (`roleEditedBy`) so a later seed run, which
//    owns the role of a seeded entry, does not overwrite the admin's choice.

/** The statuses an admin may set (never "failing": only the crawler does that). */
export const EDITABLE_GUIDANCE_STATUSES = ["active", "paused", "retired"] as const;
type EditableStatus = (typeof EDITABLE_GUIDANCE_STATUSES)[number];

/** Keys the body may carry. */
export const GUIDANCE_PATCH_KEYS = ["status", "role"] as const;

/** A validated patch (at least one field). */
export interface GuidanceSourcePatch {
  status?: EditableStatus;
  role?: GuidanceSourceRole;
}

/** Strict body parse: only the whitelisted keys, each from its enum. Throws RegistryError 400. */
export function parseGuidancePatch(raw: unknown): GuidanceSourcePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RegistryError("VALIDATION_ERROR", 400, "The body must be an object");
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!(GUIDANCE_PATCH_KEYS as readonly string[]).includes(k)) {
      throw new RegistryError("VALIDATION_ERROR", 400, `"${k}" is not a field that can be changed here (only ${GUIDANCE_PATCH_KEYS.join(" and ")})`, { field: k });
    }
  }
  const patch: GuidanceSourcePatch = {};
  if (body.status !== undefined) {
    if (!(EDITABLE_GUIDANCE_STATUSES as readonly unknown[]).includes(body.status)) {
      throw new RegistryError("VALIDATION_ERROR", 400, `status must be one of: ${EDITABLE_GUIDANCE_STATUSES.join(", ")}`, { field: "status" });
    }
    patch.status = body.status as EditableStatus;
  }
  if (body.role !== undefined) {
    if (!(GUIDANCE_SOURCE_ROLES as readonly unknown[]).includes(body.role)) {
      throw new RegistryError("VALIDATION_ERROR", 400, `role must be one of: ${GUIDANCE_SOURCE_ROLES.join(", ")}`, { field: "role" });
    }
    patch.role = body.role as GuidanceSourceRole;
  }
  if (patch.status === undefined && patch.role === undefined) {
    throw new RegistryError("VALIDATION_ERROR", 400, "Give a status or a role to change");
  }
  return patch;
}

class GuidanceSourceEditService {
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);
  clock: () => number = Date.now;

  /** Apply a patch. Returns what changed (empty `changes` = a no-op, nothing written or audited). */
  async patch(id: string, rawBody: unknown, actorUid: string): Promise<{ id: string; changes: Record<string, { from: unknown; to: unknown }> }> {
    const patch = parseGuidancePatch(rawBody);
    const ref = collections.guidanceSources.doc(id);
    const now = Timestamp.fromMillis(this.clock());

    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegistryError("NOT_FOUND", 404, "That guidance source is not in the registry");
      const cur = snap.data() as Record<string, unknown>;
      const update: Record<string, unknown> = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      if (patch.status !== undefined && patch.status !== cur.status) {
        if (patch.status === "active" && cur.addedVia === "portal") {
          let host = "";
          try {
            host = new URL(String(cur.url)).hostname.toLowerCase();
          } catch {
            /* an unreadable address is never confirmed */
          }
          // The host's own record, read in this transaction: it must be
          // confirmed, and confirmed for the authority this source belongs to.
          const domainSnap = host ? await tx.get(collections.officialDomains.doc(host)) : undefined;
          const domain = domainSnap?.exists ? (domainSnap.data() as Record<string, unknown>) : undefined;
          const ok = domain?.status === "confirmed" && officialDomainAuthorityId(domain) === String(cur.jurisdiction ?? "");
          if (!ok) {
            throw new RegistryError(
              "HOST_NOT_CONFIRMED",
              422,
              `${host || "This address"} is not a confirmed official website of this source's authority, so the source cannot be switched on`,
              { hosts: [host] }
            );
          }
        }
        update.status = patch.status;
        changes.status = { from: cur.status ?? null, to: patch.status };
        // An admin's choice replaces the system's reason for a pause.
        if (cur.pausedReason !== undefined && cur.pausedReason !== null) {
          update.pausedReason = null;
          changes.pausedReason = { from: cur.pausedReason, to: null };
        }
      }

      if (patch.role !== undefined && patch.role !== cur.role) {
        // Would the route be left without a primary source?
        if (cur.role === "primary") {
          const siblings = await tx.get(collections.guidanceSources.where("jurisdiction", "==", cur.jurisdiction).where("route", "==", cur.route));
          const otherPrimary = siblings.docs.some((d) => d.id !== id && (d.data() as { role?: string; status?: string }).role === "primary" && (d.data() as { status?: string }).status !== "retired");
          if (!otherPrimary) {
            throw new RegistryError("PRIMARY_REQUIRED", 422, "This is the route's only primary source: mark another one primary first");
          }
        }
        update.role = patch.role;
        update.roleEditedBy = actorUid;
        update.roleEditedAt = now;
        changes.role = { from: cur.role ?? null, to: patch.role };
      }

      if (Object.keys(changes).length === 0) return { id, changes };
      update.updatedAt = now;
      tx.update(ref, update);
      appendRegistryAudit(tx, {
        action: "source_changed",
        actorUid,
        at: now,
        targetType: "guidanceSource",
        targetId: id,
        before: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
        after: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
      });
      return { id, changes };
    });
  }
}

export const guidanceSourceEditService = new GuidanceSourceEditService();
