import { EmailMessage, EmailProvider, EmailResult } from "./email.types";
import { resendProvider } from "./resend.provider";
import {
  NotificationEmailOptions,
  renderNotificationEmail,
  renderNotificationText,
} from "./templates";
import { AgencyBrandLookup, resolveAgencyBrand } from "./agency-brand";

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
   *
   * CO-BRANDING: pass `brandFor` (what you know about the recipient — uid, the
   * case the email is about, or just the address) and the service resolves the
   * agency whose logo sits beside Seli's in the header. Call sites that already
   * hold the brand can pass `agency` directly instead; an explicit `agency`
   * always wins. Omit both and the email renders with the Seli mark alone, as
   * before. Resolution is fail-soft — it never blocks or fails a send.
   */
  async sendNotification(
    opts: NotificationEmailOptions & {
      to: string;
      subject: string;
      /** Recipient context used to look up the co-branding agency. */
      brandFor?: AgencyBrandLookup;
    }
  ): Promise<EmailResult> {
    // `agency === undefined` means "not resolved yet"; `null` is a deliberate
    // "no co-brand", so only the former triggers a lookup.
    const agency =
      opts.agency !== undefined
        ? opts.agency
        : opts.brandFor
          ? await resolveAgencyBrand({ email: opts.to, ...opts.brandFor })
          : null;

    const rendered = { ...opts, agency };

    return this.send({
      to: opts.to,
      subject: opts.subject,
      html: renderNotificationEmail(rendered),
      text: renderNotificationText(rendered),
    });
  }
}

export const emailService = new EmailService();
