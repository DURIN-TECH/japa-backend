# Route onboarding runs (issue #217, part P3 of umbrella #211)

An admin registers a route (P1, `shared/registry/`), then starts ONE run that
takes it from its registered pages to a published or held rulebook. The run is a
document; a worker advances it in small saved steps, so it survives the 540 s
limit and crashes. Nothing here becomes visible to applicants.

## The chain

| Step id | Plain label | What happens |
|---|---|---|
| `check_setup` | Checking the registered pages and the settings | registry, country, visa source and rule pages are in order (a paused page ends the run `failed`) |
| `read_visa_page` | Reading the visa page | the visa crawl creates the visa record, **pending review and inactive**; skipped when a record from this page exists |
| `read_rule_pages` | Reading the rule pages | one guidance crawl per page, one per worker invocation; failures name the page and the error class |
| `plan` | Planning the rulebook draft | the drafting job's **dry** plan: sizes and caps. **No model call.** Stores the estimate |
| `confirm` | Waiting for your confirmation | the run STOPS in `awaiting_confirmation` |
| `draft` | Drafting the rulebook | on confirm: re-check the plan, optional allow-list patch, start the P2 job, mirror its counters |
| `safeguards` | Running the safeguards | the draft was written; the #200 pipeline publishes or holds it; the run only **observes** it |

Step statuses: `pending | running | waiting | done | skipped | failed | cancelled`.
Run statuses: `preparing | awaiting_confirmation | running | waiting_for_publish`
(active) and `published | held | too_thin | failed | cancelled` (final).

## Rules that matter

- **No model call before confirmation.** The visa extractor is not Claude; the
  plan is a dry run. Confirming records who, when and the number (`maxRequests`);
  before the job starts the plan is re-checked and, if a page changed or the
  plan now needs more calls than confirmed, the confirmation is voided
  (`voidedConfirmations`) and the admin is asked again with a new estimate id.
- **One active run per route**, by a transaction on `routeOnboardingRoutes/{routeKey}`
  (counter + active run id). Run ids are `{routeKey}__r{n}`. A new run is allowed
  once the last is final. `maxRunsPerDay` counts runs created per UTC day.
- **The run never calls `runOnDraft`, never changes `mode`, never approves a visa
  record, never sets `isSupported`.** The allow-list is touched only when the
  admin ticked `addToAllowlist` on confirm, through the audited
  `addRouteToAllowlist` (append only; it never creates a list, which would switch
  every other route off). If publishing is in manual mode, or the route is not on
  the allow-list, the estimate says so in plain words and the run ends `held`
  with "automatic publishing is not on for this route".
- **Outcomes come from the pipeline's own records** (`rubricPublishRuns`, the
  version's review status) and the drafting job's reason codes; nothing new is
  decided here. `no_criteria`, `primary_source_empty:*` and extraction
  `no_criteria_accepted` give `too_thin`; `checker_*` and `question_plan_unusable`
  give `held` with `retryScheduled` while the pipeline's hourly sweep will retry;
  other gate failures give `held` with the gate's own words. A held run with a
  retry scheduled is re-read by the sweep and turns `published` with no admin
  action (its alert is resolved).
- **Cancel** stops before the next action, cancels the drafting job and, when the
  draft was already written but undecided, rejects it (so nothing new is
  published). Spent counters are kept. A final run is 409.
- **Crash safety**: one action per invocation, lease + `kick` (same pattern as
  the drafting job), a 5-minute sweep, and two small wake-up triggers
  (job finished, publish run written). Every action is safe to repeat.
- **Alerts**: a run that ends `failed` or `held` raises one deduplicated
  `route_onboarding_attention` alert (key = run id); the sweep re-raises one
  whose raise was lost.
- **Collections** `routeOnboardingRuns`, `routeOnboardingRoutes` are backend-only
  (pinned by `test/emulator/backend-only-collections.emu.ts`). Audit entries go
  to `sourceRegistryAudit` (`onboarding_started`, `_confirmed`, `_cancelled`,
  `_allowlist_added`, `_settings_changed`). Index: `routeOnboardingRuns`
  (`status`, `createdAt` desc) in `firestore.indexes.json`.

## Settings: `appConfig/routeOnboardingSettings`

Shared with the registry (it ignores these fields and this ignores its). Fail
closed: a missing doc is OFF. `enabled` (default false), `maxRunsPerDay` (3),
`maxChunksPerRun` (20), `publishWaitMinutes` (180), `heldWatchHours` (72).
`GET/PATCH /admin/route-onboarding/settings`, audited.

## Endpoints (admin only: `verifyAuth`, `verifyAdmin`, then `ScrapeRun` CASL)

| Request | Success | Errors |
|---|---|---|
| `POST /admin/route-onboarding` `{countryCode, visaTypeId}` | 201 `{runId, status, run}` | 400 `VALIDATION_ERROR`; 404 `ROUTE_NOT_REGISTERED`; 409 `RUN_ACTIVE` (+`activeRunId`); 429 `DAILY_LIMIT_REACHED`; 503 `SETTINGS_UNAVAILABLE` / `ONBOARDING_DISABLED` |
| `GET /admin/route-onboarding?status=&limit=` | 200 `{runs[], total}` (newest first) | 400 |
| `GET /admin/route-onboarding/:id` | 200 `{run, checklist[]}` (progress read live from the job) | 404 |
| `POST /:id/confirm` `{estimateId, statementAccepted: true, addToAllowlist?}` | 200 `{alreadyConfirmed, run}` | 400 `VALIDATION_ERROR` / `STATEMENT_REQUIRED`; 404; 409 `ESTIMATE_MISMATCH` (+`currentEstimateId`) / `NOT_AWAITING_CONFIRMATION`; 503 |
| `POST /:id/cancel` (no body) | 200 `{run}` (a run with a live worker comes back with `cancelRequested: true` and ends within one action) | 400; 404; 409 `RUN_FINISHED` |
| `GET/PATCH /settings` | 200 `{settings, problems}` | 400; 503 |

Bodies are strict (unknown keys: 400). The run view is a whitelist: lease, retry
and kick counters never leave the server. Errors: `{success:false, error, message, ...extra}`.

Tests: `test/scrapers/onboarding/` (service and worker with a kill-at-every-
transaction replay, endpoints over the real router, pure rules, genericness) and
the emulator deny test.
