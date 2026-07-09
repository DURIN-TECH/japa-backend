import {
  VerificationProvider,
  VerificationCheckRequest,
  VerificationCheckResult,
  VerificationEvent,
} from "./verification.types";

// ============================================
// SMILE ID VERIFICATION PROVIDER (swap target — stub)
// ============================================
//
// Placeholder implementation of `VerificationProvider` for Smile ID
// (https://usesmileid.com) — the designated swap target for deeper African
// biometrics/liveness, multi-country coverage, and CAC + TIN + UBO KYB. Selecting
// it is a one-line change (`VERIFICATION_PROVIDER=smileid`); nothing else in the
// codebase changes because everything talks to the interface.
//
// Real implementation (signature-authenticated jobs + callbacks) lands when/if we
// swap. Until then it reports `isConfigured=false` so the facade never routes to
// it and the safe-rollout no-op applies.

class SmileIdProvider implements VerificationProvider {
  readonly name = "smileid";

  private get partnerId(): string {
    return process.env.SMILEID_PARTNER_ID || "";
  }
  private get apiKey(): string {
    return process.env.SMILEID_API_KEY || "";
  }

  // Not implemented yet — always unconfigured so the facade won't route here.
  get isConfigured(): boolean {
    return false;
  }

  async runCheck(req: VerificationCheckRequest): Promise<VerificationCheckResult> {
    void this.partnerId;
    void this.apiKey;
    throw new Error(
      `Smile ID check '${req.checkType}' is not implemented — set VERIFICATION_PROVIDER=dojah.`
    );
  }

  parseWebhook(): VerificationEvent | null {
    return null;
  }
}

// Singleton — matches the email/billing provider export style.
export const smileIdProvider = new SmileIdProvider();
