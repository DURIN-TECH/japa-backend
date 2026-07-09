/**
 * Email branding — the single source of truth for how every transactional email
 * looks. Keep all brand literals (name, colour, logo, links) here so templates
 * stay layout-only and a rebrand is a one-file change. Each value is env-overridable
 * so different environments can point at different assets without code changes.
 */
export const EMAIL_BRANDING = {
  /** Product name, used in copy + footer. */
  appName: "Seli",

  /** Primary brand colour (matches the portal). */
  brandColor: "#1D5CDD",

  /** Hosted logo. PNG on purpose — email clients don't render SVG reliably. */
  logoUrl:
    process.env.EMAIL_LOGO_URL ||
    "https://portal.weareseli.com/assets/seli_logo.png",

  /** Brand home / default destination for the footer link (custom portal domain). */
  appUrl: process.env.APP_URL || "https://portal.weareseli.com",

  /** Support address shown in the footer / "Need help?" line. */
  supportEmail: process.env.EMAIL_SUPPORT || "support@weareseli.com",
} as const;
