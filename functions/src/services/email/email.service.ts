import { EmailMessage, EmailProvider, EmailResult } from "./email.types";
import { resendProvider } from "./resend.provider";
import {
  NotificationEmailOptions,
  renderNotificationEmail,
  renderNotificationText,
} from "./templates";

/**
 * Email service — a provider-agnostic façade over the configured email provider.
 * Callers use `sendNotification()` for the standard branded template, or `send()`
 * for a raw message. The provider is selected by `EMAIL_PROVIDER` (default resend);
 * branding + layout live in `branding.ts` / `templates.ts`.
 */
class EmailService {
  private readonly providers: Record<string, EmailProvider> = {
    resend: resendProvider,
  };

  /** The active provider (env-overridable; falls back to Resend). */
  get provider(): EmailProvider {
    const name = process.env.EMAIL_PROVIDER || "resend";
    return this.providers[name] ?? resendProvider;
  }

  /** True when the active provider is ready to actually send. */
  get isConfigured(): boolean {
    return this.provider.isConfigured;
  }

  /** Send a raw email message. */
  async send(message: EmailMessage): Promise<EmailResult> {
    return this.provider.send(message);
  }

  /**
   * Send a notification email using the standard branded template. `subject` is the
   * email subject line; `title`/`body`/`actionUrl` feed the shared template.
   */
  async sendNotification(
    opts: NotificationEmailOptions & { to: string; subject: string }
  ): Promise<EmailResult> {
    return this.send({
      to: opts.to,
      subject: opts.subject,
      html: renderNotificationEmail(opts),
      text: renderNotificationText(opts),
    });
  }
}

export const emailService = new EmailService();
