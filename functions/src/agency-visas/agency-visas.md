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

## Admin review of the visa itself (existing endpoint)

Once an agency visa is submitted, it appears in `GET /admin/visas` with
`reviewStatus: "pending_review"` and `source: "agency"`.
`PATCH /admin/visas/:id/review` works on it as it does on any other visa:

- **approve** sets `isActive: true` and `reviewStatus: "approved"`. It does
  not change `visibility`, which stays `"agency"` until make-global (#101).
  It needs a finite `baseCostUsd`.
- **reject** sets `reviewStatus: "rejected"` and `rejectionReason`.

Drafts get 409 `VISA_IS_DRAFT`.

## Firestore indexes (`firestore.indexes.json`)

| Query | Index |
| --- | --- |
| list: group `visaTypes` where `ownerAgencyId ==`, order by `createdAt desc` | `visaTypes` (COLLECTION_GROUP): `ownerAgencyId` ASC, `createdAt` DESC |
| get by id: group `visaTypes` where `ownerAgencyId ==` and `id ==` | `visaTypes` (COLLECTION_GROUP): `ownerAgencyId` ASC, `id` ASC |
| revisions of an agency: `visaRevisions` where `ownerAgencyId ==` | automatic single-field index |

## Follow-ups (out of scope for #100)

- `firestore.rules`: `countries/{cc}/visaTypes` lets any client read a doc
  with `isActive == true` directly. That includes an approved
  `visibility: "agency"` visa, which bypasses the #99 API rule. The rule
  should also require global visibility and an approved or missing review
  state.
- An agency endpoint to withdraw (delete) a pending revision.
- A visa's `requirements` subcollection (steps and documents) for agency
  visas. Today only `eligibilityCriteria` is captured.
