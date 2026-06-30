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
  application_update: FULL,
  application_created: FULL,
  document_status: FULL,
  consultation_booking: FULL,
  consultation_reminder: FULL,
  payment_received: FULL,
  payment_request: FULL,
  payment_request_rejected: FULL,
  message_received: APP_ONLY, // chat — in-app/push only
  visa_news: APP_ONLY,
  system: APP_ONLY,
};

/** Default delivery channels for a notification type (falls back to in-app + push). */
export function channelsForType(type: NotificationType): NotificationChannel[] {
  return DEFAULT_CHANNELS_BY_TYPE[type] ?? APP_ONLY;
}
