# Scrape cost: LLM token usage, prices, monthly rollup (issue #82)

What scraping costs, per extraction, run, country, model and month, and what a
re-extract would cost before it runs. Builds on the run records of #81
(`docs/scrape-runs.md`).

Code: `src/services/scrape-cost-pricing.ts` (pure maths + the default price
table), `src/services/scrape-cost.service.ts` (Firestore: price table, budget,
rollup, report, the #83 reader), `src/types/scrape-cost.ts` (shapes).

## Where usage comes from

The DeepSeek extractor reads the `usage` object of each chat-completions
response (`prompt_tokens`, `completion_tokens`, `total_tokens`,
`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`) and reports it through
`ExtractContext.onUsage` **before** the output is validated, so a call whose
output is rejected is still counted (it was billed). Nothing estimates tokens
except the explicit re-extract estimate below.

Each call is recorded in four places:

| Where | Fields |
| --- | --- |
| run page line `scrapeRuns/{id}.pages[]` | `usage`, `costUsd`, `pricedAs`, `model`, `promptVersion` (also on an `error` page after a billed call) |
| visa doc `scrapeMeta` | `llmUsage`, `llmCostUsd`, `llmPricedAs`, `llmResponseModel` (when the API names a different model), plus the existing `model` and `extractorPromptVersion` |

**Which price applies**: the model the API says served the call (response
`model`) is looked up first (by key or alias), then the requested model. The
entry used is recorded as `pricedAs` (e.g. `deepseek-flash`). A cost that
comes out non-finite is treated as **unpriced** (no `costUsd`,
`unpricedExtractions` + 1), never as $0.
| run doc | `usage`, `costUsd`, `costBreakdown.byCountry` / `.byModel` |
| eval results file | per route `usage` / `costUsd`; file-level `usage`, `costUsd`, `pricing` |

## Price table: `appConfig/llmPricing`

```jsonc
{
  "currency": "USD",
  "verifiedAt": "2026-11-10",          // last checked against the provider's page
  "models": {
    "deepseek-flash": {
      "inputPer1M": 0.30,              // input, cache miss (peak)
      "cachedInputPer1M": 0.006,       // input, cache hit (peak)
      "outputPer1M": 1.20,             // output (peak)
      "offPeak": { "inputPer1M": 0.15, "cachedInputPer1M": 0.003, "outputPer1M": 0.60 },
      "peakWindowsUtc": [
        { "startHour": 1, "endHour": 4, "isoWeekdays": [1,2,3,4,5] },
        { "startHour": 6, "endHour": 10, "isoWeekdays": [1,2,3,4,5] }
      ],
      "aliases": ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"],
      "effectiveFrom": "2026-09-10",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing",
      "note": "..."
    }
  },
  "requestPricing": {}                 // provider -> { perRequestUsd, effectiveFrom, sourceUrl }
}
```

Source of every number: <https://api-docs.deepseek.com/quick_start/pricing>,
checked 2026-11-10. The page lists `deepseek-flash` (DeepSeek-V4.1-Flash-1017)
at, per 1M tokens, peak / off-peak: input cache hit $0.006 / $0.003, input
cache miss $0.30 / $0.15, output $1.20 / $0.60, and says "Off-peak rates are
half of the peak rates" with peak hours "01:00–04:00 and 06:00–10:00 UTC,
Monday through Friday, excluding Chinese public holidays".

- **effectiveFrom 2026-09-10**: the change log
  (<https://api-docs.deepseek.com/updates>) entry for V4.1 Flash says "API
  prices have been reduced accordingly"; the 2026-10-17 entry says "pricing
  remain unchanged".
- **Why `deepseek-chat` is billed as Flash**: the extractor requests
  `deepseek-chat`. The change log (2026-04-24) says it points to the
  non-thinking mode of `deepseek-v4-flash`, and the pricing page says the
  legacy `deepseek-v4-flash` name is served by V4.1-Flash and "billed at the
  Flash price". The same entry announced `deepseek-chat` would be
  discontinued on 2026-07-24; it still answered on 2026-11-10, with the
  response's `model` = `deepseek-flash` (stored as
  `scrapeMeta.llmResponseModel`). Switching the model name is a model change: it
  needs the eval (`functions/CLAUDE.md`).
- **Peak vs off-peak**: each call is costed at the rate for the hour its
  response arrived (UTC). Chinese public holidays are not modelled, so a call
  on one is costed at the peak rate (an over-estimate). The scheduled visa
  crawl runs at each country's local night, which can be inside DeepSeek's
  UTC peak (GB 02:00–05:00 London = peak on weekdays).
- `deepseek-v4-pro` is not in the table: we do not call it and the page gives
  no effective date for its price. A model with no entry (by key or alias) is
  **unpriced**: its tokens are counted, `costUsd` is left out and
  `unpricedExtractions` goes up. Never $0, never a guessed price.
- News APIs (NewsData.io, NewsAPI): our plans have no per-call price, so
  `requestPricing` is empty and requests are counted only.

Seeding: `seed-all` writes `DEFAULT_LLM_PRICING` (in
`scrape-cost-pricing.ts`) when the doc is **absent** and never overwrites it.
When the doc is missing or malformed, runs use the default table (logged
with `console.error`) and the report says `pricing.origin: "default"`.
"Malformed" is strict: every model needs finite, non-negative peak prices,
`sourceUrl` and `effectiveFrom`; an `offPeak` rate needs the same three
prices **and** a valid `peakWindowsUtc` (0 <= startHour < endHour <= 24,
non-empty ISO weekdays 1..7); `aliases` must be strings; `requestPricing`
entries need a finite `perRequestUsd`. To change prices: edit the doc (and
the default + its quote in code, so a fresh project seeds the same numbers),
with `sourceUrl`, `effectiveFrom` and `verifiedAt`.

A cost is fixed when the run is recorded: a later price change does not
re-price old runs or months.

## Budget: `appConfig/scrapeBudget`

```json
{ "monthlyUsd": 20 }
```

A separate doc from the price table: prices are the provider's facts (copied
from its page), the budget is our policy (set by an admin), and they change
for different reasons. Absent doc or `monthlyUsd` not a number = no budget
(`null` everywhere). Covers all scraping (LLM + priced API calls). Set it by
hand for now (Firestore console or a one-off script); #83 alerts on it.

## Run doc fields (`scrapeRuns/{runId}`)

```jsonc
"usage": {                 // CostTotals
  "runs": 1, "extractions": 3, "unpricedExtractions": 0,
  "promptTokens": 15000, "completionTokens": 2100,
  "cacheHitTokens": 9000, "cacheMissTokens": 6000,
  "costUsd": 0.0042,
  "requests": { "newsdata": 2 }    // news API calls per provider
},
"costUsd": 0.0042,         // = usage.costUsd
"costBreakdown": {
  "byCountry": { "GB": { ...CostTotals, "runs": 1 } },   // visa sourceId
  "byModel":   { "deepseek-chat": { ...CostTotals, "runs": 1 } }
}
```

Written by `finalize()` / `fail()` on every run (zeros when nothing was
called). `GET /admin/scrape-runs` list items include `usage`, `costUsd` and
`costBreakdown`; `GET /admin/scrape-runs/:id` also has the per-page fields.
A run swept as stale (crashed) has no usage: it lived in the crashed
process's memory.

## Monthly rollup: `scrapeCosts/{YYYY-MM}`

UTC month of the run's `startedAt`. Kept by a `scrapeRunService` finalize hook
(installed when `scrape-cost.service.ts` is loaded, which every scraper path
does). One transaction per run reads the marker
`scrapeCosts/{month}/runs/{runId}` and the month doc, and writes both; if the
marker exists the run is skipped, so the rollup is **idempotent per runId**
(a late finalize after a stale sweep, a retried hook).

```jsonc
{
  "month": "2026-11",
  "totals":    { ...CostTotals },                    // every kind
  "byKind":    { "visa": { ...CostTotals, "byCountry": {...}, "byModel": {...} },
                 "news": { ...CostTotals, "byCountry": {}, "byModel": {} } },
  "byCountry": { "GB": { ...CostTotals } },          // every kind (only visa has countries)
  "byModel":   { "deepseek-chat": { ...CostTotals } },
  "updatedAt": Timestamp
}
```

**Backfill**: finalize writes `costRolledUp: false` on the run doc and the
rollup transaction sets it `true` (with the marker). If the hook fails, the
run stays `false`; `scrapeCostService.backfillRecent(nowMs)` re-applies such
finished runs of the current and previous UTC month (`backfillMonth(month)`,
at most 50 per month per call, oldest first; idempotent through the marker).
It runs at the start of every hourly visa orchestrator tick (idle ticks
included); #83's hourly check can call it too. Query: `costRolledUp == false`
+ `startedAt` range, index `scrapeRuns (costRolledUp ASC, startedAt ASC)` in
`firestore.indexes.json`. Normally it matches nothing.

`runs` in a country / model bucket = runs that touched it. News runs have no
country (no LLM; their requests are in `byKind.news.requests`). Rollup docs
have no TTL (12 small docs a year).

## Reader for #83 (stable)

```ts
import { scrapeCostService } from "../services/scrape-cost.service";
const mtd: ScrapeCostMonthToDate = await scrapeCostService.monthToDate(nowMs?);
// {
//   month: "2026-11",                 // UTC
//   costUsd: number,                  // month to date, 0 before the first run
//   budgetUsd: number | null,         // appConfig/scrapeBudget.monthlyUsd
//   budgetUsedFraction: number | null,// costUsd / budgetUsd; null without a budget (or 0)
//   totals: CostTotals,
//   byKind: { visa?: CostTotals, news?: CostTotals },
//   updatedAt: string | null          // ISO, last rollup write
// }
```

Two doc reads; throws on a Firestore read failure (the caller decides).
Type: `ScrapeCostMonthToDate` in `src/types/scrape-cost.ts`.

## Admin API: `GET /admin/scrape-costs`

`Authorization: Bearer <Firebase ID token>`; 401 without, 403 unless CASL
allows `read` on `ScrapeRun` (admins). Envelope `{ success, data }`.

| Param | Values |
| --- | --- |
| `from`, `to` | `YYYY-MM`, or an ISO date/time / epoch ms (its UTC month); inclusive. Defaults: `to` = current month, `from` = `to` − 5 months. At most 24 months; `from > to` → 400 |
| `groupBy` | `month` (default) \| `country` \| `model` \| `kind` |
| `kind` | `visa` \| `news`; filters every `groupBy` (the budget block stays all-kinds) |

Each param at most once (else 400 `VALIDATION_ERROR`).

```jsonc
{ "data": {
  "from": "2026-06", "to": "2026-11", "groupBy": "month", "kind": null, "currency": "USD",
  "groups": [                         // month: every month, oldest first, zero-filled;
    { "key": "2026-06", ...CostTotals }, //  else one row per key, highest costUsd first
    { "key": "2026-11", "runs": 52, "extractions": 14, "unpricedExtractions": 0,
      "promptTokens": 70000, "completionTokens": 9800, "cacheHitTokens": 42000,
      "cacheMissTokens": 28000, "costUsd": 0.0213, "requests": { "newsdata": 96 } }
  ],
  "totals": { ...CostTotals },        // whole range, kind-filtered
  "budget": { "monthlyUsd": 20, "month": "2026-11", "monthToDateUsd": 0.0213,
              "usedFraction": 0.001065, "configPath": "appConfig/scrapeBudget.monthlyUsd" },
  "pricing": {
    "origin": "config",               // or "default" (doc missing / malformed)
    "configPath": "appConfig/llmPricing", "verifiedAt": "2026-11-10",
    "models": [ { "model": "deepseek-flash", "inputPer1M": 0.3, "cachedInputPer1M": 0.006,
                  "outputPer1M": 1.2, "offPeak": {...}, "peakWindowsUtc": [...],
                  "aliases": [...], "effectiveFrom": "2026-09-10",
                  "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing" } ],
    "requestPricing": []
  }
} }
```

Reads at most 24 month docs + 3 config/rollup docs. No index needed.

## Re-extract estimate (before a prompt bump)

```bash
# against the emulator or --project <id>; no LLM, no fetch, no writes, no key
node lib/scripts/crawl-visa-catalog.js --estimate [--country GB] [--visa student] [--assume-bump]
```

Counts, per source, the pages a #71 re-extract would queue (pending scraped
docs from another `EXTRACTOR_PROMPT_VERSION`, plus pages with no doc yet;
with `--assume-bump`, every pending scraped doc) and every extractable page
(the `--force` upper bound), then prices them as
**pages × average recorded tokens per extraction × price**, from the last 50
visa runs' `usage`. It prints an all-off-peak and an all-peak figure, the
basis (how many recorded extractions) and the price source. With no recorded
usage yet, or no price for the model, it says so and prints no USD figure.
Helper: `estimateReextractCost()` in `scrape-cost-pricing.ts`.

The scheduled crawl drains a queue at `maxExtractions` (15) per run, so the
cost is spread over several runs.
