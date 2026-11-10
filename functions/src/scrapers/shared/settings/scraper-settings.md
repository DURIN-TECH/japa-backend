# Scraper settings + manual runs: admin API contract (issue #96)

Admins control both scrapers from the portal (#97): global on/off switches,
limits, the LLM budget and its hard stop, alert config, the LLM price table,
per-source controls, and "Run now". Code: `src/scrapers/shared/settings/`.

All routes sit behind `verifyAuth` (no / bad token -> 401), then the shared
CASL ability, checked BEFORE any validation or Firestore read:

| Action | CASL | Non-admin |
| --- | --- | --- |
| every `GET` | `read ScrapeRun` | 403 `FORBIDDEN` |
| every `PATCH` / `POST` | `update ScrapeRun` | 403 `FORBIDDEN` |

Only admins hold `ScrapeRun` (via `manage all`); the authz catalog is unchanged.

Envelope (as every other admin route): success
`{ "success": true, "data": ... }`; error
`{ "success": false, "error": "<CODE>", "message": "...", "field"?: "...", ... }`.
A validation error ALWAYS names the offending field in `field` (dotted path,
e.g. `"visa.maxExtractionsPerRun"`, `"alerts.thresholds.errorRatePct"`,
`"pricing"`, `"crawlWindow.endHour"`). All dates are ISO-8601 strings.

---

## 1. `GET /admin/scraper-settings`

Everything, with defaults filled in (defaults = the code constants in use
before #96, so an empty Firestore behaves exactly as before).

```jsonc
{
  "visa": {
    "enabled": true,                 // scheduled visa ticks run (kill switch)
    "blockManualWhenOff": false,     // when enabled=false, also refuse Run now
    "maxExtractionsPerRun": 15,      // LLM calls per run (was DEFAULT_MAX_EXTRACTIONS)
    "maxSourcesPerTick": 3           // countries per run (was DEFAULT_MAX_SOURCES)
  },
  "news": {
    "enabled": true,
    "blockManualWhenOff": false,
    "maxSourcesPerRun": 5            // was the hard-coded 5
  },
  "manualRuns": {
    "cooldownMinutes": 10            // per source / per scraper, between Run now requests
  },
  "budget": {
    "monthlyUsd": 20,                // appConfig/scrapeBudget.monthlyUsd; null = no budget
    "hardStop": false,               // stop visa LLM extraction once month-to-date >= budget
    // read-only, computed:
    "month": "2026-11",              // current UTC month
    "monthToDateUsd": 0.0123,        // scrapeCosts/{month} total
    "hardStopActive": false          // hardStop && monthlyUsd != null && monthToDateUsd >= monthlyUsd
  },
  "alerts": {                        // appConfig/scrapeAlerts, resolved over the engine defaults
    "enabled": true,
    "recipientUserIds": [],          // admin uids; [] = every admin
    "extraRecipientEmails": [],      // NEW: extra addresses that also get alert emails (max 20)
    "email": {
      "immediate": true, "immediateMinSeverity": "warning",
      "digest": false, "digestHourUtc": 7, "digestMinSeverity": "info"
    },
    "thresholds": {
      "stuckRunMinutes": 60, "errorRatePct": 20, "errorRateMinPages": 5,
      "backoffConsecutiveRuns": 2, "linkedSurchargeErrors": 1, "fxFailingHours": 48,
      "budgetPcts": [50, 80, 100], "reviewQueueMaxAgeDays": 7, "missedWindowGraceHours": 2
    },
    "rules": { "error_rate": { "enabled": false }, "run_failed": { "severity": "warning" } },
    // read-only: every rule id with its default severity (for the UI's rule table)
    "ruleDefaults": [ { "rule": "run_failed", "defaultSeverity": "critical" }, ... ]
  },
  "pricing": {
    "origin": "config",              // "config" = appConfig/llmPricing; "default" = built-in table (doc absent / invalid)
    "table": { "currency": "USD", "models": { ... }, "requestPricing": { ... }, "verifiedAt": "2026-11-01" }
  },
  "updatedAt": "2026-11-10T12:00:00.000Z" | null,   // appConfig/scraperSettings
  "updatedBy": "adminUid" | null
}
```

Alert rule ids: `run_failed`, `run_stuck`, `missed_window`, `source_broken`,
`error_rate`, `host_backoff`, `linked_surcharge`, `fx_refresh_failing`,
`llm_budget`, `review_queue_stale`, and NEW `budget_hard_stop` (critical: a
visa run skipped extraction because of the hard stop).

## 2. `PATCH /admin/scraper-settings`

Partial update: send only what changes. Objects merge key by key (incl.
`alerts.email`, `alerts.thresholds`, `alerts.rules.<rule>`); arrays replace.
`pricing.table` replaces the WHOLE price table. Unknown keys -> 400.

```jsonc
{
  "visa":   { "enabled": false, "maxExtractionsPerRun": 1 },
  "news":   { "maxSourcesPerRun": 3 },
  "manualRuns": { "cooldownMinutes": 5 },
  "budget": { "monthlyUsd": 25, "hardStop": true },          // monthlyUsd: null clears the budget
  "alerts": { "extraRecipientEmails": ["ops@example.org"], "thresholds": { "errorRatePct": 30 },
              "rules": { "error_rate": { "enabled": false, "severity": "info" } } },
  "pricing": { "table": { /* full LlmPricingDoc */ } }
}
```

Validation (400 `VALIDATION_ERROR`, `field` names the first bad field):

| Field | Rule |
| --- | --- |
| `visa.enabled`, `news.enabled`, `*.blockManualWhenOff`, `budget.hardStop` | boolean |
| `visa.maxExtractionsPerRun` | integer 1..200 (the run stops at the cap; to stop spending use `enabled` or the hard stop) |
| `visa.maxSourcesPerTick` | integer 1..50 |
| `news.maxSourcesPerRun` | integer 1..50 |
| `manualRuns.cooldownMinutes` | integer 0..1440 |
| `budget.monthlyUsd` | null, or a finite number 0..100000 |
| `alerts.*` | the engine's own `resolveConfig` rules (any value it would reject -> 400, field = `alerts.<its path>`); `extraRecipientEmails`: up to 20 valid addresses; `rules.<id>`: known rule ids only |
| `pricing.table` | `isValidPricingDoc`, plus `currency: "USD"` and a `verifiedAt` string. Invalid -> 400 `field: "pricing.table"`, nothing saved |

-> 200 with the same body as `GET` (new values). A body with no change -> 200,
nothing written, no history entry.

Storage (the engines keep reading the docs they read today):

| Section | Doc |
| --- | --- |
| `visa`, `news`, `manualRuns`, `budget.hardStop` | `appConfig/scraperSettings` (new) |
| `budget.monthlyUsd` | `appConfig/scrapeBudget` (#82) |
| `alerts` | `appConfig/scrapeAlerts` (#83) |
| `pricing.table` | `appConfig/llmPricing` (#82) |

Each written doc gets `updatedAt` + `updatedBy` (admin uid). One
`scraperSettingsHistory/{id}` entry per PATCH that changed something (below).

## 3. `GET /admin/scraper-settings/history?limit=&cursor=`

Newest first. `limit` default 25, max 100; `cursor` = previous `nextCursor`
(unknown -> 400 `INVALID_CURSOR`).

```jsonc
{ "items": [ {
    "id": "h1",
    "at": "2026-11-10T12:00:00.000Z",
    "by": "adminUid",
    "target": "settings",            // "settings" | "source:visa:GB" | "source:news:cic-news"
    "changes": [ { "path": "visa.maxExtractionsPerRun", "before": 15, "after": 1 } ]
  } ],
  "nextCursor": "h0" | null }
```

## 4. `PATCH /admin/scrape-sources/:kind/:id` (per source)

`kind`: `visa` (id = country code, `GB`) | `news` (id = newsSources doc id).

```jsonc
{
  "status": "paused",                // active | paused | retired ("broken" is set by the crawler only)
  "reason": "Site redesign, selectors broken",   // required for paused / retired; max 500 chars
  "crawlWindow": { "timeZone": "Europe/London", "dayOfWeek": 1, "startHour": 2, "endHour": 5 },
                                     // visa only; null = back to the registry default window
  "resetFailures": true,             // consecutiveFailures -> 0 (a `broken` source becomes `active`)
  "clearHostBackoffs": true          // visa only: drop every stored 429/503 backoff
}
```

- Window validated with `assertValidCrawlWindow` (400, `field: "crawlWindow"`);
  a new window also moves `nextCrawlAt` to its next opening.
- News + `crawlWindow` / `clearHostBackoffs` -> 400 (news has neither).
- Unknown source -> 404 `NOT_FOUND`. Empty body -> 400.
- Stored as `adminOverrides` on the source doc
  (`{ status?, reason?, crawlWindow?, updatedAt, updatedBy }`), applied to the
  live fields at once. **Re-seeding keeps them** (visa and news seeders).
- -> 200 with the source's health row (same shape as `GET /admin/scrape-sources`,
  plus `adminOverrides`). A history entry is written (`target: "source:<kind>:<id>"`).

`GET /admin/scrape-sources` rows now also carry `adminOverrides` (or null).

## 5. `POST /admin/scrape-sources/:kind/:id/run` (Run now, one source)

Body `{ "force"?: boolean }` (`force`: ignore the content-hash gate, so every
page re-extracts within the extraction limit; ignored for news).

-> **202** at once:

```jsonc
{ "requestId": "req123", "runId": null, "status": "queued" }
```

The crawl runs asynchronously in the Firestore-triggered function
`processScrapeRunRequest` (on `scrapeRunRequests/{id}` create). It runs the
normal orchestrator for that one source with `trigger: "manual"` and its own
`scrapeRuns` record. It IGNORES the crawl window and `nextCrawlAt`, and STILL
obeys robots.txt, host backoff (#64), `maxExtractionsPerRun` and the budget
hard stop. Poll section 7 for `runId` (set when the run starts) and the outcome.

Errors:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | bad `kind`, `force` not boolean, unknown body key |
| 404 | `NOT_FOUND` | no such source |
| 409 | `RUN_IN_PROGRESS` | a manual run of this source is queued / running; body has `requestId` |
| 409 | `RUN_COOLDOWN` | the last request for this source was < `cooldownMinutes` ago; body has `retryAfter` (ISO) |
| 409 | `SOURCE_NOT_ACTIVE` | the source is `paused` or `retired` (a `broken` one may run) |
| 409 | `SCRAPER_DISABLED` | the scraper is off and `blockManualWhenOff` is set |

## 6. `POST /admin/scrapers/:kind/run` (Run now, whole scraper)

Same body, response and errors (no 404 / `SOURCE_NOT_ACTIVE`). Runs every DUE
active source now, ignoring crawl windows (visa: up to `maxSourcesPerTick`;
news: the normal due batch, up to `maxSourcesPerRun`). One in flight per
scraper, same cooldown. Nothing due -> the request ends `skipped`.

## 7. `GET /admin/scrape-run-requests/:id`

```jsonc
{
  "id": "req123",
  "kind": "visa",
  "scope": "source",                 // source | scraper
  "sourceId": "GB" | null,
  "force": false,
  "status": "queued",                // queued | running | succeeded | failed | skipped
  "runId": "run456" | null,          // the scrapeRuns doc, once the run started
  "requestedBy": "adminUid",
  "requestedAt": "...", "startedAt": "..." | null, "finishedAt": "..." | null,
  "summary": { ... } | null,         // the run's summary (CrawlSummary / OrchestratorResult)
  "skipReason": "nothing due" | null,
  "error": "redacted message" | null
}
```

`succeeded` = the orchestrator finished (the run itself may be `partial` /
`failed`: read `scrapeRuns/{runId}`); `failed` = the worker threw; `skipped` =
nothing to run (no due source, source no longer active, scraper disabled with
`blockManualWhenOff`). Unknown id -> 404. Requests are TTL-deleted 30 days after
`requestedAt` (`expireAt`).

---

## Runtime behaviour

- **Kill switch.** Each scheduled tick reads `appConfig/scraperSettings` ONCE
  at its start. `enabled: false` -> the tick returns at once: no stale sweep,
  no run doc, no fetch, no LLM call.
- **Limits.** The same read supplies `maxExtractionsPerRun` / `maxSourcesPerTick`
  (visa) and `maxSourcesPerRun` (news). Missing / invalid values fall back to
  the defaults above (never throws).
- **Hard stop.** With `hardStop` on and a budget set, a visa run checks
  month-to-date cost (+ this run's own cost so far) before each LLM call. At
  or over budget: pages are still fetched and hashed, a changed page keeps its
  OLD `lastContentHash` (so it stays pending and re-extracts once the budget
  allows) and gets `extractionDeferredAt`; its run line is `capped` with
  reason `budget hard stop`. The run records a warning, `summary.budgetHardStop:
  true` and `summary.extractionsSkippedBudget`, and the post-run alert rule
  `budget_hard_stop` raises a critical alert (auto-resolved by the next visa
  run without the stop).
- **One in flight + cooldown.** Enforced in a transaction on
  `scrapeRunLocks/{kind}__{sourceId | _all}` while creating the request. A
  queued / running request older than 15 minutes is treated as dead.

## Firestore

New collections (backend-only; `firestore.rules` has no match, so clients are
denied): `appConfig/scraperSettings`, `scraperSettingsHistory`,
`scrapeRunRequests` (TTL `expireAt`), `scrapeRunLocks`. All new queries are
single-field (`orderBy at desc`), so no composite index is needed; the TTL
override for `scrapeRunRequests.expireAt` is in `firestore.indexes.json`.
