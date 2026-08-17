/**
 * Vanity agency-subdomain configuration.
 *
 * `AGENCY_PAGE_DOMAIN` is the base domain that every approved agency's public
 * page hangs off: with `weareseli.com` set here, an agency slugged `lagosvisas`
 * is served at `https://lagosvisas.weareseli.com`.
 *
 * UNSET-SAFE ON PURPOSE. The wildcard DNS record (`*.weareseli.com`) and the
 * App Hosting wildcard custom domain are a manual, one-time setup (see the
 * runbook in `infra/terraform/apphosting.tf`). Until they exist — and in local
 * dev and the dev project, where they never will — this stays unset and every
 * consumer falls back to the path-based URL the platform has always used
 * (`${APP_URL}/a/<slug>`). Nothing breaks; the vanity host simply isn't offered.
 *
 * Set it per environment in `functions/.env.<PROJECT_ID>` (committed, non-secret).
 * The portal has a mirrored `NEXT_PUBLIC_AGENCY_PAGE_DOMAIN`; the two must agree
 * or the portal will advertise a host the backend won't redirect payments to.
 */
export const AGENCY_PAGE_DOMAIN: string | undefined =
  process.env.AGENCY_PAGE_DOMAIN?.trim().toLowerCase() || undefined;
