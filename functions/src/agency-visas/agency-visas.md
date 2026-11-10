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

## Follow-ups (out of scope for #100)

- `firestore.rules`: `countries/{cc}/visaTypes` lets any client read a doc
  with `isActive == true` directly. That includes an approved
  `visibility: "agency"` visa, which bypasses the #99 API rule. The rule
  should also require global visibility and an approved or missing review
  state.
- An agency endpoint to withdraw (delete) a pending revision.
- #101: an admin can't take down an APPROVED agency visa with the review
  endpoint (reject only works from `pending_review`, as the #100 review asked).
  Making it agency-only hides it from the public. A separate "deactivate"
  admin action would be a follow-up if Seli needs to pull one completely.
- A visa's `requirements` subcollection (steps and documents) for agency
  visas. Today only `eligibilityCriteria` is captured.
