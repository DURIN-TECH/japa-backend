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
 */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class ResendProvider implements EmailProvider {
  readonly name = "resend";

  private get from(): string | undefined {
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
      // Surface the provider's error body when available for easier debugging.
      const detail = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data ?? err.message)
        : (err as Error).message;
      return { status: "failed", error: detail };
    }
  }
}

export const resendProvider = new ResendProvider();
