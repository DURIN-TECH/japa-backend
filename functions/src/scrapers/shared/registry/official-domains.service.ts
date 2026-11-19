import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { appendRegistryAudit, stripUndefined } from "./registry-audit";
import { parseRegistryHost } from "./registry-address";
import { resolveRegistryAuthority } from "./registry-authority";
import { RegistryError } from "./registry-errors";
import { loadRegistrySettings } from "./registry-settings";
import type { VisaSourcePage } from "../../visa-catalog/types";

// ============================================
// OFFICIAL DOMAINS — THE CONFIRMED-HOSTS ALLOW-LIST (issue #215)
// ============================================
//
// `officialDomains/{host}`: one doc per EXACT host an admin confirmed as an
// official website. This is the safeguard that stands in for a human reading
// the rules: rulebooks publish automatically, so the system must never read a
// rulebook from a page on a site nobody vouched for. Registration refuses any
// address whose host is not `confirmed`, and registry fetches refuse a redirect
// to a host that is not `confirmed` (see the crawl services).
//
// What the code cannot do is prove a site is governmental. It records WHO
// confirmed WHICH host, WHEN, what they typed (the issuing authority), and what
// the system itself read from the site at that moment (title, language, size,
// opening text, kept server-side from the address check the admin made).
//
// Matching is on EXACT hosts. There are no subdomain wildcards in this version
// (the codebase has no public-suffix list, so a pattern such as "*.co.xx" could
// not be told apart from a real organisation); wildcards are refused outright.
//
// Issue #232 (P3 of #228): a host belongs to ONE ISSUING AUTHORITY (a country,
// a bloc or a treaty), stored as `authorityId`. For a country the value is the
// same two-letter code the old `countryCode` field held. A host confirmed for
// one authority cannot be confirmed for another (409
// HOST_CONFIRMED_FOR_OTHER_AUTHORITY); letting one host serve several
// authorities is a separate follow-up (FU-3). Sources registered for an
// authority may only use hosts confirmed for THAT authority
// (`confirmedHostsFor`).

/** The stored doc. */
export interface OfficialDomain {
  host: string;
  /** The issuing authority the host was confirmed for (country code, or bloc/treaty id). */
  authorityId: string;
  status: "confirmed" | "revoked";
  confirmedBy: string; // uid, or "system:seed" for the one-off import
  confirmedAt: Timestamp;
  // What the admin typed: the issuing authority. Required, never empty.
  statement: string;
  // What the system read at confirmation (absent only for the seed import).
  evidencePreview?: {
    finalUrl: string;
    title: string | null;
    language: string | null;
    httpStatus: number;
    characterCount: number;
    openingText: string;
    previewedAt: Timestamp;
  };
  addedVia: "portal" | "seed";
  revokedBy?: string;
  revokedAt?: Timestamp;
  revokeReason?: string;
}

/**
 * A stored doc as it may still be read before the dev migration (#239) runs:
 * documents written before #232 carry `countryCode` and no `authorityId`.
 */
type StoredOfficialDomain = Omit<OfficialDomain, "authorityId"> & { authorityId?: string; countryCode?: string };

/**
 * The authority a stored host belongs to.
 *
 * LEGACY READ, the ONE place it happens: a document written before #232 has
 * only `countryCode`; a country's authority id IS its code, so that value is
 * used as the authority. REMOVE this fallback once the migration script of
 * #239 (P10 of #228) has rewritten every `officialDomains` doc on dev; prod
 * is migrated in the same deliberate release. Returns "" for a doc with
 * neither field (never matches any authority, so it fails closed).
 */
export function officialDomainAuthorityId(raw: unknown): string {
  const d = (raw ?? {}) as { authorityId?: unknown; countryCode?: unknown };
  if (typeof d.authorityId === "string" && d.authorityId) return d.authorityId;
  // TODO(#239): delete this legacy branch after the officialDomains migration
  // (scripts/migrate-shared-visa-model.ts) has run on EVERY environment that
  // holds old docs. Kept for now: the code deploys before the script runs, and
  // without this branch an old doc matches no authority (the crawl fails closed).
  if (typeof d.countryCode === "string" && d.countryCode) return d.countryCode;
  return "";
}

/**
 * A stored doc in today's shape: `authorityId` filled (legacy fallback above)
 * and the old `countryCode` field dropped, so nothing downstream ever sees it.
 */
export function readOfficialDomain(raw: unknown): OfficialDomain {
  const { countryCode: _legacy, ...rest } = (raw ?? {}) as StoredOfficialDomain;
  void _legacy;
  return { ...rest, authorityId: officialDomainAuthorityId(raw) } as OfficialDomain;
}

/** Bounds of the typed statement. */
export const STATEMENT_MIN_CHARS = 3;
export const STATEMENT_MAX_CHARS = 500;
export const REVOKE_REASON_MAX_CHARS = 500;

/** Actor recorded for changes the system makes itself (a revoke pausing sources). */
const SYSTEM_REVOKE_ACTOR = "system:host_revoked";
/** Why a source was paused by a revoke. */
export const HOST_REVOKED_REASON = "host_revoked";

/** Host of a stored source address (lowercased), or "" when unparseable. */
function hostOfUrl(url: unknown): string {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The id of a stored address check: one per admin and requested host. */
export function previewDocId(uid: string, host: string): string {
  return `${uid}__${host}`;
}

/** Result of a revoke, for the response. */
export interface RevokeResult {
  domain: OfficialDomain;
  changed: boolean;
  pausedGuidanceSources: string[];
  /** Paused visa pages: the visa source's id (its authority) and the page address. */
  pausedVisaPages: Array<{ authorityId: string; url: string }>;
}

class OfficialDomainsService {
  /** Transaction runner (tests swap in the in-memory one). */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);
  /** Clock in epoch ms. */
  clock: () => number = Date.now;

  /**
   * Confirm one exact host for an issuing authority (issue #232).
   *
   * Requires: a valid exact host (no wildcard), an authority that exists (a
   * real country code, or a bloc/treaty in `authorities`, not retired: see
   * registry-authority.ts), a typed statement (the name of the body that runs
   * the site), and a fresh address check this admin made for exactly this
   * host whose final host was that same host (a redirect to another site
   * proves nothing about THIS site). Idempotent: confirming a host that is
   * already confirmed for the same authority changes and audits nothing; for
   * a different authority it is 409 HOST_CONFIRMED_FOR_OTHER_AUTHORITY.
   */
  async confirm(input: { host: unknown; authorityId: unknown; statement: unknown }, actorUid: string): Promise<{ domain: OfficialDomain; created: boolean }> {
    const host = parseRegistryHost(input.host);
    if (!host.ok) throw new RegistryError(host.code, 400, host.message);
    const statement = typeof input.statement === "string" ? input.statement.trim() : "";
    if (statement.length < STATEMENT_MIN_CHARS) {
      throw new RegistryError("STATEMENT_REQUIRED", 400, "Type the name of the authority that runs this website");
    }
    if (statement.length > STATEMENT_MAX_CHARS) {
      throw new RegistryError("STATEMENT_TOO_LONG", 400, `The statement is longer than ${STATEMENT_MAX_CHARS} characters`);
    }
    const loaded = await loadRegistrySettings();
    if (loaded.readError) throw new RegistryError("SETTINGS_UNAVAILABLE", 503, "Settings could not be read; try again shortly");
    const maxAgeMs = loaded.settings.previewMaxAgeMinutes * 60_000;

    const now = this.clock();
    const domainRef = collections.officialDomains.doc(host.host);
    const previewRef = collections.officialDomainPreviews.doc(previewDocId(actorUid, host.host));

    return this.runTransaction(async (tx) => {
      // All reads first. The authority is read in the SAME transaction, so a
      // bloc retired a moment ago cannot receive a new website.
      const authority = await resolveRegistryAuthority(input.authorityId, (ref) => tx.get(ref));
      const [domainSnap, previewSnap] = await Promise.all([tx.get(domainRef), tx.get(previewRef)]);
      const existing = domainSnap.exists ? readOfficialDomain(domainSnap.data()) : undefined;

      // Idempotent: already confirmed -> same answer, no write, no audit entry.
      // One host, one authority: another authority's claim is a conflict.
      if (existing?.status === "confirmed") {
        if (existing.authorityId !== authority.id) {
          throw new RegistryError("HOST_CONFIRMED_FOR_OTHER_AUTHORITY", 409, "That website is already confirmed for a different authority", {
            confirmedFor: existing.authorityId,
          });
        }
        return { domain: existing, created: false };
      }

      // The evidence must be the server's own record of a recent check of THIS host.
      const preview = previewSnap.exists ? (previewSnap.data() as Record<string, unknown>) : undefined;
      const previewedAt = preview?.previewedAt instanceof Timestamp ? preview.previewedAt.toMillis() : 0;
      if (!preview || now - previewedAt > maxAgeMs) {
        throw new RegistryError("PREVIEW_REQUIRED", 422, "Check the address first: confirmation rests on what the system read from the website just now");
      }
      if (preview.redirectedToOtherHost === true || preview.finalHost !== host.host) {
        throw new RegistryError(
          "PREVIEW_HOST_MISMATCH",
          422,
          "That address redirected to a different website, so the check says nothing about this one. Check and confirm the website it ended on instead"
        );
      }

      const domain: OfficialDomain = stripUndefined({
        host: host.host,
        authorityId: authority.id,
        status: "confirmed",
        confirmedBy: actorUid,
        confirmedAt: Timestamp.fromMillis(now),
        statement,
        evidencePreview: {
          finalUrl: String(preview.finalUrl),
          title: (preview.title as string | null) ?? null,
          language: (preview.language as string | null) ?? null,
          httpStatus: Number(preview.httpStatus),
          characterCount: Number(preview.characterCount),
          openingText: String(preview.openingText ?? ""),
          previewedAt: preview.previewedAt as Timestamp,
        },
        addedVia: "portal",
      });
      tx.set(domainRef, domain);
      appendRegistryAudit(tx, {
        action: "domain_confirmed",
        actorUid,
        at: Timestamp.fromMillis(now),
        targetType: "officialDomain",
        targetId: host.host,
        before: existing ? ({ ...existing } as unknown as Record<string, unknown>) : null,
        after: domain as unknown as Record<string, unknown>,
        statement,
      });
      return { domain, created: true };
    });
  }

  /**
   * Keep the address check an admin just made, server-side, so a later
   * confirmation rests on what the SYSTEM read and not on what a client sends
   * back. One doc per admin and requested host (a newer check replaces it).
   */
  async recordPreview(actorUid: string, preview: { host: string; finalUrl: string; finalHost: string; redirectedToOtherHost: boolean; httpStatus: number; title: string | null; language: string | null; characterCount: number; openingText: string }): Promise<void> {
    await collections.officialDomainPreviews.doc(previewDocId(actorUid, preview.host)).set(
      stripUndefined({ ...preview, adminUid: actorUid, previewedAt: Timestamp.fromMillis(this.clock()) })
    );
  }

  /** Every host, sorted by host name. */
  async list(): Promise<OfficialDomain[]> {
    const snap = await collections.officialDomains.get();
    return snap.docs.map((d) => readOfficialDomain(d.data())).sort((a, b) => a.host.localeCompare(b.host));
  }

  /**
   * The exact hosts whose status is `confirmed`, for ANY authority.
   *
   * No crawl uses this any more: every fetch policy, including the guidance
   * crawl's, asks for ONE authority's hosts through `confirmedHostsFor`. Kept
   * for admin listings and tests only; never use it to decide what to fetch.
   */
  async confirmedHosts(): Promise<Set<string>> {
    const snap = await collections.officialDomains.where("status", "==", "confirmed").get();
    return new Set(snap.docs.map((d) => String((d.data() as OfficialDomain).host).toLowerCase()));
  }

  /**
   * The exact hosts confirmed for ONE authority (issue #232): the allow-list
   * for registering, previewing, re-activating and crawling that authority's
   * sources. A host confirmed for another authority is NOT in it, so a
   * redirect to it is refused like a redirect to any unconfirmed host.
   *
   * Reads every confirmed host and filters in memory rather than querying
   * `authorityId`: documents written before #232 only carry `countryCode`
   * (see officialDomainAuthorityId), and the list is small. Fails closed: a
   * read error propagates, and the caller fetches nothing.
   */
  async confirmedHostsFor(authorityId: string): Promise<Set<string>> {
    const snap = await collections.officialDomains.where("status", "==", "confirmed").get();
    return new Set(
      snap.docs
        .filter((d) => officialDomainAuthorityId(d.data()) === authorityId)
        .map((d) => String((d.data() as OfficialDomain).host).toLowerCase())
    );
  }

  /** Status of one host: "confirmed", "revoked" or "not_confirmed". */
  async statusOf(host: string): Promise<"confirmed" | "revoked" | "not_confirmed"> {
    const snap = await collections.officialDomains.doc(host).get();
    if (!snap.exists) return "not_confirmed";
    return (snap.data() as OfficialDomain).status === "confirmed" ? "confirmed" : "revoked";
  }

  /**
   * Revoke a host. Sets `revoked` (audited), then pauses every portal-added
   * source whose address is on that host: guidance sources (status paused,
   * pausedReason host_revoked) and visa pages (paused, pausedReason). Nothing is
   * deleted; an admin re-activates a source by hand after re-confirming. A host
   * that is already revoked answers `changed: false` (still pausing anything
   * that was missed, so a half-finished revoke can be repeated).
   */
  async revoke(rawHost: unknown, reason: unknown, actorUid: string): Promise<RevokeResult> {
    const host = parseRegistryHost(rawHost);
    if (!host.ok) throw new RegistryError(host.code, 400, host.message);
    const why = reason === undefined ? undefined : typeof reason === "string" ? reason.trim() : null;
    if (why === null || (why !== undefined && why.length > REVOKE_REASON_MAX_CHARS)) {
      throw new RegistryError("INVALID_REASON", 400, `The reason must be text of at most ${REVOKE_REASON_MAX_CHARS} characters`);
    }
    const now = this.clock();
    const ref = collections.officialDomains.doc(host.host);

    const { domain, changed } = await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegistryError("NOT_FOUND", 404, "That website is not in the confirmed list");
      const existing = readOfficialDomain(snap.data());
      if (existing.status === "revoked") return { domain: existing, changed: false };
      const next: OfficialDomain = stripUndefined({
        ...existing,
        status: "revoked" as const,
        revokedBy: actorUid,
        revokedAt: Timestamp.fromMillis(now),
        ...(why ? { revokeReason: why } : {}),
      });
      tx.set(ref, next);
      appendRegistryAudit(tx, {
        action: "domain_revoked",
        actorUid,
        at: Timestamp.fromMillis(now),
        targetType: "officialDomain",
        targetId: host.host,
        before: existing as unknown as Record<string, unknown>,
        after: next as unknown as Record<string, unknown>,
        statement: why || undefined,
      });
      return { domain: next, changed: true };
    });

    const paused = await this.pauseSourcesOnHost(host.host, now);
    return { domain, changed, ...paused };
  }

  /**
   * Pause every portal-added source on `host` (guidance sources, visa pages).
   * Each change is its own transaction with its own audit entry, so one
   * failing source never leaves another unaudited.
   */
  private async pauseSourcesOnHost(
    host: string,
    now: number
  ): Promise<{ pausedGuidanceSources: string[]; pausedVisaPages: Array<{ authorityId: string; url: string }> }> {
    const pausedGuidanceSources: string[] = [];
    const pausedVisaPages: Array<{ authorityId: string; url: string }> = [];
    const at = Timestamp.fromMillis(now);

    // ---- Guidance sources ----
    const guidance = await collections.guidanceSources.where("addedVia", "==", "portal").get();
    for (const doc of guidance.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (hostOfUrl(data.url) !== host) continue;
      await this.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const cur = snap.data() as Record<string, unknown> | undefined;
        // Already paused or retired: nothing to do (a retired source stays retired).
        if (!cur || cur.status === "paused" || cur.status === "retired") return;
        const after = { status: "paused", pausedReason: HOST_REVOKED_REASON };
        tx.update(doc.ref, after);
        appendRegistryAudit(tx, {
          action: "source_changed",
          actorUid: SYSTEM_REVOKE_ACTOR,
          at,
          targetType: "guidanceSource",
          targetId: doc.id,
          before: { status: cur.status ?? null, pausedReason: cur.pausedReason ?? null },
          after,
        });
        pausedGuidanceSources.push(doc.id);
      });
    }

    // ---- Visa pages (inside the per-authority registry docs, `visaSources/{authorityId}`) ----
    const visa = await collections.visaSources.get();
    for (const doc of visa.docs) {
      const first = doc.data() as { pages?: VisaSourcePage[] };
      if (!(first.pages ?? []).some((p) => p.addedVia === "portal" && hostOfUrl(p.url) === host)) continue;
      await this.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const cur = snap.data() as { pages?: VisaSourcePage[]; officialHosts?: string[]; countryCode?: string } | undefined;
        if (!cur?.pages) return;
        let touched = false;
        const pages = cur.pages.map((p) => {
          if (p.addedVia !== "portal" || hostOfUrl(p.url) !== host || p.paused) return p;
          touched = true;
          appendRegistryAudit(tx, {
            action: "source_changed",
            actorUid: SYSTEM_REVOKE_ACTOR,
            at,
            targetType: "visaSource",
            targetId: `${doc.id}#${p.url}`,
            before: { paused: p.paused ?? false },
            after: { paused: true, pausedReason: HOST_REVOKED_REASON },
          });
          pausedVisaPages.push({ authorityId: doc.id, url: p.url });
          return { ...p, paused: true, pausedReason: HOST_REVOKED_REASON };
        });
        // The revoked host also stops being an allowed apply-link host.
        const officialHosts = (cur.officialHosts ?? []).filter((h) => h.toLowerCase() !== host);
        const hostsChanged = officialHosts.length !== (cur.officialHosts ?? []).length;
        if (!touched && !hostsChanged) return;
        tx.update(doc.ref, { pages, ...(cur.officialHosts ? { officialHosts } : {}), updatedAt: at });
      });
    }
    return { pausedGuidanceSources, pausedVisaPages };
  }
}

export const officialDomainsService = new OfficialDomainsService();
