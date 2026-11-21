import { Router } from "express";
import { consultationController } from "../controllers/consultation.controller";
import { verifyAuth } from "../middleware/auth";
import { requireFeature } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";

const router = Router();

// PUBLIC — no auth: verify-on-return for a guest consultation payment. Defined
// before "/:id" so "public" isn't matched as a consultation id.
router.post("/public/verify", (req, res) =>
  consultationController.verifyPublicConsultation(req, res)
);

// /stats must come before /:id to avoid "stats" matching as an id
router.get("/stats", verifyAuth, (req, res) =>
  consultationController.getStats(req, res)
);

router.get("/", verifyAuth, (req, res) =>
  consultationController.getConsultations(req, res)
);

router.post("/", verifyAuth, requireFeature(FEATURES.CONSULTATIONS_BOOK), (req, res) =>
  consultationController.createConsultation(req, res)
);

// Issue #354: admin list of unapplied-payment refunds that need an admin
// (held, or failed at Paystack). Before /:id, so "payment-exceptions" is
// never read as a booking id.
router.get("/payment-exceptions", verifyAuth, (req, res) =>
  consultationController.listPaymentExceptions(req, res)
);

router.get("/:id", verifyAuth, (req, res) =>
  consultationController.getConsultation(req, res)
);

router.put("/:id", verifyAuth, (req, res) =>
  consultationController.updateConsultation(req, res)
);

// Issue #180: resume paying a pending booking (same checkout inside the quote
// lock, a fresh quote after it). Only the booking's own client may call it;
// the controller checks that.
router.post("/:id/checkout", verifyAuth, (req, res) =>
  consultationController.checkoutConsultation(req, res)
);

router.put("/:id/status", verifyAuth, (req, res) =>
  consultationController.updateStatus(req, res)
);

// Issue #317: admin manual refund / retry of a failed refund. The controller
// answers 403 for anyone but an admin, before the booking is read.
router.post("/:id/refund", verifyAuth, (req, res) =>
  consultationController.refundConsultation(req, res)
);

// Issue #413 (B): an admin closes the booking's HELD client-cancel refund as
// nothing_to_refund (Paystack's stored fee >= the charge). No money moves.
// 401 without a token (verifyAuth); the controller answers 403 for anyone
// but an admin, before anything is read.
router.post("/:id/refund/close", verifyAuth, (req, res) =>
  consultationController.closeHeldRefund(req, res)
);

// Issue #354 fix round: an admin closes a client-caused unapplied-payment
// exception as nothing_to_refund (Paystack's fee >= the charge). No money
// moves. 401 without a token (verifyAuth); the controller answers 403 for
// anyone but an admin, before anything is read.
router.post("/:id/payment-exceptions/:exceptionId/close", verifyAuth, (req, res) =>
  consultationController.closePaymentException(req, res)
);

router.delete("/:id", verifyAuth, (req, res) =>
  consultationController.deleteConsultation(req, res)
);

export { router as consultationRoutes };
