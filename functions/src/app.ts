import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

// Route modules
import { userRoutes } from "./routes/user.routes";
import { countryRoutes, visaSearchRoutes, adminVisaRoutes } from "./routes/visa.routes";
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
import { newsRoutes } from "./routes/news.routes";
import { bankAccountRoutes } from "./routes/bank-account.routes";
import { onboardingRoutes } from "./routes/onboarding.routes";
import { analyticsRoutes } from "./routes/analytics.routes";

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
app.use("/bank-accounts", bankAccountRoutes);
app.use("/onboarding", onboardingRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/news", newsRoutes);
app.use("/eligibility", eligibilityRoutes);
app.use("/admin/eligibility", adminEligibilityRoutes);
app.use("/admin/visas", adminVisaRoutes);

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
