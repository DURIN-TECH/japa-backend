# Scrape alerts: rules, storage, email, admin API (issue #83)

Admins find out when a scrape goes wrong without watching a dashboard. Rule
checks run after every visa / news run and once an hour; each problem becomes
one `scrapeAlerts/{alertId}` doc that is bumped while it lasts and resolved
when it clears. New and escalated alerts are emailed to admins, and every alert
action writes one structured log line (the Cloud Monitoring backstop in the
meta-repo, `infra/terraform/monitoring_scrape_alerts.tf`).

Code: `src/scrapers/shared/alerts/scrape-alert-rules.ts` (pure rule logic),
`src/scrapers/shared/alerts/scrape-alert.service.ts` (store, email, checks, reads),
`src/scrapers/shared/alerts/scrape-alert-cost.ts` (adapter over #82's cost rollup),
`src/scrapers/shared/alerts/types.ts` (schema), `src/scrapers/shared/alerts/scrape-alert.controller.ts`
(API). Run records it reads: [scrape-runs.md](../runs/scrape-runs.md).

## When rules run

| Trigger | Where | Rules |
| --- | --- | --- |
| After every run (scheduled / manual) | #81 finalize hook, registered in `index.ts` (`scrapeAlertService.onRunFinalized`) | `run_failed`, `run_stuck` (clears the run's own), `error_rate`, `linked_surcharge`, `budget_hard_stop` (#96), `host_backoff`, `source_broken` (that scraper) |
| Hourly, :45 UTC | `checkScrapeAlerts` scheduled function (`runHourlyCheck`; 300s timeout, 256MB) | `run_stuck`, `run_failed` (latest finished run per scraper), `missed_window`, `source_broken`, `host_backoff` clears (below), `fx_refresh_failing`, `llm_budget`, `review_queue_stale`; then emails held back by a late hook (`emailPending`) and the daily digest |

Script runs (`trigger: "script"`, the CLI) never alert. Stale sweeps (#81) fire
no hook, so the hourly check reads the latest finished run of each scraper
itself: a run the sweep marked `failed` raises `run_failed` within the hour.
A read failure skips only that rule for that check (logged, see below) and
never resolves its alerts.

**Post-run time budget.** The hook runs inside the scraper function's 540s
timeout, after the crawl. `run.durationMs` (real elapsed time) decides:
>= 450s (`HOOK_NO_EMAIL_AFTER_MS`) the alerts are stored but not emailed; they
get `emailPending: true` and the next hourly check emails them and clears the
flag. >= 500s (`HOOK_SKIP_AFTER_MS`) the hook does nothing: the hourly check
still catches `run_failed`, the other per-run rules are lost for that run.

## Rules

| Rule | Dedupe key | Raised when | Clears when | Default severity |
| --- | --- | --- | --- | --- |
| `run_failed` | `run_failed:<kind>` | the run (hook) / latest finished run (hourly) is `failed` | a later run of that scraper is `succeeded` / `partial` | critical |
| `run_stuck` | `run_stuck:<runId>` | `running` for more than `stuckRunMinutes` | the run is no longer running | critical |
| `missed_window` | `missed_window:<cc>` | an `active` visa source with a `crawlWindow` (#63): its last window closed (+ `missedWindowGraceHours`) and `lastCrawledAt` is before that window opened. Sources created after the opening are skipped | it is crawled | warning |
| `source_broken` | `source_broken:<kind>:<id>` | status `broken` (auto-paused at 5 consecutive failures), or `paused` with >= 5 failures. A manual pause alone does not alert | status changes | critical |
| `error_rate` | `error_rate:<kind>` | `errorCount / pagesAttempted` above `errorRatePct`, runs with >= `errorRateMinPages` pages | such a run is under the threshold | warning |
| `host_backoff` | `host_backoff:<kind>:<host>` | a host answered 429/503 (#64) on `backoffConsecutiveRuns` consecutive runs **that touched it** (runs for other countries do not break the streak) | a run touches the host without a backoff | warning |
| `linked_surcharge` | `linked_surcharge:visa` | `summary.linkedSurchargeErrors >= linkedSurchargeErrors` (#69) | a visa run below it | warning |
| `fx_refresh_failing` | `fx_refresh_failing:fx` | `appConfig/fx.fetchedAt` older than `fxFailingHours` **and** the latest visa run's refresh failed (`summary.fxRefreshed === false`) (#59) | a refresh succeeds | warning |
| `llm_budget` | `llm_budget:<YYYY-MM>` | month-to-date LLM cost >= a `budgetPcts` level; `level` = highest reached | new month / under every level | 50% info, 80% warning, 100% critical |
| `budget_hard_stop` (#96) | `budget_hard_stop:visa` | a visa run's `summary.budgetHardStop` is true: the hard stop (`appConfig/scraperSettings.budget.hardStop`) skipped extraction because month-to-date cost reached the budget | a visa run without it | critical |
| `review_queue_stale` | `review_queue_stale:visa` | a scraped visa pending review (queued at max(createdAt, restoredAt)) or an open `pendingVisaChanges` row waiting longer than `reviewQueueMaxAgeDays` | nothing is that old | info |

How `host_backoff` sees hosts: visa page lines (`pages[]`, every line's host is
"touched"; an `error`/`deferred` line with a backoff message marks the host) and
`errors[].url` with a backoff message (both scrapers). News runs keep no page
lines, so a later news run counts as touching the host when it processed a
source that was seen with that host.

A backoff alert also clears on the hourly check, without a run, when every
source it was seen with (`details.sources`) is no longer `active` (paused,
broken, retired or deleted), or when the host's last "retry after"
(`details.backoffUntil`) has passed.

**Budget (#82):** the rule reads `scrapeAlertService.costSource`, an adapter
(`src/scrapers/shared/alerts/scrape-alert-cost.ts`) over #82's `scrapeCostService.monthToDate()`
(`{ costUsd, budgetUsd }` -> `{ monthUsd, budgetUsd }`): spend from the
`scrapeCosts/{YYYY-MM}` rollup, budget from `appConfig/scrapeBudget.monthlyUsd`.
The hourly check first calls `scrapeCostService.backfillRecent()` so runs whose
post-run rollup was lost are counted. No budget set (`null`) = rule skipped.

## Dedupe, escalation, resolution

- One **active** (open or acknowledged) alert per dedupe key. The pointer doc
  `scrapeAlertKeys/{sha256(key)[0..40]} = { dedupeKey, alertId, createdAt }`
  exists only while it is active and is read inside the upsert transaction, so
  concurrent checks can't open two.
- Seen again: `lastSeen`, `message`, `details` refresh and `count` goes up by 1,
  unless it is the **same occurrence** (`eventIds`, max 20: run id, window
  opening). So the hourly re-read of a run the hook already reported doesn't
  count twice.
- **Escalated** when the severity or `level` goes up (budget 50 -> 80 -> 100).
  It keeps the highest severity, sets `escalatedAt` and re-opens an
  acknowledged alert (`acknowledgedBy/At` cleared).
- **Auto-resolved** when the condition clears: `status: resolved`,
  `resolvedBy: "system"`, `autoResolved: true`, pointer deleted. A resolved alert
  is never re-opened; a recurrence creates a new alert (and a new email).
  Race guard: inside the resolve transaction, an alert whose `lastSeen` is later
  than the evaluation's start (another check re-raised it meanwhile) is left
  alone.
- **Resolved by hand**: when the alert has occurrence ids, the pointer stays as
  a tombstone (`suppressEventIds`, `resolvedAt`, pointing at the resolved alert).
  A check that sees one of those SAME occurrences again (the hourly check
  re-reading the run the admin resolved) skips it: no new alert, no email. A
  new occurrence (a new failing run) opens a new alert; an auto-resolve deletes
  the tombstone. Alerts without occurrence ids (source_broken, fx, review
  queue) free the key, so a condition that still holds opens a new alert.
- A rule disabled in config has its active alerts resolved.

## Document shape (`scrapeAlerts/{alertId}`)

```jsonc
{
  "id": "Xy12...",
  "rule": "run_failed",
  "dedupeKey": "run_failed:visa",
  "severity": "critical",           // critical | warning | info (highest seen while active)
  "level": 80,                      // llm_budget only
  "kind": "visa",                   // visa | news | null
  "subject": { "type": "scraper", "id": "visa", "label": "Visa scraper" },
                                    // type: scraper | run | source | host | fx | budget | review_queue
  "message": "Visa scraper run Ab12 failed: ...",
  "details": { "runId": "Ab12", "errorCount": 3 },   // flat facts, per rule
  "lastRunId": "Ab12",
  "firstSeen": Timestamp, "lastSeen": Timestamp, "count": 2,
  "eventIds": ["Ab12", "Cd34"],     // internal, not returned by the API
  "emailPending": false,            // true while a late post-run hook's email waits for the hourly check
  "escalatedAt": Timestamp,         // when it last escalated
  "status": "open",                 // open | acknowledged | resolved
  "acknowledgedBy": "uid" | null, "acknowledgedAt": Timestamp | null,
  "resolvedBy": "uid" | "system" | null, "resolvedAt": Timestamp | null,
  "autoResolved": false,
  "expireAt": Timestamp,            // TTL: lastSeen + 180d while active, resolvedAt + 180d once resolved
  "createdAt": Timestamp, "updatedAt": Timestamp
}
```

## Config: `appConfig/scrapeAlerts`

Written with the defaults on the first check if missing. Each value is
validated on its own; an invalid one falls back to its default and is logged.

```jsonc
{
  "enabled": true,                  // master switch (false: no checks, no emails)
  "recipientUserIds": [],           // admin uids; [] = every admin (users.admin == true). Non-admins are skipped.
  "extraRecipientEmails": [],       // #96: extra addresses that also get every alert email / digest (max 20; branded email service, no user opt-out)
  "email": {
    "immediate": true,              // email new + escalated alerts right away (one email per check)
    "immediateMinSeverity": "warning",
    "digest": false,                // daily digest of active alerts
    "digestHourUtc": 7,
    "digestMinSeverity": "info"
  },
  "thresholds": {
    "stuckRunMinutes": 60, "errorRatePct": 20, "errorRateMinPages": 5,
    "backoffConsecutiveRuns": 2, "linkedSurchargeErrors": 1, "fxFailingHours": 48,
    "budgetPcts": [50, 80, 100], "reviewQueueMaxAgeDays": 7, "missedWindowGraceHours": 2
  },
  "rules": { "review_queue_stale": { "enabled": false }, "error_rate": { "severity": "critical" } }
}
```

`appConfig/scrapeAlertsState` holds `lastDigestDay` / `lastDigestAt` (the
digest is claimed in a transaction, so it goes out at most once per UTC day).

## Email

Server-side only, through `notificationService.notifyUser` (type
`scrape_alert`, channel `email` only, so the Resend provider and the branded
template; without `RESEND_API_KEY` it takes the stub path and records a
`notificationDeliveries` row). Subject = the title (no event template):
`[Critical] Visa scraper: run failed`, or `[Critical] 3 new scraper alerts` when
one check raised several (one email per check, not per alert). The CTA links to
`APP_URL + /admin/scrapers?tab=alerts` (TODO #84: the dashboard's real route).
Acknowledged alerts are not emailed again unless they escalate. An email that
lists a **critical** alert is sent with notifyUser's existing `critical: true`
flag (the one security emails use), so it reaches admins who switched email
off; warning / info emails respect the opt-out. If every admin opted out and
nothing is critical, only the log line is written. Tests use
`delivered+<name>@resend.dev`.

The scraper functions (`crawlVisaCatalogOrchestrator`, `scrapeNewsOrchestrator`)
and `checkScrapeAlerts` bind `RESEND_API_KEY` / `EMAIL_FROM`.

## Structured logs (Cloud Monitoring backstop)

One JSON line per alert action via the firebase-functions logger (lands as
`jsonPayload` with a real `severity`):

```jsonc
{
  "severity": "CRITICAL",           // critical->CRITICAL, warning->WARNING, info->INFO; resolved/acknowledged->INFO
  "message": "scrape alert created: [Critical] Visa scraper run Ab12 failed: ...",
  "event": "scrape_alert",
  "action": "created",              // created | bumped | escalated | resolved | acknowledged
  "alert": { "id", "rule", "dedupeKey", "severity", "status", "kind", "subject", "count", "firstSeen", "lastSeen", "lastRunId" }
}
```

Engine failures (a read, a write, config, email) log
`{ "severity": "ERROR", "event": "scrape_alert_engine_error", "stage": "...", "message": "..." }`.
The Terraform policies page on `event="scrape_alert"` + `action` created/escalated
+ `severity=CRITICAL`, and on any `scrape_alert_engine_error`.

## Admin API

`Authorization: Bearer <Firebase ID token>`; 401 without a token. CASL:
list / get need `read ScrapeRun`, acknowledge / resolve need `update ScrapeRun`.
Both are admin-only through `manage all` (no other role holds `ScrapeRun`), so
no `@durin-tech/authz` change. 403 otherwise, before any read. Envelope
`{ success, data, message? }` / `{ success: false, error, message }`. Dates are
ISO strings; `eventIds` is not returned.

### `GET /admin/scrape-alerts`

| Param | Values |
| --- | --- |
| `status` | `open` (includes `acknowledged`) \| `acknowledged` \| `resolved`; omitted = all |
| `limit` | 1..100, default 25 |
| `cursor` | the previous page's `nextCursor`; unknown -> 400 `INVALID_CURSOR` |

`200 { data: { items: Alert[], nextCursor: string | null } }`, `lastSeen` newest first.

### `GET /admin/scrape-alerts/:id`

`200 { data: Alert }` or 404 `NOT_FOUND`.

### `POST /admin/scrape-alerts/:id/acknowledge`

`200 { data: Alert, message: "Alert acknowledged" }` with `status:
"acknowledged"`, `acknowledgedBy` (caller uid), `acknowledgedAt`. Already
acknowledged: 200, unchanged. Resolved: 409 `ALERT_RESOLVED`. Unknown: 404.

### `POST /admin/scrape-alerts/:id/resolve`

`200 { data: Alert, message: "Alert resolved" }` with `status: "resolved"`,
`resolvedBy` (caller uid), `resolvedAt`, `autoResolved: false`. Already resolved:
200 unchanged (`"Alert was already resolved"`). Unknown: 404. If the condition
still holds, the next check opens a new alert.

## Indexes and retention

`firestore.indexes.json`: `scrapeAlerts` `status ASC + lastSeen DESC` (list,
also `status in [...]`), `rule ASC + status ASC` (auto-resolve scope query);
plus the TTL field override `scrapeAlerts.expireAt` (180 days), deployed by CI
like the #81 one. The rules also use existing indexes: `scrapeRuns`
`kind + startedAt DESC`, `pendingVisaChanges` `status + createdAt DESC`.
`scrapeAlertKeys` needs no index or TTL (one doc per active alert or manual
resolve tombstone; deleted on auto-resolve, replaced by the next occurrence).
`emailPending == true` uses the automatic single-field index. Both collections are backend-only (no `firestore.rules` match).
