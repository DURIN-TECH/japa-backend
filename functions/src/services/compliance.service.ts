import { collections, serverTimestamp } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { Agency, AgencyCompliance, KycIdType, SettlementBank } from "../types";

// ============================================
// COMPLIANCE (KYC / KYB / PAYOUT) SERVICE
// ============================================
//
// Owns the agency compliance file: the structured KYC (owner identity), KYB
// (business) and payout information an agency must provide before it can move
// money on the platform or be assigned platform-originated ("our") clients.
//
// Compliance lives as a nested `compliance` map on the agency document. The
// service reads-merges-writes the whole map (it's small and bounded) rather
// than juggling dot-notation field paths, which keeps the transition logic in
// one place and easy to reason about.

/** A slot identifies which document field an upload belongs to. */
export type ComplianceDocumentSlot =
  | "idDocument" // KYC government ID scan  -> idDocumentPath
  | "proofOfAddress" // KYC proof of address    -> proofOfAddressPath
  | "cacDocument"; // KYB CAC certificate     -> cacDocumentPath

// Map each document slot to the compliance field that stores its storage path.
const DOCUMENT_SLOT_FIELD: Record<ComplianceDocumentSlot, keyof AgencyCompliance> = {
  idDocument: "idDocumentPath",
  proofOfAddress: "proofOfAddressPath",
  cacDocument: "cacDocumentPath",
};

/**
 * Editable scalar fields an owner may submit for their compliance file.
 * `dateOfBirth` arrives as an ISO string and is converted to a Timestamp.
 */
export interface ComplianceFieldsInput {
  // KYC
  legalFirstName?: string;
  legalLastName?: string;
  dateOfBirth?: string; // ISO date string
  idType?: KycIdType;
  idNumber?: string;
  bvn?: string;
  // KYB
  rcNumber?: string;
  tin?: string;
  businessAddress?: string;
  // Payout
  settlementBank?: SettlementBank;
}

/** A single required compliance item + whether it's satisfied. */
export interface ComplianceRequirement {
  key: string;
  label: string;
  group: "kyc" | "kyb" | "payout";
  kind: "field" | "document";
  complete: boolean;
}

// A compliance file can only be edited while it is in one of these states.
// Once submitted (under_review) or verified it is locked until an admin acts;
// a rejected file is editable again so the owner can fix and resubmit.
const EDITABLE_STATES: AgencyCompliance["status"][] = [
  "not_started",
  "in_progress",
  "rejected",
];

class ComplianceService {
  /** Default (empty) compliance file for an agency that hasn't started one. */
  private emptyCompliance(): AgencyCompliance {
    return { status: "not_started" };
  }

  /**
   * Compute the full required-item checklist for a compliance file, marking
   * each item complete/incomplete. This is the single source of truth shared
   * by the "can submit?" check and the portal UI (returned over the wire), so
   * the two can never drift.
   */
  getRequirements(compliance: AgencyCompliance): ComplianceRequirement[] {
    const has = (v: unknown) =>
      typeof v === "string" ? v.trim().length > 0 : v != null;
    const bank = compliance.settlementBank;
    return [
      // ---- KYC: owner identity ----
      {
        key: "legalName",
        label: "Owner's full legal name",
        group: "kyc",
        kind: "field",
        complete: has(compliance.legalFirstName) && has(compliance.legalLastName),
      },
      {
        key: "dateOfBirth",
        label: "Owner's date of birth",
        group: "kyc",
        kind: "field",
        complete: has(compliance.dateOfBirth),
      },
      {
        key: "idNumber",
        label: "Government ID type & number (NIN / passport / etc.)",
        group: "kyc",
        kind: "field",
        complete: has(compliance.idType) && has(compliance.idNumber),
      },
      {
        key: "bvn",
        label: "Bank Verification Number (BVN)",
        group: "kyc",
        kind: "field",
        complete: has(compliance.bvn),
      },
      {
        key: "idDocument",
        label: "Government ID document upload",
        group: "kyc",
        kind: "document",
        complete: has(compliance.idDocumentPath),
      },
      {
        key: "proofOfAddress",
        label: "Proof of address / selfie upload",
        group: "kyc",
        kind: "document",
        complete: has(compliance.proofOfAddressPath),
      },
      // ---- KYB: business ----
      {
        key: "rcNumber",
        label: "CAC registration (RC/BN) number",
        group: "kyb",
        kind: "field",
        complete: has(compliance.rcNumber),
      },
      {
        key: "tin",
        label: "Tax Identification Number (TIN)",
        group: "kyb",
        kind: "field",
        complete: has(compliance.tin),
      },
      {
        key: "businessAddress",
        label: "Registered business address",
        group: "kyb",
        kind: "field",
        complete: has(compliance.businessAddress),
      },
      {
        key: "cacDocument",
        label: "CAC certificate upload",
        group: "kyb",
        kind: "document",
        complete: has(compliance.cacDocumentPath),
      },
      // ---- Payout ----
      {
        key: "settlementBank",
        label: "Settlement bank account",
        group: "payout",
        kind: "field",
        complete:
          !!bank && has(bank.bankName) && has(bank.accountNumber) && has(bank.accountName),
      },
    ];
  }

  /** True when every required item is satisfied (i.e. the file may be submitted). */
  isComplete(compliance: AgencyCompliance): boolean {
    return this.getRequirements(compliance).every((r) => r.complete);
  }

  /** Read an agency's compliance file (defaults to an empty one). */
  async getCompliance(agencyId: string): Promise<AgencyCompliance> {
    const doc = await collections.agencies.doc(agencyId).get();
    if (!doc.exists) throw new Error("Agency not found");
    const agency = doc.data() as Agency;
    return agency.compliance ?? this.emptyCompliance();
  }

  /** Convenience: has this agency passed compliance? (the gate for money/clients) */
  async isVerified(agencyId: string): Promise<boolean> {
    try {
      const compliance = await this.getCompliance(agencyId);
      return compliance.status === "verified";
    } catch {
      return false;
    }
  }

  /**
   * Persist a merged compliance file back onto the agency, updating the parent
   * doc's `updatedAt`. Centralises the read-merge-write so callers only pass the
   * next compliance object.
   */
  private async saveCompliance(
    agencyId: string,
    compliance: AgencyCompliance
  ): Promise<AgencyCompliance> {
    await collections.agencies.doc(agencyId).update({
      compliance,
      updatedAt: serverTimestamp(),
    });
    return compliance;
  }

  /**
   * Merge owner-supplied scalar fields into the compliance file. Only allowed
   * while the file is editable; a not_started/rejected file transitions to
   * in_progress (and any prior rejection reason is cleared).
   */
  async updateFields(
    agencyId: string,
    fields: ComplianceFieldsInput
  ): Promise<AgencyCompliance> {
    const current = await this.getCompliance(agencyId);
    if (!EDITABLE_STATES.includes(current.status)) {
      throw new ComplianceLockedError(current.status);
    }

    const next: AgencyCompliance = { ...current };

    // Copy through only the provided scalar fields (omitting undefined).
    if (fields.legalFirstName !== undefined) next.legalFirstName = fields.legalFirstName;
    if (fields.legalLastName !== undefined) next.legalLastName = fields.legalLastName;
    if (fields.idType !== undefined) next.idType = fields.idType;
    if (fields.idNumber !== undefined) next.idNumber = fields.idNumber;
    if (fields.bvn !== undefined) next.bvn = fields.bvn;
    if (fields.rcNumber !== undefined) next.rcNumber = fields.rcNumber;
    if (fields.tin !== undefined) next.tin = fields.tin;
    if (fields.businessAddress !== undefined) next.businessAddress = fields.businessAddress;
    if (fields.settlementBank !== undefined) next.settlementBank = fields.settlementBank;
    if (fields.dateOfBirth !== undefined) {
      // Convert the ISO date string to a Firestore Timestamp for storage.
      next.dateOfBirth = Timestamp.fromDate(new Date(fields.dateOfBirth));
    }

    // Moving forward from a fresh/rejected file clears the rejection reason.
    next.status = "in_progress";
    delete next.rejectionReason;

    return this.saveCompliance(agencyId, next);
  }

  /**
   * Record an uploaded document against its slot (idDocument/proofOfAddress/
   * cacDocument). Same editability rules as field updates.
   */
  async registerDocument(
    agencyId: string,
    slot: ComplianceDocumentSlot,
    storagePath: string
  ): Promise<AgencyCompliance> {
    const current = await this.getCompliance(agencyId);
    if (!EDITABLE_STATES.includes(current.status)) {
      throw new ComplianceLockedError(current.status);
    }

    const field = DOCUMENT_SLOT_FIELD[slot];
    const next: AgencyCompliance = { ...current, [field]: storagePath };
    next.status = "in_progress";
    delete next.rejectionReason;

    return this.saveCompliance(agencyId, next);
  }

  /**
   * Submit the compliance file for admin review. Refuses if any required item
   * is still outstanding (defence-in-depth alongside the portal's own check).
   */
  async submitForReview(agencyId: string): Promise<AgencyCompliance> {
    const current = await this.getCompliance(agencyId);
    if (!EDITABLE_STATES.includes(current.status)) {
      throw new ComplianceLockedError(current.status);
    }
    if (!this.isComplete(current)) {
      throw new ComplianceIncompleteError();
    }

    const next: AgencyCompliance = {
      ...current,
      status: "under_review",
      submittedAt: Timestamp.now(),
    };
    delete next.rejectionReason;

    return this.saveCompliance(agencyId, next);
  }

  /**
   * Admin decision on a submitted file. `approve` -> verified (unlocks money +
   * platform clients); `reject` -> rejected (owner can edit and resubmit).
   */
  async review(
    agencyId: string,
    adminUserId: string,
    action: "approve" | "reject",
    reason?: string
  ): Promise<AgencyCompliance> {
    const current = await this.getCompliance(agencyId);
    const approved = action === "approve";

    const next: AgencyCompliance = {
      ...current,
      status: approved ? "verified" : "rejected",
      reviewedAt: Timestamp.now(),
      reviewedBy: adminUserId,
    };
    if (approved) {
      delete next.rejectionReason;
    } else {
      next.rejectionReason = reason || "Compliance information could not be verified.";
    }

    return this.saveCompliance(agencyId, next);
  }
}

/** Thrown when an edit/submit is attempted on a locked (under_review/verified) file. */
export class ComplianceLockedError extends Error {
  constructor(public readonly status: AgencyCompliance["status"]) {
    super(
      status === "under_review"
        ? "Your compliance information is under review and can't be changed right now."
        : "Your compliance is already verified."
    );
    this.name = "ComplianceLockedError";
  }
}

/** Thrown when submitting a file that still has outstanding required items. */
export class ComplianceIncompleteError extends Error {
  constructor() {
    super("Please complete all required KYC/KYB items before submitting.");
    this.name = "ComplianceIncompleteError";
  }
}

export const complianceService = new ComplianceService();
