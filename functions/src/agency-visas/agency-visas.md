# Agency visas: create, edit, submit, delete-draft API (issue #100)

Agency owners and agents can add visas that only their agency knows about,
such as organisation-sponsored routes. These visas have the same structure as
scraped and seed visas, and nobody can use one until Seli approves it. This
file is the contract that #101 (admin review of agency visas and revisions,
make-global), #102 (reachable through the agency) and #104 (portal "Our
visas") build on.

Code: `agency-visa.validation.ts` (pure body rules), `agency-visa.service.ts`
(storage and state machine), `agency-visa.controller.ts` (HTTP and CASL gate),
`agency-visa.routes.ts` (mounted at `/agency/visas` in `src/app.ts`). Tests:
`test/agency-visas/agency-visas.test.ts`.

## Where the data lives

| What | Path | Notes |
| --- | --- | --- |
| The visa (draft, pending, approved, rejected) | `countries/{cc}/visaTypes/{id}` | The same collection as seed and scraped visas, so the existing admin review (`PATCH /admin/visas/:id/review`), the #99 public-read rule and case creation all work unchanged. `id` is a Firestore auto id, also stored in the `id` field. |
| A pending edit to an **approved** visa | `visaRevisions/{cc}__{id}` | Top level, at most one per visa. Kept off the live doc, so public reads never serve unreviewed agency text and the live doc is not written at all. Backend-only: no `firestore.rules` match, so clients are denied. |

### Fields the server sets (never taken from the body)

On create: `id`, `ownerAgencyId` (the caller's `agencyId` claim), `createdBy`
(the caller's uid), `source: "agency"` (`AGENCY_VISA_SOURCE`),
`visibility: "agency"`, `reviewStatus: "draft"`, `isActive: false`,
`agentIds: []`, `createdAt`, `updatedAt`.

On submit: `reviewStatus: "pending_review"`, `isActive: false`,
`submittedAt`, `submittedBy`, `updatedAt`, and `rejectionReason` is removed.

`ownerAgencyId`, `createdBy`, `source` and `countryCode` never change after
create.

## States

```
draft ──submit──▶ pending_review ──admin approve──▶ approved
  │                     │                              │
  └─ DELETE (only here) └──admin reject──▶ rejected    └─ edit ──▶ visaRevisions doc (pending_review)
                                            │                       live doc unchanged, isActive stays true
                                            └─ edit / submit ──▶ pending_review
```

**`reviewStatus: "draft"`.** A draft is stored with an explicit `"draft"`
value, not with the field missing. A missing `reviewStatus` already means a
seed or never-reviewed visa, which the #99 public rule treats as approved, so
an explicit value keeps drafts out of every public read by the review-state
rule too, not only by `isActive` and `visibility`. Drafts are:

- left out of `GET /admin/visas`;
- refused by `PATCH /admin/visas/:id/review` with **409 `VISA_IS_DRAFT`**,
  with nothing written.

`VisaType.reviewStatus` is now `"draft" | "pending_review" | "approved" | "rejected"`
(`VisaReviewStatus` in `src/types/index.ts`).

**A submit always enforces the full set** of required fields. Create needs
the full set too, which is the issue's default: there are no partial drafts.

## Endpoints

All routes are under `/agency/visas`. Each one first runs `verifyAuth`, which
returns **401** with no valid token, and **402** on writes while the plan is
read-only.

The controller then **gates the caller** and returns **403 `FORBIDDEN`**
unless both of these hold:

- the caller has an `agencyId` claim;
- their shared CASL ability allows the action on a `Visa` tagged
  `asSubject("Visa", { ownerAgencyId: <their agency>, source: "agency" })`.

This lets the agency `owner` and `agent` (authz >= 0.1.6) through. An agent
with no agency, a client and an admin all get 403. An admin has no agency and
reviews through `/admin/visas` instead.

The checks never use a string subject. Every check on a real doc tags it with
`asSubject("Visa", doc)`, so the `ownerAgencyId` and `source` conditions are
matched. Update also checks each written field
(`can("update", subject, field)`).

Every lookup is also **scoped to the caller's agency in the query**. Another
agency's id and an unknown id therefore return the **same 404 body**:
`{ success: false, error: "NOT_FOUND", message: "Visa not found" }`. Nothing is
written in either case.

| Method and path | CASL action | Success | Errors |
| --- | --- | --- | --- |
| `GET /agency/visas` | `read` | 200 `AgencyVisaView[]`, newest first (`createdAt desc`); `[]` when the agency has none | 403 |
| `GET /agency/visas/:id` | `read` | 200 `AgencyVisaView` | 403, 404 |
| `POST /agency/visas` | `create`, checked on the server-built draft | 201 `AgencyVisaView` (draft) | 400, 403 |
| `PUT /agency/visas/:id`, `PATCH /agency/visas/:id` | `update`, plus each written field | 200 `AgencyVisaView` | 400, 403, 404, 409 `VISA_IN_REVIEW` |
| `POST /agency/visas/:id/submit` | `update` | 200 `AgencyVisaView` | 400 (incomplete), 403, 404, 409 `ALREADY_SUBMITTED` (pending), 409 `VISA_APPROVED` |
| `DELETE /agency/visas/:id` | `delete` | 200 `{ id }` | 403, 404, 409 `NOT_A_DRAFT` (pending, approved or rejected) |

Responses use the usual envelope: `{ success: true, data, message? }`.
Errors use `{ success: false, error, message, field? }`. A 400 always carries
`field`, the first offending body key, for example `"sponsor.website"` or
`"eligibilityCriteria[1]"`.

### `AgencyVisaView`

`AgencyVisaView` is the visa doc as stored, plus `pendingRevision`:

```jsonc
{
  "id": "Xy12…", "countryCode": "GB",
  "name": "…", "code": "ACME-SW", "description": "…", "category": "work",
  "processingTime": "3 to 8 weeks", "processingDaysMin": 21, "processingDaysMax": 56,
  "validityPeriod": "Up to 5 years", "isExtendable": true, "maxExtensions": 1,
  "eligibilityCriteria": ["…"],
  "baseCostUsd": 900,                       // government fee in USD, optional
  "applicationUrl": "https://…", "applicationInstructions": "…", "sourceUrl": "https://…",
  "sponsor": { "organisationName": "Acme Ltd", "website": "https://…",
               "sponsorLicenceNumber": "ABC12345", "contact": "…" },
  "source": "agency", "ownerAgencyId": "…", "createdBy": "uid",
  "visibility": "agency",                   // "global" once made global (#101)
  "reviewStatus": "draft",                  // draft | pending_review | approved | rejected
  "rejectionReason": "…",                   // only when rejected
  "isActive": false,                        // true only once approved
  "submittedAt": Timestamp, "submittedBy": "uid",
  "reviewedBy": "uid", "reviewedAt": Timestamp,
  "agentIds": [], "createdAt": Timestamp, "updatedAt": Timestamp,
  "pendingRevision": null                   // or a VisaRevision (below)
}
```

Timestamps serialise as `{ _seconds, _nanoseconds }`, as in every other
endpoint.

## Request body (create and update)

Only these keys are accepted:

- **Required** (all of them on create; a visa must have them to be
  submitted):
  - `countryCode`: 2 letters, upper-cased, and must be an existing
    `countries/{cc}` doc;
  - `name`;
  - `code`: stored upper-cased;
  - `description`;
  - `category`: `work | student | tourist | business | family | investor | transit | other`;
  - `processingTime`;
  - `processingDaysMin` and `processingDaysMax`: non-negative integers, with
    min <= max;
  - `validityPeriod`;
  - `isExtendable`: boolean;
  - `eligibilityCriteria`: an array of non-empty strings, at most 100. An
    empty array is allowed.
- **Optional:**
  - `baseCostUsd`: finite and >= 0;
  - `applicationUrl` and `sourceUrl`: absolute **http(s)** URLs;
  - `applicationInstructions`;
  - `maxExtensions`: a non-negative integer;
  - `sponsor`: `{ organisationName` (required), `website?` (http(s) URL),
    `sponsorLicenceNumber?`, `contact? }`. Other keys inside `sponsor` are
    refused.

Text fields are trimmed and must not be empty. Short fields are capped at 200
characters, `description` and `applicationInstructions` at 5000, and URLs at
2048.

Refused keys:

- any key in `VISA_PROTECTED_FIELDS` (`reviewStatus`, `reviewedBy`,
  `reviewedAt`, `rejectionReason`, `visibility`, `isActive`, `ownerAgencyId`,
  `createdBy`, `source`) returns **400 `PROTECTED_FIELD`**;
- any other key (`agentIds`, `scrapeMeta`, `id`, `createdAt`,
  `pendingRevision`, …) returns **400 `UNKNOWN_FIELD`**.

Nothing is written when a request is refused.

**Updates.** `PUT` and `PATCH` behave the same way: they are partial and
merge with what is stored. The merged visa must still be complete and
consistent. Sending `null` for an optional field removes it; `null` for a
required field is a 400. Changing `countryCode` is a 400, because it is part
of the doc path.

**Update by state:**

- **draft** or **rejected**: the visa doc is written. A rejected visa keeps
  its `rejectionReason` until it is resubmitted.
- **pending_review**: 409 `VISA_IN_REVIEW`.
- **approved**: the edit becomes a revision. The live doc and `isActive` are
  not touched.

## Revisions of approved visas (`visaRevisions/{cc}__{id}`)

```jsonc
{
  "id": "GB__Xy12…", "visaId": "Xy12…", "countryCode": "GB",
  "ownerAgencyId": "…",
  "changes": { "name": "New name", "baseCostUsd": null },  // differs from live; null = remove the field
  "reviewStatus": "pending_review",                         // or "rejected" (set by #101)
  "submittedBy": "uid", "submittedAt": Timestamp,           // last agency edit
  "rejectionReason": "…", "reviewedBy": "uid", "reviewedAt": Timestamp,  // #101, on reject
  "createdAt": Timestamp, "updatedAt": Timestamp
}
```

How an agency edit changes the revision:

- **Each edit** builds a proposal and validates it as a complete visa. The
  proposal is the live content, then the existing `changes` on top, then the
  body. The revision then stores `changes = diff(proposal, live)`.
- **Several edits** merge into one revision.
- **Reverting.** An edit that brings every field back to the live values
  deletes the revision.
- **After a rejection.** Editing a rejected revision reopens it as
  `pending_review` and drops `rejectionReason`, `reviewedBy` and
  `reviewedAt`. Its earlier `changes` are kept as the base.
- **The live visa** keeps `reviewStatus: "approved"` and `isActive: true`.
  Public and agency reads keep serving the live values, and the agency reads
  return the revision as `pendingRevision`.

**For #101 (admin review of revisions):**

- **Finding pending revisions:** query `visaRevisions` where
  `reviewStatus == "pending_review"`. This is a single-field query, so the
  automatic index covers it.
- **Approve:** in one transaction, apply `changes` to the live doc (`null`
  becomes `FieldValue.delete()`), delete the revision doc, and record
  `reviewedBy` and `reviewedAt` on the live doc. Re-check `updatedAt` inside
  the transaction, because the agency can still edit a pending revision.
  `assertVisaApprovable` needs a finite `baseCostUsd` on the result.
- **Reject:** set `reviewStatus: "rejected"`, `rejectionReason`,
  `reviewedBy` and `reviewedAt` on the revision. The live doc is untouched.
- **Withdrawing a revision:** the agency has no endpoint for this yet. See
  the follow-ups.

## Admin side (issue #101)

Code: `agency-visa-review.service.ts` (list enrichment, review state machine,
make-global, owner emails), wired into `src/controllers/visa.controller.ts`
and `src/routes/visa.routes.ts`. Tests:
`test/agency-visas/agency-visa-review.test.ts`.

**Authz.** Every admin route runs `verifyAuth` (401) and `verifyAdmin` (403).
The controller then checks the shared CASL ability for `update` on the
`reviewStatus` field (list, review) or the `visibility` field (make-global).
It checks first on a tagged empty probe, before any read, and then again on
the real doc tagged `asSubject("Visa", doc)` inside the transaction. An agency
owner of the visa matches the #98 conditional grant, but the field-level
`cannot` on `VISA_PROTECTED_FIELDS` still refuses them, so they get **403**.
No check uses a string subject.

### `GET /admin/visas`

Lists every reviewable visa: drafts are left out, and `pending_review`,
`approved` and `rejected` are included. Scraped and seed rows are unchanged
from before #101. Agency rows (`source: "agency"`) also carry these fields:

| Field | Value |
| --- | --- |
| `ownerAgencyId`, `createdBy`, `visibility`, `sponsor` | As stored. |
| `agencyName` | `agencies/{ownerAgencyId}.name`, read on the server. It is `null` when the agency doc is missing. The client never supplies it. |
| `pendingRevision` | The `visaRevisions/{cc}__{id}` doc when its `reviewStatus` is `"pending_review"`, otherwise `null`. A rejected revision is not shown here. |

An approved visa whose `pendingRevision` is not null needs review: its live
values are approved, and the edit is waiting.

Optional query filters (400 `VALIDATION_ERROR` on a bad value):

- `?source=scraped` returns only `source: "scraped"`. Seed and legacy
  `"agent"` visas are left out.
- `?source=agency` returns only agency visas.
- `?agencyId=<id>` returns only that agency's visas. It combines with
  `source`.

Filters run in code over the existing per-country scan, so no new query and
no new index are needed. Pending revisions are read with one equality query
on `visaRevisions.reviewStatus`, which the automatic index covers.

### `PATCH /admin/visas/:id/review` for an agency visa

The body is unchanged: `{ action: "approve" | "reject", countryCode, reason?,
revisionUpdatedAt? }`. `reason` is required on reject. For agency visas the
controller sends the request to the agency review, which runs one
transaction. Every other visa keeps the existing path.

| Visa state | approve | reject |
| --- | --- | --- |
| `draft` | 409 `VISA_IS_DRAFT` | 409 `VISA_IS_DRAFT` |
| `pending_review` | `reviewStatus: "approved"`, `isActive: true`, `reviewedBy`, `reviewedAt`. `visibility` stays `"agency"`. | `reviewStatus: "rejected"`, `rejectionReason`, `isActive: false`, `reviewedBy`, `reviewedAt` |
| `approved` with a pending revision | Applies the revision (see below) | Rejects the revision (see below) |
| `approved` with no pending revision | **200** `reviewOutcome: "unchanged"`. Nothing is written and no email is sent (idempotent). | 409 `VISA_NOT_IN_REVIEW` |
| `rejected` | 409 `VISA_NOT_IN_REVIEW` | 409 `VISA_NOT_IN_REVIEW` |

A rejected visa can be edited (#100), but it must be **resubmitted** before an
admin can approve it.

**Cost guard.** Approve needs a finite `baseCostUsd` on the visa, or on the
visa with the revision applied. Without one the answer is
**409 `VISA_COST_MISSING`**, with the message "Add the government fee in USD
(baseCostUsd) to this visa before approving it". The shared guard
(`assertVisaApprovable`) runs after it.

**Revisions.**

- `revisionUpdatedAt` is required, and must equal `pendingRevision.updatedAt`
  as the admin loaded it. Send the serialised Timestamp as received
  (`{ _seconds, _nanoseconds }`), an ISO 8601 string, or millis.
  - missing: 400 `VALIDATION_ERROR`, `field: "revisionUpdatedAt"`;
  - unparseable: 400;
  - different from the stored value, checked inside the transaction:
    **409 `REVISION_CHANGED`**. The agency edited the revision after the
    admin opened it, so the admin should reload. Nothing is written.
- **Approve** writes only the agency content keys found in `changes` (the
  `AGENCY_VISA_CONTENT_FIELDS`, except `countryCode`), with `null` becoming
  `FieldValue.delete()`. It also writes `reviewedBy`, `reviewedAt` and
  `updatedAt`, and deletes the revision doc. Any other key in `changes` is
  ignored, so review state, visibility and ownership can never come from a
  revision. The live visa stays `approved` and active, and keeps its
  visibility.
- **Reject** sets `reviewStatus: "rejected"`, `rejectionReason`, `reviewedBy`
  and `reviewedAt` on the revision. The live doc is not written, so the
  previous approved values stay live with `isActive: true`. The agency's next
  edit reopens the revision (#100).

The response is `200` with the visa as stored, plus `reviewOutcome`:
`approved | rejected | revision_approved | revision_rejected | unchanged`.

### `PATCH /admin/visas/:id/visibility` (new)

The body is `{ countryCode, visibility: "global" | "agency" }`.

| Case | Result |
| --- | --- |
| Approved agency visa, new value `"global"` | Writes `visibility: "global"`, `madeGlobalBy` (uid), `madeGlobalAt`, `updatedAt`. The visa now appears in `/visas`, `/countries/:code/visas`, search, popular and the country stats. |
| Approved agency visa, new value `"agency"` | Writes `visibility: "agency"`, `madeAgencyOnlyBy`, `madeAgencyOnlyAt`, `updatedAt`. The visa drops out of the public reads again. |
| Same value as stored | **200** `visibilityOutcome: "unchanged"`. Nothing is written and no email is sent. |
| Agency visa that is not `approved` | 409 `VISA_NOT_APPROVED` |
| Not an agency visa | 409 `NOT_AN_AGENCY_VISA` |
| Unknown id | 404 `NOT_FOUND` |
| Bad `visibility` or missing `countryCode` | 400 `VALIDATION_ERROR` |

Both who-and-when pairs are kept as history and never cleared. The current
state is always `visibility`, and the later of `madeGlobalAt` and
`madeAgencyOnlyAt` tells which switch came last. `ownerAgencyId`, `source`
and the review fields are never written, so the agency tag stays. The owning
agency sees the visa in `/agency/visas` either way. The response is `200`
with the visa, plus `visibilityOutcome`:
`made_global | made_agency_only | unchanged`. Country stats are recomputed
after every change (best effort).

### Emails to the agency owner

Emails are sent through `notificationService.notifyUser` (in-app, push and
email via Resend) to `agencies/{ownerAgencyId}.ownerId`, after the write
commits.

| Event | Type | Title (also the email subject) |
| --- | --- | --- |
| Visa approved | `agency_visa_approved` | "Seli approved <visa name>" |
| Revision approved | `agency_visa_approved` | "Seli approved your changes to <visa name>" |
| Visa rejected | `agency_visa_rejected` | "<visa name> needs changes". The body includes the reason. |
| Revision rejected | `agency_visa_rejected` | "Your changes to <visa name> need work". The body includes the reason. |
| Made global | `agency_visa_made_global` | "<visa name> is now on Seli for everyone" |

Taking a visa back to agency-only sends **no** email. The agency's own access
and pages don't change, so there is nothing for it to act on. Idempotent
calls (`unchanged`) send nothing.

The email button opens `/our-visas` (`AGENCY_VISAS_PATH` in
`src/services/email/event-templates.ts`). **#104 should use this portal
route, or update the constant.**

An email failure never fails or rolls back the action. A missing agency or
owner, or a `notifyUser` rejection, is logged
(`[agency-visa-review] … email failed`) and the response is still 200.
`notifyUser` itself checks the provider's `EmailResult` and logs any status
other than "sent".

## Firestore indexes (`firestore.indexes.json`)

| Query | Index |
| --- | --- |
| list: group `visaTypes` where `ownerAgencyId ==`, order by `createdAt desc` | `visaTypes` (COLLECTION_GROUP): `ownerAgencyId` ASC, `createdAt` DESC |
| get by id: group `visaTypes` where `ownerAgencyId ==` and `id ==` | `visaTypes` (COLLECTION_GROUP): `ownerAgencyId` ASC, `id` ASC |
| revisions of an agency: `visaRevisions` where `ownerAgencyId ==` | automatic single-field index |
| admin list (#101): `visaRevisions` where `reviewStatus == "pending_review"` | automatic single-field index |

## Reachable through the agency (issue #102)

Code: `agency-visa-access.ts` (the rules and the applicant-safe projection),
wired into `src/controllers/visa.controller.ts`,
`src/services/application.service.ts`,
`src/controllers/application.controller.ts` and the public page
(`agency-visa-prices/agency-visa-price.service.ts`). Tests:
`test/agency-visas/agency-visa-access.test.ts`.

### Who reaches an agency-only visa

An agency-only visa is `source: "agency"`, `visibility: "agency"`. It is
**usable** only when `reviewStatus: "approved"` and `isActive: true`
(`isApprovedAgencyVisa`). Drafts, pending, rejected and inactive visas are
never usable, by anyone, the owner included.

| Caller | Public page `/agencies/public/:slug` | Detail, `/full`, `/requirements` | Start a case |
| --- | --- | --- | --- |
| Anonymous | Sees the owning agency's approved visas (applicant-safe) | 404 | n/a (401) |
| Applicant with no case at the agency | Same as anonymous | 404 | Only with an agent of the owning agency (`mode: "agent"`, `agentId`), so the case belongs to it |
| Applicant with a case whose `agencyId` is the owning agency | Same | **200**, applicant-safe | Same as above |
| Anyone with a readable case **on this visa** (any agency) | Same | **200**, applicant-safe (existing cases keep loading their visa after it is taken back to agency-only) | Same rule as their role |
| Owner or agent of the owning agency | Same | **200**, full doc (any state, CASL #98 grant) | **201** via `POST /applications/for-client` |
| Owner or agent of another agency | Same | 404 | 404 |
| Admin | Same | **200**, full doc | Only when acting for the owning agency (`agencyId` in the body) |

- Every denial is the **same 404 body as an unknown id**
  (`{ success: false, error: "NOT_FOUND", message: "Visa type not found" }`).
- The applicant rule is the firm one: an applicant sees an agency-only visa
  on the single-visa endpoints **only through an application** (checked with
  the shared CASL `read` on the tagged Application, so `checkApplicationAccess`
  semantics). "Arriving through the agency link" means the public page
  itself: its `visaPrices[]` entries carry the applicant-safe detail (below).
  No slug or link parameter unlocks the single-visa endpoints or case start.
- **Case start.** `POST /applications` and `POST /applications/for-client`
  compute the agency the new case belongs to (from its agent, or the agency an
  admin acts for), then `canStartCaseOnVisa(visa, caseAgencyId)`: a public
  visa for any case, an approved agency-only visa only for a case of
  `ownerAgencyId`. A refusal is 404 `NOT_FOUND` "Visa type not found", the
  same as an unknown id, and nothing is written. `for-client` checks **before**
  it provisions a client account, sends an invite, or opens a conversation.
- The detail queries reached for a non-public visa: `applications where
  userId ==` (automatic index), `applications where agencyId == <claim> and
  visaTypeId ==` and `applications where agentId == uid and visaTypeId ==`
  (composite indexes added to `firestore.indexes.json`).

### Applicant-safe fields

Applicants, anonymous callers and other agencies never get the sponsor
licence number, the sponsor contact, `createdBy`, `submittedBy`, the review
fields (`reviewedBy`, `reviewedAt`, `rejectionReason`, `submittedAt`), the
make-global audit fields, `agentIds` or `scrapeMeta`.

- **Detail / `/full`:** `toApplicantSafeVisa`, a whitelist
  (`APPLICANT_SAFE_VISA_FIELDS`): `id`, `countryCode`, `name`, `code`,
  `description`, `category`, `processingTime`, `processingDaysMin`,
  `processingDaysMax`, `baseCostUsd`, `validityPeriod`, `isExtendable`,
  `maxExtensions`, `eligibilityCriteria`, `applicationUrl`,
  `applicationInstructions`, `sourceUrl`, `isActive`, `source`, `visibility`,
  `ownerAgencyId`, `createdAt`, `updatedAt`, and
  `sponsor: { organisationName, website? }`. It applies to every
  agency-created visa served to a non-privileged caller, **including one made
  global**. Scraped and seed visas are served as stored, as before.
- **Public page:** see `../agency-visa-prices/agency-visa-prices.md`.

### `firestore.rules` (direct client reads)

- `countries/{cc}/visaTypes/{id}`: readable only when the doc matches
  `isVisaPubliclyVisible` (active, visibility global or missing, reviewStatus
  approved or missing), or by an admin. Before #102 any `isActive == true` doc
  was readable, including approved agency-only visas.
- `.../requirements/{id}`: readable only when the parent visa is publicly
  visible, or by an admin (was `if true`).
- `visaRevisions/{id}` and `agencies/{id}/visaPrices/{id}`: explicit
  `allow read, write: if false` (backend only).

There is no rules test harness in the repo. The rules were checked by hand
on the Firestore emulator (alternate port, `demo-` project): seed, global,
agency-only, pending and inactive visas, their requirements, a revision and a
price, as anonymous, a client token and an admin token.

## Listing screening (issue #120)

Code: `agency-visa-screening.service.ts` (storage, caps, signals, hook,
rerun), `../services/risk-rules/listing-comparison.rules.ts` (pure code
comparisons), `../services/risk-rules/listing-language.rules.ts` (the three
indicators and flag validation), `../services/ai/listing-screening-prompt.ts`
(prompt, schema, content hash). Tests: `test/agency-visas/agency-visa-screening.test.ts`,
`listing-screening-rules.test.ts`, `listing-screening-generic.test.ts`, and the
emulator role matrix `test/emulator/listing-screening.emu.ts`.

Seli screens a listing **for an admin**, never for the agency or applicants.
Screening never changes the listing, its review state, `isActive`,
`visibility` or a revision, never notifies anyone, and never appears in an
agency or applicant response. The agency endpoints answer exactly the same
whether screening succeeded, failed or was skipped.

**When it runs** (inside the request, after the transaction commits, never
throws, stops waiting after 20 s, failures logged without listing text):

- `POST /agency/visas/:id/submit` (draft or rejected to `pending_review`):
  screens the visa content (`target: "visa"`).
- `PUT|PATCH /agency/visas/:id` on an `approved` visa that writes or changes a
  `visaRevisions` doc: screens live content plus the proposal
  (`target: "revision"`). The live doc stays untouched and visible.
- Not on draft create, draft edit, a rejected edit, or an edit that deletes
  the revision.

**Code comparison** (no model). The listing is compared only with a verified
record: a `countries/{cc}/visaTypes` doc with `source: "scraped"`,
`reviewStatus: "approved"`, `isActive`, and the same `code` after trim and
upper-casing. If none matches (or more than one does) nothing is judged. Each
field is skipped on its own when the verified side lacks it, and a mismatch is
only raised when the verified record gives a verbatim citation and an http(s)
`scrapeMeta.sourceUrl`; the signal carries both as its source.

| Field | Rule |
| --- | --- |
| `baseCostUsd` | Whole USD both sides; verified fee must have none of `feeUnverified`, `fxMissing`, `fxStale`, `noPublishedFee` and a finite value. Flagged when `|listing - verified| > max(1, ceil(5% of verified))` (`LISTING_FEE_TOLERANCE_PCT`, a screening noise threshold, not an immigration fact). Citation `fee.application`. |
| `category` | Exact. Citation `category`. |
| `isExtendable` | Exact boolean. Citation `isExtendable`. |
| `processingDays` | The `[min, max]` ranges must overlap; skipped when the verified record is `processingUnknown` or lacks a value. Citation `processingTime`. |

**Language check** (model locates, code decides). Three indicators registered
in `RISK_RULES`, each with its published quote and URL on the rule entry:
`listing_guaranteed_outcome`, `listing_payment_for_job_offer`,
`listing_identity_document_retention`. The model (role `extraction`, no tools)
gets only the listing's text fields (`name`, `description`,
`applicationInstructions`, each eligibility criterion,
`sponsor.organisationName`), wrapped with `wrapUntrusted(text, "listing")`.
It returns `{ flags: [{ indicator, field, quote }] }`; code accepts a flag only
when the indicator is registered, the field is one of the fields above, and the
quote is non-empty, at most 200 characters and an exact substring of that
field. At most 10 are accepted; the rest are counted in `droppedFlags`. A reply
that is not valid JSON is a model failure. Severity comes from a code table
(identity documents `high`, the others `medium`).

**Storage.** `listingScreenings/{cc}__{visaId}` (backend-only, no
`firestore.rules` match): `target`, `contentHash`, `ranAt`, `countryCode`,
`visaId`, `ownerAgencyId`, `comparisons[]`, `verifiedVisaId`, `languageCheck`
(`done | not_run`) with `notRunReason` (`ai_disabled | settings_unavailable |
cap_reached | model_failed`), `flags[]` (the quotes, admin-only),
`droppedFlags`, `injectionSuspected`, `signalIds[]`.

**Signals** are raised only through `riskSignalService.raiseRiskSignal`, subject
`{ type: "visa", id: "{cc}__{visaId}" }`, `source.kind: "rule"`, `dedupeKey`
`{ruleId}:visa:{cc}__{visaId}`. Types: `listing_contradicts_verified_record`,
`listing_recruitment_language`, and a low `listing_screening_incomplete` when
the language check did not run. Evidence is references and structured facts
only (field name, indicator, character offsets, a hash of the quote,
`contentHash`, money as `{ value, currency: "USD", unit: "major" }`). A listing
with no mismatch and no flag raises nothing. The same `contentHash` again
writes nothing; a changed edit adds new evidence and merges into the active
signal.

**Caps and settings** (`appConfig/aiSettings`): `listingScreeningsPerDay`
(default 200, 1 to 10000) and `listingScreeningsPerAgencyPerDay` (default 20,
1 to 1000), counted in requests in `aiCosts/{day}` (`listingScreenings` and a
per-agency map) in one transaction, failing closed. The model call is skipped
when AI is disabled, the settings cannot be read, a cap is reached or the
provider fails. The code comparison always runs. No entitlement is needed.

**Admin touchpoints.**

- `GET /admin/visas`: agency rows gain `screening` (the stored doc, or `null`;
  `ranAt` is a serialised Timestamp `{ _seconds, _nanoseconds }` like the other
  dates on the row) and `openScreeningSignals` (count of open or in-review
  risk signals for this visa). Scraped and seed rows are unchanged.
- `PATCH /admin/visas/:id/review` with `action: "approve"` on a new submit or a
  pending revision: **409 `SCREENING_OPEN`** unless the screening is clean for
  the content about to go live (a doc for this target and hash with
  `languageCheck: "done"`, no mismatch, no flag) or the body has
  `acknowledgeScreening: true`. Nothing is written on the 409. Reject is never
  blocked. An approve of an already approved visa with no revision stays
  idempotent.
- `POST /admin/visas/:id/screening/rerun` with `{ countryCode }`: re-screens the
  current target (the recovery path after a model outage). 404 for an unknown
  or non-agency visa, 409 `NO_SCREENING_TARGET` when nothing is waiting for
  review. 200 `{ screening, openScreeningSignals, status }`.

Out of scope (follow-ups): comparing sponsor requirement and work rights;
re-screening live listings when a verified record changes.

## Follow-ups (out of scope for #100)

- ~~`firestore.rules` direct read of agency-only visas~~: done in #102.
- An agency endpoint to withdraw (delete) a pending revision.
- #101: an admin can't take down an APPROVED agency visa with the review
  endpoint (reject only works from `pending_review`, as the #100 review asked).
  Making it agency-only hides it from the public. A separate "deactivate"
  admin action would be a follow-up if Seli needs to pull one completely.
- A visa's `requirements` subcollection (steps and documents) for agency
  visas. Today only `eligibilityCriteria` is captured.
