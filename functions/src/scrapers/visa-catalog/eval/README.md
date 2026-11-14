# Visa extraction eval (UK golden set)

An accuracy bar for the visa-catalog extractor (issue DURIN-TECH/japa#60). A
hand-verified **golden set** of recorded GOV.UK guides, and a **manual** check
that runs the real extractor on them and scores every field. A prompt or
model change can be compared with the previous result, so it cannot quietly
make the data worse.

It is **not** part of `npm test`, CI or any deploy (it calls a paid LLM).
`npm test` only runs the scorer and `--replay` unit tests, with no key.

## When to run it

Run `npm run eval:visa-extract` **before merging**:

- every `EXTRACTOR_PROMPT_VERSION` bump (`src/scrapers/visa-catalog/visa-catalog-extract.service.ts`)
- every model change (`DEEPSEEK_EXTRACTOR_MODEL`, the `DeepSeekExtractor` default model, or a new `LlmExtractor`), and when DeepSeek's change log announces a new Flash build (`deepseek-flash` is a moving alias)

Commit the results file it writes (`src/scrapers/visa-catalog/eval/results/…json`) in the same PR, and
put the version + overall score in the PR description. Use `--compare` with
the previous results file to show the before/after.

A run costs about 6 DeepSeek calls (a few cents). The key is read from
`functions/.env.local` (`DEEPSEEK_API_KEY`), or export it in your shell.
The script loads that file with `node --env-file-if-exists`, which needs
**Node 22.9 or later** (an older 22.x fails at startup with "bad option").

```bash
cd functions
npm run eval:visa-extract                                      # all routes
npm run eval:visa-extract -- --only student-visa               # one route
npm run eval:visa-extract -- --compare src/scrapers/visa-catalog/eval/results/<old>.json # + delta vs an earlier run
npm run eval:visa-extract -- --replay src/scrapers/visa-catalog/eval/results/<run>.json  # re-score stored outputs, no LLM, no key
```

Only a run over **all** routes is an eval result for a PR. A live `--only`
run (or a replay of a file with fewer routes) is marked `partial: true` in the
results file and prints `PARTIAL` in the header and next to the gate verdict:
its PASS/FAIL covers only the routes it ran.

Exit codes: `0` pass, `1` below the gate, `2` usage/config error (no key,
missing fixture, unknown route, unreadable results file). Without a key (and
without `--replay`) it exits `2` before making any call.

## What a run does

For each route in `src/scrapers/visa-catalog/eval/golden/<route>/`:

1. `guide.json` (a recorded Content API response) is served to the **real**
   `GovukContentApiAdapter` through a stub fetch service, so the real section
   selection (including the registry's `VISA_SOURCE_OVERRIDES` section lists),
   formatting and cap are used. No network call.
2. The **real** extractor (`visaCatalogExtractor.extract()`) is called with the
   same context a crawl uses. This is the only network call.
3. The output is scored against `expected.json` by the pure scorer
   (`src/scrapers/visa-catalog/eval/score.ts`). A failed or invalid extraction (validation error, API
   error) scores that route 0 and is listed; it does not crash the run.

## How a run is scored

All numbers live in `src/scrapers/visa-catalog/eval/config.ts`. Change them there and here, in a
reviewed commit, and never to make one run pass.

| Field | Type | Rule | Weight |
|---|---|---|---|
| `feeComponents` | fee | Set-based (order-independent) exact match on `kind`, `amount`, `currency`, `per`, `years`. A missing, extra, wrong-amount or wrong-years component, or `feeUnverifiedReasons` on the output, is a **mismatch** | 3 |
| `eligibility` | eligibility | Fraction of expected themes with at least one keyword alternative present (whole words, case-insensitive) in the joined `eligibilityCriteria`. No LLM judge. Keep alternatives specific to the theme: phrases such as "18 or over" or "aged 16", never bare numbers, the route's own name ("talent") or generic words ("money", "income", "offer", "relationship", "in the uk") that vague criteria would hit | 2 |
| `category` | exact | Equal | 1 |
| `isExtendable` | exact | Equal | 1 |
| `processingDaysMin` / `processingDaysMax` | numeric | Within ±20% of `value` (at least ±1 day), `PROCESSING_DAYS_TOLERANCE` / `PROCESSING_DAYS_MIN_TOLERANCE_DAYS`. **Full range** (user decision): min = the outside-country decision time, max = the inside-country time where the page states one (Global Talent: 21–56); if the inside time is the shorter one, the range runs from the shorter to the longer (Family: 56–84). When the page gives only one figure, it is the max and the min is an inclusive `range` `[0, max]` ("within 8 weeks" says nothing about the minimum) | 1 each |
| `name` | text | Normalised actual contains the expected core name ("Skilled Worker") | 1 |
| `validityPeriod` | text | Fraction of the expected durations (e.g. 2 years + 9 months) stated in the text | 1 |
| `applicationUrlHost` | url | Host of `applicationUrl` equals the expected host | 1 |

- **Route score** = Σ(weight × field score) / Σ(weight), in [0, 1].
- **Overall** = the same weighted sum over every field of every route.

### Pass bar (gate)

The run **fails** (exit 1) when any of these is true:

- **Hard gate:** any fee mismatch on any route, whatever the scores. Known
  gaps (below) are excluded.
- **Hard gate (#87):** any route whose `processingDaysMin` or `processingDaysMax`
  is more than 20% (at least 1 day; the numeric tolerance) from **every**
  duration stated in its own processing citations (keys starting
  `processingTime` or `processingDays`, so `processingTime.inside` counts;
  a field is judged only when every citation relevant to it parsed to a
  duration, so an unparsable or non-English quote never fails the run). The value can match
  `expected.json` and still fail: the v4 Standard Visitor crawl stored max 56
  (the "extend your stay ... within 8 weeks" sentence, the agreed full-range
  max) with only "within 3 weeks" cited. Output with no cited duration at all
  is not judged here. The extractor validator runs the same check
  (`src/scrapers/visa-catalog/visa-catalog-processing-check.ts`) and flags the extraction
  (`processingUnverifiedReasons`, confidence capped at 0.5). `npm test` also
  checks that every expected processing value is stated by its own `source`
  quote.
- overall < **0.85** (`OVERALL_PASS_THRESHOLD`)
- any single route < **0.7** (`ROUTE_PASS_THRESHOLD`)

If the baseline (or any run) fails, report the failing fields. Do not lower a
threshold or edit an expected value to make it pass. Change an expected value
only when it is wrong against the source page, with the quote to prove it.

### Item kind and need (`documentKinds`, issue #187)

A route's `expected.json` may carry `documentKinds.items`: for each listed item,
`match` (keywords that find it in the extractor's `requiredDocuments`), the
`kind` (`document` uploaded / `information` typed in) and `need` (`required` /
`conditional` / `optional`) the page's own wording gives, and a verbatim
`source`. The field (weight 2) is scored only on routes that have it; an item
scores when both kind and need match (a missing or `kindReview` item scores 0).
Standard Visitor scores 14 items: the passport / travel document sentence
(document, required) and the 13 items of its two lists; only the passport and
the TB certificate are documents. UK Family uses the issue's two named examples (photo-page copies =
document, criminal convictions = information) plus passport, TB results and
certified translation.

### Answer types (`answerTypes`, issue #187 regroom)

An item in `documentKinds.items` may also carry `answerType` (`date`,
`date_range`, `money`, `address`, `list` or `text`): the shape of the answer its
own words give. The `answerTypes` field (weight 2) is scored only on routes where
at least one item sets it, and an item scores when the extractor's stored
`answerType` equals the expected one (an untyped or missing item scores 0).
Standard Visitor scores its 12 information items (travel dates `date_range`,
trip cost and earnings `money`, where you'll be staying / home / employer's
address `address`, the "details of ..." and people items `list`, the partner's
mixed item `text`); UK Family, Skilled Worker and Graduate score the typed-in
items they list (dates of birth `date`, names and details `list`, references
and mixed items `text`).

### Known gaps

`expected.json` may list `knownGaps` (e.g. `feeComponents`, a tracker ref,
and a note). A known gap is printed in every report and never fails the run.
For a `feeComponents` gap the expected components are what the guide itself
prints. An **extra surcharge** or `feeUnverifiedReasons` from the extractor is
reported as a note, not a mismatch. A wrong application fee is still a
mismatch. (No route has one today: Student's IHS was gap #69 until the linked
surcharge below.)

### Linked surcharges (#69)

Some guides only link to a surcharge (Student: "You'll also have to pay the
healthcare surcharge as part of your application"). The registry marks those
routes (`linkedSurcharges` in `VISA_SOURCE_OVERRIDES`) and the crawl adds the
rate read **in code** from the linked page (`LINKED_SURCHARGE_SOURCES`,
`src/scrapers/visa-catalog/visa-catalog-linked-surcharge.ts`). The eval does the same, in
live runs and in `--replay`: the linked page is recorded in
`src/scrapers/visa-catalog/eval/golden/_linked/<path>/guide.json` (record it with `recordRoutes` and
`goldenDir: src/scrapers/visa-catalog/eval/golden/_linked`), served to the real adapter, parsed by the
real parser, and applied to the extractor output before the fee is scored.
The results file keeps the raw `extracted` output and adds `linkedSurcharges`
(the provenance a crawl writes to `scrapeMeta.fee.linkedSurcharges`).

In `expected.json`, a linked component has `linkedPage` (the `_linked` fixture
its `source` is quoted from) and, for a registry-assumed length,
`yearsAssumed` (the registry note, verbatim) instead of `yearsSource`.
Student: £776 per year (student rate) x 1 year (assumed; the course length
varies).

## How to read the report

```
route                 score   fee         exact       numeric     text        eligibility url
skilled-worker-visa   0.917   1.000       1.000       1.000       1.000       1.000       0.000
...
field type mean               …
OVERALL 0.900 (pass >= 0.85, every route >= 0.7, no fee or processing citation mismatch)

Field failures:
  skilled-worker-visa.applicationUrlHost (0.000): host "www.gov.uk", expected "apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk" | actual "https://www.gov.uk/…"
GATE: PASS
```

- One row per route with its score and the mean per field type.
- **Field failures** lists every field below 1, with why and what the
  extractor returned. Check each one against the `source` quote in
  `expected.json` to decide whether the model or the expected value is wrong.
- The results JSON (`src/scrapers/visa-catalog/eval/results/<EXTRACTOR_PROMPT_VERSION>__<model>__<timestamp>.json`)
  holds the prompt version, model, run time, git SHA, each route's raw
  extractor output, per-field scores, overall, thresholds and pass/fail. It
  never contains the API key.

## The golden set

`src/scrapers/visa-catalog/eval/golden/<route>/`:

- `guide.json`: the recorded Content API response, in the same envelope as
  `test/scrapers/visa-catalog/fixtures/govuk-*.json` (`_fixture`: `sourceUrl`, `recordedAt`,
  `recordedBy`, `notes`; then `status`, `contentType`, `body`).
- `expected.json`: the expected values. **Every** value has a `source` quote
  copied verbatim from `guide.json` (a plain-text sentence, or the raw `href`
  for `applicationUrlHost`). `npm test` fails if a quote is not in the fixture,
  or (except URL hosts) not in the sections the extractor actually sees.
  `notes` records the judgement calls (which fee option, which length).
  `verifiedBy` / `verifiedOn` name the human who checked the values against the
  **live** GOV.UK page ("pending" until then).

Expected values come from the fixtures only. They are **not** derived from,
and must not import, the `uk-*` seed data (it stores GBP as USD and has no
IHS, #59; retired in #65).

Fees follow the #59 rule: the main applicant's application fee for the
standard case of applying from outside the UK, at the **longest** standard
length; plus mandatory surcharges (IHS) for that same length, as printed on
the page. Each component is in the page's own currency (the eval does not
score FX conversion).

v1 routes: `skilled-worker-visa`, `standard-visitor`, `student-visa`,
`graduate-visa`, `uk-family-visa`, `global-talent` (see `src/scrapers/visa-catalog/eval/config.ts` for
what each one exercises).

## Refreshing a fixture

GOV.UK changes. A change enters the golden set only as a deliberate, reviewed
commit:

```bash
npm run eval:record -- <route>          # fetch + show a diff, change nothing
npm run eval:record -- --all            # same for every route
npm run eval:record -- <route> --write  # overwrite guide.json
```

It uses the shared production fetch service: our bot User-Agent, robots.txt
check, at least 1.5s between requests, one route at a time. The diff covers
`updated_at`, the ordered part slugs (a renamed slug changes which sections
the extractor sees) and every part's text. `--write` only rewrites routes
whose diff is non-empty; an unchanged fixture is left byte-for-byte. A non-200,
non-JSON, non-guide, withdrawn or part-less response aborts without writing
anything (with `--all`, nothing is written if any route fails).

After `--write`:

1. Run `npm test`. A quote that is no longer in the page fails the
   golden-set test.
2. Re-check every value in that route's `expected.json` against the live
   page. Update values, quotes and `fixtureRecordedAt`, and set `verifiedBy` /
   `verifiedOn` to the person who checked.
3. Re-run `npm run eval:visa-extract` and commit the new results file.

## Adding a route

1. Add it to `EVAL_ROUTES` in `src/scrapers/visa-catalog/eval/config.ts` (URL + the registry label from
   `official_visa_links_verified_v3.md`).
2. `npm run eval:record -- <route> --write`.
3. Write `src/scrapers/visa-catalog/eval/golden/<route>/expected.json` from the fixture only, every value
   with a verbatim `source` quote. Add `knownGaps` for anything the guide itself
   cannot provide. Use `"pending"` for `verifiedBy`/`verifiedOn` until a human
   has checked the live page.
4. `npm test`, then `npm run eval:visa-extract -- --only <route>`.

Another country gets its own routes in the same format; it may need its own
adapter in the runner if it is not a GOV.UK guide.
