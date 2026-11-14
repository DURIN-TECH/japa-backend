import { Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { VISA_SOURCE_OFFICIAL_HOSTS } from "../../visa-catalog/visa-catalog-official-hosts";
import { appendRegistryAudit } from "./registry-audit";
import { parseRegistryHost } from "./registry-address";
import type { OfficialDomain } from "./official-domains.service";

// ============================================
// OFFICIAL DOMAINS — ONE-OFF IMPORT OF THE BUILT-IN HOSTS (issue #215)
// ============================================
//
// `VISA_SOURCE_OFFICIAL_HOSTS` (code) already says which hosts are official for
// the countries that were set up by hand. The portal's allow-list is the
// `officialDomains` collection, so the EXACT hosts of that constant are
// imported once as confirmed, `confirmedBy: "system:seed"`.
//
//  - Pattern entries ("*.apex") are NOT imported: the allow-list has no
//    wildcards. They stay in the code constant and keep working there
//    (apply-link checks, GOV.UK adapter links).
//  - Idempotent: a host that already has a doc (confirmed OR revoked) is left
//    alone, so a re-run never un-revokes a host an admin revoked and never
//    rewrites a portal confirmation.
//  - Every import writes an audit entry (actor "system:seed").

/** Who the import records as having confirmed the hosts. */
export const SEED_ACTOR = "system:seed";

/** What the import records as the statement. */
export const SEED_STATEMENT = "Imported from the registry's built-in list of official hosts";

/** One host the import would create. */
export interface PlannedDomain {
  host: string;
  countryCode: string;
}

/**
 * The exact hosts to import (pure): every non-pattern entry of `hosts` that is a
 * valid exact host, once each, in a stable order. Patterns and invalid entries
 * are reported in `skipped` with the reason.
 */
export function planOfficialDomainImport(
  hosts: Record<string, readonly string[]> = VISA_SOURCE_OFFICIAL_HOSTS
): { planned: PlannedDomain[]; skipped: Array<{ entry: string; reason: string }> } {
  const planned: PlannedDomain[] = [];
  const skipped: Array<{ entry: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const [countryCode, entries] of Object.entries(hosts).sort(([a], [b]) => a.localeCompare(b))) {
    for (const entry of entries) {
      if (entry.includes("*")) {
        skipped.push({ entry, reason: "pattern entry: stays in the code constant" });
        continue;
      }
      const parsed = parseRegistryHost(entry);
      if (!parsed.ok) {
        skipped.push({ entry, reason: parsed.message });
        continue;
      }
      if (seen.has(parsed.host)) continue;
      seen.add(parsed.host);
      planned.push({ host: parsed.host, countryCode: countryCode.toUpperCase() });
    }
  }
  return { planned, skipped };
}

/**
 * Import the planned hosts that have no doc yet. Returns what was created and
 * what already existed. `apply: false` only reports.
 */
export async function importOfficialDomains(options: { apply: boolean; now?: number } = { apply: false }): Promise<{
  created: string[];
  existing: string[];
  skipped: Array<{ entry: string; reason: string }>;
}> {
  const { planned, skipped } = planOfficialDomainImport();
  const now = Timestamp.fromMillis(options.now ?? Date.now());
  const created: string[] = [];
  const existing: string[] = [];
  for (const p of planned) {
    const ref = collections.officialDomains.doc(p.host);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        existing.push(p.host);
        return;
      }
      created.push(p.host);
      if (!options.apply) return;
      const doc: OfficialDomain = {
        host: p.host,
        countryCode: p.countryCode,
        status: "confirmed",
        confirmedBy: SEED_ACTOR,
        confirmedAt: now,
        statement: SEED_STATEMENT,
        addedVia: "seed",
      };
      tx.create(ref, doc as unknown as Record<string, unknown>);
      appendRegistryAudit(tx, {
        action: "domain_confirmed",
        actorUid: SEED_ACTOR,
        at: now,
        targetType: "officialDomain",
        targetId: p.host,
        before: null,
        after: doc as unknown as Record<string, unknown>,
        statement: SEED_STATEMENT,
      });
    });
  }
  return { created, existing, skipped };
}
