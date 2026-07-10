import { NotificationChannel, NotificationType } from "../types";

/**
 * Notification channel policy — the single place that decides which channels each
 * notification type fans out to by default. Call sites should NOT hardcode channel
 * arrays; they call `notifyUser` and let this policy choose (or pass an explicit
 * override when the user picked channels themselves).
 *
 * To add/remove email for an event, flip its entry here — one line, one place.
 */

/** Transactional events worth an email (plus in-app + push). */
const FULL: NotificationChannel[] = ["in_app", "push", "email"];
/** Ephemeral/high-frequency events — in-app + push only (email would be noisy). */
const APP_ONLY: NotificationChannel[] = ["in_app", "push"];

export const DEFAULT_CHANNELS_BY_TYPE: Record<NotificationType, NotificationChannel[]> = {
  // Applications
  application_update: FULL,
  application_created: FULL,
  application_assigned: FULL,
  application_withdrawn: FULL,
  // Documents
  document_status: FULL,
  document_uploaded: FULL,
  document_approved: FULL,
  document_rejected: FULL,
  // Consultations
  consultation_booking: FULL,
  consultation_reminder: FULL,
  consultation_confirmed: FULL,
  consultation_rescheduled: FULL,
  consultation_cancelled: FULL,
  consultation_completed: FULL,
  // Payments
  payment_received: FULL,
  payment_request: FULL,
  payment_request_rejected: FULL,
  // Subscriptions / billing
  subscription_activated: FULL,
  subscription_renewed: FULL,
  subscription_payment_failed: FULL,
  subscription_canceled: FULL,
  plan_changed: FULL,
  seats_added: FULL,
  // Agency / agent lifecycle
  agent_invited: FULL,
  invitation_accepted: FULL,
  invitation_declined: FULL,
  agency_member_removed: FULL,
  agent_suspended: FULL,
  agent_deactivated: FULL,
  agency_pending_review: FULL,
  agency_approved: FULL,
  agency_rejected: FULL,
  // Verification
  verification_approved: FULL,
  verification_rejected: FULL,
  // Compliance (agency KYC/KYB/payout) — transactional, worth an email
  compliance_submitted: FULL,
  compliance_approved: FULL,
  compliance_rejected: FULL,
  // Account / engagement
  welcome: FULL,
  role_changed: FULL,
  review_received: FULL,
  // Other — in-app/push only (email would be noisy)
  message_received: APP_ONLY,
  visa_news: APP_ONLY,
  system: APP_ONLY,
};

/** Default delivery channels for a notification type (falls back to in-app + push). */
export function channelsForType(type: NotificationType): NotificationChannel[] {
  return DEFAULT_CHANNELS_BY_TYPE[type] ?? APP_ONLY;
}
