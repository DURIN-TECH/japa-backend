// ============================================
// Agency per-visa service price: storage + rules (issue #103)
// ============================================
//
// An agency sets its OWN service price, in US DOLLARS (issue #179: a Money
// `{ amountMinor: <cents>, currency: "USD" }`, stored as `priceUsd`), on any
// visa it offers. The public list adds the local-currency figure
// (`priceLocal`) from the request's LocalPricer. Contract:
// ./agency-visa-prices.md.
//
// Where it lives: `agencies/{agencyId}/visaPrices/{cc}__{visaTypeId}`
// (`AgencyVisaPrice` in src/types). One doc per (agency, visa), so prices are
// per agency by construction: when a visa is made global, every agency, the
// creator included, has its own doc and never sees another agency's.
//
// Which visas an agency may price (`canAgencyPriceVisa`):
//  - any PUBLICLY VISIBLE visa (active, approved or seed, global): the same
//    #99 rule as every public read (`isVisaPubliclyVisible`);
//  - its OWN agency visa (`source: "agency"`, `ownerAgencyId` = the agency)
//    once it is approved and active, while it is still agency-only.
// Never another agency's agency-only visa, never an unapproved visa, never
// an unknown id. Those are refused before anything is written.
//
// What an agency "offers" (the read endpoints): its own approved visas
// (priced or not) plus every other visa it has priced that it may still
// price. A price whose visa has since become unpriceable (deactivated, or
// taken back to agency-only by the admin) is kept in storage but left out of
// every read, so a stale price is never shown; the agency can still clear it.
//
// The government fee (`VisaType.baseCostUsd`, USD) is only READ here, for
// display next to the price; nothing in this module writes a visa doc.

import { Timestamp, Transaction } from "firebase-admin/firestore";
import { AGENCY_VISA_SOURCE } from "@durin-tech/authz";
import { collectionGroups, db, subcollections } from "../utils/firebase";
import { AgencyVisaPrice, VISA_VISIBILITY, VisaCategory, VisaSource, VisaType, VisaVisibility } from "../types";
import { isVisaPubliclyVisible, visaService } from "../services/visa.service";
import { AgencyVisaError } from "../agency-visas/agency-visa.validation";
import type { VisaPriceTarget } from "./agency-visa-price.validation";
// Applicant-safe sponsor projection (issue #102). Imported from its file, not
// the agency-visas index, to keep the import graph flat.
import { PublicVisaSponsor, toPublicSponsor } from "../agency-visas/agency-visa-access";
import type { LocalPriceQuote, Money } from "../types/money";
import { readStoredUsd } from "../money/usd-price";
import type { LocalPricer } from "../money/local-price";

// ============================================
// Types
// ============================================

/**
 * One offered visa with THIS agency's price, as returned by
 * `GET /agency/visa-prices` and `PUT /agency/visa-prices/...`.
 */
export interface AgencyVisaPriceView {
  visaTypeId: string;
  countryCode: string;
  /** Visa display fields (live values from the visa doc). */
  visaName: string;
  visaCode: string | null;
  category: VisaCategory;
  /** Origin of the visa doc (null for old seed docs without the field). */
  source: VisaSource | null;
  /** "global" or "agency"; a missing field is reported as "global" (#99). */
  visibility: VisaVisibility;
  /** True when the visa was created by THIS agency (agency-only or made global). */
  isOwnVisa: boolean;
  /** The GOVERNMENT fee in USD, read-only here (never changed by a price). */
  baseCostUsd: number | null;
  /**
   * This agency's service price in US dollars (issue #179), or null when
   * unset (or when the stored doc has no valid dollar price, e.g. it was not
   * migrated yet).
   */
  priceUsd: Money | null;
  /** When the price was last set (null when unset). */
  priceUpdatedAt: Timestamp | null;
}

/**
 * The public projection of one offered visa on `GET /agencies/public/:slug`
 * (`visaPrices[]`). No owner ids, no review fields, no `createdBy`, no
 * `agentIds`, and no private sponsor fields.
 *
 * Issue #103 added the first five keys. Issue #102 added the applicant-safe
 * visa detail to the SAME entries (not a second list), so the `/a/<slug>`
 * page can show the agency's own visas, and a visitor arriving through the
 * link can read them, without the single-visa endpoints (which never serve
 * an agency-only visa to someone without a case at that agency).
 */
export interface PublicAgencyVisaPrice {
  visaTypeId: string;
  countryCode: string;
  visaName: string;
  category: VisaCategory;
  /** US dollars (issue #179), or null ("Contact for pricing"). */
  priceUsd: Money | null;
  /** The price in the viewer's local currency at the current rate; null when there is no price. */
  priceLocal: LocalPriceQuote | null;

  // ---- Applicant-safe visa detail (issue #102) ----
  /** True for this agency's OWN agency visa (agency-only or made global). */
  isAgencyVisa: boolean;
  /** "agency" while only reachable through this agency, else "global". */
  visibility: VisaVisibility;
  visaCode: string | null;
  description: string | null;
  processingTime: string | null;
  processingDaysMin: number | null;
  processingDaysMax: number | null;
  validityPeriod: string | null;
  isExtendable: boolean | null;
  maxExtensions: number | null;
  eligibilityCriteria: string[];
  /** GOVERNMENT fee in USD (not this agency's price); null when unset. */
  baseCostUsd: number | null;
  applicationUrl: string | null;
  applicationInstructions: string | null;
  /** Organisation name + website only; null when the visa has no sponsor. */
  sponsor: PublicVisaSponsor | null;
}

/** One offered visa: its view (with this agency's price) and the doc it came from. */
interface OfferedEntry {
  view: AgencyVisaPriceView;
  visa: VisaType;
}

// ============================================
// Pure helpers
// ============================================

/** Doc id of a price: `${countryCode}__${visaTypeId}` (same shape as visaRevisions). */
export function agencyVisaPriceId(countryCode: string, visaTypeId: string): string {
  return `${countryCode}__${visaTypeId}`;
}

/** True when the visa is an agency visa created by `agencyId`. */
export function isOwnAgencyVisa(visa: Pick<VisaType, "source" | "ownerAgencyId">, agencyId: string): boolean {
  return visa.source === AGENCY_VISA_SOURCE && visa.ownerAgencyId === agencyId;
}

/**
 * Whether `agencyId` may set a price on `visa` (see the file header).
 *
 *  1. Publicly visible (active + approved/seed + global): any agency. This is
 *     how a global visa, including one this agency created and the admin
 *     made global, is priced by every agency independently.
 *  2. Otherwise only the agency's OWN agency visa, and only when it is
 *     approved and active (agency-only visas are reachable through their
 *     agency, #102).
 * Anything else (another agency's agency-only visa, draft / pending /
 * rejected / inactive) is not priceable.
 */
export function canAgencyPriceVisa(visa: VisaType, agencyId: string): boolean {
  if (isVisaPubliclyVisible(visa)) return true;
  return (
    isOwnAgencyVisa(visa, agencyId) &&
    visa.isActive === true &&
    visa.reviewStatus === "approved" &&
    visa.visibility === VISA_VISIBILITY.AGENCY
  );
}

/** Build the view of one visa + this agency's price doc (or none). */
export function toPriceView(visa: VisaType, agencyId: string, price: AgencyVisaPrice | null): AgencyVisaPriceView {
  return {
    visaTypeId: visa.id,
    countryCode: visa.countryCode,
    visaName: visa.name,
    visaCode: visa.code ?? null,
    category: visa.category,
    source: visa.source ?? null,
    visibility: visa.visibility ?? VISA_VISIBILITY.GLOBAL,
    isOwnVisa: isOwnAgencyVisa(visa, agencyId),
    baseCostUsd: typeof visa.baseCostUsd === "number" ? visa.baseCostUsd : null,
    // Tolerant read: a doc without a valid dollar price shows as unset.
    priceUsd: price ? readStoredUsd(price.priceUsd) : null,
    priceUpdatedAt: price ? price.updatedAt : null,
  };
}

/**
 * The public page entry of one offered visa (issue #103 keys + the #102
 * applicant-safe detail). A whitelist: every key is named here, so a new
 * private field on the visa doc can never reach the public page by accident.
 * Missing optional values are `null` (never `undefined`, which JSON drops),
 * so the shape is the same for every entry.
 */
export function toPublicAgencyVisa(v: AgencyVisaPriceView, visa: VisaType, pricer: LocalPricer): PublicAgencyVisaPrice {
  /** A string value, or null. */
  const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
  /** A finite number, or null. */
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    // ---- #103 ----
    visaTypeId: v.visaTypeId,
    countryCode: v.countryCode,
    visaName: v.visaName,
    category: v.category,
    // ---- #179: dollars as stored + the local figure ----
    priceUsd: v.priceUsd,
    priceLocal: v.priceUsd ? pricer.price(v.priceUsd) : null,
    // ---- #102: applicant-safe detail ----
    isAgencyVisa: v.isOwnVisa,
    visibility: v.visibility,
    visaCode: v.visaCode,
    description: str(visa.description),
    processingTime: str(visa.processingTime),
    processingDaysMin: num(visa.processingDaysMin),
    processingDaysMax: num(visa.processingDaysMax),
    validityPeriod: str(visa.validityPeriod),
    isExtendable: typeof visa.isExtendable === "boolean" ? visa.isExtendable : null,
    maxExtensions: num(visa.maxExtensions),
    eligibilityCriteria: Array.isArray(visa.eligibilityCriteria)
      ? visa.eligibilityCriteria.filter((c): c is string => typeof c === "string")
      : [],
    baseCostUsd: v.baseCostUsd,
    applicationUrl: str(visa.applicationUrl),
    applicationInstructions: str(visa.applicationInstructions),
    sponsor: toPublicSponsor(visa.sponsor) ?? null,
  };
}

/** The 404 for an unknown visa AND a visa this agency can't see (same body, no leak). */
function visaNotFound(): AgencyVisaError {
  return new AgencyVisaError("NOT_FOUND", "Visa not found", 404);
}

// ============================================
// Service
// ============================================

class AgencyVisaPriceService {
  /** Transaction runner; swapped for an in-memory one in unit tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Clock; swappable in tests. */
  now: () => Timestamp = () => Timestamp.now();

  // ------------------------------------------
  // Reads
  // ------------------------------------------

  /**
   * Every visa `agencyId` offers, each with its price (or null).
   *
   * Order: the agency's own approved visas first (newest first), then the
   * other priced visas, then (with `includeGlobal`) every other public visa,
   * the last two sorted by country and name. No duplicates.
   *
   * Queries:
   *  - `agencies/{id}/visaPrices` (whole subcollection, no index);
   *  - collection group `visaTypes` where `ownerAgencyId ==` ordered by
   *    `createdAt desc` (existing #100 index: ownerAgencyId + createdAt desc,
   *    COLLECTION_GROUP);
   *  - one doc read per priced visa not already loaded;
   *  - `includeGlobal`: the public per-country reads (visaService), the same
   *    ones `/visas` uses. This is the picker of global visas in the portal.
   *
   * @param includeGlobal also list every public visa the agency has not priced
   */
  async listOffered(agencyId: string, options: { includeGlobal?: boolean } = {}): Promise<AgencyVisaPriceView[]> {
    return (await this.listOfferedEntries(agencyId, options)).map((e) => e.view);
  }

  /**
   * listOffered, keeping each entry's visa doc next to its view (issue #102:
   * the public page projects applicant-safe detail from the doc). Same
   * queries, rules and order as listOffered; see its comment.
   */
  private async listOfferedEntries(
    agencyId: string,
    options: { includeGlobal?: boolean } = {}
  ): Promise<OfferedEntry[]> {
    const [priceSnap, ownSnap] = await Promise.all([
      subcollections.agencyVisaPrices(agencyId).get(),
      collectionGroups.visaTypes().where("ownerAgencyId", "==", agencyId).orderBy("createdAt", "desc").get(),
    ]);

    // ---- This agency's prices, by doc id (cc__visaTypeId) ----
    const prices = new Map<string, AgencyVisaPrice>();
    for (const d of priceSnap.docs) prices.set(d.id, d.data() as AgencyVisaPrice);

    const seen = new Set<string>();
    const own: OfferedEntry[] = [];
    const others: OfferedEntry[] = [];

    /** Add one visa if it is priceable and not listed yet. */
    const add = (visa: VisaType, bucket: OfferedEntry[]) => {
      const key = agencyVisaPriceId(visa.countryCode, visa.id);
      if (seen.has(key) || !canAgencyPriceVisa(visa, agencyId)) return;
      seen.add(key);
      bucket.push({ view: toPriceView(visa, agencyId, prices.get(key) ?? null), visa });
    };

    // ---- 1. Own approved agency visas (priced or not) ----
    for (const d of ownSnap.docs) {
      const visa = { id: d.id, ...d.data() } as VisaType;
      if (isOwnAgencyVisa(visa, agencyId)) add(visa, own);
    }

    // ---- 2. Other priced visas (global ones, mostly) ----
    const missing = [...prices.values()].filter((p) => !seen.has(agencyVisaPriceId(p.countryCode, p.visaTypeId)));
    const snaps = await Promise.all(
      missing.map((p) => subcollections.visaTypes(p.countryCode).doc(p.visaTypeId).get())
    );
    for (const s of snaps) {
      if (!s.exists) continue; // the visa was deleted: stale price, not shown
      add({ id: s.id, ...s.data() } as VisaType, others);
    }

    // ---- 3. Optional: every other public visa (the global picker) ----
    if (options.includeGlobal) {
      const countries = await visaService.getCountries();
      const perCountry = await Promise.all(countries.map((c) => visaService.getVisaTypesByCountry(c.code)));
      for (const visas of perCountry) for (const v of visas) add(v, others);
    }

    others.sort(
      (a, b) =>
        a.view.countryCode.localeCompare(b.view.countryCode) || a.view.visaName.localeCompare(b.view.visaName)
    );
    return [...own, ...others];
  }

  /**
   * The public `visaPrices[]` of an agency's page (`/a/<slug>`): the offered
   * visas (own approved + priced, NOT the whole global catalog), with the
   * price or null. Public data only.
   *
   * @param pricer this request's local-currency pricer (issue #179)
   */
  async listPublic(agencyId: string, pricer: LocalPricer): Promise<PublicAgencyVisaPrice[]> {
    const offered = await this.listOfferedEntries(agencyId);
    return offered.map(({ view: v, visa }) => toPublicAgencyVisa(v, visa, pricer));
  }

  // ------------------------------------------
  // Writes
  // ------------------------------------------

  /**
   * Set (create or change) this agency's price on one visa.
   *
   * In one transaction: re-read the visa and decide if it is priceable, then
   * write `agencies/{agencyId}/visaPrices/{cc}__{id}`. A refusal writes
   * nothing:
   *  - unknown visa, or one this agency may not see (another agency's
   *    agency-only visa, a hidden non-agency visa) -> 404 NOT_FOUND (same
   *    body, so existence never leaks);
   *  - the agency's OWN visa that is not approved and active yet -> 400
   *    VISA_NOT_APPROVED (the agency already knows this visa exists).
   *
   * @param priceUsd the dollar price (already validated by parseVisaPriceBody)
   * @returns the visa's view with the new price
   */
  async setPrice(agencyId: string, uid: string, target: VisaPriceTarget, priceUsd: Money): Promise<AgencyVisaPriceView> {
    const visaRef = subcollections.visaTypes(target.countryCode).doc(target.visaTypeId);
    const priceRef = subcollections
      .agencyVisaPrices(agencyId)
      .doc(agencyVisaPriceId(target.countryCode, target.visaTypeId));

    return this.runTransaction(async (tx) => {
      // ---- Reads first (Firestore transactions need them before writes) ----
      const [visaSnap, priceSnap] = await Promise.all([tx.get(visaRef), tx.get(priceRef)]);
      if (!visaSnap.exists) throw visaNotFound();
      const visa = { id: visaSnap.id, ...visaSnap.data() } as VisaType;
      // A doc stored under another country than its own field claims would be
      // corrupt; trust the path.
      visa.countryCode = target.countryCode;

      // ---- Decide ----
      if (!canAgencyPriceVisa(visa, agencyId)) {
        if (isOwnAgencyVisa(visa, agencyId)) {
          throw new AgencyVisaError(
            "VISA_NOT_APPROVED",
            "You can set a price on this visa once Seli has approved it",
            400
          );
        }
        throw visaNotFound();
      }

      // ---- Write ----
      const now = this.now();
      const prior = priceSnap.exists ? (priceSnap.data() as AgencyVisaPrice) : null;
      // A full `set` (no merge): an old naira `price` on the doc is dropped,
      // so the doc never holds two prices (issue #179). The migration audit
      // (`migratedFrom`) is history, so it is carried over when present.
      const doc: AgencyVisaPrice = {
        id: priceRef.id,
        agencyId,
        visaTypeId: target.visaTypeId,
        countryCode: target.countryCode,
        priceUsd,
        ...(prior?.migratedFrom ? { migratedFrom: prior.migratedFrom } : {}),
        updatedBy: uid,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
      tx.set(priceRef, doc);
      return toPriceView(visa, agencyId, doc);
    });
  }

  /**
   * Clear this agency's price on one visa (the public page then says
   * "Contact for pricing"). Deletes the price doc. Idempotent: clearing a
   * price that is not set succeeds and writes nothing. It works whatever the
   * visa's state, so a stale price can always be removed. It only ever
   * touches the CALLER's own subcollection, so it can't affect another agency.
   */
  async clearPrice(agencyId: string, target: VisaPriceTarget): Promise<void> {
    const priceRef = subcollections
      .agencyVisaPrices(agencyId)
      .doc(agencyVisaPriceId(target.countryCode, target.visaTypeId));
    await this.runTransaction(async (tx) => {
      const snap = await tx.get(priceRef);
      if (snap.exists) tx.delete(priceRef);
    });
  }
}

export const agencyVisaPriceService = new AgencyVisaPriceService();
