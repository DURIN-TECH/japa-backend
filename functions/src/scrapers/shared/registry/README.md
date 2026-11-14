# Source registry API (issue #215, part P1 of umbrella #211)

Backend endpoints that let an **admin** add a country or visa route without a
developer: confirm an official website once, check an address, register a
country, a visa page and its rule/guidance pages. Nothing is crawled or drafted
here, and **nothing becomes visible to applicants**: a new country is created
with `isSupported: false`, and no `countries/{cc}/visaTypes` record is created
or activated (the visa crawl does that later, as a pending, inactive record).

Rulebooks now publish with no human sign-off, so the safeguards in this folder
are security features: the **confirmed-hosts allow-list** and the **audit trail**.

## Endpoints (all admin-only: `verifyAuth`, then `read`/`update ScrapeRun`)

| Method and path | Gate | What it does |
|---|---|---|
| `POST /admin/official-domains/preview` `{ url }` | update | Check an address (see "The check-address action"). 200 with host, final URL, status, `docType`, `language`, `title`, `characterCount`, `openingText` (300 chars), `redirected`, `redirectedToOtherHost`, `hostStatus`. |
| `POST /admin/official-domains` `{ host, countryCode, statement }` | update | Confirm one exact host. 201 (new) or 200 (already confirmed: idempotent, nothing written). |
| `GET /admin/official-domains` | read | `{ domains, total }`. |
| `POST /admin/official-domains/:host/revoke` `{ reason? }` | update | Sets `revoked` and pauses every portal-added source on that host. |
| `GET /admin/route-sources/country-lookup?code=SV` | read | English name from `Intl.DisplayNames`, and whether `countries/{cc}` / `visaSources/{cc}` exist. 400 for a malformed or unknown code. |
| `POST /admin/route-sources` | update | Register a route in one request (see below). 201, or 200 `created: false` when repeated. |
| `PATCH /admin/guidance-sources/:id` `{ status?, role? }` | update | `status` in `active, paused, retired`; `role` in the guidance roles. Audited. |

There is **no delete route**: a source is retired, never removed. Bodies are
strict (unknown keys: 400). Errors are `{ success:false, error, message, ... }`.

## Rules in force

- **Addresses** (`registry-address.ts`): https only; no user name or password,
  port (even `:443`), fragment or IP literal; a host with at least two valid
  labels, no trailing dot. Judged on the text, so a refusal means no request.
- **Confirmed hosts**: `officialDomains/{host}` (exact host). Registration is
  refused (422 `HOST_NOT_CONFIRMED`, with the host list) before anything is
  fetched unless every host is `confirmed`. **Exact match only**: a confirmed
  host does not cover its subdomains or its parent; wildcards are rejected
  (subdomain patterns are follow-up FU-3). A confirmation records who, when, the
  exact host, the typed statement and what the system read (title, language,
  size, opening text), taken from the server-held check the admin made (see
  `officialDomainPreviews`), which must be recent (`previewMaxAgeMinutes`) and
  must have ended on the same host.
- **Language**: `appConfig/routeOnboardingSettings.supportedLanguages`, default
  `["en"]`; anything else is 422 `LANGUAGE_NOT_SUPPORTED`. A malformed list falls
  back to the default, never to "everything". A failed settings read is 503.
- **Registering a route** creates, in one transaction, only what is missing:
  `countries/{cc}` (hidden), the page in `visaSources/{cc}` (pinned `visaId`,
  `addedVia: "portal"`, generic-html, weekly night window on the least loaded
  weekday), `guidanceSources/{id}` docs (`verificationStatus: "registered"`:
  retrieved in full by the registration fetch, not read by a person), and one
  audit entry per object. At least one `primary` guidance source. Guidance ids
  are `<cc>-<slug(title)>`, never from the URL. Repeating a body changes nothing
  and fetches nothing.
- **Rate limits** per admin per hour (counter docs, transactional): 20 address
  checks, 30 registrations (settings `previewsPerHour`, `registrationsPerHour`).
- **Audit**: `sourceRegistryAudit/{id}`, written with `tx.create` in the same
  transaction as the change; nothing updates or deletes it.
- New collections `officialDomains`, `officialDomainPreviews`,
  `sourceRegistryAudit`, `sourceRegistryRateLimits` are backend-only (no
  `firestore.rules` match; pinned by `test/emulator/backend-only-collections.emu.ts`).

## The check-address action

The one place the API fetches. It uses the shared guarded `VisaCatalogFetchService`
(never a raw HTTP call; a test greps this folder). Protections: robots.txt and
the bot User-Agent; per-host spacing and 429/503 back-off; IP literals and
non-web ports refused before any request, every DNS answer checked at connect
time (private, loopback, link-local, metadata, CGNAT, multicast), at most 5
redirects with every hop's address checked, no proxy; 5 MB HTML / PDF byte, page
and text caps enforced while streaming; 15 s per request, 60 s per body, 15 s
idle. The host need not be confirmed (that is the point). A redirect to another
host is **followed and reported** (`redirectedToOtherHost`), and a confirmation
refuses a check that did not end on the host being confirmed.

When a route is **registered**, the same fetch runs with a host policy
(`allowedHost`): the requested host, every redirect hop (before it is
requested) and the final URL must be confirmed hosts, otherwise the redirect is
refused. The same policy applies to every crawl of a portal-added source (visa
page, guidance source); the refusal is recorded as the source's error
(`host_not_confirmed` for guidance), and an unreadable allow-list fails closed.

## Seed scripts

Code seed files stay seeds; Firestore is the source of truth.
`seedVisaSources` carries over pages with `addedVia: "portal"` (with their crawl
state), unions stored and code `officialHosts`, keeps the doc's portal
provenance, and still never touches a country absent from the markdown.
`seedGuidanceSources` never deletes, and skips a stored doc that was added from
the portal; an admin's role edit is kept (`roleEditedBy`).
`npm run seed:official-domains [-- --apply --confirm-project=<id>]` imports the
exact hosts of `VISA_SOURCE_OFFICIAL_HOSTS` once (`confirmedBy: "system:seed"`,
dry run by default, idempotent, never un-revokes); pattern entries stay in code.

Tests: `test/scrapers/shared/registry/`.
