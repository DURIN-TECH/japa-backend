import { Timestamp } from "firebase-admin/firestore";
import {
  VerificationProvider,
  VerificationCheckRequest,
  VerificationCheckResult,
  VerificationEvent,
} from "./verification.types";
import { dojahProvider } from "./dojah.provider";
import { smileIdProvider } from "./smileid.provider";

// ============================================
// VERIFICATION SERVICE (provider-agnostic facade)
// ============================================
//
// The single entry point the rest of the backend uses for automated verification.
// Mirrors `email.service.ts` / `billing.service.ts`: an env var picks the active
// provider, and callers never import a concrete provider directly.
//
// SAFE-ROLLOUT is the load-bearing property: when the active provider isn't
// configured (no API keys — the state on every environment until we go live),
// `runChecks()` returns `[]`, so the existing MANUAL compliance flow
// (`submitForReview -> under_review -> admin decides`) is completely unchanged.

/** Government-ID checks that legally require the subject's consent before running. */
const CONSENT_REQUIRED_CHECKS = new Set(["gov_id_bvn", "gov_id_nin"]);

class VerificationService {
  // Registry of available providers. Add a sibling class + entry to support a new one.
  private readonly providers: Record<string, VerificationProvider> = {
    dojah: dojahProvider,
    smileid: smileIdProvider,
  };

  /**
   * The active provider (env-overridable; falls back to Dojah rather than throwing,
   * matching the email facade — an unknown/unset value degrades to a safe default).
   */
  get provider(): VerificationProvider {
    const name = process.env.VERIFICATION_PROVIDER || "dojah";
    return this.providers[name] ?? dojahProvider;
  }

  /** True when the active provider is ready to make real calls. */
  get isConfigured(): boolean {
    return this.provider.isConfigured;
  }

  /** Whether high-confidence, all-passed sets may be auto-verified (default off). */
  get autoApproveEnabled(): boolean {
    return process.env.VERIFICATION_AUTO_APPROVE === "true";
  }

  /**
   * Run a set of checks and return normalized results.
   *
   * - Unconfigured provider  -> `[]` (safe no-op; manual flow untouched).
   * - gov-id check w/o consent -> a `needs_review` result (never sent to the provider).
   * - provider throws on a check -> that check degrades to `needs_review` so one bad
   *   check never fails the whole submission (the rest still run).
   */
  async runChecks(
    reqs: VerificationCheckRequest[]
  ): Promise<VerificationCheckResult[]> {
    if (!this.isConfigured) return [];

    return Promise.all(
      reqs.map(async (req) => {
        // Enforce consent for BVN/NIN before any provider call (NIBSS iGree / NDPA).
        if (CONSENT_REQUIRED_CHECKS.has(req.checkType) && !req.consent?.granted) {
          return this.degraded(
            req,
            "Consent is required before a government ID lookup can run."
          );
        }
        try {
          return await this.provider.runCheck(req);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Verification check failed";
          return this.degraded(req, reason);
        }
      })
    );
  }

  /**
   * Webhook entry point (mirrors `billing.handleWebhook`): verify + normalize.
   * Returns `null` for an unverified/irrelevant payload; the caller applies the
   * normalized event to the subject's record.
   */
  handleWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): VerificationEvent | null {
    return this.provider.parseWebhook(headers, rawBody);
  }

  /** Build a resilient `needs_review` result when a check can't complete cleanly. */
  private degraded(
    req: VerificationCheckRequest,
    reason: string
  ): VerificationCheckResult {
    return {
      checkType: req.checkType,
      provider: this.provider.name,
      status: "needs_review",
      reason,
      checkedAt: Timestamp.now(),
    };
  }
}

export const verificationService = new VerificationService();
