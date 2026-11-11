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
                                       Types live in src/types/rubric.ts. Not scheduled, no routes.
    rubric-extraction.service.ts       orchestrator: settings (fail closed) -> hash gate -> chunk ->
                                       one model call per chunk -> validate in code -> merge ->
                                       version N+1 (pending) + run record
    rubric-quote.ts                    verbatim quote lookup in a snapshot (per page for PDFs);
                                       numbers / dates / units must be in the quote
    rubric-chunk.ts                    bounded, deterministic chunks (whole pages / paragraphs)
    rubric-prompt.ts                   constant system prompt, delimited data frame, output JSON
                                       schema + the in-code schema check of the answer
    rubric-validate.ts                 structural validator (kind rules, id joins, intent flag)
    rubric.store.ts                    visaRubrics head + rubricVersions; writes pending only;
                                       getApprovedRubric is the only consumer read
    rubric-settings.ts                 appConfig/rubricExtractionSettings: kill switch + caps
    scripts/                           extract-rubric (CLI, dry run by default)
```

Tests mirror this layout under `functions/test/scrapers/`; shared test helpers
stay in `functions/test/helpers/`.

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
