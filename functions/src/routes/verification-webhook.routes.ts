import { Router, raw } from "express";
import { verificationWebhookController } from "../controllers/verification-webhook.controller";

// ============================================
// VERIFICATION WEBHOOK ROUTE (public, raw-body)
// ============================================
//
// The provider POSTs async verification results here. Like the Paystack webhook,
// this MUST read the raw body to verify the HMAC signature, so it uses
// `raw({ type: "*/*" })` and is mounted under `/webhooks` BEFORE the global JSON
// parser in app.ts. No auth middleware — authenticity is proven by the signature.
const router = Router();

router.post("/verification", raw({ type: "*/*" }), (req, res) =>
  verificationWebhookController.handleWebhook(req, res)
);

export { router as verificationWebhookRoutes };
