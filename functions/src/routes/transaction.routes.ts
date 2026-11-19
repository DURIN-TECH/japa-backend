import { Router } from "express";
import { transactionController } from "../controllers/transaction.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// /stats must come before /:id to avoid "stats" matching as an id
router.get("/stats", verifyAuth, (req, res) =>
  transactionController.getStats(req, res)
);

router.get("/", verifyAuth, (req, res) =>
  transactionController.getTransactions(req, res)
);

// Issue #395: an admin asks Paystack for an unknown fee again (admin check in the controller).
router.post("/:id/paystack-fee/refresh", verifyAuth, (req, res) =>
  transactionController.refreshPaystackFee(req, res)
);

router.get("/:id", verifyAuth, (req, res) =>
  transactionController.getTransaction(req, res)
);

export { router as transactionRoutes };
