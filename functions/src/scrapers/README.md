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
