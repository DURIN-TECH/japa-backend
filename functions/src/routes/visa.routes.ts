import { Router } from "express";
import { visaController } from "../controllers/visa.controller";
import { verifyAuth, verifyAdmin, optionalAuthFresh } from "../middleware/auth";

// Routes mounted at /countries
const countryRoutes = Router();

countryRoutes.get("/", (req, res) => visaController.getCountries(req, res));
countryRoutes.get("/:code", (req, res) => visaController.getCountry(req, res));
countryRoutes.post("/", verifyAuth, verifyAdmin, (req, res) =>
  visaController.createCountry(req, res)
);

// Visa types under countries
countryRoutes.get("/:code/visas", (req, res) =>
  visaController.getVisaTypes(req, res)
);
// Single-visa reads (issue #99): public, but a non-visible visa is 404 unless
// the caller's ability allows reading it. `optionalAuthFresh` attaches the
// ability when a valid token is sent and never blocks an anonymous request.
// Issue #289: these three reads (detail, /full, /requirements) serve hidden
// visas to admins and the owning agency's members, so they use the STRICTER
// optional auth: an agent-side token is checked for revocation and the
// ability is built from the account's current claims, which turns a
// suspended or demoted admin / agency member into a guest (or their current
// role) at once instead of when the old token expires. Client tokens and
// anonymous callers cost nothing extra.
countryRoutes.get("/:code/visas/:visaId", optionalAuthFresh, (req, res) =>
  visaController.getVisaType(req, res)
);
countryRoutes.get("/:code/visas/:visaId/full", optionalAuthFresh, (req, res) =>
  visaController.getVisaTypeWithRequirements(req, res)
);
countryRoutes.post("/:code/visas", verifyAuth, verifyAdmin, (req, res) =>
  visaController.createVisaType(req, res)
);

// Requirements under visa types. Issue #102: gated like the detail and /full
// routes (optionalAuthFresh attaches the caller's ability when a token is
// sent; strict for agent-side tokens, see the #289 note above).
countryRoutes.get("/:code/visas/:visaId/requirements", optionalAuthFresh, (req, res) =>
  visaController.getRequirements(req, res)
);
countryRoutes.post(
  "/:code/visas/:visaId/requirements",
  verifyAuth,
  verifyAdmin,
  (req, res) => visaController.createRequirement(req, res)
);

// Routes mounted at /visas
const visaSearchRoutes = Router();

visaSearchRoutes.get("/", (req, res) =>
  visaController.getAllVisaTypes(req, res)
);
visaSearchRoutes.get("/search", (req, res) =>
  visaController.searchVisaTypes(req, res)
);
visaSearchRoutes.get("/popular", (req, res) =>
  visaController.getPopularVisaTypes(req, res)
);

// Routes mounted at /admin/visas
const adminVisaRoutes = Router();

adminVisaRoutes.get("/", verifyAuth, verifyAdmin, (req, res) =>
  visaController.getAdminVisas(req, res)
);
adminVisaRoutes.patch("/:id/review", verifyAuth, verifyAdmin, (req, res) =>
  visaController.reviewVisa(req, res)
);

// Re-run listing screening on an agency visa's current target (issue #120).
// Body { countryCode }. Admin only: verifyAuth, verifyAdmin, then a CASL probe
// on `reviewStatus` in the controller.
adminVisaRoutes.post("/:id/screening/rerun", verifyAuth, verifyAdmin, (req, res) =>
  visaController.rerunScreening(req, res)
);

// Make an approved agency visa global, or take it back to agency-only
// (issue #101). Body { countryCode, visibility: "global" | "agency" }.
// Same admin gate as the review route; the controller adds a CASL check on
// the `visibility` field.
adminVisaRoutes.patch("/:id/visibility", verifyAuth, verifyAdmin, (req, res) =>
  visaController.setVisibility(req, res)
);

// Set the USD cost of a PENDING scraped visa by hand (issue #70). Body
// { countryCode, amountUsd, reason, rates, expectedContentHash?, expectedExtractedAt? }.
// `verifyAuth` → 401 without a token; the controller then gates on the
// shared CASL ability (no `verifyAdmin` role check) → 403 for non-admins.
adminVisaRoutes.put("/:id/manual-cost", verifyAuth, (req, res) =>
  visaController.setManualCost(req, res)
);

export { countryRoutes, visaSearchRoutes, adminVisaRoutes };
