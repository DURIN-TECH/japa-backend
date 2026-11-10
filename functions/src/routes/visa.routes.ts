import { Router } from "express";
import { visaController } from "../controllers/visa.controller";
import { verifyAuth, verifyAdmin, optionalAuth } from "../middleware/auth";

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
// the caller's ability allows reading it. `optionalAuth` attaches the ability
// when a valid token is sent and never blocks an anonymous request.
countryRoutes.get("/:code/visas/:visaId", optionalAuth, (req, res) =>
  visaController.getVisaType(req, res)
);
countryRoutes.get("/:code/visas/:visaId/full", optionalAuth, (req, res) =>
  visaController.getVisaTypeWithRequirements(req, res)
);
countryRoutes.post("/:code/visas", verifyAuth, verifyAdmin, (req, res) =>
  visaController.createVisaType(req, res)
);

// Requirements under visa types
countryRoutes.get("/:code/visas/:visaId/requirements", (req, res) =>
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

// Set the USD cost of a PENDING scraped visa by hand (issue #70). Body
// { countryCode, amountUsd, reason, rates, expectedContentHash?, expectedExtractedAt? }.
// `verifyAuth` → 401 without a token; the controller then gates on the
// shared CASL ability (no `verifyAdmin` role check) → 403 for non-admins.
adminVisaRoutes.put("/:id/manual-cost", verifyAuth, (req, res) =>
  visaController.setManualCost(req, res)
);

export { countryRoutes, visaSearchRoutes, adminVisaRoutes };
