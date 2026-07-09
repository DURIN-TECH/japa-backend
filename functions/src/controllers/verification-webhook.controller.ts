import { Request, Response } from "express";
import { verificationService } from "../services/verification/verification.service";
import { verificationOrchestrator } from "../services/verification/verification.orchestrator";

// ============================================
// VERIFICATION WEBHOOK CONTROLLER
// ============================================
//
// Receives async results from the identity/document-verification provider
// (document authenticity, liveness/face-match). Distinct from the existing
// `verification.controller.ts`, which handles AGENT professional-vetting document
// uploads — different domain, hence the separate name.
//
// Mirrors `handlePaystackWebhook`: reads the RAW body (the route uses `raw()` and
// is mounted before the JSON parser), hands it to the service for HMAC
// verification + normalization, and applies the normalized event.
//
// Always answers 200 — an unverified/irrelevant payload is ignored, and an
// internal error is swallowed with 200 so the provider doesn't hammer retries on
// our own bug. (Phase 0: `parseWebhook` returns null until async checks exist.)

class VerificationWebhookController {
  async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      const raw = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : JSON.stringify(req.body);
      const headers = req.headers as Record<string, string | undefined>;

      const event = verificationService.handleWebhook(headers, raw);
      if (!event) {
        // Unverified signature or nothing to apply — acknowledge and stop.
        res.status(200).json({ received: true, applied: false });
        return;
      }

      await verificationOrchestrator.applyEvent(event);
      res.status(200).json({ received: true, applied: true });
    } catch (error) {
      console.error("Error handling verification webhook:", error);
      // Still 200 so the provider doesn't hammer retries on our internal errors.
      res.status(200).json({ received: true, applied: false });
    }
  }
}

export const verificationWebhookController = new VerificationWebhookController();
