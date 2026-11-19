import { Timestamp } from "firebase-admin/firestore";
import { collections, subcollections } from "../utils/firebase";
import { computeFee } from "../scrapers";
import type { FxRatesDoc } from "../scrapers/types";
import { membersOn, todayUtc } from "../authorities/authority-ids";
import type { AuthorityMember } from "../types/authority";
import { NO_FACTS, type FactsForRules, type HeldDocumentFact, type MembershipOnDate } from "../services/ai/applicant-groups";
import { applicantHoldingsService, HoldingsValidationError } from "../services/applicant-holdings.service";
import type { TravelPurpose } from "../types/eligibility";
import type { EntryAnswerFee, EntryRequirementResult, EntryRule, EntryRuleHead } from "../types/entry-requirements";
import { answerEntryRequirements } from "./entry-requirements-answer";
import { entryRuleStore, type EntryRuleStore } from "./entry-rule.store";

// ============================================
// ENTRY REQUIREMENTS — THE LOOKUP (issue #236, P7 of #228)
// ============================================
//
// GET /entry-requirements answers "do I need a visa for this destination?"
// from STORED, PUBLISHED entry rules. No model is called at answer time, so
// the lookup is plain data and free for every signed-in user (decision on the
// issue: only the AI drafting of rules is the paid part).
//
// What it loads for one destination (and caches for a few minutes per
// instance, because rules change at most when a drafting run publishes):
//   1. the published rules that cover it: rules listing the country, plus rules
//      scoped to "every member of authority X" when the country is a current
//      member of X (membership data, P1);
//   2. only rules of the run each issuing authority SERVES (its head);
//   3. the members of every authority a rule's group names (`members_of`);
//   4. whether each rule's source is still current: the page's last fetch is
//      the same version the rule was drafted from, and is within the
//      configured age (`appConfig/entryRequirementsSettings.maxSourceAgeDays`);
//   5. the destination authority's registered official page (the link an
//      `unknown` answer carries).
// The traveller's facts come from the query, and from the caller's OWN
// holdings only when asked (`useMyHoldings`). Nobody else's data is ever read.
//
// Generic: no country, bloc, treaty or nationality name.

/** The settings doc (appConfig/{id}). */
export const ENTRY_SETTINGS_DOC_ID = "entryRequirementsSettings";

/** Default age after which a rule's source counts as stale (guidance sources are crawled about weekly). */
export const DEFAULT_MAX_SOURCE_AGE_DAYS = 90;

/** How long one instance reuses a destination's loaded rules. */
export const DESTINATION_CACHE_MS = 5 * 60_000;

/** Most destinations held in the cache (a bound on memory). */
const MAX_CACHED_DESTINATIONS = 300;

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/** A guidance source's freshness fields (guidanceSources/{id}). */
export interface SourceFreshness {
  lastContentHash: string | null;
  lastFetchedAtMs: number | null;
}

/** What the lookup reads (Firestore by default; faked in tests). */
export interface LookupDeps {
  store: EntryRuleStore;
  listMembers(authorityId: string): Promise<AuthorityMember[]>;
  readSource(sourceId: string): Promise<SourceFreshness | null>;
  readFx(): Promise<FxRatesDoc | undefined>;
  readSettings(): Promise<Record<string, unknown> | undefined>;
  // The first official page registered for an authority's visas (visaSources/{id}), if any.
  readVisaSourcePage(authorityId: string): Promise<string | undefined>;
  // The CALLER's own holdings (never anyone else's).
  readOwnFacts(uid: string): Promise<FactsForRules>;
  now(): number;
}

/** Firestore-backed reads. */
const firestoreDeps: LookupDeps = {
  store: entryRuleStore,
  async listMembers(authorityId) {
    const snap = await subcollections.authorityMembers(authorityId).get();
    return snap.docs.map((d) => d.data() as AuthorityMember);
  },
  async readSource(sourceId) {
    const snap = await collections.guidanceSources.doc(sourceId).get();
    if (!snap.exists) return null;
    const d = snap.data() as { lastContentHash?: unknown; lastFetchedAt?: unknown };
    const at = d.lastFetchedAt instanceof Timestamp ? d.lastFetchedAt.toMillis() : null;
    return { lastContentHash: typeof d.lastContentHash === "string" ? d.lastContentHash : null, lastFetchedAtMs: at };
  },
  async readFx() {
    const snap = await collections.appConfig.doc("fx").get();
    return snap.exists ? (snap.data() as FxRatesDoc) : undefined;
  },
  async readSettings() {
    const snap = await collections.appConfig.doc(ENTRY_SETTINGS_DOC_ID).get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
  },
  async readVisaSourcePage(authorityId) {
    const snap = await collections.visaSources.doc(authorityId).get();
    const pages = snap.exists ? (snap.data() as { pages?: { url?: unknown }[] }).pages : undefined;
    const url = Array.isArray(pages) ? pages.find((p) => typeof p?.url === "string")?.url : undefined;
    return typeof url === "string" ? url : undefined;
  },
  async readOwnFacts(uid) {
    // The holdings view of the caller's own profile (expired documents are
    // kept with their date; matching ignores them on the lookup date).
    let view;
    try {
      view = await applicantHoldingsService.get(uid);
    } catch (error) {
      // No profile yet: nothing stated (the answer then asks for the facts it needs).
      if (error instanceof HoldingsValidationError && error.status === 404) return NO_FACTS;
      throw error;
    }
    return {
      nationalities: view.nationalities,
      residentialCountry: view.residentialCountry,
      heldDocuments: view.heldDocuments === null ? null : view.heldDocuments.map((d): HeldDocumentFact => ({ kind: d.kind, issuerCountryCode: d.issuerCountryCode, issuerAuthorityId: d.issuerAuthorityId, validUntil: d.validUntil })),
    };
  },
  now: () => Date.now(),
};

/** What a lookup is asked (validated by the controller). */
export interface LookupInput {
  destination: string;
  // Facts given in the query (each one wins over the caller's holdings).
  nationalities?: string[];
  residentialCountry?: string;
  heldDocuments?: HeldDocumentFact[];
  purpose?: TravelPurpose;
  stayDays?: number;
  // Fill facts not given in the query from the caller's own profile.
  useMyHoldings?: { uid: string };
}

/** Everything loaded for one destination (cached). */
interface DestinationData {
  rules: EntryRule[];
  membership: MembershipOnDate;
  freshRuleIds: Set<string>;
  page?: string;
  onDate: string;
}

/** Read `maxSourceAgeDays` (an integer 1..3650), else the default. Never throws. */
export function maxSourceAgeDaysOf(raw: Record<string, unknown> | undefined): number {
  const v = raw?.maxSourceAgeDays;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 3650 ? v : DEFAULT_MAX_SOURCE_AGE_DAYS;
}

/**
 * Is a rule's source current? Fresh only when BOTH hold:
 *  - the source's latest fetch is the same page version the rule was drafted
 *    from (a changed page means the rule may be out of date: never served as
 *    an answer until it is re-drafted);
 *  - that fetch is within `maxAgeDays` (a source we stopped reaching is not vouched for).
 * A source record we cannot find falls back to the rule's own `fetchedAt`.
 */
export function isRuleFresh(rule: Pick<EntryRule, "contentHash" | "fetchedAt">, source: SourceFreshness | null, nowMs: number, maxAgeDays: number): boolean {
  const maxAgeMs = maxAgeDays * DAY_MS;
  if (source) {
    if (source.lastContentHash !== rule.contentHash) return false;
    return source.lastFetchedAtMs !== null && nowMs - source.lastFetchedAtMs <= maxAgeMs;
  }
  const at = Date.parse(rule.fetchedAt);
  return Number.isFinite(at) && nowMs - at <= maxAgeMs;
}

/**
 * A rule's fee as shown: the source amount and currency with its quote, plus
 * whole USD through the catalog's FX rules (null when there is no usable rate:
 * never a guessed figure).
 */
export function feeViewOf(rule: Pick<EntryRule, "fee">, fx: FxRatesDoc | undefined, nowMs: number): EntryAnswerFee | null {
  if (!rule.fee) return null;
  const { baseCostUsd, feeMeta } = computeFee(
    [{ kind: "application", label: "fee", amount: rule.fee.amount, currency: rule.fee.currency, per: "application" }],
    fx,
    Timestamp.fromMillis(nowMs)
  );
  return {
    amount: rule.fee.amount,
    currency: rule.fee.currency,
    quote: rule.fee.quote,
    usd: typeof baseCostUsd === "number" ? baseCostUsd : null,
    fxDate: feeMeta.fxDate ?? null,
  };
}

/** The lookup service. */
export class EntryRequirementsService {
  /** destination -> loaded data and when it expires. */
  private readonly cache = new Map<string, { expires: number; data: DestinationData }>();
  /** The FX doc, cached on its own (it changes daily at most). */
  private fxCache: { expires: number; fx: FxRatesDoc | undefined } | null = null;

  constructor(private readonly deps: LookupDeps = firestoreDeps) {}

  /** Forget every cached destination (tests; and after a publish from a script). */
  clearCache(): void {
    this.cache.clear();
    this.fxCache = null;
  }

  /** The current members of an authority on a date, or null when none are recorded. */
  private async membersCurrent(authorityId: string, onDate: string): Promise<string[] | null> {
    const all = await this.deps.listMembers(authorityId);
    if (all.length === 0) return null;
    return membersOn(all, onDate).map((m) => m.countryCode);
  }

  /** Load (or reuse) everything for one destination. */
  private async load(destination: string): Promise<DestinationData> {
    const nowMs = this.deps.now();
    const hit = this.cache.get(destination);
    if (hit && hit.expires > nowMs) return hit.data;
    const onDate = todayUtc(nowMs);

    // ---- 1. candidate rules: listed for the country, or scoped to a group it belongs to ----
    const [listed, scoped, settings] = await Promise.all([
      this.deps.store.publishedForCountry(destination),
      this.deps.store.publishedMembersOfScopes(),
      this.deps.readSettings().catch(() => undefined),
    ]);
    const scopeIds = [...new Set(scoped.map((r) => r.scopeAuthorityId).filter((x): x is string => !!x))];
    const scopeMembers = new Map<string, string[] | null>();
    await Promise.all(scopeIds.map(async (id) => scopeMembers.set(id, await this.membersCurrent(id, onDate))));
    // A scope with no recorded members covers nobody we can name: its rules are not used.
    const inScope = scoped.filter((r) => r.scopeAuthorityId && (scopeMembers.get(r.scopeAuthorityId) ?? []).includes(destination));
    const candidates = [...listed, ...inScope];

    // ---- 2. only the run each issuing authority serves ----
    const issuers = [...new Set(candidates.map((r) => r.issuingAuthorityId))];
    const memberOf = scopeIds.filter((id) => (scopeMembers.get(id) ?? []).includes(destination));
    const heads = await this.deps.store.heads([...new Set([...issuers, destination, ...memberOf])]);
    const rules = candidates.filter((r) => heads.get(r.issuingAuthorityId)?.publishedRunId === r.runId);

    // ---- 3. membership of every authority a group names ----
    const groupAuthorities = new Set<string>();
    for (const r of rules) for (const m of r.group.members) if (m.kind === "members_of") groupAuthorities.add(m.authorityId);
    const membership: Record<string, string[] | null> = {};
    await Promise.all([...groupAuthorities].map(async (id) => (membership[id] = await this.membersCurrent(id, onDate))));

    // ---- 4. freshness of each rule's source ----
    const maxAge = maxSourceAgeDaysOf(settings);
    const sourceIds = [...new Set(rules.map((r) => r.sourceId))];
    const sources = new Map<string, SourceFreshness | null>();
    await Promise.all(sourceIds.map(async (id) => sources.set(id, await this.deps.readSource(id))));
    const freshRuleIds = new Set(rules.filter((r) => isRuleFresh(r, sources.get(r.sourceId) ?? null, nowMs, maxAge)).map((r) => r.id));

    // ---- 5. the destination authority's registered official page ----
    const page = await this.officialPage(destination, memberOf, heads);

    const data: DestinationData = { rules, membership, freshRuleIds, page, onDate };
    if (this.cache.size >= MAX_CACHED_DESTINATIONS) this.cache.clear();
    this.cache.set(destination, { expires: nowMs + DESTINATION_CACHE_MS, data });
    return data;
  }

  /**
   * The destination authority's registered official page: the pages its own
   * entry rules are drafted from, else those of an authority it belongs to,
   * else the first page registered for its visas. Undefined when none is
   * registered (the answer then carries no link rather than a guessed one).
   */
  private async officialPage(destination: string, memberOf: string[], heads: Map<string, EntryRuleHead>): Promise<string | undefined> {
    const own = heads.get(destination)?.sourceUrls?.[0];
    if (own) return own;
    for (const id of memberOf) {
      const shared = heads.get(id)?.sourceUrls?.[0];
      if (shared) return shared;
    }
    return this.deps.readVisaSourcePage(destination).catch(() => undefined);
  }

  /** The FX doc (cached 10 minutes). */
  private async fx(nowMs: number): Promise<FxRatesDoc | undefined> {
    if (this.fxCache && this.fxCache.expires > nowMs) return this.fxCache.fx;
    const fx = await this.deps.readFx().catch(() => undefined);
    this.fxCache = { expires: nowMs + 10 * 60_000, fx };
    return fx;
  }

  /** Answer one lookup. */
  async lookup(input: LookupInput): Promise<EntryRequirementResult> {
    const nowMs = this.deps.now();
    // ---- the traveller's facts: the query first, then (only if asked) the caller's own profile ----
    const own = input.useMyHoldings ? await this.deps.readOwnFacts(input.useMyHoldings.uid) : NO_FACTS;
    const facts: FactsForRules = {
      nationalities: input.nationalities && input.nationalities.length > 0 ? input.nationalities : own.nationalities,
      residentialCountry: input.residentialCountry ?? own.residentialCountry,
      heldDocuments: input.heldDocuments ?? own.heldDocuments,
    };
    const data = await this.load(input.destination);
    const fx = data.rules.some((r) => r.fee) ? await this.fx(nowMs) : undefined;
    return answerEntryRequirements(
      data.rules,
      { destination: input.destination, facts, purpose: input.purpose, stayDays: input.stayDays },
      {
        onDate: data.onDate,
        membership: data.membership,
        isFresh: (r) => data.freshRuleIds.has(r.id),
        feeView: (r) => feeViewOf(r, fx, nowMs),
        destinationAuthorityPage: data.page,
      }
    );
  }
}

/** The shared instance (the controller and eligibility preCheck use it). */
export const entryRequirementsService = new EntryRequirementsService();
