import { Router, raw } from "express";
import { entitlementController } from "../controllers/entitlement.controller";
import { verifyAuth, verifyAdmin } from "../middleware/auth";

const plansRouter = Router();
const subscriptionsRouter = Router();
const adminPlansRouter = Router();
const webhooksRouter = Router();

// Plans (upgrade screens — active plans only is enforced client-side via isActive)
plansRouter.get("/", verifyAuth, (req, res) => entitlementController.listPlans(req, res));

// Subscriptions
subscriptionsRouter.get("/me", verifyAuth, (req, res) =>
  entitlementController.getMySubscription(req, res)
);
// Manual admin plan assignment (pre-billing / comps)
subscriptionsRouter.post("/assign", verifyAuth, verifyAdmin, (req, res) =>
  entitlementController.assignPlan(req, res)
);
// Start a real subscription purchase (Paystack)
subscriptionsRouter.post("/checkout", verifyAuth, (req, res) =>
  entitlementController.createCheckout(req, res)
);
// Confirm a subscription purchase after Paystack redirects back (verify-on-return)
subscriptionsRouter.post("/verify", verifyAuth, (req, res) =>
  entitlementController.verifyCheckout(req, res)
);
// Agent seats (agency owner pays per seat)
subscriptionsRouter.post("/seats/checkout", verifyAuth, (req, res) =>
  entitlementController.startSeatCheckout(req, res)
);
subscriptionsRouter.post("/seats/confirm", verifyAuth, (req, res) =>
  entitlementController.confirmSeats(req, res)
);
subscriptionsRouter.post("/seats", verifyAuth, verifyAdmin, (req, res) =>
  entitlementController.setSeats(req, res)
);

// Admin package management (configurable plans)
adminPlansRouter.get("/", verifyAuth, verifyAdmin, (req, res) =>
  entitlementController.listAllPlans(req, res)
);
adminPlansRouter.post("/", verifyAuth, verifyAdmin, (req, res) =>
  entitlementController.createPlan(req, res)
);
adminPlansRouter.put("/:id", verifyAuth, verifyAdmin, (req, res) =>
  entitlementController.updatePlan(req, res)
);
adminPlansRouter.delete("/:id", verifyAuth, verifyAdmin, (req, res) =>
  entitlementController.deletePlan(req, res)
);

// Provider webhook — RAW body so the signature can be verified. Mounted before the
// global JSON parser in app.ts so the raw bytes survive.
webhooksRouter.post("/paystack", raw({ type: "*/*" }), (req, res) =>
  entitlementController.handlePaystackWebhook(req, res)
);

export { plansRouter, subscriptionsRouter, adminPlansRouter, webhooksRouter };
