import * as crypto from "crypto";
import axios, { AxiosInstance } from "axios";
import { Timestamp } from "firebase-admin/firestore";
import {
  VerificationProvider,
  VerificationCheckRequest,
  VerificationCheckResult,
  VerificationEvent,
} from "./verification.types";

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
// SCAFFOLDING (Phase 0): the transport is stubbed. `isConfigured` + `parseWebhook`
// signature verification are real; the per-check HTTP calls in `runCheck` land in
// Phase 1 (sync BVN/NIN/CAC/AML) and Phase 2 (async document/liveness). Until then
// the facade's `runChecks()` no-ops when unconfigured, so nothing calls `runCheck`.

/** Header Dojah is expected to sign webhooks with. Confirm against Dojah docs in Phase 2. */
const DOJAH_SIGNATURE_HEADER = "x-dojah-signature";

/**
 * Sentinel value the DOJAH_* secrets are set to in dev+prod so deploys pass secret
 * validation before we have real Dojah credentials (see dojah-secrets-placeholder).
 * We treat it as "unconfigured" so `isConfigured` stays false until real keys land —
 * otherwise a non-empty placeholder would flip verification on and every lookup would
 * 401 (which the applicant would experience as a verification failure).
 */
const PLACEHOLDER_SECRET = "temp-placeholder-not-configured";

/**
 * Dojah government-ID lookup endpoints (relative to `baseUrl`). Dojah authenticates
 * with an `AppId` header + the private/secret key in `Authorization` (NOT a Bearer
 * token). BVN "full" returns name/DOB/phone; NIN returns name/DOB. Both wrap the
 * record in an `entity` object.
 */
const DOJAH_ENDPOINTS = {
  bvn: "/api/v1/kyc/bvn/full",
  nin: "/api/v1/kyc/nin",
} as const;

/** The subset of a Dojah gov-id `entity` we read (fields are snake_case from Dojah). */
interface DojahEntity {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  date_of_birth?: string;
  reference_id?: string;
  [k: string]: unknown;
}

/** Case/whitespace-insensitive normalization for name comparison. */
function norm(s?: string): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Normalize an assortment of DOB formats (dd-mm-yyyy, yyyy-mm-dd, ISO) to yyyy-mm-dd. */
function normDob(s?: string): string {
  if (!s) return "";
  const iso = s.slice(0, 10);
  // Already yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  // dd-mm-yyyy or dd/mm/yyyy → yyyy-mm-dd
  const m = iso.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return iso;
}

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

  /**
   * Ready to make real calls only when both credentials are present AND are not the
   * deploy placeholder (safe-rollout). While the secrets hold the placeholder value,
   * this stays false, so `runChecks` no-ops and submissions record as `under_review`.
   */
  get isConfigured(): boolean {
    return (
      !!this.appId &&
      !!this.secretKey &&
      this.appId !== PLACEHOLDER_SECRET &&
      this.secretKey !== PLACEHOLDER_SECRET
    );
  }

  /** Lazily-built axios client with Dojah's auth headers + base URL. */
  private get http(): AxiosInstance {
    return axios.create({
      baseURL: this.baseUrl,
      timeout: 15000, // KYC lookups can be slow; give NIBSS/NIMC room
      headers: {
        // Dojah auth: AppId header + the private key in Authorization (not Bearer).
        "AppId": this.appId,
        "Authorization": this.secretKey,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Run a single check.
   *
   * Implemented (sync, Phase 1): `gov_id_bvn` / `gov_id_nin` — real Dojah lookups
   * that match the returned name/DOB against what the subject submitted and return a
   * terminal `passed` / `needs_review` / `failed` result.
   *
   * Not yet implemented (Phase 2, async): `business_registry`, `document_analysis`,
   * `liveness_facematch`, `aml_pep` — these throw, and the verification service
   * degrades them to `needs_review` rather than failing the whole submission.
   */
  async runCheck(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    switch (req.checkType) {
    case "gov_id_bvn":
      return this.lookupGovId("bvn", req.bvn, req);
    case "gov_id_nin":
      return this.lookupGovId("nin", req.nin, req);
    default:
      throw new Error(
        `Dojah check '${req.checkType}' is not implemented yet (Phase 2 async).`
      );
    }
  }

  /**
   * Perform a BVN or NIN government-ID lookup and score it against the submitted
   * name/DOB. Returns a terminal result:
   *   - `passed`       — both names match (0.95, or 0.98 with a DOB match).
   *   - `needs_review` — partial / unscoreable match (no names to compare, one name off).
   *   - `failed`       — the authority record's names clearly don't match the applicant,
   *                      or Dojah reports the ID as invalid / not found.
   * A network/transport error is rethrown so the service degrades it to `needs_review`
   * (an API hiccup should never hard-fail a user).
   *
   * DATA-MINIMIZATION: we deliberately store only match booleans + the provider
   * reference in `extractedData` — never the raw BVN/NIN or the full authority record.
   */
  private async lookupGovId(
    kind: "bvn" | "nin",
    idNumber: string | undefined,
    req: VerificationCheckRequest
  ): Promise<VerificationCheckResult> {
    const base = {
      checkType: req.checkType,
      provider: this.name,
      checkedAt: Timestamp.now(),
    } as const;

    // A missing/blank id is a definitive fail (nothing to look up).
    if (!idNumber || !idNumber.trim()) {
      return { ...base, status: "failed", reason: `No ${kind.toUpperCase()} provided.` };
    }

    // Dojah returns the record under `entity`; a bad/unknown id comes back as a 4xx
    // with a message — we treat that as a definitive `failed` (not a transient error).
    let entity: DojahEntity | undefined;
    let providerRef: string | undefined;
    try {
      const res = await this.http.get(DOJAH_ENDPOINTS[kind], {
        params: { [kind]: idNumber.trim() },
      });
      entity = (res.data?.entity ?? undefined) as DojahEntity | undefined;
      providerRef = entity?.reference_id;
    } catch (err) {
      // Only a genuine "invalid / unknown ID" is a DEFINITIVE fail. Auth (401/403),
      // rate-limit (429), server (5xx) and network errors are OUR problem, not the
      // applicant's — rethrow so the service degrades them to `needs_review` (this is
      // also what keeps placeholder/misconfigured creds from failing real users).
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const isInvalidId = status === 400 || status === 404 || status === 422;
      if (isInvalidId) {
        const data = axios.isAxiosError(err)
          ? (err.response?.data as { error?: string; message?: string } | undefined)
          : undefined;
        const msg = data?.error || data?.message || `${kind.toUpperCase()} could not be verified.`;
        return { ...base, status: "failed", reason: String(msg), providerRef };
      }
      throw err; // auth/rate-limit/5xx/network — degrade to needs_review
    }

    if (!entity) {
      return { ...base, status: "failed", reason: `${kind.toUpperCase()} not found.`, providerRef };
    }

    // Score the authority record against what the applicant submitted.
    const firstMatch = norm(req.firstName) !== "" && norm(req.firstName) === norm(entity.first_name);
    const lastMatch = norm(req.lastName) !== "" && norm(req.lastName) === norm(entity.last_name);
    const dobMatch =
      normDob(req.dateOfBirth) !== "" && normDob(req.dateOfBirth) === normDob(entity.date_of_birth);

    // Only match booleans + the ref are persisted (see data-minimization note above).
    const extractedData = { firstMatch, lastMatch, dobMatch };

    // Both names match → a confident pass (DOB match nudges confidence higher).
    if (firstMatch && lastMatch) {
      return {
        ...base,
        status: "passed",
        confidence: dobMatch ? 0.98 : 0.95,
        providerRef,
        extractedData,
      };
    }

    // We had names to compare and NEITHER matched → a definitive mismatch.
    if (norm(req.firstName) !== "" && norm(req.lastName) !== "" && !firstMatch && !lastMatch) {
      return {
        ...base,
        status: "failed",
        confidence: 0.2,
        reason: `The name on this ${kind.toUpperCase()} does not match your profile.`,
        providerRef,
        extractedData,
      };
    }

    // Partial / unscoreable (one name off, or nothing to compare) → a human decides.
    return {
      ...base,
      status: "needs_review",
      confidence: 0.6,
      reason: `Your details partially matched this ${kind.toUpperCase()}; a quick review is needed.`,
      providerRef,
      extractedData,
    };
  }

  /**
   * Verify the webhook HMAC and normalize the payload. Returns `null` for an
   * unverified or irrelevant body — the caller must never trust an unsigned
   * payload. Signature check mirrors `paystack.provider.ts parseWebhook()`.
   *
   * Phase 0: verifies the signature and safely returns `null` (there are no async
   * checks in flight yet). Payload -> `VerificationEvent` normalization lands in
   * Phase 2 alongside document/liveness.
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
