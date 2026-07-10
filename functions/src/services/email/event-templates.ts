import { NotificationType } from "../../types";
import { EMAIL_BRANDING } from "./branding";

/**
 * Per-event email templates — the single registry that gives each notification type
 * its own subject line and call-to-action (label + deep link). The dynamic message
 * (title/body) still comes from the emitting call site; this layer frames it.
 *
 * Add or tweak an event's email in ONE place here — no call-site or template-engine
 * changes needed.
 */

/** Context passed from the notifier to resolve a per-event email. */
export interface EventEmailContext {
  title: string;
  body: string;
  /** Explicit deep link from the caller — wins over the template's path when set. */
  actionUrl?: string;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}

/** The subject + CTA resolved for a given event. */
export interface ResolvedEventEmail {
  subject: string;
  actionUrl: string;
  actionLabel: string;
}

interface EventTemplate {
  subject: string;
  actionLabel: string;
  /** Relative path (joined to APP_URL) for the CTA, derived from the context. */
  path?: (ctx: EventEmailContext) => string | undefined;
}

/** Deep-link to the case when the notification references an application. */
const casePath = (ctx: EventEmailContext): string =>
  ctx.relatedEntityType === "application" && ctx.relatedEntityId
    ? `/case-management/${ctx.relatedEntityId}`
    : "/dashboard";

/**
 * Deep-link to the admin agency-review page when the notification references an
 * agency (used for compliance_submitted, which fans out to admins). Falls back
 * to the agencies list if the id is missing.
 */
const agencyReviewPath = (ctx: EventEmailContext): string =>
  ctx.relatedEntityType === "agency" && ctx.relatedEntityId
    ? `/admin/agencies/${ctx.relatedEntityId}`
    : "/admin/agencies";

/**
 * Subject + CTA per event type. Keep subjects specific (they're what users scan in
 * their inbox) and CTAs action-oriented.
 */
const TEMPLATES: Partial<Record<NotificationType, EventTemplate>> = {
  application_update: {
    subject: "Your application status has changed",
    actionLabel: "View application",
    path: casePath,
  },
  application_created: {
    subject: "An application was started for you",
    actionLabel: "View application",
    path: casePath,
  },
  document_status: {
    subject: "Document update on your application",
    actionLabel: "View documents",
    path: casePath,
  },
  consultation_booking: {
    subject: "New consultation booking",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },
  consultation_reminder: {
    subject: "Reminder: your consultation is tomorrow",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },
  payment_request: {
    subject: "You have a new payment request",
    actionLabel: "Review request",
    path: casePath,
  },
  payment_received: {
    subject: "A payment was approved",
    actionLabel: "View case",
    path: casePath,
  },
  payment_request_rejected: {
    subject: "A payment request was rejected",
    actionLabel: "View case",
    path: casePath,
  },

  // Applications (assignment / withdrawal)
  application_assigned: {
    subject: "A case was assigned to you",
    actionLabel: "View case",
    path: casePath,
  },
  application_withdrawn: {
    subject: "An application was withdrawn",
    actionLabel: "View case",
    path: casePath,
  },

  // Documents
  document_uploaded: {
    subject: "A document was uploaded for review",
    actionLabel: "Review document",
    path: casePath,
  },
  document_approved: {
    subject: "Your document was approved",
    actionLabel: "View documents",
    path: casePath,
  },
  document_rejected: {
    subject: "Your document needs attention",
    actionLabel: "View documents",
    path: casePath,
  },

  // Consultations
  consultation_confirmed: {
    subject: "Your consultation is confirmed",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },
  consultation_rescheduled: {
    subject: "Your consultation was rescheduled",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },
  consultation_cancelled: {
    subject: "Your consultation was cancelled",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },
  consultation_completed: {
    subject: "Your consultation is complete",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },

  // Subscriptions / billing
  subscription_activated: {
    subject: "Your subscription is active",
    actionLabel: "Manage subscription",
    path: () => "/account-settings?tab=subscription",
  },
  subscription_renewed: {
    subject: "Your subscription renewed",
    actionLabel: "Manage subscription",
    path: () => "/account-settings?tab=subscription",
  },
  subscription_payment_failed: {
    subject: "Action needed: payment failed",
    actionLabel: "Update payment",
    path: () => "/account-settings?tab=subscription",
  },
  subscription_canceled: {
    subject: "Your subscription was canceled",
    actionLabel: "Resubscribe",
    path: () => "/account-settings?tab=subscription",
  },
  plan_changed: {
    subject: "Your plan was updated",
    actionLabel: "Manage subscription",
    path: () => "/account-settings?tab=subscription",
  },
  seats_added: {
    subject: "Agent seats added to your plan",
    actionLabel: "Manage agents",
    path: () => "/account-settings?tab=agencyProfile",
  },

  // Agency / agent lifecycle
  agent_invited: {
    subject: "You've been invited to join an agency on Seli",
    actionLabel: "Accept invitation",
    path: () => "/login",
  },
  invitation_accepted: {
    subject: "An agent accepted your invitation",
    actionLabel: "View agency",
    path: () => "/account-settings?tab=agencyProfile",
  },
  invitation_declined: {
    subject: "An agent declined your invitation",
    actionLabel: "View agency",
    path: () => "/account-settings?tab=agencyProfile",
  },
  agency_member_removed: {
    subject: "You were removed from an agency",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },
  agent_suspended: {
    subject: "Your access has been suspended",
    actionLabel: "View details",
    path: () => "/account-suspended",
  },
  agent_deactivated: {
    subject: "Your account has been deactivated",
    actionLabel: "View details",
    path: () => "/account-suspended",
  },
  agency_pending_review: {
    subject: "Your agency is awaiting approval",
    actionLabel: "View review status",
    path: () => "/pending-review",
  },
  agency_approved: {
    subject: "Your agency has been approved",
    actionLabel: "Go to dashboard",
    path: () => "/dashboard",
  },
  agency_rejected: {
    subject: "Update on your agency application",
    actionLabel: "View agency",
    path: () => "/account-settings?tab=agencyProfile",
  },

  // Compliance (agency KYC/KYB/payout)
  compliance_submitted: {
    // Sent to admins when an owner submits their compliance file for review.
    // CTA links straight to that agency's review page.
    subject: "An agency is ready for compliance review",
    actionLabel: "Review agency",
    path: agencyReviewPath,
  },
  compliance_approved: {
    subject: "Your agency is verified",
    actionLabel: "View agency",
    path: () => "/account-settings?tab=agencyProfile",
  },
  compliance_rejected: {
    subject: "Your agency compliance needs attention",
    actionLabel: "Update compliance",
    path: () => "/account-settings?tab=agencyProfile",
  },

  // Verification
  verification_approved: {
    subject: "Your verification was approved",
    actionLabel: "View verification",
    path: () => "/account-settings?tab=verification",
  },
  verification_rejected: {
    subject: "Your verification needs attention",
    actionLabel: "View verification",
    path: () => "/account-settings?tab=verification",
  },

  // Account / engagement
  welcome: {
    subject: "Welcome to Seli",
    actionLabel: "Get started",
    path: () => "/dashboard",
  },
  role_changed: {
    subject: "Your account access changed",
    actionLabel: "Open dashboard",
    path: () => "/dashboard",
  },
  review_received: {
    subject: "You received a new review",
    actionLabel: "View reviews",
    path: () => "/dashboard",
  },
};

/** Join a relative path to the configured app URL. */
function toUrl(path: string | undefined): string | undefined {
  return path ? `${EMAIL_BRANDING.appUrl}${path}` : undefined;
}

/**
 * Resolve the subject + CTA for an event. Falls back gracefully for unmapped types
 * (uses the notification title as subject and links to the app home).
 */
export function resolveEventEmail(
  type: NotificationType,
  ctx: EventEmailContext
): ResolvedEventEmail {
  const template = TEMPLATES[type];
  return {
    subject: template?.subject ?? ctx.title,
    actionLabel: template?.actionLabel ?? `Open ${EMAIL_BRANDING.appName}`,
    // Caller's explicit deep link wins; else the template's path; else app home.
    actionUrl: ctx.actionUrl ?? toUrl(template?.path?.(ctx)) ?? EMAIL_BRANDING.appUrl,
  };
}
