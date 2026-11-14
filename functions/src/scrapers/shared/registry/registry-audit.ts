import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections } from "../../../utils/firebase";

// ============================================
// SOURCE REGISTRY — AUDIT TRAIL (issue #215)
// ============================================
//
// `sourceRegistryAudit/{autoId}`: one APPEND-ONLY record for every confirm,
// revoke, register, edit and retirement made through the registry API: who,
// when, what, and the object before and after. Rulebooks publish with no
// person reading them, so "which page did an admin point the system at, and
// who confirmed that website" must always be answerable afterwards.
//
// Append-only is enforced three ways:
//   - this module exposes ONE write, `appendRegistryAudit`, which uses
//     `tx.create` (fails if the id exists) on a fresh auto id;
//   - no code anywhere updates or deletes an audit doc (a test greps for it);
//   - the collection has no firestore.rules match, so clients are denied.
// The entry is written INSIDE the same transaction as the change it records,
// so a change can never be stored without its audit entry (or the reverse).

/** What happened. */
export type RegistryAuditAction =
  | "domain_confirmed"
  | "domain_revoked"
  | "country_created"
  | "visa_page_added"
  | "source_added"
  | "source_changed"
  | "route_registered"
  // Route onboarding runs (issue #217): who started, confirmed (the number they
  // saw) and cancelled a run, who added a route to the publish allow-list
  // through it, and who changed the onboarding settings.
  | "onboarding_started"
  | "onboarding_confirmed"
  | "onboarding_cancelled"
  | "onboarding_allowlist_added"
  | "onboarding_settings_changed"
  // Issuing authorities (issue #230): who created or edited an authority (a
  // country, bloc or treaty), and who added or changed a bloc/treaty member
  // (with the before/after quote and URL, since membership is a legal claim).
  | "authority_created"
  | "authority_changed"
  | "authority_member_added"
  | "authority_member_changed" | "shared_route_created" | "shared_route_changed" | "visa_inheritance_changed"; // #231

/** One audit entry as stored. */
export interface RegistryAuditEntry {
  action: RegistryAuditAction;
  // uid of the admin (or "system:..." for an automatic consequence such as a revoke pausing a source).
  actorUid: string;
  at: Timestamp;
  // What the entry is about: "officialDomain" | "country" | "visaSource" | "guidanceSource" | "route" | "onboardingRun" | "setting"
  // | "authority" | "authorityMember" (#230; a member's id is `{authorityId}/{countryCode}`).
  targetType: string;
  targetId: string;
  // The object before and after the change (null when it did not exist / no longer applies).
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  // Free text the admin typed that justified the action (the confirmation statement, a revoke reason).
  statement?: string;
}

/** Firestore refuses `undefined` anywhere in a document: drop it, deeply. */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v)) as unknown as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)])
    ) as T;
  }
  return value;
}

/**
 * Append one entry inside `tx`. Returns the new entry's id. The only write
 * to the audit collection in the codebase.
 */
export function appendRegistryAudit(tx: Transaction, entry: RegistryAuditEntry): string {
  const ref = collections.sourceRegistryAudit.doc();
  tx.create(ref, stripUndefined({ ...entry }));
  return ref.id;
}
