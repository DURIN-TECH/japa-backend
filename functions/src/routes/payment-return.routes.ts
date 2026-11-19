import { Router } from "express";
import { paymentReturnController } from "../controllers/payment-return.controller";

/**
 * Payment return routes (issue #252) — PUBLIC, mounted at `/payments` in
 * app.ts WITHOUT `verifyAuth`: Paystack redirects the payer's in-app browser
 * here after checkout, and that browser has no Firebase token. The route only
 * redirects to the fixed app deep link (no data is read or written); payment
 * is confirmed by the app through the authenticated verify endpoints.
 */
const router = Router();

// Paystack `callback_url` for app-initiated checkouts → `durintech://payment-return`.
router.get("/return", (req, res) => paymentReturnController.handleReturn(req, res));

export { router as paymentReturnRoutes };
