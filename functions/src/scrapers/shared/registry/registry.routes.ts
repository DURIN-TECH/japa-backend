import { Router } from "express";
import { verifyAuth } from "../../../middleware/auth";
import { registryController as c } from "./registry.controller";

// ============================================
// Routes for the source registry API (issue #215)
// ============================================
//
// Mounted in app.ts. Every route: `verifyAuth` (401), then the controller's
// admin-only CASL gate (403) before anything else happens. There is NO delete
// route anywhere in this API: a source is retired, never removed.

/** /admin/official-domains — the confirmed-hosts allow-list. */
const adminOfficialDomainRoutes = Router();
adminOfficialDomainRoutes.post("/preview", verifyAuth, (req, res) => c.preview(req, res));
adminOfficialDomainRoutes.post("/", verifyAuth, (req, res) => c.confirm(req, res));
adminOfficialDomainRoutes.get("/", verifyAuth, (req, res) => c.list(req, res));
adminOfficialDomainRoutes.post("/:host/revoke", verifyAuth, (req, res) => c.revoke(req, res));

/** /admin/route-sources — register a route; country lookup. */
const adminRouteSourceRoutes = Router();
adminRouteSourceRoutes.get("/country-lookup", verifyAuth, (req, res) => c.countryLookup(req, res));
adminRouteSourceRoutes.post("/", verifyAuth, (req, res) => c.register(req, res));

export { adminOfficialDomainRoutes, adminRouteSourceRoutes };
