import { Router } from "express";
import { bankAccountController } from "../controllers/bank-account.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// All routes require authentication
router.get("/", verifyAuth, (req, res) =>
  bankAccountController.listAccounts(req, res)
);

router.post("/", verifyAuth, (req, res) =>
  bankAccountController.createAccount(req, res)
);

router.post("/withdraw", verifyAuth, (req, res) =>
  bankAccountController.withdraw(req, res)
);

router.delete("/:id", verifyAuth, (req, res) =>
  bankAccountController.deleteAccount(req, res)
);

router.put("/:id/main", verifyAuth, (req, res) =>
  bankAccountController.setMain(req, res)
);

export { router as bankAccountRoutes };
