import { FieldValue } from "firebase-admin/firestore";
import { collections, subcollections } from "../../utils/firebase";
import { authorityService } from "../../authorities/authority.service";
import { sharedRouteService } from "../../shared-routes/shared-route.service";
import { RegistryError } from "../../scrapers";
import type { Authority, AuthorityMember } from "../../types/authority";
import type { VisaType } from "../../types";
import { EMPTY_SHARED_VISA_DATA, type SharedVisaData } from "../../data/shared-visa-data-format";

// ============================================
// SHARED-VISA MODEL MIGRATION (issue #239, P10 of #228) — THE RUNNER
// ============================================
//
// Brings existing dev data in line with the shared-visa model on purpose, not
// by accident. NO compatibility layer: after this runs, the temporary
// "read the old field" tolerance can go (see officialDomainAuthorityId).
//
// DRY RUN BY DEFAULT: with `dryRun: true` this only READS and reports. With
// `dryRun: false` it writes. A second apply changes nothing (every step plans
// only what differs).
//
// What it does, in order (each step reports; a step that cannot proceed
// reports why and the run goes on, so one problem never hides the others):
//
//  1. SNAPSHOT every rulebook head and its approved version (read only).
//  2. REPORT whether the Netherlands rulebook (`visaRubrics/NL_nl-visitor`)
//     exists, with its versions and sources. Nothing is created, deleted or
//     re-drafted: an existing rulebook simply stays as that record's own
//     ("thin") layer, because its key does not change. The owner decides on a
//     re-draft; this script never spends model credit.
//  3. CREATE the country authority for every country that has a route (a visa
//     record, a visa source registry entry, or an official website). The id is
//     the country code, the name is the country's name.
//  4. REWRITE `officialDomains/{host}`: `countryCode` becomes `authorityId`
//     (same value; the old field is removed). Docs already in the new shape
//     are left alone.
//  5. DELETE the retired Nigeria -> Ireland `visaExemptions` seed row (it had
//     no quoted official source). Dry run LISTS every row first; any other row
//     is left alone and listed as such.
//  6. APPLY the shared visa DATA FILE, through the same services the admin API
//     uses (so every rule and every audit entry is the API's): the bloc or
//     treaty, its members (each with a verbatim quote and an official URL),
//     the shared route, and which visa records inherit it. An empty data file
//     writes nothing. A member whose official host is not confirmed yet is
//     reported as blocked (confirm the host in the portal, then run again).
//  7. RE-SNAPSHOT the rulebooks and compare with step 1: heads and approved
//     versions must be identical (this script never writes `visaRubrics`).
//
// Left alone ON PURPOSE (already in the new shape, so nothing to copy): the
// ids of `visaSources/{cc}` (a country's authority id IS its code) and the
// `jurisdiction` of guidance sources. Their counts are printed as a check.

/** Who the migration's writes (and their audit entries) are attributed to. */
export const MIGRATION_ACTOR = "system:migration-239";

/** The retired seed row's identity: Nigeria -> Ireland, written by the old eligibility seed. */
const RETIRED_EXEMPTION = { nationality: "NG", destinationCountry: "IE", source: "Irish Naturalisation and Immigration Service (INIS)" } as const;

/** The Netherlands record whose rulebook the owner asked about. */
const NL_ROUTE_KEY = "NL_nl-visitor";

// ============================================
// Report types
// ============================================

/** A stable fingerprint of one stored document (for before/after comparison). */
export interface RulebookFingerprint {
  routeKey: string;
  approvedVersion: number | null;
  /** Fingerprint of the head document. */
  head: string;
  /** Fingerprint of the approved version document ("none" when there is no approved version). */
  approved: string;
}

export interface RulebookCheck {
  before: RulebookFingerprint[];
  /** Filled after the writes (the same as `before` on a dry run, which writes nothing). */
  after: RulebookFingerprint[];
  /** Heads and approved versions identical before and after. */
  identical: boolean;
  /** How many of them are UK (`GB_*`) rulebooks. */
  ukHeads: number;
  /** Every UK head that has an approved version still loads (the document exists and says approved). */
  ukApprovedStillServe: boolean;
}

export interface NlRulebookReport {
  routeKey: string;
  /** Does `visaRubrics/NL_nl-visitor` exist? */
  exists: boolean;
  approvedVersion: number | null;
  latestVersion: number | null;
  versionCount: number;
  /** Guidance source ids the head says it was drafted from, and whether each still exists. */
  sources: Array<{ id: string; exists: boolean }>;
  /** Pages on the registry entry `visaSources/NL`, if there is one. */
  visaSourcePages: number;
  /** What the owner has to know, in plain words. */
  summary: string;
}

export type StepOutcome = "unchanged" | "would_create" | "created" | "would_update" | "updated" | "would_delete" | "deleted" | "conflict" | "blocked";

export interface ItemResult {
  id: string;
  outcome: StepOutcome;
  /** Plain-words reason for `conflict` / `blocked`. */
  reason?: string;
}

export interface MigrationReport {
  dryRun: boolean;
  rulebooks: RulebookCheck;
  nl: NlRulebookReport;
  countryAuthorities: ItemResult[];
  officialDomains: ItemResult[];
  /** Every `visaExemptions` row found, and what happens to it. */
  visaExemptions: Array<ItemResult & { nationality?: unknown; destinationCountry?: unknown; source?: unknown }>;
  sharedData: { supplied: boolean; authorities: ItemResult[]; members: ItemResult[]; routes: ItemResult[]; inheritance: ItemResult[] };
  /** Already-compatible collections: counts only. */
  untouched: { visaSources: number; guidanceSources: number };
}

// ============================================
// Fingerprints (pure)
// ============================================

/** Canonical JSON: sorted keys, Timestamps as milliseconds (so equal docs give equal text). */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v && typeof v === "object") {
      const t = v as { toMillis?: () => number };
      if (typeof t.toMillis === "function") return { __timestampMs: t.toMillis() };
      if (Array.isArray(v)) return v.map(norm);
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v === undefined ? null : v;
  };
  return JSON.stringify(norm(value));
}

/** Fingerprint every rulebook head and its approved version (read only). */
export async function snapshotRulebooks(): Promise<RulebookFingerprint[]> {
  const heads = await collections.visaRubrics.get();
  const out: RulebookFingerprint[] = [];
  for (const h of heads.docs) {
    const data = h.data() as { approvedVersion?: number | null };
    const approvedVersion = typeof data.approvedVersion === "number" ? data.approvedVersion : null;
    let approved = "none";
    if (approvedVersion !== null) {
      const v = await subcollections.rubricVersions(h.id).doc(String(approvedVersion)).get();
      approved = v.exists ? canonical(v.data()) : "missing";
    }
    out.push({ routeKey: h.id, approvedVersion, head: canonical(data), approved });
  }
  return out.sort((a, b) => a.routeKey.localeCompare(b.routeKey));
}

/** Compare two snapshots: same keys, same heads, same approved versions. */
export function sameRulebooks(a: RulebookFingerprint[], b: RulebookFingerprint[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================
// Step 2: the Netherlands rulebook report
// ============================================

export async function reportNlRulebook(): Promise<NlRulebookReport> {
  const headSnap = await collections.visaRubrics.doc(NL_ROUTE_KEY).get();
  const visaSource = await collections.visaSources.doc("NL").get();
  const visaSourcePages = visaSource.exists ? ((visaSource.data() as { pages?: unknown[] }).pages ?? []).length : 0;
  if (!headSnap.exists) {
    return {
      routeKey: NL_ROUTE_KEY,
      exists: false,
      approvedVersion: null,
      latestVersion: null,
      versionCount: 0,
      sources: [],
      visaSourcePages,
      summary: `No rulebook exists for ${NL_ROUTE_KEY}: none is created by this migration. Netherlands rules start from the shared route's own rulebook once one is drafted.`,
    };
  }
  const head = headSnap.data() as { approvedVersion?: number | null; latestVersion?: number; sourceIds?: string[] };
  const versions = await subcollections.rubricVersions(NL_ROUTE_KEY).get();
  const sources: Array<{ id: string; exists: boolean }> = [];
  for (const id of head.sourceIds ?? []) sources.push({ id, exists: (await collections.guidanceSources.doc(id).get()).exists });
  return {
    routeKey: NL_ROUTE_KEY,
    exists: true,
    approvedVersion: typeof head.approvedVersion === "number" ? head.approvedVersion : null,
    latestVersion: typeof head.latestVersion === "number" ? head.latestVersion : null,
    versionCount: versions.size,
    sources,
    visaSourcePages,
    summary:
      `A rulebook EXISTS for ${NL_ROUTE_KEY} (${versions.size} version(s), approved: ${typeof head.approvedVersion === "number" ? `v${head.approvedVersion}` : "none"}). ` +
      "It is kept as-is and becomes the Netherlands own (\"thin\") layer (its key does not change). It is NOT re-drafted by this script: a re-draft spends model credit and is an explicit owner decision.",
  };
}

// ============================================
// Step 3: country authorities
// ============================================

/** Country codes that have a route: a visa record, a visa source entry, or a confirmed official website. */
async function countriesWithRoutes(): Promise<Array<{ code: string; name: string }>> {
  const countries = await collections.countries.get();
  const domains = await collections.officialDomains.get();
  const domainCountries = new Set(
    domains.docs.map((d) => {
      const x = d.data() as { authorityId?: string; countryCode?: string };
      return x.authorityId || x.countryCode || "";
    })
  );
  const out: Array<{ code: string; name: string }> = [];
  for (const c of countries.docs) {
    const hasVisa = !(await subcollections.visaTypes(c.id).limit(1).get()).empty;
    const hasSource = (await collections.visaSources.doc(c.id).get()).exists;
    if (hasVisa || hasSource || domainCountries.has(c.id)) {
      out.push({ code: c.id, name: String((c.data() as { name?: unknown }).name ?? "") });
    }
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

async function migrateCountryAuthorities(dryRun: boolean): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const c of await countriesWithRoutes()) {
    const existing = await collections.authorities.doc(c.code).get();
    if (existing.exists) {
      const a = existing.data() as Authority;
      if (a.kind === "country" && a.name === c.name) results.push({ id: c.code, outcome: "unchanged" });
      else results.push({ id: c.code, outcome: "conflict", reason: `an authority ${c.code} already exists as ${a.kind} "${a.name}"; left alone` });
      continue;
    }
    if (!c.name.trim()) {
      results.push({ id: c.code, outcome: "blocked", reason: "the country has no name" });
      continue;
    }
    if (dryRun) {
      results.push({ id: c.code, outcome: "would_create" });
      continue;
    }
    try {
      // Through the service: validates the country exists and audits the write.
      await authorityService.create({ id: c.code, kind: "country", name: c.name }, MIGRATION_ACTOR);
      results.push({ id: c.code, outcome: "created" });
    } catch (e) {
      results.push({ id: c.code, outcome: "blocked", reason: reasonOf(e) });
    }
  }
  return results;
}

// ============================================
// Step 4: official websites
// ============================================

async function migrateOfficialDomains(dryRun: boolean): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  const snap = await collections.officialDomains.get();
  for (const d of snap.docs) {
    const x = d.data() as { authorityId?: unknown; countryCode?: unknown };
    const hasNew = typeof x.authorityId === "string" && x.authorityId !== "";
    const hasOld = typeof x.countryCode === "string" && x.countryCode !== "";
    if (hasNew && !hasOld && !("countryCode" in x)) {
      results.push({ id: d.id, outcome: "unchanged" });
    } else if (hasNew && hasOld && x.authorityId !== x.countryCode) {
      // Two different values: never guess which is right.
      results.push({ id: d.id, outcome: "conflict", reason: `authorityId "${String(x.authorityId)}" and countryCode "${String(x.countryCode)}" disagree; left alone` });
    } else if (!hasNew && !hasOld) {
      results.push({ id: d.id, outcome: "blocked", reason: "has neither authorityId nor countryCode; left alone (it matches no authority)" });
    } else if (dryRun) {
      results.push({ id: d.id, outcome: "would_update" });
    } else {
      // authorityId = the old country code (a country's authority id IS its code); the old field goes.
      await d.ref.update({ authorityId: hasNew ? x.authorityId : x.countryCode, countryCode: FieldValue.delete() });
      results.push({ id: d.id, outcome: "updated" });
    }
  }
  return results;
}

// ============================================
// Step 5: the retired exemption rows
// ============================================

async function retireExemptions(dryRun: boolean): Promise<MigrationReport["visaExemptions"]> {
  const results: MigrationReport["visaExemptions"] = [];
  const snap = await collections.visaExemptions.get();
  for (const d of snap.docs) {
    const x = d.data() as { nationality?: unknown; destinationCountry?: unknown; source?: unknown };
    const info = { nationality: x.nationality, destinationCountry: x.destinationCountry, source: x.source };
    const isRetired = x.nationality === RETIRED_EXEMPTION.nationality && x.destinationCountry === RETIRED_EXEMPTION.destinationCountry && x.source === RETIRED_EXEMPTION.source;
    if (!isRetired) {
      // Not the seed row (an admin may have added it): never deleted by this script.
      results.push({ id: d.id, outcome: "unchanged", reason: "not the retired seed row; left alone", ...info });
    } else if (dryRun) {
      results.push({ id: d.id, outcome: "would_delete", ...info });
    } else {
      await d.ref.delete();
      results.push({ id: d.id, outcome: "deleted", ...info });
    }
  }
  return results;
}

// ============================================
// Step 6: the data file
// ============================================

/** Plain words for a thrown error (RegistryError has a message written for admins). */
function reasonOf(e: unknown): string {
  if (e instanceof RegistryError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

async function applySharedData(data: SharedVisaData, dryRun: boolean): Promise<MigrationReport["sharedData"]> {
  const out: MigrationReport["sharedData"] = { supplied: data.authorities.length + data.sharedRoutes.length > 0, authorities: [], members: [], routes: [], inheritance: [] };

  // ---- Authorities and members ----
  for (const a of data.authorities) {
    const existing = await collections.authorities.doc(a.id).get();
    if (existing.exists) {
      const e = existing.data() as Authority;
      out.authorities.push(e.kind === a.kind && e.name === a.name ? { id: a.id, outcome: "unchanged" } : { id: a.id, outcome: "conflict", reason: `already exists as ${e.kind} "${e.name}"; edit it in the portal` });
    } else if (dryRun) {
      out.authorities.push({ id: a.id, outcome: "would_create" });
    } else {
      try {
        await authorityService.create({ id: a.id, kind: a.kind, name: a.name }, MIGRATION_ACTOR);
        out.authorities.push({ id: a.id, outcome: "created" });
      } catch (e) {
        out.authorities.push({ id: a.id, outcome: "blocked", reason: reasonOf(e) });
      }
    }

    for (const m of a.members) {
      const label = `${a.id}/${m.countryCode}`;
      const storedSnap = await subcollections.authorityMembers(a.id).doc(m.countryCode).get();
      const stored = storedSnap.exists ? (storedSnap.data() as AuthorityMember) : undefined;
      const same = !!stored && stored.joinedOn === m.joinedOn && (stored.leftOn ?? undefined) === m.leftOn && stored.sourceQuote === m.sourceQuote && stored.sourceUrl === m.sourceUrl;
      if (same) {
        out.members.push({ id: label, outcome: "unchanged" });
        continue;
      }
      if (dryRun) {
        // The full rule (which authority owns the host) runs on apply; a dry run reports the part it can see.
        const host = new URL(m.sourceUrl).hostname.toLowerCase();
        const hostSnap = await collections.officialDomains.doc(host).get();
        const confirmed = hostSnap.exists && (hostSnap.data() as { status?: string }).status === "confirmed";
        out.members.push(confirmed ? { id: label, outcome: stored ? "would_update" : "would_create" } : { id: label, outcome: "blocked", reason: `${host} is not a confirmed official website yet: confirm it in the portal first` });
        continue;
      }
      try {
        const r = await authorityService.putMember(a.id, m.countryCode, { joinedOn: m.joinedOn, ...(m.leftOn ? { leftOn: m.leftOn } : {}), sourceQuote: m.sourceQuote, sourceUrl: m.sourceUrl }, MIGRATION_ACTOR);
        out.members.push({ id: label, outcome: !r.changed ? "unchanged" : r.created ? "created" : "updated" });
      } catch (e) {
        out.members.push({ id: label, outcome: "blocked", reason: reasonOf(e) });
      }
    }
  }

  // ---- Shared routes and the records that inherit them ----
  for (const r of data.sharedRoutes) {
    const existing = await sharedRouteService.get(r.id);
    if (existing) {
      const same = existing.name === r.name && existing.category === r.category && existing.issuingAuthorityId === r.issuingAuthorityId && JSON.stringify(existing.destinations) === JSON.stringify(r.destinations);
      out.routes.push(same ? { id: r.id, outcome: "unchanged" } : { id: r.id, outcome: "conflict", reason: "already exists with a different body; edit it in the portal" });
    } else if (dryRun) {
      out.routes.push({ id: r.id, outcome: "would_create" });
    } else {
      try {
        await sharedRouteService.create({ id: r.id, name: r.name, category: r.category, issuingAuthorityId: r.issuingAuthorityId, destinations: r.destinations }, MIGRATION_ACTOR);
        out.routes.push({ id: r.id, outcome: "created" });
      } catch (e) {
        out.routes.push({ id: r.id, outcome: "blocked", reason: reasonOf(e) });
      }
    }

    for (const who of r.inheritedBy) {
      const label = `${who.countryCode}/${who.visaTypeId} <- ${r.id}`;
      const visaSnap = await subcollections.visaTypes(who.countryCode).doc(who.visaTypeId).get();
      if (!visaSnap.exists) {
        out.inheritance.push({ id: label, outcome: "blocked", reason: "no such visa record (seed it first)" });
        continue;
      }
      const current = ((visaSnap.data() as VisaType).inheritsFrom ?? []).map((x) => x.sharedRouteId);
      if (current.includes(r.id)) {
        out.inheritance.push({ id: label, outcome: "unchanged" });
        continue;
      }
      if (dryRun) {
        out.inheritance.push({ id: label, outcome: "would_update" });
        continue;
      }
      try {
        // Keep whatever else the record already inherits; add this route once.
        await sharedRouteService.setInheritance(who.countryCode, who.visaTypeId, [...current, r.id].map((sharedRouteId) => ({ sharedRouteId })), MIGRATION_ACTOR);
        out.inheritance.push({ id: label, outcome: "updated" });
      } catch (e) {
        out.inheritance.push({ id: label, outcome: "blocked", reason: reasonOf(e) });
      }
    }
  }
  return out;
}

// ============================================
// The run
// ============================================

/**
 * Run the migration (or its dry run) and return the full report.
 * @param opts.dryRun  default TRUE: read and report only
 * @param opts.data    the validated shared visa data (default: empty, writes no bloc)
 * @param opts.log     where progress lines go (default console.log)
 */
export async function runSharedVisaMigration(opts: { dryRun?: boolean; data?: SharedVisaData; log?: (line: string) => void } = {}): Promise<MigrationReport> {
  const dryRun = opts.dryRun ?? true;
  const data = opts.data ?? EMPTY_SHARED_VISA_DATA;
  const log = opts.log ?? ((l: string) => console.log(l));
  log(`Shared-visa model migration (${dryRun ? "DRY RUN: nothing is written" : "APPLY"})`);

  // 1 + 2: read-only facts first.
  const before = await snapshotRulebooks();
  const nl = await reportNlRulebook();
  log(`\n[rulebooks] ${before.length} head(s) fingerprinted (${before.filter((r) => r.routeKey.startsWith("GB_")).length} UK).`);
  log(`[netherlands] ${nl.summary}`);
  if (nl.exists) log(`  versions: ${nl.versionCount}; sources: ${nl.sources.map((s) => `${s.id}${s.exists ? "" : " (MISSING)"}`).join(", ") || "none"}; visaSources/NL pages: ${nl.visaSourcePages}`);

  // 3..6: the writes (or their plan).
  const countryAuthorities = await migrateCountryAuthorities(dryRun);
  const officialDomains = await migrateOfficialDomains(dryRun);
  const visaExemptions = await retireExemptions(dryRun);
  const sharedData = await applySharedData(data, dryRun);

  // Collections that are already in the new shape: counts only.
  const untouched = { visaSources: (await collections.visaSources.get()).size, guidanceSources: (await collections.guidanceSources.get()).size };

  // 7: the rulebooks must be exactly as they were.
  const after = await snapshotRulebooks();
  const identical = sameRulebooks(before, after);
  const uk = before.filter((r) => r.routeKey.startsWith("GB_"));
  const ukApprovedStillServe = uk.every((r) => r.approvedVersion === null || after.some((a) => a.routeKey === r.routeKey && a.approvedVersion === r.approvedVersion && a.approved !== "missing" && a.approved !== "none"));
  const rulebooks: RulebookCheck = { before, after, identical, ukHeads: uk.length, ukApprovedStillServe };

  const report: MigrationReport = { dryRun, rulebooks, nl, countryAuthorities, officialDomains, visaExemptions, sharedData, untouched };
  printReport(report, log);
  return report;
}

/** Count items by outcome, as "a=2, b=1". */
function tally(items: ItemResult[]): string {
  const c = new Map<string, number>();
  for (const i of items) c.set(i.outcome, (c.get(i.outcome) ?? 0) + 1);
  return items.length === 0 ? "none" : [...c.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
}

/** Print the counts, and every item that needs a human (conflicts, blocked, and what would be deleted). */
export function printReport(r: MigrationReport, log: (line: string) => void): void {
  log("\n---------------- REPORT ----------------");
  log(`country authorities : ${tally(r.countryAuthorities)}`);
  log(`official websites   : ${tally(r.officialDomains)}`);
  log(`visaExemptions rows : ${tally(r.visaExemptions)}`);
  for (const e of r.visaExemptions) log(`  - ${e.id}: ${String(e.nationality)} -> ${String(e.destinationCountry)} (${String(e.source)}) => ${e.outcome}`);
  log(`shared data         : ${r.sharedData.supplied ? "supplied" : "EMPTY (no bloc, shared route or inheritance written)"}`);
  log(`  authorities       : ${tally(r.sharedData.authorities)}`);
  log(`  members           : ${tally(r.sharedData.members)}`);
  log(`  shared routes     : ${tally(r.sharedData.routes)}`);
  log(`  inheritance       : ${tally(r.sharedData.inheritance)}`);
  const attention = [
    ...r.countryAuthorities,
    ...r.officialDomains,
    ...r.sharedData.authorities,
    ...r.sharedData.members,
    ...r.sharedData.routes,
    ...r.sharedData.inheritance,
  ].filter((i) => i.outcome === "conflict" || i.outcome === "blocked");
  for (const i of attention) log(`  ! ${i.outcome}: ${i.id}: ${i.reason}`);
  log(`untouched (already compatible): visaSources=${r.untouched.visaSources}, guidanceSources=${r.untouched.guidanceSources}`);
  log(`rulebooks: ${r.rulebooks.before.length} head(s); UK heads=${r.rulebooks.ukHeads}; head + approved version identical before/after: ${r.rulebooks.identical ? "YES" : "NO !!"}; UK approved still serve: ${r.rulebooks.ukApprovedStillServe ? "YES" : "NO !!"}`);
  log(r.dryRun ? "\nDry run only. Re-run with --apply to write." : "\nDone.");
}
