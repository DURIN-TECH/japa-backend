/**
 * Provider-agnostic email contract.
 *
 * Mirrors the billing-provider pattern: the rest of the app talks to this
 * interface, and a concrete provider (Resend today) implements it. Swap providers
 * by writing a sibling class — nothing else changes. Lives backend-only because
 * sending involves a secret API key + outbound HTTP (must never reach a client).
 */

/** A single outbound email. */
export interface EmailMessage {
  /** Recipient address. */
  to: string;
  subject: string;
  /** HTML body (required). */
  html: string;
  /** Optional plain-text fallback (improves deliverability). */
  text?: string;
  /** Optional Reply-To address. */
  replyTo?: string;
}

/** Outcome of a send attempt. */
export interface EmailResult {
  /**
   * - `sent`    — accepted by the provider.
   * - `failed`  — provider rejected / errored.
   * - `skipped` — no recipient, or the provider isn't configured (safe-rollout).
   */
  status: "sent" | "failed" | "skipped";
  /** Provider message id when sent. */
  providerId?: string;
  /** Error detail when failed/skipped. */
  error?: string;
}

/** Pluggable email provider. */
export interface EmailProvider {
  readonly name: string;
  /** True when the provider has everything it needs (API key, from address). */
  readonly isConfigured: boolean;
  send(message: EmailMessage): Promise<EmailResult>;
}
