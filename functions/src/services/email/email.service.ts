import { EmailMessage, EmailProvider, EmailResult } from "./email.types";
import { resendProvider } from "./resend.provider";

/**
 * Email service — a provider-agnostic façade over the configured email provider.
 * Callers use `sendNotification()` for the standard branded template, or `send()`
 * for a raw message. The provider is selected by `EMAIL_PROVIDER` (default resend).
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
   * Send a notification email using the standard branded template. Title/body map
   * straight from the in-app notification, with an optional call-to-action button.
   */
  async sendNotification(opts: {
    to: string;
    subject: string;
    title: string;
    body: string;
    actionUrl?: string;
    actionLabel?: string;
  }): Promise<EmailResult> {
    const html = renderNotificationEmail(opts);
    const text =
      `${opts.title}\n\n${opts.body}` +
      (opts.actionUrl ? `\n\n${opts.actionLabel ?? "Open Seli"}: ${opts.actionUrl}` : "");
    return this.send({ to: opts.to, subject: opts.subject, html, text });
  }
}

/** Escape user-controlled strings before interpolating into the HTML template. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Minimal, table-based branded HTML email (table layout = best client support).
 * Kept inline-styled for the same reason — email clients strip <style> blocks.
 */
function renderNotificationEmail(opts: {
  title: string;
  body: string;
  actionUrl?: string;
  actionLabel?: string;
}): string {
  const title = escapeHtml(opts.title);
  const body = escapeHtml(opts.body).replace(/\n/g, "<br/>");
  const brand = "#1D5CDD";
  const cta =
    opts.actionUrl && /^https?:\/\//i.test(opts.actionUrl)
      ? `<tr><td style="padding:8px 0 0;">
           <a href="${escapeHtml(opts.actionUrl)}"
              style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;
                     font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">
             ${escapeHtml(opts.actionLabel ?? "Open Seli")}
           </a></td></tr>`
      : "";

  return `<!DOCTYPE html>
<html><body style="margin:0;background:#F6F8FB;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F8FB;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E8EDF3;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:22px 28px;border-bottom:1px solid #EEF2F7;">
          <span style="font-size:18px;font-weight:700;color:${brand};letter-spacing:0.2px;">Seli</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:18px;font-weight:600;color:#1A2433;padding-bottom:10px;">${title}</td></tr>
            <tr><td style="font-size:14px;line-height:22px;color:#4A5568;">${body}</td></tr>
            ${cta}
          </table>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #EEF2F7;font-size:12px;color:#94A3B8;">
          You're receiving this because you have a Seli account.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export const emailService = new EmailService();
