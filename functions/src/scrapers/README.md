# Scrapers module

All code for the two scrapers lives here: the **visa-catalog scraper** (official
visa pages -> LLM extraction -> pending review in `countries/{cc}/visaTypes`) and
the **news scraper** (RSS / HTML / news API -> `newsArticles`). Moved here from
`services/`, `controllers/`, `routes/`, `types/`, `data/`, `scripts/`, `utils/`,
`docs/` and `functions/eval/` in issue #91, without behaviour changes.

## Boundaries

- **Public API.** Code outside `src/scrapers/` imports only:
  - `scrapers` (`index.ts`): the scheduled-run services (`visaCatalogCrawlService`,
    `newsScraperService`, `scrapeRunService`, `scrapeAlertService`), the admin
    routers, the seeders (`seedVisaSources`, `seedNewsSources`,
    `scrapeCostService`) and the few catalog rules the app-facing visa
    service and controller use (`assertVisaApprovable`, `finiteMin`, manual cost,
    `isValidDocId`);
  - `scrapers/types` (`types.ts`): the visa-catalog types that are part of the
    app's `VisaType`, re-exported by `src/types/index.ts`. No runtime code.
- **Enforced** by the `no-restricted-imports` override in `functions/.eslintrc.js`:
  a static import of `scrapers/<area>/...` from outside this folder fails lint.
  `test/scrapers/**` (the module's tests) and `test/helpers/**` (the shared fakes)
  are exempt. The rule does not see dynamic `import()`, so keep those on
  the public API too.
- **App-facing services stay outside.** `services/visa.service.ts` (the catalog
  CRUD / review) and `services/news.service.ts` (the app's news read endpoints,
  also used by the news scraper to write articles and source health) are app
  code. The scrapers import them; they reach the module only through `scrapers`.
- **Wiring** lives in `src/index.ts` (scheduled functions, the alert
  finalize-hook registration) and `src/app.ts` (admin routes).

## Map

```
scrapers/
  index.ts, types.ts       public API (see above)
  shared/                  used by both scrapers
    fetch/                 HTTP client, robots.txt (RFC 9309), User-Agent; secret redaction
    etiquette/             per-host crawl state + backoff store, weekly crawl windows
    runs/                  scrapeRuns records, /admin/scrape-runs + /admin/scrape-sources (#81), scrape-runs.md;
                           source-health.ts: the auto-pause rules both crawlers apply (#107)
    scripts/               one-off data fixes, e.g. remediate-failing-sources (#107, dry run by default)
    cost/                  LLM price table, monthly cost rollup, /admin/scrape-costs (#82), scrape-costs.md
    alerts/                post-run + hourly alert rules, emails, /admin/scrape-alerts (#83), scrape-alerts.md
    registry/              source registry API (#215): confirmed official hosts, address check, route
                           registration, audit trail; README.md in that folder
    settings/              appConfig/scraperSettings (kill switch, limits, hard stop), /admin/scraper-settings,
                           per-source controls, Run now requests + worker (#96), scraper-settings.md
  visa-catalog/
    visa-catalog-crawl.service.ts      orchestrator (crawlVisaCatalogOrchestrator)
    visa-catalog-extract.service.ts    LLM extractor + validator
    visa-catalog.service.ts            ingest: validate -> stage -> diff
    visa-catalog-{diff,fx,ids,meta,linked-surcharge,official-hosts,
                  processing-check,supplementary}.ts, visa-manual-cost.ts
    types.ts                           VisaSource, PendingVisaChange, extraction schema
    adapters/                          source adapters (GOV.UK Content API, generic HTML)
    changes/                           pendingVisaChanges service + /admin/visa-changes (#61)
                                       + manual cost on a proposal (#77), visa-change-manual-cost.md
    data/                              source registry seed + vendored official_visa_links_verified_v3.md (#78)
    scripts/                           crawl-visa-catalog, sync-visa-sources (CLI)
    eval/                              extraction eval: golden set, results history, run/score/record (#60)
    docs/                              scraping spike, UK reference design
  news/
    news-scraper.service.ts            orchestrator (scrapeNewsOrchestrator) + strategies
    news-source-health.ts              per-run source health write + missing-key pause (#107)
    seed-news-sources.ts               news source registry seed
    docs/                              news scraping plan
  guidance/                            caseworker-guidance registry (#39): HOW OFFICERS DECIDE,
                                       separate from visa-catalog's visaSources (what a visa is)
    types.ts                           GuidanceSource, seed entry, snapshot metadata + stored object
    guidance-crawl.service.ts          orchestrator: shared fetch -> hash gate -> snapshot; skips
                                       unverified sources; N failures -> status "failing"
    guidance-snapshot.store.ts         snapshot text in Cloud Storage, keyed by content hash,
                                       create-only, backend-only (never served to a client)
    guidance-published-date.ts         publisher's own date, found by a per-source selector
    guidance-resolve.ts                current address of a document that moves with each
                                       publication, read from a stable parent page (#111)
    guidance-quote-check.ts            passages that must appear verbatim in stored snapshots (#111)
    guidance-source.{controller,routes}.ts   GET /admin/guidance-sources (admin-only list)
    data/                              seed-guidance-sources.ts: entries (data) + validator + loader;
                                       guidance-quote-checks.ts: the passages (data) (#111)
    scripts/                           seed-guidance-sources (CLI, dry run by default)
    README.md                          runbook: adding a source, seeding, crawling, recovering
  rubric/                              visa rubrics (#40): guidance snapshots -> cited, versioned,
                                       machine-checkable criteria, staged `pending_review`.
                                       Types live in src/types/rubric.ts. Extraction is not scheduled; the drafting job (#216) has a trigger and a sweep.
    rubric-extraction.service.ts       orchestrator: settings (fail closed) -> hash gate -> chunk ->
                                       one model call per chunk -> validate in code -> merge ->
                                       version N+1 (pending) + run record
    rubric-extraction-job.ts           (#216) the same drafting as a resumable BACKGROUND JOB: start,
                                       worker (`advance`), sweep, cancel, status
    rubric-extraction-job.store.ts     (#216) job + step documents (backend-only), large results split
    rubric-quote.ts                    verbatim quote lookup in a snapshot (per page for PDFs);
                                       numbers / dates / units must be in the quote
    rubric-chunk.ts                    bounded, deterministic chunks (whole pages / paragraphs)
    rubric-prompt.ts                   constant system prompt, delimited data frame, output JSON
                                       schema + the in-code schema check of the answer
    rubric-validate.ts                 structural validator (kind rules, id joins, intent flag)
    rubric.store.ts                    visaRubrics head + rubricVersions; writes pending only;
                                       getApprovedRubric is the only consumer read
    rubric-settings.ts                 appConfig/rubricExtractionSettings: kill switch + caps
    rubric-publish-settings.ts         appConfig/rubricPublishSettings: auto-publish mode (fails
                                       closed to `manual`), allowlist, gate numbers (#201)
    rubric-gates.ts                    PURE automatic gates: flag table, leave-outs, shrink guard,
                                       leave-out budget, protected rules, sample audit (#201)
    scripts/                           extract-rubric (CLI, dry run by default);
                                       publish-rubric (#201: run the auto-publish pipeline on a
                                       pending draft; --project required, --dry-run, --skip-checker)
```

Tests mirror this layout under `functions/test/scrapers/`; shared test helpers
stay in `functions/test/helpers/`.

## Route onboarding runs (`onboarding/`; issue #217)

One run per route takes registered pages to a published or held rulebook, with a
stored step list, a spend estimate the admin must confirm before any model call,
progress, cancel and crash-safe advancing. See `onboarding/README.md`.

## Paths that moved with the code

- **Eval** (`visa-catalog/eval/`): excluded from the build (`tsconfig.json`),
  type-checked and linted through `tsconfig.test.json`. Run with
  `npm run eval:visa-extract` / `npm run eval:record`; see `eval/README.md`.
- **CLI scripts** compile to `lib/scrapers/visa-catalog/scripts/*.js`, e.g.
  `node lib/scrapers/visa-catalog/scripts/crawl-visa-catalog.js --country GB`
  and `npm run sync:visa-sources`.
- **Vendored markdown**: tsc does not copy `.md` into `lib/`, so
  `findVisaSourcesMarkdown` (data/seed-visa-sources.ts) probes its own dir, then
  `../../../../src/scrapers/visa-catalog/data/`. That resolves to the committed copy
  from both `src/` (tsx) and `lib/` (compiled seed in CI).

## Rubric extraction (`rubric/`): what the code checks, and what it cannot

Every criterion the model proposes is checked in code against the stored
snapshot before it is written (`rubric-quote.ts`,
`rubric-extraction.service.ts`):

- the quote is in its own source verbatim, starts and ends on a whole word or
  number, and sits within one PDF page or one line of a web page;
- a threshold is a JSON number written in the criterion's **own quote** (not
  the day or year of a date in it); a unit, a date (day, month and year in one
  expression) and each group name are in that quote too. Supporting
  `citations` are reviewer aids and never count as support;
- a rule reference is printed in the quote or directly before it.

**The limit code cannot close.** A verbatim, whole-word quote can still mean
something else than its source. A quote that begins after a negation or a
condition passes every check: "required to interview the applicant", quoted
from "is **not** required to interview the applicant", is verbatim. The
extractor raises `quote_starts_mid_sentence` on a criterion whose quote begins
part-way through a sentence and `quote_ends_mid_sentence` when it stops before
the end of its sentence (an exception such as "only where ..." may follow),
but those are prompts to look, not verdicts, and they do not cover a qualifier
in another sentence. Also per criterion: `multiple_dates_in_quote`. Standing on
every version that has the content: `title_wording_uncited`. **A human reviewer must read each quote in its source
context before approving a rubric.**

Also for the reviewer, raised as flags on the version rather than decided by
code: country codes on a mandatory bar are the model's mapping of the source's
wording (`nationality_codes_model_proposed`, `nationality_code_name_mismatch`);
intake question wording is the model's (`intake_wording_uncited`); a rule that
runs across a chunk or page boundary may be missing (`multiple_chunks`,
`page_ends_mid_sentence`); the model can silently omit a rule, which nothing
detects. Number words and month names are recognised in English only; anything
else is not recognised and the criterion that relies on it is rejected.

## Lead-in lists and non-nationality group members (`rubric-list-items.ts`; issue #222)

Two defects found by the first real run (a "protected" bar rejected by the independent check):

- **A quote that ends with a lead-in** ("... except where they are subject to any of the following:") is half a rule. The quote validator accepts one passage inside one line, so a quote cannot span the list. **Code attaches the list**: `readLeadInList` reads the lines that follow the lead-in in the stored snapshot and the service stores each one, verbatim and whole, in `source.listItems`. The model never writes them; `verifyListItems` re-proves they are exactly the snapshot's lines (at extraction, and in the independent check's `buildViews`).
  - Marked lists ("(a)", "(ii)"): the run of marked lines, nested lists included; a marked lead-in ends at its own sibling marker.
  - Unmarked lists (plain lines): strict. Items start with a lower-case letter; the list ends at the first line that does not, a numbered label, a full stop on an item, or the end of the page. Capitalised unmarked lines are `ambiguous_list_end`, never guessed.
  - Not readable cleanly (`no_list_follows`, `item_too_long` over 2000 characters, `ambiguous_list_end`, `nested_unmarked_lead_in`, `pdf_layout_lost`): the rule is kept without items and flagged **`list_not_readable`**, a leave-out flag, so the gates HOLD a protected rule and leave out an ordinary one, by that named reason. A list is never truncated and a lead-in is never published alone. PDF pages lose their line layout (wrapped lines), so a lead-in quoted from a PDF is held; the same rule printed on a web page is read.
  - The checker is shown `listItems`; a lead-in quote with no verified items has no check view, so it cannot pass.
- **A group that is not purely a nationality.** `appliesTo.nationalities` / `asWritten` stay parallel for real nationalities. Members that are not nationalities go in **`appliesTo.uncoded`**: verbatim in the quote (`uncodedNameSupported`: `groupNameSupported` without its capital-letter rule, which would refuse "right of abode"; a lower-case entry must be a phrase of two words or more), no code ever made up. A bar needs at least one coded or uncoded member. `reviewFlagsFor` lists uncoded members in the "confirm every code" flag.
- **Serving.** Code still decides only the coded members (`mandatoryBarHits`). A bar with uncoded members is also put to the assessment model in full (quote, list lines, group) through `judgementCriteriaOf`; the model can only raise a concern on it. It is never read as "applies to nobody" or "applies to everybody". How an applicant with such a status is asked and matched is a product question (not built).
- Prompt versions: extraction `2026-11-rubric-v7`, check `2026-11-checker-v3`. Both fields are optional: earlier stored versions load unchanged.
- Re-check two saved rules without a re-extraction: `scripts/recheck-list-and-group.ts` (offline by default; `--live` runs the two-model check on only those rules).

## Non-English sources (`language/`, `rubric-translation.ts`, `rubric-language-eval.ts`; issue #220, part P5 of #211)

Official pages are not always in English. The rules for a language that has not
been evaluated are conservative: it is held, never published by itself.

- **Quotes stay in the page's language and are validated in it.** Nothing is
  translated for validation. The quote check is a text match; the part that
  READS numbers, dates, durations and reference shapes out of a quote
  (`rubric-quote.ts`) takes its language facts from a per-language lexicon, a
  DATA file in `language/lexicons/<code>.json` (format and how to add a language:
  `language/README.md`). No language is named in code (a test fails if one is).
  The product language's lexicon reproduces the old readings exactly (a golden
  file produced by the old code, `test/scrapers/rubric/fixtures/english-readings.golden.json`).
  A language with no file is read STRICTLY (whole digits only, no words, no month
  names): fewer rules, never a guess, never another language's rules. An
  unreadable number is still rejected, never accepted unverified.
- **What the model writes is English.** Titles, questions, answer options and
  document item names are written in the product language (extraction prompt
  v8); no number, date, amount or group in that wording may be missing from the
  quote, in digits or in words of the quote's language (the claim is read with
  the product lexicon, the quote with the source's: "30 days" is supported by
  "treinta días"). The independent check and the question check say the same
  (prompt versions bumped: no stored verdict of an older version is reused).
- **`sourceLanguages`** is recorded on every version (from each source's declared
  `language`; a source with none counts as the product language, see
  `language-lexicon.ts`), and each `sourceSnapshots[]` entry keeps its language
  so the independent check reads the document in it.
- **The publish gate**: a version is HELD `language_not_supported` (gate
  `language_support`, before any check spend, alerted like every hold, not retried
  by the sweep) unless every source language is in
  `appConfig/routeOnboardingSettings.supportedLanguages` (default only the
  product language) AND has a lexicon file. A failed settings read uses the
  default list. After an admin enables a language, running the safeguards again
  on the held draft publishes it through the same pipeline.
- **Unofficial translations** (`quoteTranslations` on the version, keyed by rule
  id: `text`, `language`, `model`, `promptVersion`, `unofficial: true`,
  `quoteHash`): one model call per excerpt of a non-product-language source that
  has accepted rules, a stored step of the drafting job (`c{n}__translate`),
  counted against the request cap and in the onboarding estimate
  (`translationCallsAtMost`). It is a courtesy and NEVER evidence: it is not in
  `source.quote`, it is never passed to the extractor, checker, question check,
  assessment or any letter (`rubric-translation-firewall.test.ts` greps the tree
  and builds an assessment request to prove it), and a failed, cut-off or
  capped translation just leaves the rule without one, never blocking the
  version. The label is defined once (`UNOFFICIAL_TRANSLATION_LABEL`) and
  exposed with the translation by `translationView`, which also refuses a
  translation of a different quote (a repaired rule). Clients adopt it in their
  own issues (FU-1).
- **Evaluation before enabling**: `npm run evaluate:language` (script header
  explains it). Offline by default (reads a stored version and the stored page
  files, rechecks every kept rule in the page's language, writes a report and a
  20-rule sample sheet); `--live` drafts and checks in memory and spends model
  calls; `--score` computes the check's agreement with a person's read of the
  sheet. It enables nothing: a person adds the language to `supportedLanguages`
  after reading it.
- **Known limit**: a group name must start with a capital letter
  (`groupNameSupported`), which many languages do not do for nationality
  adjectives; such a bar is rejected (fail closed) or, for a non-nationality
  member, expressed as `appliesTo.uncoded` (a phrase of two words or more).

## A failed bar: one repair, then hold (issue #223)

Before #223 any protected rule that failed the independent check stopped the run on the spot: the ordinary rules were never checked, no question plan was built and a route with no earlier version served nothing. Now (`rubric-checker.ts`, `repairFailed`; the drafting entry is `RubricExtractionService.redraftRule`):

1. **The ordinary rules are checked anyway** (same code path, same caps, once), so a held record lists every problem: each failed bar with both models' per-aspect verdicts, the ordinary leave-outs, and their shares (`counts.leftOutByReason`, plus `leave_out_budget_exceeded` when a share is over). A bar whose quote cannot be found is still held before any spend (there is no passage to repair from), and a provider, cap or format failure still holds at once.
2. **ONE automatic re-draft per failed bar**, from its own source passage: the quote's line, up to 6 lines above (the lead-in) and 40 below (the list lines), at most 6000 characters (`SnapshotQuoteIndex.passageWindow`). There is no second drafting path: the request is the drafting call's system prompt and output schema plus a REPAIR block (the failed rule and the aspects that failed, `buildRepairRequest`), the answer goes through `assessChunkOutput` (verbatim quote, group names in the quote, check values, list lines attached from the stored text), and an empty `criteria` list is the model's "cannot be repaired". Code takes back exactly one accepted rule that quotes the SAME line, is still a bar and has a readable list; it keeps the original `criterionId` and its `trigger` / question links.
3. **The replacement goes through the SAME check**: both models, `judgeRule`, `judgeTrigger` when it carries a trigger. Nothing about the check is weakened: an "unsure" on an aspect a re-draft cannot change is still a failure.
4. **Confirmed -> the run continues** (gates on the rulebook with the replacement, the question plan, publish). **Not confirmed -> HOLD** `protected_rule_failed:<id>` with a critical alert naming the rule title, reference and failed aspects. Never published with a bar missing, never dropped.
5. **Caps** (`appConfig/rubricPublishSettings`): `repairMaxRulesPerRun` (default 5, 0 = never repair). More failed bars than that is something systemic: no repair is attempted and every bar is held as `protected_rule_failed:<id>`. Every repair request (re-draft, its transient retry, the check of the replacements) counts in the run's request counter and against `checkerMaxRequestsPerRun`, `checkerMaxInputCharsPerRun` and the daily run limit; a run that cannot afford a repair holds `checker_capped` (retryable; the failed bar is still reported and alerted). At the default cap the repair adds at most 5 re-drafts (+ retries) and, because replacements are checked in batches, 2 check requests (+ 2 for triggers) per batch of 10.
6. **Idempotent**: the finished attempt is stored with the check's record (`rubricCheckerRuns/{routeKey}__v{n}.repairs[ruleId]`, keyed by the rule's content hash `ruleHashOf`). A re-delivered trigger, an admin re-run and a sweep retry find it and never re-draft that rule again; the check of the replacement replays from the stored answers. Only a FINISHED attempt is stored (a replacement, "cannot be repaired", or a re-draft code refused). A provider failure stores nothing, is reported as `checker_unavailable:provider` (retryable), and is not the rule's attempt.

**Where the repaired rule lives.** Versions are immutable drafts, so the replacement is never written into `criteria`. When the version is published, the replacements are recorded on it as the review field `ruleRepairs` (written by the pipeline through the same approval write as the question plan; the planner's allow-list is `questionPlan`, `ruleRepairs`). `applyExclusions` (the one read-side filter, `rubric-exclusions.ts`) swaps each replacement in at the original's position (`applyRuleRepairs`, `rubric-repair.ts`), and the publish gates, the question planner and the approval transaction's structural check and flag acknowledgement all run on the rulebook WITH the replacement. So what the check verified, what is served and what the audit says agree: the check was shown exactly the replacement; the replacement is what applicants get; the original stays in `criteria` (the audit trail); the approval's audit entry lists `repairedCriterionIds`; the publish run record (`rubricPublishRuns`) holds `protectedFailures` (per-aspect verdicts of both models on the original, the repair status and code, the replacement's verdicts) and `checkerRequests {total, repair}`. A bar can never be repaired away: a replacement is applied only for a protected original, only if it is itself protected, with the same id. A hold changes nothing for applicants (a version already serving keeps serving).

Wording and diagnostics fixed with it: `publish-rubric.ts` says "the independent AI check ran and failed" when it ran and did not confirm the draft, and "has NOT run" only for `not_run`, `not_configured` and `--skip-checker` (`checkerStatusLine`); `checker_unavailable` names what was unreachable (above). Hold reasons and alerts name rules by title (data read from the draft, never code).

Try one saved bar without a run: `scripts/repair-saved-rule.ts` (`npm run repair:saved-rule -- --page <stored-page.json> --rules <one-rule.json> [--live]`; offline by default; `--live` runs the production check and, only if the rule fails, its one repair, and prints the held-record entry). Nothing is written.

## Drafting a rulebook as a resumable background job (`rubric-extraction-job.ts`; issue #216, part P2 of #211)

`extractRoute` drafts a whole rulebook in one call chain (a real route took
30-40 minutes; a server function is cut off at 540 s). The job drafts the SAME
rulebook in small saved steps that a worker can drop and another can pick up.
`extractRoute` and the CLI are unchanged; both paths call the same step
functions (`runCriteriaStep`, `runIntakeStep`) and the same `assembleDraft`
(merge, draft, structural validation, flags), which is why the job's version
equals the one-shot version (tested against one scripted provider).

- **A step** is one model call and the validation of its answer in code:
  `c{position}__criteria` (the rules of a chunk) and `c{position}__intake` (its
  questions and document items, told the rules code accepted and the questions
  already asked for earlier chunks; a chunk with no accepted rule has none).
  Steps are ORDER-DEPENDENT, so they run strictly in document order.
- **Where results are stored**: `rubricExtractionJobs/{jobId}/steps/{stepId}`,
  the validated `ChunkAssessment` as a JSON string plus its cost; a result over
  150,000 characters is split over `stepParts` in the same transaction (never
  truncated). Firestore, not Cloud Storage, because the result must commit in
  the same transaction as the job's counters. The source text is not stored:
  the job pins each source by content hash and rebuilds chunks from it.
- **The job** `rubricExtractionJobs/{jobId}` (id = route key + a digest of the
  source-set hash, prompt version, model, chunk size, newest version number and
  `force`: a duplicate start is a no-op returning the existing job). Statuses:
  `queued | running | succeeded | failed | cancelled | skipped`, with a
  `reasonCode` (the existing run stop codes, plus `cancelled`, `sources_changed`,
  `plan_changed`, `job_timed_out`) and a plain-words `message`.
- **Worker** `processRubricExtractionJob` (Firestore `onWrite`, fires on a new
  job or a changed `kick`, binds the AI key, 540 s): takes a lease, runs as many
  steps as fit in `invocationBudgetMs` (a new step starts only when a whole
  request timeout still fits), then bumps `kick` to hand over. **Sweep**
  `sweepRubricExtractionJobs` (every 5 minutes, no secret): kicks an active job
  with no live lease and no recent progress. A dead worker leaves `inFlight`
  set; the next worker counts it as one failed attempt of that step (and against
  the cap); `stepAttemptsMax` failures of one step fail the job.
- **Exactly one version**: the version, the head, the job's completion and the
  final run record are written in one transaction whose guard checks the job is
  still `running`, owned, not cancelled and has no version.
- **Pinned inputs**: if a pinned source's newest snapshot moves mid-job the job
  stops `skipped / sources_changed` before its next call and writes nothing; the
  change starts a new job (`onGuidanceChanged` now starts a job instead of
  running inline).
- **Caps** (`maxRequestsPerRun`, `maxInputCharsPerRun`) hold across the whole
  job: the counters live on the job and are checked before every call; a job
  that would pass the cap stops `skipped / run_cap_exceeded` and keeps its
  finished steps. The daily cap counts a job once (its `started` run record is
  written with the job).
- **Admin endpoints** (`/admin/rubric-extraction-jobs`, same gate as
  `/admin/rubrics`): `POST /` `{countryCode, visaTypeId, sourceIds?, dryRun?, force?}`,
  `GET /:id`, `POST /:id/cancel`. Cancel stops the job before its next step; a
  cancelled job writes no version.
- **Settings** (`appConfig/rubricExtractionSettings`): `stepAttemptsMax` (3),
  `invocationBudgetMs` (450000), `leaseMs` (600000), `jobMaxAgeMs` (6 h),
  `jobIdleMs` (120000).

## Automatic rulebook publishing (`rubric-gates.ts`, `rubric-publish-settings.ts`; issue #201, umbrella #200)

There is **no human sign-off** before a rulebook goes live when
`appConfig/rubricPublishSettings.mode` is `auto`. A draft that passes the
automatic safeguards is published by the named system actor
`system:rubric-auto-publish`; a draft that fails is **held** (the serving
version keeps serving, admins are alerted). Admins can still reject, roll back
(part D) or publish a held draft by hand.

- **Settings** (`appConfig/rubricPublishSettings`, fails closed): `mode`
  (`manual` | `auto`, default and any fallback `manual`), `routeAllowlist`
  (route keys; absent = all routes; a malformed list publishes nowhere),
  `pauseAfterRollback` (true), `maxLeftOutShare` (0.15), `maxPrimaryLeftOutShare`
  (0.20), `minKeptShareOfServing` (0.7). Edit the doc in the console or
  `PATCH /admin/rubrics/publish-settings` (audited in `rubricPublishSettingsHistory`).
  A missing or unreadable doc is `manual`; an unreadable one is recorded as
  `settings_unreadable` and alerted (critical).
- **Trigger**: `onRubricVersionCreated` (src/index.ts) on creation of a
  `pending_review` version with an `extractionRunId`. One record per version,
  `rubricPublishRuns/{routeKey}__v{n}`, written with `create()`: a re-delivered
  trigger publishes nothing twice.
- **Gates** (`rubric-gates.ts`, pure): structural validator; suspicious
  passages; flags `no_criteria` / `intent_polarity_conflict` /
  `intent_criteria_without_polarity` hold; an unknown flag code holds; shrink
  guard; leave-out budget; the per-rule flags (`quote_starts_mid_sentence`,
  `quote_ends_mid_sentence`, `combined_sub_conditions`,
  `multiple_dates_in_quote`, `possible_duplicate` only when its partner is
  kept) LEAVE THE RULE OUT through the existing `excludedCriterionIds`; the same
  flag on a protected rule (a mandatory bar, or any rule with `appliesTo`)
  holds. A rule is never edited or reworded.
- **Plug-in points**: the independent AI check (part B) and the question plan
  (part C) register on `rubricAutoPublishService` (`registerChecker` /
  `registerPlanner`). Until they exist, `auto` holds every draft
  (`checker_not_configured`, `question_plan_missing`).
- **Publish** goes through the SAME approval transaction and validator as a
  human approval (`RubricReviewService.decideAs`); the audit entry has
  `action: "approve"`, `by: "system:rubric-auto-publish"`, `automatic: true`
  and `publishRunId`, so `onRubricApproved` and `onRubricApprovedRecordAlert`
  fire unchanged.
- **Alerts** (`scrape-alerts.md`): `rubric_auto_published` and
  `rubric_draft_held`, subject type `rubric_route`.
- **Run on an existing draft**: `POST /admin/rubrics/:id/auto-publish`
  (`?dryRun=true` writes nothing) or
  `npm run publish:rubric -- --project <id> --route <routeKey> --version <n> [--dry-run] [--skip-checker]`.

## Independent AI check of every rule (`rubric-checker.ts`, `rubric-checker-prompt.ts`; issue #202, part B of #200)

A second model, with its own prompt (`CHECKER_PROMPT_VERSION`, no text shared
with extraction), reads **every rule of the draft** against its own quoted
sentence plus a bounded window of the stored source (400 characters each side,
inside the quote's own line or page, plus the lead-in of a list item) and
returns **closed verdicts only**. The pipeline calls it after every code gate
passed, never in a dry run. It never writes, edits or adds a rule and returns
no free text; code decides.

- **Roles**: ordinary rules are read by `verification` (mid tier, not the
  extractor's `judgement`). Protected rules (a mandatory bar, or any rule with
  `appliesTo`) are read by BOTH `verification` and `judgement`, and so is the
  intention-to-stay reading (which sees only the proposal's quote). Honest
  limit: the second reading of a protected rule uses the extractor's model with
  a different prompt.
- **Aspects** (each `yes | no | unsure | na`): `title_faithful`, `kind_right`,
  `stage_right`, `condition_faithful`, `check_faithful` (`na` without a check),
  `group_matches_codes` (`na` without `appliesTo`). The schema is flat, with
  no union type and no free-text key but the batch handle (`r1`, `r2`, ...).
- **Verdict to action** (`judgeRule`, table-tested): ordinary rule, every
  applicable aspect `yes` -> keep; any applicable aspect `no` / `unsure` / `na`
  (or a doubt on an aspect that does not apply) -> leave out as
  `checker:<first failing aspect>`; protected rule, both models `yes` on every
  applicable aspect -> keep, anything else -> HOLD
  `protected_rule_failed:<id>` (never in `leftOut`), after the ONE repair of
  that rule described in "A failed bar: one repair, then hold" below; a quote
  that cannot be found in its cited snapshot -> `checker:source_text` (ordinary) or hold
  (protected, before any spend). A rule is never left out for size or to keep the rulebook short.
- **Fail closed**: an answer that is not exactly the handles sent (missing,
  extra or repeated id, extra key, bad enum, cut off) -> `checker_output_invalid`;
  provider error after ONE retry, no key, unreadable settings, a refusal, a
  run cut off by the clock -> `checker_unavailable:<what>` (`provider`,
  `provider_refused`, `not_configured`, `deadline`, `settings_read`,
  `snapshot_read`, `ledger`, `internal`: WHAT was unreachable, a code, never error
  text; the sweep reads the part before the colon); a cap -> `checker_capped`;
  intention-to-stay not confirmed by both models -> `polarity_unverified`.
  Nothing is published on a partial check.
- **Order and spend**: protected rules and the polarity readings first (a
  provider, cap or format failure holds before the bulk is spent; a bar that
  FAILED a verdict no longer does, see below), then ordinary rules in rulebook
  order, batches of 10, 6 requests in flight. Caps (in
  `appConfig/rubricPublishSettings`, checked BEFORE the first call): rules per
  draft 1000, requests per run 120 (retries count), input characters per run
  2,000,000, output tokens per request 8000, runs per UTC day 20, request
  timeout 240 s. A draft over a cap is held, not trimmed. Expected load:
  `estimateCheckerLoad` (270 rules: about 31 requests; 500 rules: about 54).
- **Reuse**: every closed answer is stored in `rubricCheckerRuns/{routeKey}__v{n}`
  under its request hash with calls and tokens. A re-run of the same version
  makes no model call; a run cut off resumes from what it stored.
- **Sweep**: `sweepHeldRubricDrafts` (hourly) re-runs held drafts whose only
  reasons are `checker_unavailable`, `checker_capped` or `checker_output_invalid`,
  up to 3 runs per version, only in `auto` mode.
- **Flag codes it resolves**: `title_wording_uncited`,
  `nationality_codes_model_proposed`, `nationality_code_name_mismatch`.
  (`intake_wording_uncited` is part C's.)
