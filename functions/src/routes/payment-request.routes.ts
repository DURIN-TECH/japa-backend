import { Router } from "express";
import { paymentRequestController } from "../controllers/payment-request.controller";
import { verifyAuth } from "../middleware/auth";

// Routes mounted at /payment-requests
const paymentRequestRoutes = Router();

// List payment requests
paymentRequestRoutes.get("/", verifyAuth, (req, res) =>
  paymentRequestController.getPaymentRequests(req, res)
);

// Create payment request
paymentRequestRoutes.post("/", verifyAuth, (req, res) =>
  paymentRequestController.createPaymentRequest(req, res)
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
