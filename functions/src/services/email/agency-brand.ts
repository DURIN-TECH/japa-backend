/**
 * Agency co-branding for transactional email.
 *
 * Every Seli email is sent on behalf of an agency the recipient actually deals
 * with, so the header carries BOTH marks: the agency's logo next to Seli's. This
 * module answers the one question the template needs — "whose logo sits beside
 * ours for this recipient?" — and is deliberately fail-soft: any miss returns
 * `null` and the template falls back to the Seli-only header it rendered before.
 *
 * Resolution order (first hit wins), cheapest and most specific first:
 *   1. an explicit `agencyId` supplied by the caller
 *   2. the agency owning a specific `applicationId` (the case the email is about)
 *   3. the recipient's OWN agency, when they are an agent-side user
 *   4. for clients: the agency handling their most recently updated application
 *
 * WHY THE ORDER MATTERS: a client can be handled by more than one agency across
 * different cases. When the email is about a particular case (2) that case's
 * agency is the honest answer; only when there's no case context do we fall back
 * to "whoever they most recently worked with" (4).
 */
import { collections } from "../../utils/firebase";

/** The agency mark rendered beside the Seli logo. */
export interface AgencyBrand {
  /** Agency name — used as the logo's alt text. */
  name: string;
  /** Absolute https URL of the agency's uploaded logo. */
  logoUrl: string;
}

/** What the caller knows about the recipient. Every field is optional. */
export interface AgencyBrandLookup {
  /** Recipient's Firebase uid, when the email is addressed to a known account. */
  userId?: string;
  /** Explicit agency — short-circuits every other lookup. */
  agencyId?: string | null;
  /** The case this email concerns, if any. */
  applicationId?: string | null;
  /** Recipient's address, for flows (password reset, magic link) with no uid. */
  email?: string;
}

/**
 * Per-instance memo of agencyId → brand (or `null` for "no usable logo").
 *
 * Agency logos change roughly never, and a scheduled fan-out can email dozens of
 * clients belonging to the same agency in one run — without this, each of those
 * emails would re-read the same agency document. Bounded by TTL rather than size
 * because a Cloud Functions instance is short-lived anyway.
 */
const brandCache = new Map<string, { brand: AgencyBrand | null; at: number }>();
const BRAND_CACHE_TTL_MS = 5 * 60 * 1000;

/** Only absolute http(s) logos are usable — email clients won't load anything else. */
function usableLogo(logoUrl: unknown): logoUrl is string {
  return typeof logoUrl === "string" && /^https?:\/\//i.test(logoUrl);
}

/** Load an agency's brand by id, memoized. Returns null when it has no logo. */
async function brandForAgencyId(agencyId: string): Promise<AgencyBrand | null> {
  const cached = brandCache.get(agencyId);
  if (cached && Date.now() - cached.at < BRAND_CACHE_TTL_MS) return cached.brand;

  let brand: AgencyBrand | null = null;
  try {
    const snap = await collections.agencies.doc(agencyId).get();
    const data = snap.data();
    if (data && usableLogo(data.logoUrl)) {
      brand = { name: String(data.name ?? "Agency"), logoUrl: data.logoUrl };
    }
  } catch (err) {
    // Branding must never break a send. Log and fall through to Seli-only.
    console.error("[agency-brand] agency lookup failed:", err);
  }

  brandCache.set(agencyId, { brand, at: Date.now() });
  return brand;
}

/** The agency owning an application, if the application exists and has one. */
async function agencyIdForApplication(
  applicationId: string
): Promise<string | null> {
  try {
    const snap = await collections.applications.doc(applicationId).get();
    const agencyId = snap.data()?.agencyId;
    return typeof agencyId === "string" ? agencyId : null;
  } catch (err) {
    console.error("[agency-brand] application lookup failed:", err);
    return null;
  }
}

/**
 * The agency a user belongs to as STAFF.
 *
 * Checks the `agents` collection (which carries `agencyId` for members) and then
 * agency ownership, since an owner may not have an agent record of their own.
 */
async function agencyIdForStaff(userId: string): Promise<string | null> {
  try {
    const agentSnap = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();
    const agencyId = agentSnap.docs[0]?.data()?.agencyId;
    if (typeof agencyId === "string") return agencyId;

    const ownedSnap = await collections.agencies
      .where("ownerId", "==", userId)
      .limit(1)
      .get();
    return ownedSnap.docs[0]?.id ?? null;
  } catch (err) {
    console.error("[agency-brand] staff agency lookup failed:", err);
    return null;
  }
}

/**
 * The agency handling a client's most recently updated application.
 *
 * Ordered by `updatedAt` so a client with several cases gets the agency they are
 * currently working with, not whichever case happens to sort first.
 */
async function agencyIdForClient(userId: string): Promise<string | null> {
  try {
    const snap = await collections.applications
      .where("userId", "==", userId)
      .orderBy("updatedAt", "desc")
      .limit(5)
      .get();
    for (const doc of snap.docs) {
      const agencyId = doc.data()?.agencyId;
      if (typeof agencyId === "string") return agencyId;
    }
    return null;
  } catch (err) {
    // A missing composite index surfaces here — degrade to Seli-only branding
    // rather than failing the email.
    console.error("[agency-brand] client agency lookup failed:", err);
    return null;
  }
}

/** Resolve a uid from an email address, for flows that only know the address. */
async function userIdForEmail(email: string): Promise<string | null> {
  try {
    const snap = await collections.users
      .where("email", "==", email.toLowerCase())
      .limit(1)
      .get();
    return snap.docs[0]?.id ?? null;
  } catch (err) {
    console.error("[agency-brand] email lookup failed:", err);
    return null;
  }
}

/**
 * Resolve the agency mark to render beside the Seli logo for one recipient.
 *
 * Returns `null` whenever there is no agency, no logo, or anything goes wrong —
 * callers pass the result straight to the template, which degrades to the
 * Seli-only header.
 */
export async function resolveAgencyBrand(
  lookup: AgencyBrandLookup
): Promise<AgencyBrand | null> {
  try {
    // 1. Explicit agency.
    if (lookup.agencyId) return brandForAgencyId(lookup.agencyId);

    // 2. The case this email is about.
    if (lookup.applicationId) {
      const agencyId = await agencyIdForApplication(lookup.applicationId);
      if (agencyId) return brandForAgencyId(agencyId);
    }

    // Fall back to the recipient's own affiliation. Resolve a uid from the
    // address when the caller only has one (password reset, magic link).
    const userId =
      lookup.userId ?? (lookup.email ? await userIdForEmail(lookup.email) : null);
    if (!userId) return null;

    // 3. Agent-side users: their own agency.
    const staffAgencyId = await agencyIdForStaff(userId);
    if (staffAgencyId) return brandForAgencyId(staffAgencyId);

    // 4. Clients: the agency on their latest case.
    const clientAgencyId = await agencyIdForClient(userId);
    if (clientAgencyId) return brandForAgencyId(clientAgencyId);

    return null;
  } catch (err) {
    console.error("[agency-brand] resolution failed:", err);
    return null;
  }
}
