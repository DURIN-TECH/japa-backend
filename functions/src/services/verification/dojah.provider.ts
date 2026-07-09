import * as crypto from "crypto";
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

  /**
   * Run a single check. Real Dojah HTTP calls are added per check type in Phase 1
   * (sync: BVN/NIN/CAC/AML) and Phase 2 (async: document_analysis / liveness_facematch,
   * which resolve `pending` and complete via `parseWebhook`). Throwing here is safe:
   * the orchestrator wraps each call and degrades a failed/unimplemented check to
   * `needs_review` rather than failing the whole submission.
   */
  async runCheck(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    void this.baseUrl; // referenced so the getter isn't flagged unused until Phase 1
    throw new Error(
      `Dojah check '${req.checkType}' is not implemented yet (Phase 0 scaffolding).`
    );
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
