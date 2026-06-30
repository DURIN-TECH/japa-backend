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
