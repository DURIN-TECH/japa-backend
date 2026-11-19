// ============================================
// Agency visas: routes (issue #100), mounted at /agency/visas in app.ts
// ============================================
//
// `verifyAuth` on every route: 401 without a valid token, 402 for writes on a
// read-only (lapsed) plan. The controller then gates on the shared CASL
// ability (403) — no role middleware here. Contract: ./agency-visas.md.

import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { agencyVisaController } from "./agency-visa.controller";

const agencyVisaRoutes = Router();

// List this agency's visas.
agencyVisaRoutes.get("/", verifyAuth, (req, res) => agencyVisaController.list(req, res));
// Create a draft.
agencyVisaRoutes.post("/", verifyAuth, (req, res) => agencyVisaController.create(req, res));
// One visa (+ pending revision).
agencyVisaRoutes.get("/:id", verifyAuth, (req, res) => agencyVisaController.get(req, res));
// Edit (PUT and PATCH behave the same: partial merge).
agencyVisaRoutes.put("/:id", verifyAuth, (req, res) => agencyVisaController.update(req, res));
agencyVisaRoutes.patch("/:id", verifyAuth, (req, res) => agencyVisaController.update(req, res));
// Submit for review.
agencyVisaRoutes.post("/:id/submit", verifyAuth, (req, res) => agencyVisaController.submit(req, res));
// Delete a never-submitted draft.
agencyVisaRoutes.delete("/:id", verifyAuth, (req, res) => agencyVisaController.remove(req, res));

export { agencyVisaRoutes };
