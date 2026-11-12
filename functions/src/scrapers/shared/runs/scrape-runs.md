# Scrape runs: run records, admin API, retention (issue #81)

Every visa-catalog and news scraper run leaves one `scrapeRuns/{runId}` doc,
so admins can see what ran, how long it took, what it found and what failed
without reading Cloud Functions logs. Code: `src/scrapers/shared/runs/scrape-run.service.ts`
(recorder + reads), `src/scrapers/shared/runs/types.ts` (schema),
`src/scrapers/shared/runs/scrape-run.controller.ts` (API).

## When a run is recorded

| Scraper | Trigger | Recorded when |
| --- | --- | --- |
| `crawlVisaCatalogOrchestrator` (hourly :15) | `scheduled` | the tick has at least one due, in-window source. Idle ticks (most of them) write nothing. |
| `scrapeNewsOrchestrator` (every 30 min) | `scheduled` | at least one news source is due. |
| `scrapers/visa-catalog/scripts/crawl-visa-catalog.ts` | `script` | always (after the args check); the run id is printed at the end. |
| admin "Run now" (#96): `processScrapeRunRequest` | `manual` | always (one source, or every due source with windows ignored); see `shared/settings/scraper-settings.md`. |

Lifecycle: the doc is written `running` before any FX / fetch / LLM work, then
finalised once with `succeeded` (no errors), `partial` (errors, but something
worked: a page fetched / a news source scraped) or `failed` (errors and
nothing worked, or the run threw: `fatalError`). A run that crashes stays
`running`; every scheduled tick (idle or not, either scraper) and every script
run first sweeps `running` docs older than 1h to `failed` with
`fatalError: "stale: ..."`. The sweep re-reads each doc in a transaction and
only flips it while it is still `running`; a run that finalises after being
swept gets its real status and the stale `fatalError` is cleared.

Run-level **warnings** (`warnings[]`, max 10) record problems that are not
errors: a failed FX refresh (previous rates used) or a failed fee re-convert.
They never change `status` or `errorCount`, so a clean crawl stays `succeeded`.

Recording never breaks a crawl: write failures are logged and swallowed.

Per-source logs link back: `visaSources/{cc}/crawlRuns/{id}.runId` and
`newsSources/{id}/scrapeRuns/{id}.runId`. The run doc's `sources[].sourceRunId`
points the other way.

## Document shape (`scrapeRuns/{runId}`)

```jsonc
{
  "id": "Ab12...",
  "kind": "visa",                 // visa | news
  "trigger": "scheduled",         // scheduled | manual | script
  "status": "partial",            // running | succeeded | partial | failed
  "startedAt": Timestamp,         // run clock (the tick's `now`)
  "finishedAt": Timestamp | null, // startedAt + real elapsed; null while running
  "durationMs": 81234 | null,
  "summary": { ... },             // the scraper's full summary, verbatim (below)
  "sourcesAttempted": 2,
  "pagesAttempted": 14,
  "sources": [ {                  // max 100
    "sourceId": "GB", "name": "United Kingdom",
    "status": "partial",          // succeeded | partial | failed | deferred | empty (no page attempted: no pages, or the extraction cap was used up)
    "pagesAttempted": 8, "pagesFetched": 7, "errors": 1,
    "sourceRunId": "crawlRunDocId",
    "counts": { "created": 1, "updated": 0, "proposed": 2, "skipped": 0,
                "withdrawn": 0, "unchanged": 4, "deferred": 0, "visasIngested": 3 },
    "error": "..."                // news: when the source failed outright
  } ],
  "pages": [ {                    // visa only, max 300 (pagesTruncated: true past that)
    "sourceId": "GB", "url": "https://www.gov.uk/...", "routeName": "Skilled Worker visa",
    "outcome": "proposed",        // created|updated|proposed|skipped|unchanged|withdrawn|deferred|capped|supplement|error
    "visaId": "gb-skilled-worker",// -> countries/GB/visaTypes/{visaId}
    "error": "...",
    "reason": "..."               // e.g. supplement rows: whether a route fetched it this run
  } ],
  "pagesTruncated": false,
  "errorCount": 1,                // all errors (>= errors.length)
  "errors": [ { "sourceId": "GB", "url": "...", "message": "...", "at": Timestamp } ], // first 20, redacted
  "fatalError": "...",            // only when the run threw / went stale
  "warnings": ["FX refresh failed: ..."], // run-level, not errors
  "options": { "maxSources": 3, "maxExtractions": 15 }, // script: country, visa, limit, maxExtractions, force
  "usage": { ... },               // #82: tokens, extractions, news requests (src/scrapers/shared/cost/scrape-costs.md)
  "costUsd": 0.0042,              // #82: run cost in USD
  "costBreakdown": { "byCountry": {...}, "byModel": {...} }, // #82
  "expireAt": Timestamp,          // startedAt + 180 days (TTL field)
  "createdAt": Timestamp, "updatedAt": Timestamp
}
```

`summary` keys:

- visa (`CrawlSummary`): `sourcesProcessed, pagesFetched, pagesChanged,
  promptReextracts, created, updated, skipped, proposed, withdrawn, restored,
  errors, fxRefreshed, feesReconverted, hostsBackedOff, pagesDeferred,
  linkedSurchargeErrors` (script runs add `unchanged`).
- news (`OrchestratorResult`): `sourcesProcessed, newArticles, errors,
  articlesFound, articlesDuplicate, articlesFailed, sourcesDeferred,
  hostsBackedOff, requestsAttempted`.

All error text goes through `redactSecrets()` (`src/scrapers/shared/fetch/redact.ts`, from
#76): `apikey=` / `X-Api-Key:` pairs, `Bearer` tokens and the literal values
of `NEWS_API_KEY_*` and `DEEPSEEK_API_KEY` are replaced with `[REDACTED]`.

## Extending it (#82 cost, #83 alerting)

- Add counters to `CrawlSummary` / `OrchestratorResult`: they land in
  `summary` with no schema change.
- `usage` / `costUsd` / `costBreakdown` are written by #82 (see
  `src/scrapers/shared/cost/scrape-costs.md`); visa page lines also carry `usage`, `costUsd`,
  `model`, `promptVersion`.
- Finalize hook: `scrapeRunService.registerFinalizeHook(async (run) => ...)`
  runs after every run's final write with the final doc (a throwing hook is
  logged and ignored). Use it for the cost rollup and the post-run alert
  rules. Stale sweeps do not call hooks; #83's hourly check reads the latest
  finished run per scraper itself. Alerting: see [scrape-alerts.md](../alerts/scrape-alerts.md).

## Admin API

All routes: `Authorization: Bearer <Firebase ID token>`; 401 without a token,
403 unless the CASL ability allows `read` on `ScrapeRun` (admins only,
`@durin-tech/authz` 0.1.5). Responses use the usual envelope
`{ success, data }` / `{ success: false, error, message }`. **All dates are
ISO-8601 strings.**

### `GET /admin/scrape-runs`

Query (all optional, each at most once, else 400 `VALIDATION_ERROR`):

| Param | Values |
| --- | --- |
| `kind` | `visa` \| `news` |
| `status` | `running` \| `succeeded` \| `partial` \| `failed` |
| `from`, `to` | ISO date/time or epoch ms; inclusive bounds on `startedAt`; `from > to` → 400 |
| `limit` | 1..100, default 25 (larger values are capped) |
| `cursor` | the previous page's `nextCursor`; unknown → 400 `INVALID_CURSOR` |

`200 { data: { items: RunListItem[], nextCursor: string | null } }`, newest
first. `RunListItem` = the run doc without `pages`, `sources` and `errors`
(so it includes `usage`, `costUsd` and `costBreakdown`, #82).

### `GET /admin/scrape-runs/stats`

Per-UTC-day run counts by status, per kind (dashboard overview, #84).

| Param | Values |
| --- | --- |
| `from`, `to` | ISO date/time or epoch ms, inclusive on `startedAt`. Defaults: `to` = now, `from` = `to` − 30 days. At most 90 days; `from > to` → 400 |
| `bucket` | `day` only (default) |
| `kind` | `visa` \| `news` (default both) |

```jsonc
{ "data": {
  "from": "2026-11-01T00:00:00.000Z", "to": "2026-11-10T23:59:59.000Z",
  "bucket": "day", "kinds": ["visa", "news"],
  "buckets": [   // every UTC day in range, oldest first, zero-filled
    { "date": "2026-11-01",
      "visa": { "succeeded": 3, "partial": 1, "failed": 0, "running": 0, "total": 4 },
      "news": { "succeeded": 46, "partial": 1, "failed": 1, "running": 0, "total": 48 } }
  ],
  "totals": { "visa": { ... }, "news": { ... } },
  "scanned": 520,      // run docs read
  "truncated": false   // true if the 10,000-doc scan cap was hit (oldest days undercounted)
} }
```

Computed by one bounded, projected scan (`kind`, `status`, `startedAt`) over
the range rather than 720 count queries; uses the existing
`kind+startedAt` index (or the single-field `startedAt` index without `kind`).

### `GET /admin/scrape-runs/:id`

`200 { data: Run }` (the whole doc, ISO dates), or 404 `NOT_FOUND`.

### `GET /admin/scrape-sources?kind=visa|news`

Both kinds when `kind` is omitted (visa first). `200 { data: SourceHealth[] }`:

```jsonc
{
  "kind": "visa", "sourceId": "GB", "name": "United Kingdom", "countryCodes": ["GB"],
  "status": "active",              // visa: active|paused|broken; news: + retired
  "reliabilityScore": 92 | null, "consecutiveFailures": 0,
  "lastCrawledAt": "ISO" | null, "nextCrawlAt": "ISO" | null,
  "crawlWindow": { "timeZone": "Europe/London", "dayOfWeek": 1, "startHour": 2, "endHour": 5 } | null, // visa only
  "intervalHours": 168 | null,     // visa legacy interval; news scrapeIntervalMinutes/60
  "hostBackoffs": [ { "host": "www.gov.uk", "until": "ISO", "status": 429, "recordedAt": "ISO" } ], // active only; [] for news
  "lastError": { "message": "...", "at": "ISO" | null, "url": "..." } | null, // visa: latest page error
  "pageCount": 12 | null, "pagesWithErrors": 1 | null,  // visa only
  // Issue #107 (additive):
  "autoPaused": false,             // true while the CRAWLER holds it: `broken` at the failure limit,
                                   // or `paused` for a missing news API key; false for an admin / registry pause
  "autoPausedAt": "ISO" | null,
  "autoPausedReason": "HTTP 404 ..." | null,      // the last error when it was paused (redacted)
  "autoPauseCause": "failure_limit" | "missing_api_key" | null,
  "consecutiveFailureLimit": 5,    // <kind>.consecutiveFailureLimit in force (appConfig/scraperSettings)
  "statusReason": "..." | null     // why the registry seed ships it paused / retired (news)
}
```

Run source lines (`scrapeRuns/{id}.sources[]`, the run detail) also carry
`health: { consecutiveFailures, consecutiveFailureLimit, autoPaused,
autoPausedThisRun }` after each crawled source's health write (#107), and the
summaries count `sourcesAutoPaused` (both kinds) and, for news,
`sourcesPaused` (news_api sources skipped for a missing key).

## Indexes

`firestore.indexes.json` (collection `scrapeRuns`, all `startedAt DESC`):
`kind + startedAt`, `status + startedAt`, `kind + status + startedAt`.
`startedAt` alone and the sweep's `status == running` use single-field indexes.

## Retention: 180 days via Firestore TTL

Each run doc carries `expireAt = startedAt + 180 days`. Firestore deletes a doc
(typically within 24h of that instant) once a TTL policy exists on collection
group `scrapeRuns`, field `expireAt`. The policy is declared in
`firestore.indexes.json`:

```json
"fieldOverrides": [
  { "collectionGroup": "scrapeRuns", "fieldPath": "expireAt", "ttl": true, "indexes": [] }
]
```

It is applied by the normal CI `firebase deploy` of Firestore indexes (CI owns
the database's contents; see `infra/terraform/firestore.tf` in the meta-repo).
Nothing to do by hand. To check or enable it manually on a project:

```bash
gcloud firestore fields ttls list --project <project>
gcloud firestore fields ttls update expireAt --collection-group=scrapeRuns --enable-ttl --project <project>
```

If Terraform should own it instead, the equivalent resource is:

```hcl
resource "google_firestore_field" "scrape_runs_ttl" {
  project    = google_project.seli_dev.project_id
  database   = google_firestore_database.default.name
  collection = "scrapeRuns"
  field      = "expireAt"
  ttl_config {}
  index_config {} # no single-field indexes on the TTL field
}
```

(Pick one owner, not both.)

Notes:

- The collection ID `scrapeRuns` is shared with the legacy per-source news log
  `newsSources/{id}/scrapeRuns`. The TTL policy only deletes docs that have an
  `expireAt`. Since issue #19 the per-source news logs carry one too
  (`startedAt` + 30 days, written by `newsService.createScrapeRun`), so this
  same collection-group policy prunes them; the weekly `cleanupOldNews`
  sweep that used to do it was removed. Logs written before #19 get the
  field from `npm run backfill:expireat`.
- The emulator ignores TTL policies.
