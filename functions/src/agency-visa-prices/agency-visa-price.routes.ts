// ============================================
// Agency per-visa service price: routes (issue #103)
// ============================================
//
// Mounted at /agency/visa-prices in app.ts ("/agency" = the caller's own
// agency, taken from the token). `verifyAuth` on every route: 401 without a
// valid token, 402 for writes on a read-only plan. The controller then gates
// on the shared CASL ability (403). Contract: ./agency-visa-prices.md.

import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { agencyVisaPriceController } from "./agency-visa-price.controller";

const agencyVisaPriceRoutes = Router();

// Every offered visa with this agency's price (`?include=global` adds the
// rest of the public catalog, for the picker).
agencyVisaPriceRoutes.get("/", verifyAuth, (req, res) => agencyVisaPriceController.list(req, res));
// Set / change (or `{ price: null }` to clear) the price of one visa.
agencyVisaPriceRoutes.put("/:countryCode/:visaTypeId", verifyAuth, (req, res) =>
  agencyVisaPriceController.set(req, res)
);
// Clear the price of one visa.
agencyVisaPriceRoutes.delete("/:countryCode/:visaTypeId", verifyAuth, (req, res) =>
  agencyVisaPriceController.clear(req, res)
);

export { agencyVisaPriceRoutes };
