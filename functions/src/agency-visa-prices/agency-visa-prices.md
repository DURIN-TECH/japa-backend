# Agency per-visa service price API (issue #103)

An agency sets its own **service price** on any visa it offers: what the
agency charges to handle the application. It is separate from the visa's
**government fee** (`VisaType.baseCostUsd`, in USD). Setting a price never
reads into or writes the visa doc.

**Unit: whole NAIRA.** ₦12,500 is sent, stored and returned as `12500`.
There is no kobo or cents conversion anywhere. Never multiply or divide by 100.

Code: `agency-visa-price.validation.ts` (pure body and path rules),
`agency-visa-price.service.ts` (storage and the "which visas" rule),
`agency-visa-price.controller.ts` (HTTP and the CASL gate),
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
  "price": 12500,                 // whole naira, integer, 0..100000000
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

Old docs still carry an empty `{}`, which is harmless and never read. Nothing
reads a cents value as naira.

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

The controller then **gates the caller** and returns **403 `FORBIDDEN`**
unless both of these hold:

- the caller has an `agencyId` claim;
- their CASL ability allows the action on
  `asSubject("Visa", { ownerAgencyId: <their agency>, source: "agency" })`.
  This is the same #98 grant as the agency visa endpoints: `read` for GET and
  `update` for PUT and DELETE.

So the agency's owner and agents pass. An agent with no agency, a client
(even one whose token carries an `agencyId`) and an admin all get 403.

The agency always comes from the **token**, never from the URL or the body.
Agency A cannot address agency B's prices.

| Method and path | Success | Errors |
| --- | --- | --- |
| `GET /agency/visa-prices` | 200 `AgencyVisaPriceView[]` | 403 |
| `GET /agency/visa-prices?include=global` | 200, the same list plus every public visa not yet priced (`price: null`), for the portal picker | 403 |
| `PUT /agency/visa-prices/:countryCode/:visaTypeId` with body `{ "price": 12500 }` | 200 `AgencyVisaPriceView` | 400, 403, 404 |
| `PUT …` with body `{ "price": null }` | 200 `{ countryCode, visaTypeId, price: null }` (clears the price) | 400, 403 |
| `DELETE /agency/visa-prices/:countryCode/:visaTypeId` | 200 `{ countryCode, visaTypeId, price: null }`. Idempotent: if no price is set, nothing is written | 400, 403 |

**List order:**

1. the agency's own approved visas, newest first;
2. the other priced visas;
3. with `include=global`, the rest of the public catalog.

Groups 2 and 3 are sorted by country code, then by visa name. No visa appears
twice.

**Validation (400, `field` names the offending key):**

- **The body** must be exactly `{ price }`. Any other key gets
  `UNKNOWN_FIELD`. A missing `price` or a non-object body gets
  `VALIDATION_ERROR`.
- **`price`** must be a JSON number that is an integer, with
  `0 <= price <= 100000000` (`MAX_VISA_SERVICE_PRICE_NAIRA`), or `null`.
  Strings (even `"12500"`), booleans, NaN, Infinity, fractions, negative
  numbers and values above the cap get `VALIDATION_ERROR`.
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
  "price": 12500,               // THIS agency's service price, whole naira; null = unset
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
    "price": null,                       // whole NAIRA; null = "Contact for pricing"
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
    "price": 12500, "isAgencyVisa": false, "visibility": "global", "…": "…" }
]
```

Every entry has every key; a missing optional value is `null`
(`eligibilityCriteria` is `[]`). The agency's own visas are listed only when
`source: "agency"`, `ownerAgencyId` is this agency, `reviewStatus: "approved"`
and `isActive: true`. Drafts, pending, rejected, inactive and other agencies'
visas never appear. The sponsor licence number and contact, `createdBy`, the
review fields, `ownerAgencyId` and `agentIds` are never exposed. The page
still 404s for an unknown slug or an agency that is not `approved`.

- **Units and empty values.** `price` is in whole naira. `null` means the page
  shows "Contact for pricing".
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
  "consultationFee": 15000,                                  // whole NAIRA, as stored
  "services": [{ "id": "svc-1", "name": "CV review", "price": 25000 }], // whole NAIRA
  "agentCount": 3, "totalCases": 12,
  "status": "approved",
  "verified": false,       // compliance badge only; approved + unverified agencies are still listed
  "createdAt": { "_seconds": 1700000000, "_nanoseconds": 0 }
}
```

Never present: `ownerId`, `compliance`, `reviewedBy`, `reviewedAt`,
`rejectionReason`, `activeCases`, bank / BVN / NIN data.

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
