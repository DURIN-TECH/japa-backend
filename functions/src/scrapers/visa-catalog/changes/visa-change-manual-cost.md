# Manual USD cost on a proposed visa edit (issue #77)

A proposed edit to a live visa (`pendingVisaChanges`, #61) whose new fee the
scraper could not convert to USD is blocked: approve answers
`409 FEE_NOT_CONVERTED`. This endpoint lets an admin set the USD cost by hand,
with the same rules and audit block as #70 (`PUT /admin/visas/:id/manual-cost`
for pending scraped visas). After it, the existing approve path accepts the
proposal and writes `baseCostUsd = round(amountUsd)` to the live visa.

Code: `visa-change-manual-cost.ts` (pure parse + plan),
`visaChangeService.setManualCost` (transaction), `visa-change.controller.ts`.
Shared with #70 in `../visa-manual-cost.ts`: `parseManualCostFields`,
`buildManualCostFee`, `markManualCostReplaced`.

## Contract

`PUT /admin/visa-changes/:id/manual-cost`

```json
{
  "amountUsd": 93.6,
  "reason": "CBC rate 1 TWD = 0.0312 USD on 2026-11-10",
  "rates": [{ "currency": "TWD", "usdPerUnit": 0.0312 }],
  "expectedRevision": 1
}
```

- `amountUsd`: JSON number, `0 <= x <= 100000` (0 = a confirmed free visa).
- `reason`: string, 10 to 500 characters after trimming.
- `rates`: exactly one entry per distinct non-USD currency among the
  PROPOSED fee's components (`proposedScrapeMeta.fee.components`); `[]` when
  there is none. `usdPerUnit` > 0 is USD per ONE unit. Never `USD`; the old
  single `rate` field is refused.
- `expectedRevision`: REQUIRED, the row `revision` the admin reviewed.

Auth: `verifyAuth` (401), then CASL `update` on `VisaChange` (admin-only) before
any validation or read (403).

| Status | `error` | When |
| --- | --- | --- |
| 200 | | The updated row (`data`): new `revision`, `approvable` / `blockReason` recomputed. |
| 400 | `VALIDATION_ERROR` | Bad body, or rates not matching the fee's currencies |
| 403 | `FORBIDDEN` | Not an admin |
| 404 | `NOT_FOUND` | No such row (or unaddressable id), or its visa is gone |
| 409 | `ALREADY_RESOLVED` | The row is approved / rejected |
| 409 | `REVISION_MISMATCH` | The crawl replaced the row since the admin looked |
| 409 | `STALE_PROPOSAL` | The live visa changed since the proposal was made |
| 409 | `FEE_ALREADY_CONVERTED` | The fee guard does not block this proposal (and it has no manual cost to correct) |

Every refusal writes nothing.

## What it writes

On the ROW only (the live visa is untouched until approve), in one
transaction:

- `proposedScrapeMeta.fee`: components / totals as published, `totalUsd =
  amountUsd`, `fxSource: "manual"`, `fxDate` = today, no
  fxMissing / fxStale / feeUnverified / noPublishedFee flags, and the
  `manualCost` audit block: `amountUsd`, `reason`, `rates`, `setBy`, `setAt`,
  `contentHash`, `previous` (the scraper's flags / conversion it overrode) and
  `supersedes` when correcting an earlier manual cost.
- `proposed.baseCostUsd` and the fee diff entry's `baseCostUsdAfter` =
  `Math.round(amountUsd)`.
- `approvable`, `blockReason` (removed when approvable; may stay set for a
  non-fee block such as `ELIGIBILITY_REMOVED`), `updatedAt`.

`revision` + 1. Setting or changing a cost is a new revision of the
proposal, so an approve sent with the revision seen BEFORE the cost was set
(or before another admin changed it) answers `409 REVISION_MISMATCH`. The
response row carries the new revision; the portal approves with it. The
crawl's replace path keeps counting from it (`openRow.revision + 1`); no crawl
logic depends on the revision staying fixed. The response row is built inside
the transaction (read + patch), so it is exactly what was committed.

## Overwrite rule

- A later crawl with the SAME page text writes nothing: the manual cost stays.
- CHANGED page text replaces the open row (revision + 1) with the new
  extraction's fee. The manual cost it dropped is kept on the row as
  `replacedManualCost` (the manual entry + `replacedAt` +
  `replacedByContentHash`), so the replacement is visible. It sits at row
  level, so approve never copies it onto the live visa. Later replacements
  carry it forward.
