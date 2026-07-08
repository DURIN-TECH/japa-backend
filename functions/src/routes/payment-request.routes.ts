import { Router } from "express";
import { paymentRequestController } from "../controllers/payment-request.controller";
import { verifyAuth } from "../middleware/auth";
import { requireFeature, requireAgencyVerified } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";

// Routes mounted at /payment-requests
const paymentRequestRoutes = Router();

// List payment requests
paymentRequestRoutes.get("/", verifyAuth, (req, res) =>
  paymentRequestController.getPaymentRequests(req, res)
);

// Create payment request — gated by (1) the "payments.request" entitlement AND
// (2) agency compliance. An unverified agency can manage its own clients but may
// not make/receive payments on the platform, so requesting funds is blocked
// until KYC/KYB verification passes.
paymentRequestRoutes.post(
  "/",
  verifyAuth,
  requireFeature(FEATURES.PAYMENTS_REQUEST),
  requireAgencyVerified("request or receive payments"),
  (req, res) => paymentRequestController.createPaymentRequest(req, res)
);

// Get payment request by ID
paymentRequestRoutes.get("/:id", verifyAuth, (req, res) =>
  paymentRequestController.getPaymentRequest(req, res)
);

// Approve payment request (client approves agent's fund request)
paymentRequestRoutes.put("/:id/approve", verifyAuth, (req, res) =>
  paymentRequestController.approvePaymentRequest(req, res)
);

// Reject payment request (client rejects with reason, auto-creates chat)
paymentRequestRoutes.put("/:id/reject", verifyAuth, (req, res) =>
  paymentRequestController.rejectPaymentRequest(req, res)
);

// Update payment request status
paymentRequestRoutes.put("/:id/status", verifyAuth, (req, res) =>
  paymentRequestController.updatePaymentRequestStatus(req, res)
);

// Delete payment request
paymentRequestRoutes.delete("/:id", verifyAuth, (req, res) =>
  paymentRequestController.deletePaymentRequest(req, res)
);

export { paymentRequestRoutes };
