// ============================================
// Agency per-visa service price: routes (issue #103)
// ============================================
//
// Mounted at /agency/visa-prices in app.ts ("/agency" = the caller's own
// agency, taken from the token). `verifyAuth` on every route: 401 without a
// valid token, 402 for writes on a read-only plan. The controller then gates
// the caller (403): reads for the agency's owner, member agents and admins;
// writes (PUT / DELETE) for the owner and admins only (issue #227). Admins
// name the agency with `?agencyId=`. Contract: ./agency-visa-prices.md.

import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { agencyVisaPriceController } from "./agency-visa-price.controller";

const agencyVisaPriceRoutes = Router();

// Every offered visa with this agency's price (`?include=global` adds the
// rest of the public catalog, for the picker).
agencyVisaPriceRoutes.get("/", verifyAuth, (req, res) => agencyVisaPriceController.list(req, res));
// Set / change (or `{ priceUsd: null }` to clear) the price of one visa, in US dollars (#179).
// Owner / admin only (#227).
agencyVisaPriceRoutes.put("/:countryCode/:visaTypeId", verifyAuth, (req, res) =>
  agencyVisaPriceController.set(req, res)
);
// Clear the price of one visa. Owner / admin only (#227).
agencyVisaPriceRoutes.delete("/:countryCode/:visaTypeId", verifyAuth, (req, res) =>
  agencyVisaPriceController.clear(req, res)
);

export { agencyVisaPriceRoutes };
