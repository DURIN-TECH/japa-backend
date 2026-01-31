import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

// Controllers
import { userController } from "./controllers/user.controller";
import { visaController } from "./controllers/visa.controller";
import { agentController } from "./controllers/agent.controller";
import { applicationController } from "./controllers/application.controller";
import { documentController } from "./controllers/document.controller";

// Middleware
import { verifyAuth, verifyAdmin } from "./middleware/auth";

// Create Express app
const app = express();

// Middleware
app.use(cors({ origin: true }));
app.use(express.json());

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================
// USER ROUTES
// ============================================
app.get("/users/me", verifyAuth, (req, res) => userController.getMe(req, res));
app.put("/users/me", verifyAuth, (req, res) =>
  userController.updateMe(req, res)
);
app.delete("/users/me", verifyAuth, (req, res) =>
  userController.deleteMe(req, res)
);

app.post("/users/onboarding", verifyAuth, (req, res) =>
  userController.completeOnboarding(req, res)
);
app.get("/users/onboarding/status", verifyAuth, (req, res) =>
  userController.getOnboardingStatus(req, res)
);

app.post("/users/fcm-token", verifyAuth, (req, res) =>
  userController.registerFcmToken(req, res)
);
app.delete("/users/fcm-token", verifyAuth, (req, res) =>
  userController.removeFcmToken(req, res)
);

app.post("/users/login", verifyAuth, (req, res) =>
  userController.recordLogin(req, res)
);

// ============================================
// COUNTRY & VISA ROUTES
// ============================================

// Countries
app.get("/countries", (req, res) => visaController.getCountries(req, res));
app.get("/countries/:code", (req, res) => visaController.getCountry(req, res));
app.post("/countries", verifyAuth, verifyAdmin, (req, res) =>
  visaController.createCountry(req, res)
);

// Visa Types
app.get("/countries/:code/visas", (req, res) =>
  visaController.getVisaTypes(req, res)
);
app.get("/countries/:code/visas/:visaId", (req, res) =>
  visaController.getVisaType(req, res)
);
app.get("/countries/:code/visas/:visaId/full", (req, res) =>
  visaController.getVisaTypeWithRequirements(req, res)
);
app.post("/countries/:code/visas", verifyAuth, verifyAdmin, (req, res) =>
  visaController.createVisaType(req, res)
);

// Requirements
app.get("/countries/:code/visas/:visaId/requirements", (req, res) =>
  visaController.getRequirements(req, res)
);
app.post(
  "/countries/:code/visas/:visaId/requirements",
  verifyAuth,
  verifyAdmin,
  (req, res) => visaController.createRequirement(req, res)
);

// All Visas & Search
app.get("/visas", (req, res) => visaController.getAllVisaTypes(req, res));
app.get("/visas/search", (req, res) =>
  visaController.searchVisaTypes(req, res)
);
app.get("/visas/popular", (req, res) =>
  visaController.getPopularVisaTypes(req, res)
);

// ============================================
// AGENT ROUTES
// ============================================

// Public agent endpoints
app.get("/agents", (req, res) => agentController.getAgents(req, res));
app.get("/agents/top", (req, res) => agentController.getTopAgents(req, res));
app.get("/agents/visa/:visaTypeId", (req, res) =>
  agentController.getAgentsForVisaType(req, res)
);
app.get("/agents/:id", (req, res) => agentController.getAgent(req, res));
app.get("/agents/:id/reviews", (req, res) =>
  agentController.getAgentReviews(req, res)
);

// Authenticated agent endpoints
app.post("/agents", verifyAuth, (req, res) =>
  agentController.createAgent(req, res)
);
app.get("/agents/me", verifyAuth, (req, res) =>
  agentController.getMyAgentProfile(req, res)
);
app.put("/agents/me", verifyAuth, (req, res) =>
  agentController.updateMyAgentProfile(req, res)
);
app.put("/agents/me/availability", verifyAuth, (req, res) =>
  agentController.updateAvailability(req, res)
);
app.put("/agents/me/slots", verifyAuth, (req, res) =>
  agentController.updateAvailableSlots(req, res)
);

// Reviews
app.post("/agents/:id/reviews", verifyAuth, (req, res) =>
  agentController.addReview(req, res)
);

// Admin endpoints
app.put("/agents/:id/verification", verifyAuth, verifyAdmin, (req, res) =>
  agentController.updateVerificationStatus(req, res)
);

// ============================================
// APPLICATION ROUTES
// ============================================

// Application CRUD
app.post("/applications", verifyAuth, (req, res) =>
  applicationController.createApplication(req, res)
);
app.get("/applications", verifyAuth, (req, res) =>
  applicationController.getApplications(req, res)
);
app.get("/applications/:id", verifyAuth, (req, res) =>
  applicationController.getApplication(req, res)
);
app.put("/applications/:id", verifyAuth, (req, res) =>
  applicationController.updateApplication(req, res)
);
app.delete("/applications/:id", verifyAuth, (req, res) =>
  applicationController.deleteApplication(req, res)
);

// Application status & timeline
app.put("/applications/:id/status", verifyAuth, (req, res) =>
  applicationController.updateStatus(req, res)
);
app.get("/applications/:id/timeline", verifyAuth, (req, res) =>
  applicationController.getTimeline(req, res)
);

// Application documents
app.get("/applications/:applicationId/documents", verifyAuth, (req, res) =>
  documentController.getApplicationDocuments(req, res)
);

// ============================================
// DOCUMENT ROUTES
// ============================================

// Get signed upload URL
app.post("/documents/upload-url", verifyAuth, (req, res) =>
  documentController.getUploadUrl(req, res)
);

// Document CRUD
app.post("/documents", verifyAuth, (req, res) =>
  documentController.createDocument(req, res)
);
app.get("/documents/:id", verifyAuth, (req, res) =>
  documentController.getDocument(req, res)
);
app.get("/documents/:id/download", verifyAuth, (req, res) =>
  documentController.getDownloadUrl(req, res)
);
app.delete("/documents/:id", verifyAuth, (req, res) =>
  documentController.deleteDocument(req, res)
);

// Document status (for agents)
app.put("/documents/:id/status", verifyAuth, (req, res) =>
  documentController.updateDocumentStatus(req, res)
);

// ============================================
// ERROR HANDLING
// ============================================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: "INTERNAL_ERROR",
    message: "An unexpected error occurred",
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

export { app };
