import {
  collections,
  db,
  subcollections,
  serverTimestamp,
} from "../utils/firebase";
import {
  Country,
  VisaType,
  VisaRequirement,
  VisaCategory,
  RequiredDocument,
  VISA_VISIBILITY,
} from "../types";
// FieldValue.delete() clears `staleSince` on approval (issue #62).
import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
// Approval guard for visas with no usable USD cost (issue #59).
import { deriveRequirementsFromScrape } from "./visa-requirements-derive";
import { assertVisaApprovable } from "../scrapers";
// Finite-only min for the denormalized country stats.
import { finiteMin } from "../scrapers";
// Manual USD cost on a pending scraped visa (issue #70): pure rules.
import { ManualCostError, ManualCostInput, planManualCost } from "../scrapers";

// ============================================
// PUBLIC VISIBILITY RULE (issue #99)
// ============================================

/**
 * The fields the public visibility rule reads. A Pick (not the whole
 * VisaType) so callers can pass raw Firestore data or partial docs.
 */
export type VisaVisibilityFields = Pick<VisaType, "isActive" | "visibility" | "reviewStatus">;

/**
 * Whether a visa may be shown on a PUBLIC read: `/countries/:code/visas`,
 * `/countries/:code/visas/:visaId(/full)`, `/visas`, `/visas/search`,
 * `/visas/popular` and the denormalized country stats. The ONE place this
 * rule lives — every public read (and #100 / #102) goes through it.
 *
 * Visible only when ALL of these hold:
 *  1. `isActive === true` (strict, matching the `isActive == true` query);
 *  2. `visibility` is "global" or missing (seed / scraped docs predate the
 *     field, and missing means global). "agency" visas are only reachable
 *     through their agency (#102), never here;
 *  3. `reviewStatus` is "approved" or missing (seed docs have no review).
 *     "pending_review" and "rejected" are hidden even when `isActive` is
 *     true — the pre-#99 bug was a pending agent visa written with
 *     `isActive: true`, which this blocks regardless of the data.
 *
 * `null` is treated like missing (Firestore can hold explicit nulls).
 *
 * Why in code and not in the query: Firestore cannot match a MISSING field
 * (`where("visibility", "==", "global")` would drop every seed doc), so the
 * reads keep their existing `isActive == true` query and filter the result
 * here. No extra index is needed for that.
 *
 * @param visa the visa (or just its isActive / visibility / reviewStatus)
 * @returns true when the visa may appear on a public read
 */
export function isVisaPubliclyVisible(visa: VisaVisibilityFields): boolean {
  // 1. Live in the app at all.
  if (visa.isActive !== true) return false;
  // 2. Globally visible (missing / null = global).
  if (visa.visibility != null && visa.visibility !== VISA_VISIBILITY.GLOBAL) return false;
  // 3. Approved, or never reviewed (seed).
  if (visa.reviewStatus != null && visa.reviewStatus !== "approved") return false;
  return true;
}

/**
 * Keep only the publicly visible visas (see isVisaPubliclyVisible), in their
 * original order.
 */
export function filterPubliclyVisible<T extends VisaVisibilityFields>(visas: T[]): T[] {
  return visas.filter(isVisaPubliclyVisible);
}

/**
 * Thrown by updateVisaReviewStatus for an agency draft (issue #100): a draft
 * has not been submitted, so the admin can't review it. Controller -> 409.
 */
export class VisaIsDraftError extends Error {
  /** Error code sent to the client. */
  readonly code = "VISA_IS_DRAFT";
  constructor() {
    super("This visa is a draft that its agency has not submitted for review");
    this.name = "VisaIsDraftError";
  }
}

export interface CreateCountryInput {
  code: string;
  name: string;
  flagUrl?: string;
  isSupported?: boolean;
}

export interface CreateVisaTypeInput {
  countryCode: string;
  name: string;
  code: string;
  description: string;
  category: VisaCategory;
  processingTime: string;
  processingDaysMin: number;
  processingDaysMax: number;
  baseCostUsd: number;
  validityPeriod: string;
  isExtendable?: boolean;
  maxExtensions?: number;
  eligibilityCriteria: string[];
}

export interface CreateRequirementInput {
  title: string;
  description: string;
  estimatedTime: string;
  orderIndex: number;
  requiredDocuments: RequiredDocument[];
  dependsOn?: string[];
  isOptional?: boolean;
}

class VisaService {
  /**
   * Transaction runner for setManualCost (issue #70). Swappable in unit tests
   * for an in-memory one (writes buffered until the callback resolves, so a
   * throw writes nothing — same all-or-nothing contract as Firestore).
   */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  // ============================================
  // COUNTRY OPERATIONS
  // ============================================

  /**
   * Get all supported countries
   */
  async getCountries(onlySupported = true): Promise<Country[]> {
    let query = collections.countries.orderBy("popularityRank", "asc");

    if (onlySupported) {
      query = collections.countries
        .where("isSupported", "==", true)
        .orderBy("popularityRank", "asc");
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Country);
  }

  /**
   * Get country by code
   */
  async getCountryByCode(code: string): Promise<Country | null> {
    const doc = await collections.countries.doc(code.toUpperCase()).get();
    return doc.exists ? (doc.data() as Country) : null;
  }

  /**
   * Create a new country (admin only)
   */
  async createCountry(input: CreateCountryInput): Promise<Country> {
    const code = input.code.toUpperCase();
    const countryRef = collections.countries.doc(code);

    const existing = await countryRef.get();
    if (existing.exists) {
      throw new Error("Country already exists");
    }

    const now = Timestamp.now();
    const country: Country = {
      code,
      name: input.name,
      flagUrl: input.flagUrl || `https://flagcdn.com/${code.toLowerCase()}.svg`,
      isSupported: input.isSupported ?? true,
      visaTypesCount: 0,
      minProcessingDays: 0,
      minCostUsd: 0,
      popularityRank: 999, // Default rank for new countries
      createdAt: now,
      updatedAt: now,
    };

    await countryRef.set(country);
    return country;
  }

  /**
   * Update country stats (called after visa type changes)
   *
   * The ONE canonical recompute of a country's denormalized
   * `visaTypesCount` / `minCostUsd` / `minProcessingDays` from its PUBLICLY
   * VISIBLE visas (issue #62 deleted the catalog-side duplicate). Issue #99:
   * it reads through getVisaTypesByCountry, so a pending, rejected or
   * agency-only visa never changes a country's stats, even when active. Callers: the
   * `onVisaTypeUpdated` trigger, createVisaType / updateVisaType,
   * updateVisaReviewStatus (approve/reject) and
   * visaCatalogService.markWithdrawn. Uses update(), so a missing country
   * doc throws rather than creating a stub country.
   *
   * @param countryCode the country doc id (upper-case code)
   */
  async updateCountryStats(countryCode: string): Promise<void> {
    const visaTypes = await this.getVisaTypesByCountry(countryCode);

    if (visaTypes.length === 0) {
      await collections.countries.doc(countryCode).update({
        visaTypesCount: 0,
        minProcessingDays: 0,
        minCostUsd: 0,
        updatedAt: serverTimestamp(),
      });
      return;
    }

    // Finite-only mins (issue #59). getVisaTypesByCountry only returns
    // isActive docs, and approval is blocked without a finite baseCostUsd, so
    // a pending scraped doc with no cost never gets here today — but a plain
    // Math.min over one missing value would write NaN, so be defensive.
    const minProcessingDays = finiteMin(visaTypes.map((v) => v.processingDaysMin));
    const minCostUsd = finiteMin(visaTypes.map((v) => v.baseCostUsd));

    await collections.countries.doc(countryCode).update({
      visaTypesCount: visaTypes.length,
      minProcessingDays,
      minCostUsd,
      updatedAt: serverTimestamp(),
    });
  }

  // ============================================
  // VISA TYPE OPERATIONS
  // ============================================

  /**
   * Get the PUBLICLY VISIBLE visa types for a country, ordered by category.
   *
   * Public read (`GET /countries/:code/visas`) and the source for search,
   * popular, `/visas` and the country stats. Issue #99: the query still
   * filters `isActive == true` (index: visaTypes isActive + category, COLLECTION
   * scope), then isVisaPubliclyVisible drops pending / rejected / agency-only
   * docs in code (Firestore can't match missing fields).
   */
  async getVisaTypesByCountry(countryCode: string): Promise<VisaType[]> {
    const snapshot = await subcollections
      .visaTypes(countryCode.toUpperCase())
      .where("isActive", "==", true)
      .orderBy("category")
      .get();

    const visaTypes = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as VisaType[];
    // ---- Public visibility rule (issue #99) ----
    return filterPubliclyVisible(visaTypes);
  }

  /**
   * Get the PUBLICLY VISIBLE visa types of one category for a country
   * (`GET /countries/:code/visas?category=…`, `/visas?category=…`).
   * Equality-only query (merged single-field indexes); filtered in code with
   * isVisaPubliclyVisible, like getVisaTypesByCountry.
   */
  async getVisaTypesByCategory(
    countryCode: string,
    category: VisaCategory
  ): Promise<VisaType[]> {
    const snapshot = await subcollections
      .visaTypes(countryCode.toUpperCase())
      .where("isActive", "==", true)
      .where("category", "==", category)
      .get();

    const visaTypes = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as VisaType[];
    // ---- Public visibility rule (issue #99) ----
    return filterPubliclyVisible(visaTypes);
  }

  /**
   * Get a single visa type, UNFILTERED (any status / visibility).
   *
   * Internal callers only (case creation in application.service, review,
   * requirements). Public endpoints must check isVisaPubliclyVisible on the
   * result (or use getPublicVisaType) — see the visa controller.
   */
  async getVisaType(
    countryCode: string,
    visaTypeId: string
  ): Promise<VisaType | null> {
    const doc = await subcollections
      .visaTypes(countryCode.toUpperCase())
      .doc(visaTypeId)
      .get();

    if (!doc.exists) {
      return null;
    }

    return { id: doc.id, ...doc.data() } as VisaType;
  }

  /**
   * Get a single visa type for a PUBLIC read: null when it does not exist OR
   * is not publicly visible (isVisaPubliclyVisible), so the caller answers
   * 404 either way and a hidden visa's existence never leaks.
   */
  async getPublicVisaType(
    countryCode: string,
    visaTypeId: string
  ): Promise<VisaType | null> {
    const visaType = await this.getVisaType(countryCode, visaTypeId);
    return visaType && isVisaPubliclyVisible(visaType) ? visaType : null;
  }

  /**
   * Create a new visa type (`POST /countries/:code/visas`, admin only).
   *
   * Issue #99 write-path fix: the doc is created PENDING and HIDDEN —
   * `reviewStatus: "pending_review"`, `isActive: false` and
   * `visibility: "agency"` — so it is not publicly visible until an admin
   * approves it (approval sets `isActive: true`). Before #99 it was written
   * `isActive: true`, which put an unreviewed visa in every public read.
   * Approval does not touch `visibility`, so the approved visa stays out of
   * the public reads until the admin make-global action (#101). It has no
   * `ownerAgencyId` (admin-created); `createdBy` is recorded when given.
   */
  async createVisaType(input: CreateVisaTypeInput, createdBy?: string): Promise<VisaType> {
    const countryCode = input.countryCode.toUpperCase();

    // Verify country exists
    const country = await this.getCountryByCode(countryCode);
    if (!country) {
      throw new Error("Country not found");
    }

    const visaTypesRef = subcollections.visaTypes(countryCode);
    const docRef = visaTypesRef.doc();

    const now = Timestamp.now();
    const visaType: VisaType = {
      id: docRef.id,
      countryCode,
      name: input.name,
      code: input.code.toUpperCase(),
      description: input.description,
      category: input.category,
      processingTime: input.processingTime,
      processingDaysMin: input.processingDaysMin,
      processingDaysMax: input.processingDaysMax,
      baseCostUsd: input.baseCostUsd,
      validityPeriod: input.validityPeriod,
      isExtendable: input.isExtendable ?? false,
      maxExtensions: input.maxExtensions,
      eligibilityCriteria: input.eligibilityCriteria,
      // Hidden until approved (issue #99): inactive + agency-only + pending.
      isActive: false,
      visibility: VISA_VISIBILITY.AGENCY,
      agentIds: [],
      reviewStatus: "pending_review",
      // Legacy source of this admin endpoint (kept so the admin review list
      // and the backfill treat these docs the same way as before).
      source: "agent",
      // Who created it (the admin's uid), when the controller passes it.
      ...(createdBy ? { createdBy } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(visaType);

    // Update country stats. A hidden visa never changes them (the recompute
    // only counts publicly visible visas), but recomputing keeps the stats
    // self-healing, as before.
    await this.updateCountryStats(countryCode);

    return visaType;
  }

  /**
   * Update visa type (admin only)
   */
  async updateVisaType(
    countryCode: string,
    visaTypeId: string,
    updates: Partial<CreateVisaTypeInput>
  ): Promise<VisaType> {
    const visaTypeRef = subcollections
      .visaTypes(countryCode.toUpperCase())
      .doc(visaTypeId);

    const doc = await visaTypeRef.get();
    if (!doc.exists) {
      throw new Error("Visa type not found");
    }

    await visaTypeRef.update({
      ...updates,
      updatedAt: serverTimestamp(),
    });

    // Update country stats if relevant fields changed
    if (updates.processingDaysMin || updates.baseCostUsd) {
      await this.updateCountryStats(countryCode);
    }

    const updated = await visaTypeRef.get();
    return { id: updated.id, ...updated.data() } as VisaType;
  }

  // ============================================
  // REQUIREMENT OPERATIONS
  // ============================================

  /**
   * Get all requirements for a visa type
   */
  async getRequirements(
    countryCode: string,
    visaTypeId: string
  ): Promise<VisaRequirement[]> {
    const snapshot = await subcollections
      .requirements(countryCode.toUpperCase(), visaTypeId)
      .orderBy("orderIndex")
      .get();

    const stored = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as VisaRequirement[];
    if (stored.length > 0) return stored;

    // Issue #175: a scraped visa has no stored requirements, so derive them
    // from its own cited `requiredDocuments` (read time, nothing written).
    // Unfiltered read on purpose: callers gate visibility before this.
    const visa = await this.getVisaType(countryCode, visaTypeId);
    return visa ? deriveRequirementsFromScrape(visa) : [];
  }

  /**
   * Get a single requirement
   */
  async getRequirement(
    countryCode: string,
    visaTypeId: string,
    requirementId: string
  ): Promise<VisaRequirement | null> {
    const doc = await subcollections
      .requirements(countryCode.toUpperCase(), visaTypeId)
      .doc(requirementId)
      .get();

    if (!doc.exists) {
      return null;
    }

    return { id: doc.id, ...doc.data() } as VisaRequirement;
  }

  /**
   * Create a requirement (admin only)
   */
  async createRequirement(
    countryCode: string,
    visaTypeId: string,
    input: CreateRequirementInput
  ): Promise<VisaRequirement> {
    // Verify visa type exists
    const visaType = await this.getVisaType(countryCode, visaTypeId);
    if (!visaType) {
      throw new Error("Visa type not found");
    }

    const requirementsRef = subcollections.requirements(
      countryCode.toUpperCase(),
      visaTypeId
    );
    const docRef = requirementsRef.doc();

    const now = Timestamp.now();
    const requirement: VisaRequirement = {
      id: docRef.id,
      visaTypeId,
      title: input.title,
      description: input.description,
      estimatedTime: input.estimatedTime,
      orderIndex: input.orderIndex,
      requiredDocuments: input.requiredDocuments,
      dependsOn: input.dependsOn,
      isOptional: input.isOptional ?? false,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(requirement);
    return requirement;
  }

  // ============================================
  // SEARCH & FILTER
  // ============================================

  /**
   * Search visa types across all countries (`GET /visas/search`).
   * Only publicly visible visas: it reads through getVisaTypesByCountry,
   * which applies isVisaPubliclyVisible (issue #99).
   */
  async searchVisaTypes(query: string): Promise<VisaType[]> {
    // Note: Firestore doesn't support full-text search natively
    // For production, consider Algolia or Elasticsearch
    // This is a simple implementation that searches by name prefix

    const results: VisaType[] = [];
    const countries = await this.getCountries();

    for (const country of countries) {
      const visaTypes = await this.getVisaTypesByCountry(country.code);
      const matches = visaTypes.filter(
        (v) =>
          v.name.toLowerCase().includes(query.toLowerCase()) ||
          v.code.toLowerCase().includes(query.toLowerCase())
      );
      results.push(...matches);
    }

    return results;
  }

  /**
   * Get popular visa types across all countries (`GET /visas/popular`).
   * Only publicly visible visas, via getVisaTypesByCountry (issue #99).
   */
  async getPopularVisaTypes(limit = 10): Promise<VisaType[]> {
    const results: VisaType[] = [];
    const countries = await this.getCountries();

    for (const country of countries.slice(0, 5)) {
      const visaTypes = await this.getVisaTypesByCountry(country.code);
      results.push(...visaTypes);
    }

    // Sort by total applications (would need this field populated)
    return results
      .sort((a, b) => (b.totalApplications || 0) - (a.totalApplications || 0))
      .slice(0, limit);
  }

  /**
   * Get all visa types across all countries with optional filtering
   * (`GET /visas`). Only publicly visible visas: both per-country reads apply
   * isVisaPubliclyVisible (issue #99), so the pagination `total` below counts
   * visible visas only.
   */
  async getAllVisaTypes(options?: {
    category?: VisaCategory;
    limit?: number;
    offset?: number;
  }): Promise<{ visaTypes: VisaType[]; total: number }> {
    const results: VisaType[] = [];
    const countries = await this.getCountries();

    for (const country of countries) {
      let visaTypes: VisaType[];
      if (options?.category) {
        visaTypes = await this.getVisaTypesByCategory(
          country.code,
          options.category
        );
      } else {
        visaTypes = await this.getVisaTypesByCountry(country.code);
      }
      results.push(...visaTypes);
    }

    // Sort by country popularity rank, then by category
    results.sort((a, b) => {
      const countryA = countries.find((c) => c.code === a.countryCode);
      const countryB = countries.find((c) => c.code === b.countryCode);
      const rankDiff =
        (countryA?.popularityRank || 999) - (countryB?.popularityRank || 999);
      if (rankDiff !== 0) return rankDiff;
      return a.category.localeCompare(b.category);
    });

    const total = results.length;
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;

    return {
      visaTypes: results.slice(offset, offset + limit),
      total,
    };
  }

  // ============================================
  // ADMIN OPERATIONS
  // ============================================

  /**
   * Get all visa types across all countries for admin review (includes
   * inactive). Issue #100: agency DRAFTS (`reviewStatus: "draft"`, never
   * submitted) are left out — they are the agency's work in progress, not
   * part of the review queue. Submitted agency visas are listed like any
   * other (#101 adds the agency name + sponsor).
   */
  async getAllVisaTypesForAdmin(): Promise<
    (VisaType & { countryName: string })[]
    > {
    const countries = await this.getCountries(false);
    const results: (VisaType & { countryName: string })[] = [];

    for (const country of countries) {
      const snapshot = await subcollections
        .visaTypes(country.code)
        .orderBy("createdAt", "desc")
        .get();

      const visaTypes = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
        countryName: country.name,
      })) as (VisaType & { countryName: string })[];

      // Drafts are filtered in code (a `!=` query would drop every doc
      // without the field, i.e. all seed visas).
      results.push(...visaTypes.filter((v) => v.reviewStatus !== "draft"));
    }

    return results;
  }

  /**
   * Update visa review status (admin only)
   *
   * Called by `PATCH /admin/visas/:id/review` (visaController.reviewVisa).
   *
   * Approval guard (issue #59): `approve` throws VisaFeeNotConvertibleError
   * (controller → 409) for a scraped visa whose fee is flagged fxStale /
   * fxMissing, or any visa without a finite `baseCostUsd`. Nothing is written
   * in that case (no review fields, no lastVerifiedAt, no staleSince change,
   * no stats recompute). `reject` is never blocked.
   *
   * Catalog consistency (issue #62), all in the SAME `update()` as the review
   * status so the visa never shows a half-applied review:
   *  - approve → `isActive: true`; `lastVerifiedAt` (server timestamp) ONLY
   *    for `source: "scraped"` (per its type comment, "when an agent last
   *    approved a scraped update" — agent/seeded visas never get it); and a
   *    `staleSince` marker (set by the crawl when the source was withdrawn) is
   *    removed with FieldValue.delete(). A visa without `staleSince` gets no
   *    `staleSince` write at all.
   *  - reject of a LIVE visa (`isActive: true`, e.g. an agent-created visa or
   *    a previously approved one) → `isActive: false`, so it leaves the app.
   *    A visa that is already inactive (a pending scraped visa) only gets the
   *    review fields.
   *
   * Country stats: when the write changes (or may change) the set of active
   * visas — every approve, and a reject that deactivated a live visa — the
   * country's `visaTypesCount` / `minCostUsd` / `minProcessingDays` are
   * recomputed with `updateCountryStats` BEFORE returning, so the response
   * and any read right after are consistent. (The `onVisaTypeUpdated`
   * trigger also recomputes asynchronously; it stays as the safety net for
   * every other write path.) A failing recompute is logged and swallowed:
   * the review itself is already committed and the trigger reconciles, so a
   * stats error must not turn a successful review into a 500.
   *
   * @param countryCode   country of the visa (any case; upper-cased here)
   * @param visaTypeId    visa doc id under `countries/{cc}/visaTypes`
   * @param action        "approve" | "reject"
   * @param reviewedBy    uid of the reviewing admin
   * @param rejectionReason reason stored on reject (controller requires it)
   * @returns the visa as stored after the review
   * @throws Error("Visa type not found") for an unknown id (controller → 404);
   *         nothing is written and no recompute is attempted
   */
  async updateVisaReviewStatus(
    countryCode: string,
    visaTypeId: string,
    action: "approve" | "reject",
    reviewedBy: string,
    rejectionReason?: string
  ): Promise<VisaType> {
    // Country docs are keyed by the upper-case code; use it for the visa ref
    // AND the stats recompute so both hit the same country.
    const cc = countryCode.toUpperCase();
    const visaTypeRef = subcollections.visaTypes(cc).doc(visaTypeId);

    const doc = await visaTypeRef.get();
    if (!doc.exists) {
      throw new Error("Visa type not found");
    }
    // The visa as it is BEFORE this review: drives which extra fields we
    // write (source, staleSince) and whether stats can change (isActive).
    const current = doc.data() as VisaType;

    // Issue #100: an agency draft was never submitted, so it is not in the
    // review queue and can't be approved or rejected (nothing is written).
    if (current.reviewStatus === "draft") {
      throw new VisaIsDraftError();
    }

    // Refuse to publish a visa with no usable USD cost (throws, no write).
    if (action === "approve") {
      assertVisaApprovable(current);
    }

    // ---- Review fields (both actions) ----
    const updates: Record<string, unknown> = {
      reviewStatus: action === "approve" ? "approved" : "rejected",
      reviewedBy,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (action === "reject" && rejectionReason) {
      updates.rejectionReason = rejectionReason;
    }

    // Issue #68: an admin review (either action) resolves a restored-guide
    // queue entry, so the crawl's `restoredAt` marker goes. Only written when
    // present, so a normal review writes no `restoredAt` at all.
    if (current.restoredAt !== undefined) {
      updates.restoredAt = FieldValue.delete();
    }

    // Whether this review can change the country's active-visa set (and so
    // its denormalized stats). Approve always can (it activates; re-approving
    // an active visa just recomputes the same values). Reject only when the
    // visa was live — rejecting an already inactive visa changes nothing.
    let statsAffected = false;

    if (action === "approve") {
      // ---- Approve: publish + provenance + clear the stale marker ----
      updates.isActive = true;
      // Only scraped visas carry verification provenance. Re-approving an
      // approved scraped visa refreshes it (idempotent otherwise).
      if (current.source === "scraped") {
        updates.lastVerifiedAt = serverTimestamp();
      }
      // A human approval is the reactivation step for a withdrawn-at-source
      // visa, so the crawl's `staleSince` marker goes. Only written when the
      // field exists, so a normal approval writes no `staleSince` at all.
      if (current.staleSince !== undefined) {
        updates.staleSince = FieldValue.delete();
      }
      statsAffected = true;
    } else if (current.isActive === true) {
      // ---- Reject a LIVE visa: take it off the app ----
      // (Strict `=== true`, matching getVisaTypesByCountry's
      // `isActive == true` filter: a doc without the flag isn't counted in
      // the stats, so rejecting it changes nothing.)
      updates.isActive = false;
      statsAffected = true;
    }

    // Issue #99: neither action writes `visibility`. An approved
    // agency-only visa stays agency-only (out of the public reads) until the
    // admin make-global action (#101) sets it to "global".
    await visaTypeRef.update(updates);

    // ---- Recompute country stats before responding ----
    if (statsAffected) {
      try {
        await this.updateCountryStats(cc);
      } catch (error) {
        // Review already committed; the onVisaTypeUpdated trigger reconciles.
        console.error(
          `Visa ${action} of ${cc}/${visaTypeId} succeeded but the country stats recompute failed:`,
          error
        );
      }
    }

    const updated = await visaTypeRef.get();
    return { id: updated.id, ...updated.data() } as VisaType;
  }

  // ============================================
  // MANUAL USD COST (issue #70)
  // ============================================

  /**
   * Set the USD cost of a PENDING scraped visa by hand
   * (PUT /admin/visas/:id/manual-cost).
   *
   * In ONE transaction: read the visa, decide with the pure planManualCost
   * (pending scraped only; not when the scraper's own cost is approvable;
   * optional content-hash check), then write `baseCostUsd` and replace
   * `scrapeMeta.fee` wholesale (field-path update, so `scrapeMeta.contentHash`,
   * citations etc. are untouched). The crawl's pending-refresh write is also
   * transactional, so the two can't interleave and lose a write silently.
   *
   * Does NOT approve the visa and does not touch stats: a pending visa is
   * inactive (not counted). The admin then approves through the normal
   * PATCH /admin/visas/:id/review, whose guard accepts the manual cost.
   *
   * @param visaTypeId doc id under countries/{cc}/visaTypes (controller has
   *   already checked it is addressable)
   * @param input validated body (parseManualCostInput)
   * @param setBy the admin's uid
   * @returns the visa as stored after the write
   * @throws ManualCostError NOT_FOUND / NOT_PENDING_SCRAPED /
   *   FEE_ALREADY_CONVERTED / STALE_VISA — nothing written
   */
  async setManualCost(visaTypeId: string, input: ManualCostInput, setBy: string): Promise<VisaType> {
    const ref = subcollections.visaTypes(input.countryCode).doc(visaTypeId);

    await this.runTransaction(async (tx) => {
      // ---- Read (before any write, as Firestore requires) ----
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ManualCostError("NOT_FOUND", "Visa type not found", 404);

      // ---- Decide (throws → nothing written) ----
      const now = Timestamp.now();
      const plan = planManualCost(snap.data() as VisaType, input, setBy, now);

      // ---- Write ----
      tx.update(ref, {
        baseCostUsd: plan.baseCostUsd,
        "scrapeMeta.fee": plan.fee,
        updatedAt: now,
      });
    });

    const updated = await ref.get();
    return { id: updated.id, ...updated.data() } as VisaType;
  }

  /**
   * Get visa type with full details including requirements, UNFILTERED.
   *
   * The public `GET /countries/:code/visas/:visaId/full` handler checks
   * visibility itself before calling this (admins see every visa), so this
   * stays the unfiltered read for internal / admin use.
   */
  async getVisaTypeWithRequirements(
    countryCode: string,
    visaTypeId: string
  ): Promise<{ visaType: VisaType; requirements: VisaRequirement[] } | null> {
    const visaType = await this.getVisaType(countryCode, visaTypeId);
    if (!visaType) {
      return null;
    }

    const requirements = await this.getRequirements(countryCode, visaTypeId);

    return { visaType, requirements };
  }
}

export const visaService = new VisaService();
