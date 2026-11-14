import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { appendRegistryAudit, stripUndefined } from "./registry-audit";
import { lookupRegionName, parseRegistryHost } from "./registry-address";
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

/** The stored doc. */
export interface OfficialDomain {
  host: string;
  countryCode: string;
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
  pausedVisaPages: Array<{ countryCode: string; url: string }>;
}

class OfficialDomainsService {
  /** Transaction runner (tests swap in the in-memory one). */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);
  /** Clock in epoch ms. */
  clock: () => number = Date.now;

  /**
   * Confirm one exact host for a country.
   *
   * Requires: a valid exact host (no wildcard), a known country code, a typed
   * statement, and a fresh address check this admin made for exactly this host
   * whose final host was that same host (a redirect to another site proves
   * nothing about THIS site). Idempotent: confirming a host that is already
   * confirmed for the same country changes and audits nothing.
   */
  async confirm(input: { host: unknown; countryCode: unknown; statement: unknown }, actorUid: string): Promise<{ domain: OfficialDomain; created: boolean }> {
    const host = parseRegistryHost(input.host);
    if (!host.ok) throw new RegistryError(host.code, 400, host.message);
    const region = lookupRegionName(input.countryCode);
    if (!region) throw new RegistryError("INVALID_COUNTRY_CODE", 400, "The country code is not a known two-letter code");
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
      const [domainSnap, previewSnap] = await Promise.all([tx.get(domainRef), tx.get(previewRef)]);
      const existing = domainSnap.exists ? (domainSnap.data() as OfficialDomain) : undefined;

      // Idempotent: already confirmed -> same answer, no write, no audit entry.
      if (existing?.status === "confirmed") {
        if (existing.countryCode !== region.code) {
          throw new RegistryError("HOST_CONFIRMED_FOR_OTHER_COUNTRY", 409, "That website is already confirmed for a different country");
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
        countryCode: region.code,
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
    return snap.docs.map((d) => d.data() as OfficialDomain).sort((a, b) => a.host.localeCompare(b.host));
  }

  /** The exact hosts whose status is `confirmed` (the allow-list used at crawl time). */
  async confirmedHosts(): Promise<Set<string>> {
    const snap = await collections.officialDomains.where("status", "==", "confirmed").get();
    return new Set(snap.docs.map((d) => String((d.data() as OfficialDomain).host).toLowerCase()));
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
      const existing = snap.data() as OfficialDomain;
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
  ): Promise<{ pausedGuidanceSources: string[]; pausedVisaPages: Array<{ countryCode: string; url: string }> }> {
    const pausedGuidanceSources: string[] = [];
    const pausedVisaPages: Array<{ countryCode: string; url: string }> = [];
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

    // ---- Visa pages (inside the per-country registry docs) ----
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
          pausedVisaPages.push({ countryCode: doc.id, url: p.url });
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
