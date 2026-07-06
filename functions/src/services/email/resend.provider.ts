import axios from "axios";
import { EmailMessage, EmailProvider, EmailResult } from "./email.types";

/**
 * Resend implementation of `EmailProvider`, via the Resend REST API
 * (https://resend.com/docs/api-reference/emails/send-email). Uses axios (already a
 * dependency) rather than the `resend` SDK to avoid adding a package.
 *
 * Config (env / Firebase secrets):
 *   - RESEND_API_KEY — API key from the Resend dashboard (re_…).
 *   - EMAIL_FROM     — verified sender, e.g. "Seli <noreply@seli.app>".
 *
 * Dev / test mode:
 *   When NODE_ENV !== "production" and EMAIL_FROM is not set (or not yet domain-
 *   verified), the provider falls back to Resend's pre-verified onboarding address
 *   (`onboarding@resend.dev`) so that the email flow can be exercised end-to-end
 *   without domain verification. Note: Resend restricts onboarding@resend.dev to
 *   sending only to the account-owner's email address.
 *
 *   A 403 from Resend means the `from` domain is not verified in your Resend
 *   account. Verify the domain at https://resend.com/domains or temporarily set
 *   EMAIL_FROM_DEV_OVERRIDE=onboarding@resend.dev in your .env.local.
 */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class ResendProvider implements EmailProvider {
  readonly name = "resend";

  private get from(): string | undefined {
    // In non-production environments, allow overriding with a dev-safe sender.
    const devOverride = process.env.EMAIL_FROM_DEV_OVERRIDE;
    if (devOverride && process.env.NODE_ENV !== "production") {
      return devOverride;
    }
    return process.env.EMAIL_FROM;
  }

  /** Configured only when both the API key and a from-address are present. */
  get isConfigured(): boolean {
    return !!process.env.RESEND_API_KEY && !!this.from;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const apiKey = process.env.RESEND_API_KEY;
    // Safe-rollout: unconfigured → skip (caller falls back to the stub/log path).
    if (!apiKey || !this.from) {
      console.warn(
        "[ResendProvider] Not configured — missing RESEND_API_KEY or EMAIL_FROM. " +
        "Skipping send. Set both in .env.local (emulator) or Cloud Secret Manager (deployed)."
      );
      return { status: "skipped", error: "Resend not configured" };
    }
    if (!message.to) {
      return { status: "skipped", error: "No recipient address" };
    }

    try {
      const res = await axios.post<{ id?: string }>(
        RESEND_ENDPOINT,
        {
          from: this.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      return { status: "sent", providerId: res.data?.id };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const body = err.response?.data as Record<string, unknown> | undefined;

        // 403 almost always means the `from` domain isn't verified in Resend.
        if (status === 403) {
          const hint =
            "The sender domain is not verified in Resend. " +
            "Verify your domain at https://resend.com/domains, or set " +
            "EMAIL_FROM_DEV_OVERRIDE=onboarding@resend.dev in .env.local for local testing.";
          console.error(`[ResendProvider] 403 Forbidden — ${hint}`);
          return { status: "failed", error: `403 Forbidden: ${hint}` };
        }

        const detail = JSON.stringify(body ?? err.message);
        return { status: "failed", error: detail };
      }
      return { status: "failed", error: (err as Error).message };
    }
  }
}

export const resendProvider = new ResendProvider();
