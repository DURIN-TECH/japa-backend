import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

// Route modules
import { userRoutes } from "./routes/user.routes";
import { countryRoutes, visaSearchRoutes } from "./routes/visa.routes";
import { agentRoutes } from "./routes/agent.routes";
import { agencyRoutes, invitationRoutes } from "./routes/agency.routes";
import { applicationRoutes } from "./routes/application.routes";
import { documentRoutes } from "./routes/document.routes";
import {
  eligibilityRoutes,
  adminEligibilityRoutes,
} from "./routes/eligibility.routes";
import { transactionRoutes } from "./routes/transaction.routes";
import { consultationRoutes } from "./routes/consultation.routes";
import { notificationRoutes } from "./routes/notification.routes";
import { paymentRequestRoutes } from "./routes/payment-request.routes";
import { messagingRoutes } from "./routes/messaging.routes";
import { devRoutes } from "./routes/dev.routes";

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

// Health check
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Mount route modules
app.use("/users", userRoutes);
app.use("/countries", countryRoutes);
app.use("/visas", visaSearchRoutes);
app.use("/agents", agentRoutes);
app.use("/agencies", agencyRoutes);
app.use("/invitations", invitationRoutes);
app.use("/applications", applicationRoutes);
app.use("/documents", documentRoutes);
app.use("/transactions", transactionRoutes);
app.use("/consultations", consultationRoutes);
app.use("/notifications", notificationRoutes);
app.use("/payment-requests", paymentRequestRoutes);
app.use("/conversations", messagingRoutes);
app.use("/eligibility", eligibilityRoutes);
app.use("/admin/eligibility", adminEligibilityRoutes);
app.use("/dev", devRoutes);

// Error handling
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
