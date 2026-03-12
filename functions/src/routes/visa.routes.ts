import { Router } from "express";
import { visaController } from "../controllers/visa.controller";
import { verifyAuth, verifyAdmin } from "../middleware/auth";

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
countryRoutes.get("/:code/visas/:visaId", (req, res) =>
  visaController.getVisaType(req, res)
);
countryRoutes.get("/:code/visas/:visaId/full", (req, res) =>
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

export { countryRoutes, visaSearchRoutes, adminVisaRoutes };
