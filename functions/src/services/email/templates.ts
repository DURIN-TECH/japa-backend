import { EMAIL_BRANDING } from "./branding";
import type { AgencyBrand } from "./agency-brand";

/**
 * Email templates — pure, layout-only render functions. All brand values come from
 * `EMAIL_BRANDING`; callers pass content only. Table-based + inline-styled on
 * purpose: that's the only thing that renders consistently across email clients
 * (Gmail/Outlook strip <style> blocks and ignore flexbox/grid).
 */

export interface NotificationEmailOptions {
  /** Headline (e.g. the notification title). */
  title: string;
  /** Body copy. `\n` becomes a line break. */
  body: string;
  /** Optional CTA button link (must be http(s) to render). */
  actionUrl?: string;
  /** CTA button label. */
  actionLabel?: string;
  /** Short inbox-preview text (hidden in the rendered email). */
  preheader?: string;
  /**
   * Agency to co-brand this email with — its logo renders beside Seli's in the
   * header. Resolved per recipient by `resolveAgencyBrand`. Omit (or pass null)
   * when there is no agency or it has no logo: the header then falls back to the
   * Seli mark alone.
   */
  agency?: AgencyBrand | null;
}

/** Escape user-controlled strings before interpolating into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the email header's logo row.
 *
 * With an agency: the agency's mark sits on the left, a hairline divider, then
 * the Seli mark — the email is from the agency, delivered on Seli. Without one
 * (no agency, no uploaded logo, or a failed lookup) it degrades to the centred
 * Seli mark alone.
 *
 * Built as a nested `<table>` rather than flexbox because Outlook ignores modern
 * layout entirely; `valign="middle"` on the cells is what actually aligns two
 * logos of differing aspect ratios. The agency logo is height-capped AND
 * width-capped so a wide banner-style upload can't blow out the 560px shell.
 */
function renderLogoHeader(agency: AgencyBrand | null | undefined): string {
  const { appName, logoUrl, appUrl } = EMAIL_BRANDING;

  const seliMark = `<a href="${escapeHtml(appUrl)}" style="text-decoration:none;">
      <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(appName)}" height="28"
           style="display:block;height:28px;width:auto;border:0;outline:none;text-decoration:none;"/>
    </a>`;

  // No co-brand — the original single, centred logo.
  if (!agency) return seliMark;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr>
      <!-- Agency mark -->
      <td valign="middle" style="padding-right:14px;">
        <img src="${escapeHtml(agency.logoUrl)}" alt="${escapeHtml(agency.name)}" height="28"
             style="display:block;height:28px;width:auto;max-width:150px;border:0;outline:none;"/>
      </td>
      <!-- Hairline divider between the two marks -->
      <td valign="middle" style="width:1px;background:#D6DEE9;font-size:0;line-height:0;">
        <div style="width:1px;height:24px;font-size:0;line-height:0;">&nbsp;</div>
      </td>
      <!-- Seli mark -->
      <td valign="middle" style="padding-left:14px;">${seliMark}</td>
    </tr>
  </table>`;
}

/** Render the branded HTML notification email. */
export function renderNotificationEmail(opts: NotificationEmailOptions): string {
  // `logoUrl`/`appUrl` are consumed by `renderLogoHeader`, not here.
  const { appName, brandColor, supportEmail } = EMAIL_BRANDING;

  const title = escapeHtml(opts.title);
  const body = escapeHtml(opts.body).replace(/\n/g, "<br/>");
  const preheader = escapeHtml(opts.preheader ?? opts.title);

  const cta =
    opts.actionUrl && /^https?:\/\//i.test(opts.actionUrl)
      ? `<tr><td style="padding:24px 0 4px;">
           <a href="${escapeHtml(opts.actionUrl)}"
              style="display:inline-block;background:${brandColor};color:#ffffff;text-decoration:none;
                     font-weight:600;font-size:15px;line-height:1;padding:14px 26px;border-radius:10px;">
             ${escapeHtml(opts.actionLabel ?? `Open ${appName}`)}
           </a></td></tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#EEF2F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <!-- Hidden inbox preview text -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF2F8;padding:36px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">

        <!-- Logos: the agency's mark beside Seli's (Seli alone when unbranded) -->
        <tr><td align="center" style="padding-bottom:20px;">
          ${renderLogoHeader(opts.agency)}
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#ffffff;border:1px solid #E4EAF2;border-radius:16px;overflow:hidden;
                       box-shadow:0 1px 2px rgba(16,24,40,0.04);">
          <!-- Brand accent bar -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="height:4px;background:${brandColor};font-size:0;line-height:0;">&nbsp;</td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:32px 36px 36px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="font-size:20px;font-weight:700;color:#101828;padding-bottom:12px;line-height:1.35;">
                  ${title}
                </td></tr>
                <tr><td style="font-size:15px;line-height:24px;color:#475467;">
                  ${body}
                </td></tr>
                ${cta}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 36px 4px;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#98A2B3;">
            You're receiving this because you have a ${escapeHtml(appName)} account.
          </p>
          <p style="margin:0;font-size:12px;line-height:18px;color:#98A2B3;">
            Need help? <a href="mailto:${escapeHtml(supportEmail)}" style="color:${brandColor};text-decoration:none;">${escapeHtml(supportEmail)}</a>
            &nbsp;·&nbsp; &copy; ${escapeHtml(appName)}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Plain-text fallback for the same content (improves deliverability). */
export function renderNotificationText(opts: NotificationEmailOptions): string {
  const { appName } = EMAIL_BRANDING;
  const action = opts.actionUrl
    ? `\n\n${opts.actionLabel ?? `Open ${appName}`}: ${opts.actionUrl}`
    : "";
  return `${opts.title}\n\n${opts.body}${action}\n\n— ${appName}`;
}
