import * as crypto from "crypto";
import axios, { AxiosInstance } from "axios";
import { Timestamp } from "firebase-admin/firestore";
import {
  VerificationProvider,
  VerificationCheckRequest,
  VerificationCheckResult,
  VerificationCheckStatus,
  VerificationEvent,
} from "./verification.types";
import { scoreIdentityMatch } from "./identity-match";

// ============================================
// DOJAH VERIFICATION PROVIDER (default)
// ============================================
//
// Concrete `VerificationProvider` for Dojah (https://dojah.io) — the Nigeria-first
// KYC/KYB API chosen as the default (cheap pay-as-you-go, CAC-with-directors,
// BVN/NIN + document/liveness, NGN billing). Mirrors `ResendProvider` /
// `PaystackProvider`: reads secrets from `process.env` via getters (so Secret
// Manager values bound at runtime are picked up), guards a safe-rollout skip via
// `isConfigured`, and HMAC-verifies webhooks exactly like `paystack.provider.ts`.
//
// Phase 1 (this file): the SYNC checks are implemented — BVN/NIN government-ID
// lookups (with name/DOB match scoring), CAC business-registry lookup (with
// directors), and AML/PEP screening. The ASYNC checks (document authenticity,
// liveness/face-match) are client-SDK-initiated and land in Phase 2 via
// `parseWebhook`.
//
// NOTE: exact Dojah endpoint paths, query params, and response field names are
// implemented against Dojah's public docs but MUST be confirmed against the
// sandbox during Phase 1 validation (see the field-mapping comments per check).
// The mapping is centralized so adjustments are one-liners.

/** Header Dojah is expected to sign webhooks with. Confirm against Dojah docs in Phase 2. */
const DOJAH_SIGNATURE_HEADER = "x-dojah-signature";

/** A Dojah response entity (loosely typed — shapes vary per endpoint). */
type DojahEntity = Record<string, unknown>;

class DojahProvider implements VerificationProvider {
  readonly name = "dojah";

  // ---- Config (read at call time so runtime-bound secrets are honored) ----
  private get appId(): string {
    return process.env.DOJAH_APP_ID || "";
  }
  private get secretKey(): string {
    return process.env.DOJAH_SECRET_KEY || "";
  }
  private get webhookSecret(): string {
    // Falls back to the API secret key if a dedicated webhook secret isn't set.
    return process.env.DOJAH_WEBHOOK_SECRET || this.secretKey;
  }
  /** Sandbox on dev (durin-seli-dev), live on prod (japa-platform). */
  private get baseUrl(): string {
    return process.env.DOJAH_BASE_URL || "https://api.dojah.io";
  }

  /** Ready to make real calls only when both credentials are present (safe-rollout). */
  get isConfigured(): boolean {
    return !!this.appId && !!this.secretKey;
  }

  /** Axios client with Dojah auth headers. Built per call so runtime secrets apply. */
  private http(): AxiosInstance {
    return axios.create({
      baseURL: this.baseUrl,
      timeout: 20000,
      headers: {
        AppId: this.appId,
        Authorization: this.secretKey,
      },
    });
  }

  /**
   * GET a Dojah endpoint and return its `entity` (Dojah wraps results as
   * `{ entity: {...} }`). Non-2xx / network errors throw; each caller maps them to
   * a `needs_review` result so a transient failure surfaces for a human rather
   * than being mistaken for an identity mismatch.
   */
  private async getEntity(
    path: string,
    params: Record<string, string | undefined>
  ): Promise<DojahEntity> {
    const { data } = await this.http().get(path, { params });
    // Some endpoints return `{ entity }`, a few return the object directly.
    const entity = (data?.entity ?? data) as DojahEntity;
    return entity ?? {};
  }

  /** Build a normalized result (fills provider + timestamp). */
  private result(
    checkType: VerificationCheckRequest["checkType"],
    status: VerificationCheckStatus,
    opts: {
      confidence?: number;
      reason?: string;
      extractedData?: Record<string, unknown>;
      providerRef?: string;
    } = {}
  ): VerificationCheckResult {
    return {
      checkType,
      provider: this.name,
      status,
      confidence: opts.confidence,
      reason: opts.reason,
      extractedData: opts.extractedData,
      providerRef: opts.providerRef,
      checkedAt: Timestamp.now(),
    };
  }

  /** Turn a caught request error into a surfaced `needs_review` result. */
  private errorResult(
    checkType: VerificationCheckRequest["checkType"],
    err: unknown
  ): VerificationCheckResult {
    const msg =
      (axios.isAxiosError(err) &&
        (err.response?.data as { error?: string; message?: string })?.error) ||
      (err instanceof Error ? err.message : "Verification request failed");
    return this.result(checkType, "needs_review", {
      reason: `Could not complete the check automatically (${msg}). Manual review needed.`,
    });
  }

  async runCheck(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    switch (req.checkType) {
    case "gov_id_bvn":
      return this.checkBvn(req);
    case "gov_id_nin":
      return this.checkNin(req);
    case "business_registry":
      return this.checkCac(req);
    case "aml_pep":
      return this.checkAml(req);
      // Document authenticity + liveness are async (client SDK -> Dojah -> webhook).
    case "document_analysis":
    case "liveness_facematch":
      throw new Error(
        `Dojah '${req.checkType}' is async (client SDK -> webhook); not run synchronously (Phase 2).`
      );
    default:
      throw new Error(`Unsupported Dojah check '${req.checkType}'.`);
    }
  }

  // ---- BVN lookup (NIBSS) + name/DOB match ----
  // Dojah: GET /api/v1/kyc/bvn/full?bvn=  -> entity { first_name, last_name, date_of_birth, ... }
  private async checkBvn(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    try {
      const e = await this.getEntity("/api/v1/kyc/bvn/full", { bvn: req.bvn });
      const match = scoreIdentityMatch(
        { firstName: req.firstName, lastName: req.lastName, dateOfBirth: req.dateOfBirth },
        {
          firstName: e.first_name as string,
          lastName: e.last_name as string,
          dateOfBirth: e.date_of_birth as string,
        }
      );
      return this.result("gov_id_bvn", match.status, {
        confidence: match.confidence,
        reason: match.reason,
        // Data-minimized: keep match booleans + last-4, NOT the raw BVN.
        extractedData: {
          match: match.fields,
          bvnLast4: (req.bvn || "").slice(-4),
          recordName: `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim(),
        },
        providerRef: (e.reference as string) || undefined,
      });
    } catch (err) {
      return this.errorResult("gov_id_bvn", err);
    }
  }

  // ---- NIN lookup (NIMC) + name/DOB match ----
  // Dojah: GET /api/v1/kyc/nin?nin=  -> entity { first_name, last_name, date_of_birth, ... }
  private async checkNin(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    try {
      const e = await this.getEntity("/api/v1/kyc/nin", { nin: req.nin });
      const match = scoreIdentityMatch(
        { firstName: req.firstName, lastName: req.lastName, dateOfBirth: req.dateOfBirth },
        {
          firstName: e.first_name as string,
          lastName: e.last_name as string,
          dateOfBirth: e.date_of_birth as string,
        }
      );
      return this.result("gov_id_nin", match.status, {
        confidence: match.confidence,
        reason: match.reason,
        extractedData: {
          match: match.fields,
          ninLast4: (req.nin || "").slice(-4),
          recordName: `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim(),
        },
        providerRef: (e.reference as string) || undefined,
      });
    } catch (err) {
      return this.errorResult("gov_id_nin", err);
    }
  }

  // ---- CAC business-registry lookup (+ directors) ----
  // Dojah: GET /api/v1/kyc/cac/advance?rc_number=  -> entity { company_name, rc_number, status, directors[] }
  private async checkCac(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    try {
      const e = await this.getEntity("/api/v1/kyc/cac/advance", {
        rc_number: req.rcNumber,
      });
      const companyName = (e.company_name ?? e.companyName) as string | undefined;
      const statusStr = (e.status as string) || "";
      // Directors/affiliates list — used both as an admin signal and (in the
      // orchestrator) to check whether the owner is a listed director.
      const directors = (e.directors ?? e.affiliates ?? []) as unknown[];

      const found = !!companyName;
      const active = statusStr ? /active/i.test(statusStr) : true;

      let status: VerificationCheckStatus;
      let reason: string;
      let confidence: number;
      if (!found) {
        status = "failed";
        confidence = 0;
        reason = "No CAC record was found for this registration number.";
      } else if (!active) {
        status = "needs_review";
        confidence = 0.5;
        reason = `CAC record found but its status is "${statusStr}" — manual review.`;
      } else {
        status = "passed";
        confidence = 1;
        reason = "CAC record found and active.";
      }

      return this.result("business_registry", status, {
        confidence,
        reason,
        extractedData: {
          companyName,
          rcNumber: (e.rc_number as string) || req.rcNumber,
          status: statusStr || undefined,
          directors,
        },
        providerRef: (e.reference as string) || undefined,
      });
    } catch (err) {
      return this.errorResult("business_registry", err);
    }
  }

  // ---- AML / PEP / sanctions screening ----
  // Dojah: GET /api/v1/aml/screening?first_name=&last_name=  -> entity with match list.
  // A hit is NOT an auto-fail — it always routes to a human.
  private async checkAml(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    try {
      const e = await this.getEntity("/api/v1/aml/screening", {
        first_name: req.firstName,
        last_name: req.lastName,
        dob: req.dateOfBirth,
      });
      const hits = (e.watchlist ?? e.hits ?? e.results ?? []) as unknown[];
      const hitCount = Array.isArray(hits) ? hits.length : 0;

      if (hitCount === 0) {
        return this.result("aml_pep", "passed", {
          confidence: 1,
          reason: "No AML / PEP / sanctions matches found.",
          extractedData: { hitCount: 0 },
        });
      }
      return this.result("aml_pep", "needs_review", {
        confidence: 0.5,
        reason: `${hitCount} potential AML/PEP match(es) — human review required.`,
        extractedData: { hitCount, hits },
      });
    } catch (err) {
      return this.errorResult("aml_pep", err);
    }
  }

  /**
   * Verify the webhook HMAC and normalize the payload. Returns `null` for an
   * unverified or irrelevant body — the caller must never trust an unsigned
   * payload. Signature check mirrors `paystack.provider.ts parseWebhook()`.
   *
   * Payload -> `VerificationEvent` normalization (async document/liveness results)
   * lands in Phase 2; for now a verified body has nothing to apply yet.
   */
  parseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): VerificationEvent | null {
    const signature =
      headers[DOJAH_SIGNATURE_HEADER] || headers[DOJAH_SIGNATURE_HEADER.toLowerCase()];
    if (!signature) return null;

    // Recompute the HMAC over the RAW body and constant-time compare.
    const expected = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn("Dojah webhook signature mismatch — ignoring payload");
      return null;
    }

    // Signature valid. Async-result normalization (document/liveness) is Phase 2;
    // until then there are no in-flight async checks, so there's nothing to apply.
    return null;
  }
}

// Singleton — matches the email/billing provider export style.
export const dojahProvider = new DojahProvider();
