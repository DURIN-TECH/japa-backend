# Agency per-visa service price API (issue #103)

An agency sets its own **service price** on any visa it offers: what the
agency charges to handle the application. It is separate from the visa's
**government fee** (`VisaType.baseCostUsd`, in USD). Setting a price never
reads into or writes the visa doc.

**Unit: US dollars (issue #179).** The price is sent as
`{ "priceUsd": { "amount": "125.00", "currency": "USD" } }` and stored and
returned as a `Money` in cents, `{ "amountMinor": 12500, "currency": "USD" }`.
The dollar -> cents step is `parseUsdPriceInput` (`src/money/usd-price.ts`,
factors from the currency table). Public reads add the local figure
`priceLocal` (see below). The old whole-naira `price` was converted by
`scripts/migrate-prices-to-usd.ts`; sending `price` is a 400.

Code: `agency-visa-price.validation.ts` (pure body and path rules),
`agency-visa-price.service.ts` (storage and the "which visas" rule),
`agency-visa-price.controller.ts` (HTTP, the CASL gate and the owner / admin
write check),
`agency-visa-price.routes.ts` (mounted at `/agency/visa-prices` in
`src/app.ts`). Tests: `test/agency-visa-prices/agency-visa-prices.test.ts`.

## Where the data lives

`agencies/{agencyId}/visaPrices/{countryCode}__{visaTypeId}` (`AgencyVisaPrice`
in `src/types/index.ts`):

```jsonc
{
  "id": "GB__uk-skilled-worker",
  "agencyId": "…",
  "visaTypeId": "uk-skilled-worker", "countryCode": "GB",
  "priceUsd": { "amountMinor": 12500, "currency": "USD" }, // $125.00; 0..10000000 cents
  "migratedFrom": { "price": { "amount": 187500, "currency": "NGN", "rate": 1500, "…": "…" } }, // only if migrated
  "updatedBy": "uid",
  "createdAt": Timestamp, "updatedAt": Timestamp
}
```

- There is **one doc per agency per visa.** Prices are per agency by
  construction. When a visa is made global, every agency, including the
  agency that created it, has its own doc. One agency's price never appears
  on another agency's page.
- **The key is the visa,** written as `countryCode__visaTypeId`. A visa's
  identity is `countries/{cc}/visaTypes/{visaTypeId}`, and seed ids are only
  unique within a country.
- **Only the backend can access it.** No `firestore.rules` match covers this
  subcollection, so clients are denied.
- **No new Firestore index is needed.** Pricing reads the whole subcollection
  and uses the existing #100 index on the `visaTypes` collection group
  (`ownerAgencyId` + `createdAt desc`).

### `Agent.serviceFees` is superseded

`Agent.serviceFees` was the legacy per-agent `visaTypeId -> fee`. Its comment
said "cents", but no UI ever wrote it and no code read it. It is now
`@deprecated` and optional in the type, and this agency-level price replaces
it:

- New agent docs no longer get `serviceFees: {}`.
- `UpdateAgentInput` no longer has the field.
- `PUT /agents/me` drops `serviceFees` from the body.

Old docs still carry an empty `{}`, which is harmless and never read. Since
#179 no client may write it directly either (`firestore.rules`).

## Which visas an agency can price

`canAgencyPriceVisa(visa, agencyId)` allows a price on:

1. **Any publicly visible visa.** This uses the #99 rule
   (`isVisaPubliclyVisible`): the visa is active, approved or seed, and
   global. A visa that another agency (or this one) created and that the admin
   made global falls under this case.
2. **The agency's own agency visa** (`source: "agency"`,
   `ownerAgencyId` = the caller's agency) while it is agency-only. It must be
   `reviewStatus: "approved"` and `isActive: true`.

Every other visa is refused, and nothing is written:

| Case | Answer |
| --- | --- |
| Unknown visa, or a wrong country | **404** `NOT_FOUND` "Visa not found" |
| Another agency's agency-only visa, in any state | **404**, with the same body as an unknown visa so its existence doesn't leak |
| A hidden non-agency visa (for example a pending scraped one) | **404** |
| The agency's own draft, pending, rejected or inactive visa | **400** `VISA_NOT_APPROVED` |

**Stale prices.** A price can become stale when its visa is deactivated,
deleted, or taken back to agency-only. The price is kept in storage, but it
is left out of every read, so it is never shown. The agency can still clear
it.

## Endpoints

Every route runs `verifyAuth` first:

- **401** with no valid token;
- **402** on writes while the plan is read-only.

The controller then **gates the caller** (`gate()` in
`agency-visa-price.controller.ts`). Since issue #227 (product decision
2026-11-14, "only owners and admin"), reading and writing differ:

| Caller | `GET` | `PUT` / `DELETE` |
| --- | --- | --- |
| Owner of the agency | 200 | 200 |
| Admin, naming the agency with `?agencyId=<id>` | 200 | 200 |
| Member agent of the agency | 200 | **403**, nothing written |
| Owner or agent of another agency (e.g. `?agencyId=<A>` from B) | 403 | 403 |
| Client (even one whose token carries an `agencyId`), agent with no agency | 403 | 403 |

How each row is decided:

- **Member or better.** For everyone but an admin, the caller needs an
  `agencyId` claim, and their CASL ability must allow the action on
  `asSubject("Visa", { ownerAgencyId: <their agency>, source: "agency" })`:
  the same #98 grant as the agency visa endpoints (`read` for GET, `update`
  for PUT and DELETE). That shared rule is **not** changed by #227, so agents
  still create and edit the agency's own visas (#106).
- **Writes are owner-only on top of that.** PUT and DELETE also need
  `agencyService.getOwnedAgencyForPrincipal(req.authz)` to return this
  agency: the same owner check as `PUT /agencies/me`. The resolved principal
  must be the owner of this agency, and the agency record must name them as
  `ownerId`. A member agent passes the CASL check but stops here with 403
  `FORBIDDEN` "Only the agency owner or an admin can set visa prices", before
  any validation or write.
- **Reads stay open to member agents.** The agency side's start-case picker
  shows the agency's price next to each visa (see "For #106" below), so
  agents need the list. #227 only takes away setting and clearing.
- **Admins** (the `role: "admin"` claim or the legacy `admin: true` claim)
  have no agency in their token, so they name it with `?agencyId=<id>` on
  every route. If it is missing or not a usable id, they get **400**
  `VALIDATION_ERROR`; if no agency has that id, **404** `NOT_FOUND`. An
  admin's write is stored with `updatedBy` set to the admin's uid.

For everyone except an admin, the agency always comes from the **token**,
never from the URL or the body. Agency A cannot address agency B's prices: a
non-admin who sends `?agencyId=` for any agency other than their own gets
403. The query never silently switches to their own agency.

| Method and path | Success | Errors |
| --- | --- | --- |
| `GET /agency/visa-prices` | 200 `AgencyVisaPriceView[]` | 400 / 404 (admin `agencyId`), 403 |
| `GET /agency/visa-prices?include=global` | 200, the same list plus every public visa not yet priced (`priceUsd: null`), for the portal picker | 403 |
| `PUT /agency/visa-prices/:countryCode/:visaTypeId` with body `{ "priceUsd": { "amount": "125.00", "currency": "USD" } }` | 200 `AgencyVisaPriceView` | 400, 403 (incl. member agents), 404 |
| `PUT …` with body `{ "priceUsd": null }` | 200 `{ countryCode, visaTypeId, priceUsd: null }` (clears the price) | 400, 403 (incl. member agents) |
| `DELETE /agency/visa-prices/:countryCode/:visaTypeId` | 200 `{ countryCode, visaTypeId, priceUsd: null }`. Idempotent: if no price is set, nothing is written | 400, 403 (incl. member agents) |

**List order:**

1. the agency's own approved visas, newest first;
2. the other priced visas;
3. with `include=global`, the rest of the public catalog.

Groups 2 and 3 are sorted by country code, then by visa name. No visa appears
twice.

**Validation (400, `field` names the offending key):**

- **The body** must be exactly `{ priceUsd }`. Any other key (the old naira
  `price` included) gets `UNKNOWN_FIELD`. A missing `priceUsd` or a
  non-object body gets `VALIDATION_ERROR`.
- **`priceUsd`** must be `{ amount, currency? }` or `null`. `amount` is a
  decimal string or JSON number of US dollars: finite, not negative, at most
  2 decimals (whole cents, never rounded), at most $100,000.00
  (`MAX_VISA_SERVICE_PRICE_USD_CENTS` = `MAX_PRICE_USD_CENTS`). `currency`, if
  sent, must be `USD`. A bare number, other keys (`amountMinor`, `rate`),
  NaN, Infinity, sub-cent amounts, negatives and values above the cap get
  `VALIDATION_ERROR`.
- **`:countryCode`** must be 2 letters; it is upper-cased.
- **`:visaTypeId`** must be non-empty, at most 200 characters, with no `/`,
  and must not be `.` or `..`.

### `AgencyVisaPriceView`

```jsonc
{
  "visaTypeId": "uk-skilled-worker", "countryCode": "GB",
  "visaName": "Skilled Worker visa", "visaCode": "UK-SW", "category": "work",
  "source": "scraped",          // "scraped" | "agent" | "agency" | null (old seed)
  "visibility": "global",       // "global" | "agency"; missing on the doc = "global"
  "isOwnVisa": false,           // true when THIS agency created the visa
  "baseCostUsd": 719,           // GOVERNMENT fee, USD, read-only here; null when unset
  "priceUsd": { "amountMinor": 12500, "currency": "USD" }, // THIS agency's price; null = unset
  "priceUpdatedAt": Timestamp   // null when unset; { _seconds, _nanoseconds } over JSON
}
```

## Public agency page: `GET /agencies/public/:slug` (no auth)

The existing whitelisted projection gains a `visaPrices` field. It lists the
visas this agency **offers**: its own approved visas plus the visas it has
priced. It does not include the whole global catalog.

```jsonc
"visaPrices": [
  {
    // ---- #103 ----
    "visaTypeId": "own-1", "countryCode": "GB", "visaName": "…", "category": "work",
    "priceUsd": null,                    // US dollars (Money); null = "Contact for pricing"
    "priceLocal": null,                  // local figure { amountMinor, currency, rate, asOf, available }; null when no price
    // ---- #102: applicant-safe visa detail (same entries, not a second list) ----
    "isAgencyVisa": true,                // this agency's OWN visa (agency-only or made global)
    "visibility": "agency",              // "agency" = only reachable through this agency; else "global"
    "visaCode": "ACME-SW", "description": "…",
    "processingTime": "3 to 8 weeks", "processingDaysMin": 21, "processingDaysMax": 56,
    "validityPeriod": "Up to 5 years", "isExtendable": true, "maxExtensions": 1,
    "eligibilityCriteria": ["…"],
    "baseCostUsd": 900,                  // GOVERNMENT fee in USD, not the agency price; null when unset
    "applicationUrl": "https://…", "applicationInstructions": "…",
    "sponsor": { "organisationName": "Acme Ltd", "website": "https://…" }  // or null
  },
  { "visaTypeId": "uk-student", "countryCode": "GB", "visaName": "…", "category": "student",
    "priceUsd": { "amountMinor": 12500, "currency": "USD" },
    "priceLocal": { "amountMinor": 18750000, "currency": "NGN", "rate": 1500, "asOf": "…", "available": true },
    "isAgencyVisa": false, "visibility": "global", "…": "…" }
]
```

Every entry has every key; a missing optional value is `null`
(`eligibilityCriteria` is `[]`). The agency's own visas are listed only when
`source: "agency"`, `ownerAgencyId` is this agency, `reviewStatus: "approved"`
and `isActive: true`. Drafts, pending, rejected, inactive and other agencies'
visas never appear. The sponsor licence number and contact, `createdBy`, the
review fields, `ownerAgencyId` and `agentIds` are never exposed. The page
still 404s for an unknown slug or an agency that is not `approved`.

- **Units and empty values.** `priceUsd` is US dollars; `priceLocal` is the
  same price in the viewer's currency at the current rate (signed-in viewer's
  profile currency, else NGN). When the rate is missing or stale,
  `priceLocal.available` is `false` with null amount / rate / asOf, and the
  page still loads with the dollar price. `null` means the page shows
  "Contact for pricing".
- **Only this agency.** Only this agency's prices are listed, and no owner or
  review fields are exposed.
- **No priced visas.** An agency with no priced visas gets `[]`.
- **Errors.** If the pricing read fails, the error is logged and the page is
  served with `[]`, so the rest of the page still loads.

## Public agency directory: `GET /agencies/browse*` (no auth, #144)

Three read-only routes for the mobile Explorer's agency screens. No
`Authorization` header. Only `approved` agencies are served; anything else is
`404 NOT_FOUND` with the same body as an unknown id. Other methods on
`/agencies/browse*` answer `405` and write nothing.

| Route | Returns |
| --- | --- |
| `GET /agencies/browse?limit=&search=` | `PublicAgency[]`, newest first, **no** `visaPrices` (keeps the list one query) |
| `GET /agencies/browse/:id` | `PublicAgency` + `visaPrices[]` |
| `GET /agencies/browse/:id/agents` | the agency's `verified` + `isAvailable` agents, same shape as `GET /agents`; 404 when the agency is not public |

- `?limit=`: a positive integer, capped at 100 (also the default). Anything
  else (`abc`, `0`, `-1`) is ignored. It applies after `?search=`.
- `?search=`: case-insensitive substring match on the agency name. No match
  is `200 []`.

`PublicAgency` is an allow-list (`toPublicAgency()` in
`services/agency.service.ts`):

```jsonc
{
  "id": "agency-a", "name": "Acme Visas", "slug": "acme",   // slug null until backfilled
  "ownerName": "Ada Owner", "state": "Lagos", "address": "…", // optional fields omitted when unset
  "description": "…", "logoUrl": "https://…",
  // Issue #179: US dollars as stored + the local figure; both null when unset.
  "consultationFeeUsd": { "amountMinor": 10000, "currency": "USD" },
  "consultationFeeLocal": { "amountMinor": 15000000, "currency": "NGN", "rate": 1500, "asOf": "…", "available": true },
  "services": [{ "id": "svc-1", "name": "CV review",
    "priceUsd": { "amountMinor": 2500, "currency": "USD" }, "priceLocal": { "…": "…" } }],
  "agentCount": 3, "totalCases": 12,
  "status": "approved",
  "verified": false,       // compliance badge only; approved + unverified agencies are still listed
  "createdAt": { "_seconds": 1700000000, "_nanoseconds": 0 }
}
```

Never present: `ownerId`, `compliance`, `reviewedBy`, `reviewedAt`,
`rejectionReason`, `activeCases`, bank / BVN / NIN data, `migratedFrom`, and
any old naira `consultationFee` / service `price`.

`visaPrices[]` on `/browse/:id` is built by the same
`agencyVisaPriceService.listPublic(agency.id)` call as the slug page, so each
entry is identical (same keys, same values) to the one in
`GET /agencies/public/:slug` (see above). A pricing read failure is logged and
served as `[]`.

Indexes: `/browse` uses `agencies (status ASC, createdAt DESC)` and
`/browse/:id/agents` uses `agents (agencyId ASC, displayName ASC)`; both
already exist, no new index was added.

## For #106 (portal and mobile)

**Start-case picker.** To show an agency's price next to each visa in the
picker, the agency side calls `GET /agency/visa-prices` and joins on
`countryCode__visaTypeId`.

**Public web page.** Read `visaPrices` from `GET /agencies/public/:slug`.

**Mobile.** Read `visaPrices` from `GET /agencies/browse/:id` (#144); the
entries are the same as the slug page's. `useAgencyVisaPrices` already reads
the field there.

**#102** (reachable through the agency) added the applicant-safe visa detail
to the same `visaPrices[]` entries (above), built on `listOffered`. See
`../agency-visas/agency-visas.md`, "Reachable through the agency", for who
may read an agency-only visa on the detail endpoints and start a case on it.
