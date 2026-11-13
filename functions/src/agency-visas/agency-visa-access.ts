// ============================================
// Agency visas reachable through the agency (issue #102)
// ============================================
//
// The ONE place that decides who may READ a non-public visa on the
// single-visa endpoints, who may START A CASE on a visa, and what an
// applicant (or anonymous visitor) is allowed to see of an agency visa.
// Contract: ./agency-visas.md, section "Reachable through the agency (#102)".
//
// The rules, in short:
//
//  - Publicly visible visas (#99 `isVisaPubliclyVisible`: active, approved
//    or seed, global) stay readable by everyone and startable by everyone,
//    exactly as before.
//  - An agency-only visa (`source: "agency"`, `visibility: "agency"`) that
//    is approved and active is reachable only THROUGH ITS AGENCY:
//      * read: admins and the owning agency's members (the shared CASL
//        ability, tagged subject, never a string subject), and an applicant
//        who has an application whose `agencyId` is the owning agency, or
//        who has an application on this very visa (so an existing case keeps
//        loading its visa after an admin takes it back to agency-only);
//      * start a case: only when the case being created belongs to the
//        owning agency (its `agencyId` = `ownerAgencyId`). That covers the
//        agency's own agents (portal `for-client`), an admin acting for that
//        agency, and an applicant self-serving with an agent of that agency.
//  - Draft, pending, rejected and inactive visas: nobody starts a case on
//    them (owner included), and only CASL-privileged callers read them.
//  - Every denial is the same 404 as an unknown id, so existence never leaks.
//
// What "arriving through the agency link" means here: the public agency page
// (`GET /agencies/public/:slug`) IS the link. Its `visaPrices[]` entries carry
// the applicant-safe detail of the agency's own approved visas, so a visitor
// who arrives on `/a/<slug>` sees them there. There is deliberately NO way to
// pass a slug to the single-visa endpoints or to case creation to unlock an
// agency-only visa: reading one through the detail endpoint needs an
// application with that agency (the firm rule), and starting a case needs the
// case to belong to that agency.

import { AGENCY_VISA_SOURCE } from "@durin-tech/authz";
import { collections } from "../utils/firebase";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can } from "../middleware/authz";
import { Application, VISA_VISIBILITY, VisaSponsor, VisaType } from "../types";
import { isVisaPubliclyVisible } from "../services/visa.service";

// ============================================
// Pure rules
// ============================================

/**
 * True when `visa` is an agency visa that is approved and active, whatever
 * its visibility. This is the state in which an agency visa can be used at
 * all (draft / pending / rejected / inactive never can).
 *
 * `ownerAgencyId` must be a non-empty string: a visa with no owner is never
 * "an agency's", so a missing owner can't match a case with no agency.
 */
export function isApprovedAgencyVisa(
  visa: Pick<VisaType, "source" | "ownerAgencyId" | "reviewStatus" | "isActive">
): boolean {
  return (
    visa.source === AGENCY_VISA_SOURCE &&
    typeof visa.ownerAgencyId === "string" &&
    visa.ownerAgencyId.length > 0 &&
    visa.reviewStatus === "approved" &&
    visa.isActive === true
  );
}

/**
 * Whether a case may be started on `visa` when the new case will belong to
 * `caseAgencyId` (the agency resolved from the case's agent, or the agency an
 * admin is acting for; undefined for a self-serve case with no agent).
 *
 *  1. Publicly visible visa: yes, for any agency or none (unchanged).
 *  2. Approved, active, agency-only visa: only when the case belongs to the
 *     owning agency.
 *  3. Anything else (draft, pending, rejected, inactive, or a hidden visa
 *     with no owning agency): no, for everyone, the owner included.
 *
 * @returns true when the case may be created
 */
export function canStartCaseOnVisa(visa: VisaType, caseAgencyId: string | null | undefined): boolean {
  // 1. Public visas: as today.
  if (isVisaPubliclyVisible(visa)) return true;
  // 2. Agency-only visas: only a case of the owning agency.
  if (!isApprovedAgencyVisa(visa)) return false;
  return typeof caseAgencyId === "string" && caseAgencyId.length > 0 && caseAgencyId === visa.ownerAgencyId;
}

/**
 * The visa fields an applicant or an anonymous visitor may see. Everything
 * else is dropped: `createdBy`, `submittedBy`, the review fields
 * (`reviewedBy`, `reviewedAt`, `rejectionReason`, `submittedAt`), the
 * make-global audit fields, `agentIds`, `scrapeMeta`, quota counters, and
 * the PRIVATE sponsor fields (`sponsorLicenceNumber`, `contact`).
 *
 * `ownerAgencyId` is kept: it is the agency's id, which a client already
 * sees on its own application (`Application.agencyId`), and #106 needs it to
 * link the visa to its agency. `source` and `visibility` are kept so the
 * client can label an agency visa.
 */
export const APPLICANT_SAFE_VISA_FIELDS = [
  "id",
  "countryCode",
  "name",
  "code",
  "description",
  "category",
  "processingTime",
  "processingDaysMin",
  "processingDaysMax",
  "baseCostUsd",
  "validityPeriod",
  "isExtendable",
  "maxExtensions",
  "eligibilityCriteria",
  "applicationUrl",
  "applicationInstructions",
  "sourceUrl",
  "isActive",
  "source",
  "visibility",
  "ownerAgencyId",
  "createdAt",
  "updatedAt",
] as const;

/** The public part of a sponsor: organisation name and website only. */
export type PublicVisaSponsor = Pick<VisaSponsor, "organisationName" | "website">;

/** A visa as an applicant / anonymous caller sees it (see APPLICANT_SAFE_VISA_FIELDS). */
export type ApplicantSafeVisa = Partial<Pick<VisaType, (typeof APPLICANT_SAFE_VISA_FIELDS)[number]>> & {
  sponsor?: PublicVisaSponsor;
};

/**
 * The public part of a sponsor, or undefined when the visa has none.
 * Only `organisationName` and `website` (when set) survive.
 */
export function toPublicSponsor(sponsor: VisaSponsor | undefined | null): PublicVisaSponsor | undefined {
  if (!sponsor || typeof sponsor.organisationName !== "string") return undefined;
  const out: PublicVisaSponsor = { organisationName: sponsor.organisationName };
  if (typeof sponsor.website === "string" && sponsor.website) out.website = sponsor.website;
  return out;
}

/**
 * Whitelist projection of a visa to its applicant-safe fields (a new object;
 * the input is not modified). Missing fields stay missing.
 */
export function toApplicantSafeVisa(visa: VisaType): ApplicantSafeVisa {
  const out: Record<string, unknown> = {};
  for (const key of APPLICANT_SAFE_VISA_FIELDS) {
    if (visa[key] !== undefined) out[key] = visa[key];
  }
  const sponsor = toPublicSponsor(visa.sponsor);
  if (sponsor) out.sponsor = sponsor;
  return out as ApplicantSafeVisa;
}

// ============================================
// Service (reads applications)
// ============================================

/** Most applications read per "has a case on this visa" query. */
const REACH_QUERY_LIMIT = 20;

class AgencyVisaAccessService {
  /**
   * Whether the signed-in caller reaches `visa` (an approved agency visa)
   * through an application they may read (checkApplicationAccess semantics:
   * the shared CASL `read` on the tagged Application).
   *
   * An application counts when EITHER:
   *  - its `agencyId` is the visa's owning agency (a case at that agency);
   *  - it is a case ON this visa (`visaTypeId` + `countryCode`), whatever its
   *    agency. This keeps an existing case's visa loading after an admin
   *    takes the visa back to agency-only, for the applicant and for the
   *    agency side handling that case.
   *
   * Queries (only reached for a non-public visa, never for public ones):
   *  - `applications where userId == uid` (the caller's own cases; automatic
   *    single-field index, an applicant has few);
   *  - when the token carries an `agencyId`: `applications where agencyId ==
   *    <claim> and visaTypeId == <id>` (index agencyId + visaTypeId);
   *  - `applications where agentId == uid and visaTypeId == <id>` (the
   *    caller's assigned cases on this visa; index agentId + visaTypeId).
   *
   * @returns false for an anonymous caller
   */
  async reachesThroughApplication(req: AuthenticatedRequest, visa: VisaType): Promise<boolean> {
    const uid = req.userId;
    if (!uid) return false;
    // Tolerate a doc without the field (the path is the source of truth;
    // the controller reads by path, and every agency visa stores it).
    const cc = String(visa.countryCode ?? "").toUpperCase();

    /** True when `app` is on THIS visa (same id and country). */
    const isOnThisVisa = (app: Application) =>
      app.visaTypeId === visa.id && String(app.countryCode ?? "").toUpperCase() === cc;

    // ---- The queries, in parallel ----
    const agencyClaim = req.authz?.agencyId;
    const [own, agencyCases, assigned] = await Promise.all([
      collections.applications.where("userId", "==", uid).get(),
      agencyClaim
        ? collections.applications
          .where("agencyId", "==", agencyClaim)
          .where("visaTypeId", "==", visa.id)
          .limit(REACH_QUERY_LIMIT)
          .get()
        : Promise.resolve(null),
      collections.applications
        .where("agentId", "==", uid)
        .where("visaTypeId", "==", visa.id)
        .limit(REACH_QUERY_LIMIT)
        .get(),
    ]);

    /** True when the caller may read `app` (shared CASL, tagged subject). */
    const readable = (app: Application) =>
      can(req, "read", asSubject("Application", { ...(app as unknown as Record<string, unknown>) }));

    // ---- 1. The caller's own cases: at the owning agency, or on this visa ----
    for (const d of own.docs) {
      const app = d.data() as Application;
      if ((app.agencyId === visa.ownerAgencyId || isOnThisVisa(app)) && readable(app)) return true;
    }
    // ---- 2. Agency-side cases on this visa (their agency, or assigned) ----
    for (const snap of [agencyCases, assigned]) {
      if (!snap) continue;
      for (const d of snap.docs) {
        const app = d.data() as Application;
        if (isOnThisVisa(app) && readable(app)) return true;
      }
    }
    return false;
  }

  /**
   * What the single-visa endpoints (`GET /countries/:code/visas/:visaId`,
   * `/full`, `/requirements`) serve to this caller, or null for a 404.
   *
   *  1. CASL `read` on the tagged visa (admins: `manage all`; the owning
   *     agency's owner and agents: the #98 conditional grant): the full doc,
   *     in any state.
   *  2. A publicly visible visa: everyone. An agency-created one (made global)
   *     is projected to the applicant-safe fields; other visas are served as
   *     stored, unchanged from #99.
   *  3. An approved, active, agency-only visa: the applicant-safe fields, to
   *     a caller who reaches it through an application (see
   *     reachesThroughApplication).
   *  4. Anything else: null (the same 404 as an unknown id).
   */
  async visaForCaller(req: AuthenticatedRequest, visa: VisaType): Promise<VisaType | ApplicantSafeVisa | null> {
    // 1. Privileged readers get the doc as stored. A copy, so the CASL tag
    //    never lands on the object that is returned.
    if (can(req, "read", asSubject("Visa", { ...visa }))) return visa;

    // 2. Public visas. Only agency visas carry private sponsor / owner data.
    if (isVisaPubliclyVisible(visa)) {
      return visa.source === AGENCY_VISA_SOURCE ? toApplicantSafeVisa(visa) : visa;
    }

    // 3. Agency-only, approved and active: through an application only.
    if (
      isApprovedAgencyVisa(visa) &&
      visa.visibility === VISA_VISIBILITY.AGENCY &&
      (await this.reachesThroughApplication(req, visa))
    ) {
      return toApplicantSafeVisa(visa);
    }

    // 3b. Issue #175: a seeded/scraped visa that was HIDDEN (isActive:false,
    //     e.g. uk-visitor once its scraped twin is live) stays readable by a
    //     caller with an application on that exact visa, so their case still
    //     loads. Pending / rejected reviews and agency/agent docs never
    //     qualify; the list endpoint still hides it and new starts are
    //     refused elsewhere (getStartableVisa).
    if (
      visa.isActive === false &&
      visa.source !== AGENCY_VISA_SOURCE &&
      visa.source !== "agent" &&
      (visa.reviewStatus === undefined || visa.reviewStatus === "approved") &&
      (await this.hasOwnApplicationOnVisa(req, visa))
    ) {
      return visa;
    }

    // 4. Hidden from this caller.
    return null;
  }

  /**
   * True when the caller has an application of their own on EXACTLY this visa
   * (same id and country) that they may read. Deliberately narrower than
   * reachesThroughApplication: no owning-agency match, which is meaningless
   * for a visa without an owner.
   */
  private async hasOwnApplicationOnVisa(req: AuthenticatedRequest, visa: VisaType): Promise<boolean> {
    const uid = req.userId;
    if (!uid) return false;
    const cc = String(visa.countryCode ?? "").toUpperCase();
    const snap = await collections.applications.where("userId", "==", uid).get();
    return snap.docs.some((d) => {
      const app = d.data() as Application;
      return (
        app.visaTypeId === visa.id &&
        String(app.countryCode ?? "").toUpperCase() === cc &&
        can(req, "read", asSubject("Application", { ...(app as unknown as Record<string, unknown>) }))
      );
    });
  }
}

/** Singleton, like the other services. */
export const agencyVisaAccessService = new AgencyVisaAccessService();
