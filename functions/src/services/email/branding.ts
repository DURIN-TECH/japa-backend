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
    "https://japa-portal-backend--japa-platform.us-central1.hosted.app/assets/seli_logo.png",

  /** Brand home / default destination for the footer link. */
  appUrl:
    process.env.APP_URL ||
    "https://japa-portal-backend--japa-platform.us-central1.hosted.app",

  /** Support address shown in the footer. */
  supportEmail: process.env.EMAIL_SUPPORT || "support@seli.app",
} as const;
