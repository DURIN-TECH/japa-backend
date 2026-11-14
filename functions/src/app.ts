import express, { Request, Response, NextFunction } from "express";
import cors from "cors";

// Route modules
import { authRoutes } from "./routes/auth.routes";
import { userRoutes, adminUsersRouter } from "./routes/user.routes";
import { countryRoutes, visaSearchRoutes, adminVisaRoutes } from "./routes/visa.routes";
// Proposed edits to approved scraped visas (pendingVisaChanges, issue #61)
import { adminVisaChangeRoutes } from "./scrapers";
// Scraper run records + source health (issue #81, CASL `ScrapeRun`).
import { adminScrapeCostRoutes, adminScrapeRunRoutes, adminScrapeSourceRoutes } from "./scrapers";
// Scraper alerts: list / acknowledge / resolve (issue #83)
import { adminScrapeAlertRoutes } from "./scrapers";
// Scraper settings, per-source controls and manual "Run now" (issue #96).
import {
  adminScrapeRunRequestRoutes,
  adminScrapeSourceControlRoutes,
  adminScraperRunRoutes,
  adminScraperSettingsRoutes,
} from "./scrapers";
// Caseworker-guidance source registry: admin list (issue #39).
import { adminGuidanceSourceRoutes } from "./scrapers";
// Source registry API (issue #215): confirmed hosts + route registration.
import { adminOfficialDomainRoutes, adminRouteSourceRoutes } from "./scrapers";
// Rubric review (issue #125): admin queue, detail with diff, approve / reject.
import { adminRubricRoutes } from "./routes/rubric-review.routes";
// Published outcome statistics imports: admin run list + Run now (issue #116).
import { adminOutcomeStatisticsRoutes } from "./scrapers";
// Agency-scoped visa drafts / edits / submit (issue #100).
import { agencyVisaRoutes } from "./agency-visas";
// Agency per-visa service prices, in whole naira (issue #103).
import { agencyVisaPriceRoutes } from "./agency-visa-prices";
import { agentRoutes } from "./routes/agent.routes";
import { agencyRoutes, invitationRoutes } from "./routes/agency.routes";
import { applicationRoutes } from "./routes/application.routes";
import { documentRoutes } from "./routes/document.routes";
// Document templates feature (rich-text templates + editable case-linked instances)
import { documentTemplateRoutes } from "./routes/document-template.routes";
import { documentInstanceRoutes } from "./routes/document-instance.routes";
// Durable agent→client document asks (backs the client web workspace to-do list)
import { checklistRoutes } from "./routes/checklist.routes";
import { documentRequestRoutes } from "./routes/document-request.routes";
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
import { aiRoutes } from "./routes/ai.routes";
import {
  plansRouter,
  subscriptionsRouter,
  adminPlansRouter,
  webhooksRouter,
} from "./routes/entitlement.routes";
// Public exchange rates + admin rate overrides (issue #178).
import { publicRatesRoutes, adminExchangeRateRoutes } from "./routes/exchange-rate.routes";
import { verificationWebhookRoutes } from "./routes/verification-webhook.routes";
// Admin review queue for trafficking / scam risk signals (issue #119).
import { adminRiskSignalRoutes } from "./routes/risk-signal.routes";

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
// Agency visas (issue #100): the caller's OWN agency's visas. Singular
// "/agency" = "my agency" (the agency comes from the token, never the URL).
app.use("/agency/visas", agencyVisaRoutes);
// Agency per-visa service prices (issue #103): the caller's OWN agency's
// prices (agency from the token). Contract: src/agency-visa-prices/agency-visa-prices.md.
app.use("/agency/visa-prices", agencyVisaPriceRoutes);
app.use("/invitations", invitationRoutes);
// Personal document checklist (issue #114): extra-segment paths on /applications.
app.use("/applications", checklistRoutes);
app.use("/applications", applicationRoutes);
app.use("/documents", documentRoutes);
// Document templates: catalog (read-only) + editable instances cloned from them
app.use("/document-templates", documentTemplateRoutes);
app.use("/document-instances", documentInstanceRoutes);
app.use("/document-requests", documentRequestRoutes);
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
// AI case-officer assessments (issue #42): async jobs, tier decided in the handler.
app.use("/ai", aiRoutes);
app.use("/admin/eligibility", adminEligibilityRoutes);
app.use("/admin/visas", adminVisaRoutes);
// Admin queue of proposed edits to live scraped visas (CASL `VisaChange`).
app.use("/admin/visa-changes", adminVisaChangeRoutes);
// Admin-only review queue for trafficking / scam risk signals (issue #119).
// Signals are raised by backend code, never through HTTP; this mount only
// lists, reads and records an admin decision.
app.use("/admin/risk-signals", adminRiskSignalRoutes);
// Scraper monitoring (issue #81): run records + per-source health (CASL `ScrapeRun`).
app.use("/admin/scrape-runs", adminScrapeRunRoutes);
app.use("/admin/scrape-sources", adminScrapeSourceRoutes);
// Issue #96: per-source edits + Run now on the same path (PATCH /:kind/:id,
// POST /:kind/:id/run; the #81 router above only serves GET /).
app.use("/admin/scrape-sources", adminScrapeSourceControlRoutes);
// Issue #96: settings (read = `read ScrapeRun`, edits / runs = `update ScrapeRun`).
app.use("/admin/scraper-settings", adminScraperSettingsRoutes);
app.use("/admin/scrapers", adminScraperRunRoutes);
app.use("/admin/scrape-run-requests", adminScrapeRunRequestRoutes);
// Scraper alerts (issue #83): read = CASL `read ScrapeRun`, ack/resolve = `update ScrapeRun`.
app.use("/admin/scrape-alerts", adminScrapeAlertRoutes);
// Scraping cost report from the monthly rollup (issue #82; CASL `ScrapeRun`).
app.use("/admin/scrape-costs", adminScrapeCostRoutes);
// Caseworker-guidance source registry (issue #39): read-only admin list
// (CASL `read ScrapeRun`, admin-only). No route serves snapshot text.
app.use("/admin/guidance-sources", adminGuidanceSourceRoutes);
// Issue #215: admin-only (verifyAuth + the ScrapeRun admin gate on every route).
app.use("/admin/official-domains", adminOfficialDomainRoutes);
app.use("/admin/route-sources", adminRouteSourceRoutes);
// Rubric review (issue #125): admin-only (verifyAuth + admin gate on every
// route). The only routes that read an unapproved rubric version.
app.use("/admin/rubrics", adminRubricRoutes);
// Outcome statistics imports (issue #116): admin-only run records + manual run.
app.use("/admin/outcome-statistics", adminOutcomeStatisticsRoutes);
// Public, unauthenticated, cacheable local-currency rates (issue #178).
app.use("/rates", publicRatesRoutes);
// Admin-only rate overrides + audit history (issue #178).
app.use("/admin/exchange-rates", adminExchangeRateRoutes);
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
