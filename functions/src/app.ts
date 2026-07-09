import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

// Route modules
import { authRoutes } from "./routes/auth.routes";
import { userRoutes, adminUsersRouter } from "./routes/user.routes";
import { countryRoutes, visaSearchRoutes, adminVisaRoutes } from "./routes/visa.routes";
import { agentRoutes } from "./routes/agent.routes";
import { agencyRoutes, invitationRoutes } from "./routes/agency.routes";
import { applicationRoutes } from "./routes/application.routes";
import { documentRoutes } from "./routes/document.routes";
// Document templates feature (rich-text templates + editable case-linked instances)
import { documentTemplateRoutes } from "./routes/document-template.routes";
import { documentInstanceRoutes } from "./routes/document-instance.routes";
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
import {
  plansRouter,
  subscriptionsRouter,
  adminPlansRouter,
  webhooksRouter,
} from "./routes/entitlement.routes";
import { verificationWebhookRoutes } from "./routes/verification-webhook.routes";

// Create Express app
const app = express();

// Middleware
app.use(cors({
  origin: true
  // TODO: In production, set this to our portal and mobile URL and remove the wildcard origin
}));
// Provider webhooks must read the RAW body to verify signatures, so mount them
// BEFORE the global JSON parser consumes the stream.
app.use("/webhooks", webhooksRouter);
// Verification provider async results (document/liveness) — also raw-body + HMAC.
app.use("/webhooks", verificationWebhookRoutes);
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
// Public auth flows (forgot-password) — no verifyAuth (user isn't signed in).
app.use("/auth", authRoutes);
app.use("/agents", agentRoutes);
app.use("/agencies", agencyRoutes);
app.use("/invitations", invitationRoutes);
app.use("/applications", applicationRoutes);
app.use("/documents", documentRoutes);
// Document templates: catalog (read-only) + editable instances cloned from them
app.use("/document-templates", documentTemplateRoutes);
app.use("/document-instances", documentInstanceRoutes);
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
app.use("/plans", plansRouter);
app.use("/subscriptions", subscriptionsRouter);
app.use("/admin/plans", adminPlansRouter);
app.use("/admin/users", adminUsersRouter);

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
