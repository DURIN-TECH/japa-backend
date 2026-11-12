import { EmailMessage, EmailProvider, EmailResult } from "./email.types";
import { resendProvider } from "./resend.provider";
import {
  NotificationEmailOptions,
  renderNotificationEmail,
  renderNotificationText,
} from "./templates";
import { AgencyBrandLookup, resolveAgencyBrand } from "./agency-brand";

/**
 * `EmailResult.error` used when local sending is deliberately suppressed. Exported
 * so callers (e.g. the auth controller's logging) can tell a deliberate local
 * suppression apart from a provider that is missing its secrets.
 */
export const LOCAL_SUPPRESSED_REASON = "Local email sending disabled (EMAIL_SENDING_ENABLED is not true)";

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

  /**
   * LOCAL EMAIL SWITCH (issue #157) — the ONE place `EMAIL_SENDING_ENABLED` is read.
   *
   * Under the Firebase emulator the real RESEND_API_KEY is fetched from Secret
   * Manager (it is bound in `src/index.ts`), so a local run would otherwise send
   * REAL emails to real recipients. To prevent that, local sends are suppressed
   * unless the developer opts in with `EMAIL_SENDING_ENABLED=true` (exactly that
   * string) in `functions/.env.local`.
   *
   * Outside the emulator (`FUNCTIONS_EMULATOR !== "true"`) the switch is ignored
   * entirely, so deployed environments can never be switched off by it.
   */
  private get suppressedLocally(): boolean {
    return (
      process.env.FUNCTIONS_EMULATOR === "true" &&
      process.env.EMAIL_SENDING_ENABLED !== "true"
    );
  }

  /**
   * True when the active provider is ready to actually send. Reports false while
   * local sending is suppressed so `notification.service.ts` takes its quiet
   * "stubbed" path instead of attempting a send.
   */
  get isConfigured(): boolean {
    if (this.suppressedLocally) return false;
    return this.provider.isConfigured;
  }

  /**
   * Send a raw email message. While suppressed locally this makes NO network call:
   * it logs one "would send" line (recipient + subject only, never the body) and
   * returns `skipped`.
   */
  async send(message: EmailMessage): Promise<EmailResult> {
    if (this.suppressedLocally) {
      console.info(
        "[EmailService] Local email sending is off (set EMAIL_SENDING_ENABLED=true in " +
          `functions/.env.local to enable) — would send to ${message.to}: "${message.subject}"`
      );
      return { status: "skipped", error: LOCAL_SUPPRESSED_REASON };
    }
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
