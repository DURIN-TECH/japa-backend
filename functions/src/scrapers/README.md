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
                                       getApprovedRubric(ByKey) is the only consumer read
    rubric-key.ts                      (#233) rulebook keys {authorityId}_{routeSlug} for any
                                       issuing authority (country, bloc, treaty); reads the parts
                                       of a document stored before #233 (no data move)
    rubric-stack.ts                    (#233) loadRulebookStack: the approved version of every
                                       layer of a route (shared first, own last) merged into one
                                       served view; a missing layer is reported; a single layer is
                                       served unchanged. Consumers reach it through
                                       services/ai/application-rulebook.ts
    rubric-settings.ts                 appConfig/rubricExtractionSettings: kill switch + caps
    rubric-publish-settings.ts         appConfig/rubricPublishSettings: auto-publish mode (fails
                                       closed to `manual`), allowlist, gate numbers (#201)
    rubric-gates.ts                    PURE automatic gates: flag table, leave-outs, shrink guard,
                                       leave-out budget, protected rules, sample audit (#201)
    scripts/                           extract-rubric (CLI, dry run by default; #233: a bloc or
                                       treaty layer with --authority=<id> --slug=<shared route id>);
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
- **Serving.** Code still decides only the coded members (`mandatoryBarHits`). A bar with uncoded members is also put to the assessment model in full (quote, list lines, group) through `judgementCriteriaOf`; the model can only raise a concern on it. (Since #248 that concern is a credibility flag marked as a bar; before, assembly dropped it. A bar served without its unconfirmed trigger is judged the same way and not decided by code at all, see #248 below.) It is never read as "applies to nobody" or "applies to everybody". How an applicant with such a status is asked and matched is a product question (not built).
- Prompt versions: extraction `2026-11-rubric-v8`, check `2026-11-checker-v5` (v6 since #242, below), re-draft `2026-11-repair-v3`. Both fields are optional: earlier stored versions load unchanged.
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

Try saved rules without a run: `scripts/repair-saved-rule.ts` (see "Drafting instructions" below; since #243 it takes several rules, bars or ordinary, and re-drafts each once). Nothing is written.

## A bar's stage is not judged; why a re-draft is refused (issue #226)

- **Stage is only an ordering label for a bar.** `.stage` is read for ORDER alone (`planJudgementBatches` in `services/ai/assessment-engine.ts`, `stageRank` in `rubric-question-plan.ts`) and copied as a display label onto the refusal/concern records. A mandatory bar is decided by code from the applicant's group whatever its stage (`mandatoryBarHits`); no branch reads the stage to decide anything. A sentence saying a named group "cannot be given permission" fits none of the four stage definitions, so a careful model answered `unsure` on `stage_right` and that held a whole rulebook over a label.
- **How the check handles it** (`rubric-checker.ts`, `unjudgedAspects`): for a rule of kind `mandatory_bar` the aspect `stage_right` is never judged. The prompt says to answer `na` for it, and code ignores the aspect whatever is answered (yes, no, unsure, na), in `applicableAspects`, `failedAspect` and `failedAspectsOf`, so a stray answer cannot hold the bar and is not listed as a failed aspect. The answer shape and the six-letter stored row are unchanged. Nothing else is relaxed: every other aspect of a bar, every aspect of any other rule (a non-bar rule scoped to named groups keeps its stage check; since #240 a judgement rule's stage is not judged either, see below), the thresholds and the meaning of `unsure` are as before. Check prompt `2026-11-checker-v4`, so stored v3 answers are not reused.
- **`not_the_same_bar`.** The re-draft is taken back only if an accepted rule quotes the SAME line (unit) of the stored text AND is still a bar. The repair record now says which condition failed: `not_the_same_bar:<cause>:returned=N:accepted=N:same_line=N:bar=N`, with `<cause>` = `different_line` (no accepted rule quotes the original's line) or `not_a_bar` (one does but it is no longer a bar). Counts only, never text. If the model returned nothing usable, `detail` is the drafting validator's reason code as before (for example `applies_to_not_in_quote`). The cause could not be established offline (no model call), so the likely one was fixed in the instructions: the REPAIR block never told the model which line to quote, and the window holds neighbouring lines (for a typical "cannot be given permission" sentence the line below says the application "cannot be considered", a clearer fit to a `validity` stage). Repair prompt `2026-11-repair-v2` now says the quote must be the original quote, or a continuous part of it, from the same line, that another line is discarded by code, and to keep the kind. The same-line test itself is unchanged: it is what stops a different rule replacing a bar.


## Labels that change no outcome are not judged (issue #240)

The first real automatic run held a 453-rule rulebook with 219 rules counted against the leave-out limit, mostly `unsure` on labels that change nothing for an applicant. The check (`rubric-checker.ts`: `unjudgedAspects`, `kindUnsureTolerated`, `aspectFails`, used by `failedAspect`, `failedAspectsOf` and `leaveOutBasis`, so they cannot disagree) now stops leaving rules out over two things. The prompt and `CHECKER_PROMPT_VERSION` (`2026-11-checker-v5`) did NOT change, so every stored answer replays with zero model calls; only the mapping of the stored letters changed.

- **`stage_right` is not judged for a `judgement` rule** (it already was not for a bar, #226), ordinary or protected, whatever a model answers (yes, no, unsure, na). A judgement rule is never decided by code: `planJudgementBatches` only sorts the assessment model's reading by stage, `stageRank` only orders the intake questions, and the portal reads the stage only on a code-decided REFUSAL GROUND ("rejected as invalid" vs "a refusal ground"), which a judgement rule can never be. Stage is **still judged for an `objective` rule** (its stage decides that portal note on a code-decided refusal ground): `unsure` or `no` there still leaves it out.
- **`kind_right = unsure` does not fail an ORDINARY `judgement` rule.** A rule already drafted as `judgement` is handled the safest way (shown in full to the assessment model, never code-decided, can only raise a concern), so the doubt changes nothing. `kind_right = no` still leaves it out as `checker:kind_right`; `na` still fails. An ordinary `objective` rule with kind `unsure` still fails (a later step), and a PROTECTED rule (a bar, or any rule with `appliesTo`) is judged exactly as before on every aspect except the stage of a judgement rule or bar: any `unsure` or `no` from either model still holds.
- **The run record separates "found wrong" from "not confirmed".** Each `checker:*` leave-out carries `basis`: `found_wrong` when a FAILING verdict is a `no`, `not_confirmed` when every failing verdict is `unsure` / `na` (or there was nothing to read, or the quote was not found). A tolerated `unsure` is not a failing verdict. `counts.leftOutFoundWrong` and `counts.leftOutNotConfirmed` hold the two totals (code leave-outs, such as `list_not_readable`, keep their own reasons and are in neither); the `leave_out_budget` gate detail adds "N found wrong, M not confirmed"; the held and published alerts say it in words; `publish-rubric` prints it. Both kinds still count against the budget and neither is served: `maxLeftOutShare`, `maxPrimaryLeftOutShare` and what is served did not change.
- **Replay without a model.** `scripts/replay-check-verdicts.ts` (`npm run build && node lib/scrapers/rubric/scripts/replay-check-verdicts.js --rules <file.json> --primary <sourceId,...>`) recomputes, from stored verdict letters and the production mapping (`rubric-verdict-replay.ts`, not a copy of it), which rules are left out and the shares. On the first run's 453 rules it gives 135 counted (general 11 of 113, scoped 124 of 340, primary 30 of 102), 57 found wrong and 72 not confirmed, plus 6 code leave-outs; the draft is still held by the budget. A synthetic copy (ids, kinds and letters only) is the fixture of `test/scrapers/rubric/rubric-check-harmless-labels.test.ts`.
- **The protected re-draft** (repair prompt `2026-11-repair-v3`, `redraftRule`, `repairFailed`): the prompt tells the model to keep the rule's applicability unless `condition_faithful` failed (as it keeps the kind). A re-draft that swaps `conditional` and `specialist` on a rule with a trigger is accepted, with the ORIGINAL trigger carried over (with a valid trigger the two behave the same in `resolveApplicability`; the replacement's trigger is still checked by both models). A change to or from `all_applicants`, or to `other_route`, is still refused as `applicability_changed`. A stored attempt made under an older repair prompt version that did NOT produce a replacement is attempted once more, and stored under the current version; a stored replacement is replayed (never re-drafted again just because the prompt moved on), and replayed replacements are batched apart from new ones so their stored check answers still match.

## An ordinary rule the check found wrong: one re-draft, then serve or leave out (issue #244, step 4 of #240)

Bars already get one automatic re-draft (#223). Since #244 an ORDINARY rule the check finds WRONG gets one too, from its own source passage, through the same drafting path (`RubricExtractionService.redraftRule`), the same code validation and the same stored-attempt ledger. Nothing about what a verdict means, and none of the leave-out limits, changed.

**Who.** After the ordinary check, an ordinary rule left out with at least one `no` on `title_faithful`, `kind_right`, `condition_faithful` or `check_faithful` (`ordinaryRepairAspects`, built on `aspectFails`, the one test of a failure). Not eligible: a rule with only `unsure` / `na` (a re-draft cannot add the context the check lacked), a code leave-out (`list_not_readable`, `combined_sub_conditions`, `possible_duplicate`, ...), `checker:source_text`, and a protected rule (its own path). Protected repairs run first; a draft held for a bar spends nothing on ordinary re-drafts.

**Guard.** More eligible rules than `ordinaryRepairMaxShare` (default 0.20, a share of ALL rules) or `ordinaryRepairMaxRules` (default 80, 0 = off) means something systemic: no ordinary rule is re-drafted, the run records `ordinary_repair_skipped:too_many` (a gate line and `counts.ordinaryRepairs.skipped`), and the draft is judged by the budget as before.

**What is accepted.** The replacement quotes verbatim text of the same snapshot (it may quote the lead-in of the list its original was one item of; that lead-in then carries its list lines, #222), is ONE rule, passes the drafting validation, is never a bar (`became_a_bar`), keeps its kind unless `kind_right` failed (`kind_changed`) and its applicability unless `condition_faithful` failed (`applicability_changed`; conditional <-> specialist is always allowed and carries the trigger). It is then read by the verification model only (not two: it is not a bar) with the same `judgeRule` table, and its trigger by the trigger check; only a replacement that passes every aspect and its trigger is served. Otherwise the original stays left out with its original reason and basis, and the repair status is recorded.

**Where it lives.** The same `ruleRepairs` record as a bar's replacement. `applyRuleRepairs` now swaps an ordinary original for an ordinary replacement of the same id; a rule never changes class (a protected original keeps its bar, an ordinary one is never swapped for a bar). The gates, the question plan and the approval validation run on the rulebook with the replacements, so a repaired rule no longer counts as left out. The audit lists `repairedCriterionIds` (and `coveredCriterionIds`).

**Duplicates.** Several items of one definition can all come back as the same lead-in, and a replacement can say what a served rule already says. A confirmed replacement that is the same rule as another served rule (`sameRuleAs`: the duplicate gate's own test, 80 % shared quote words, and the same scope; a protected rule covers whatever the scope) is not served twice. In rulebook order the first is served, later ones are covered: the covered original is left out as `checker:redraft_duplicate`, NOT counted against the budget (like `possible_duplicate`: the rule that stays says the same), the surviving repair records `alsoReplaced`, `applyRuleRepairs` re-points the covered original's question and evidence links to it, and the run record names `coveredBy`. Never silently merged.

**Bounds, and what happens when they are reached.** Every request counts inside `checkerMaxRequestsPerRun` (now 200, was 120; owner-approved) and `checkerMaxInputCharsPerRun`. Re-drafts run in waves of 6, stored after each wave, and only as many as fit WITH the check of their replacements (`affordableRedrafts` reserves it up front). No wave starts after the 330 s start deadline. When a cap, the clock or the provider cuts the repair short the run does NOT fail and nothing is trimmed: the rules not reached are left out as before (`counts.ordinaryRepairs.cutOff`, `notAttempted`, `checkPending`). If the budget then fails on its own, the draft is held with the retryable reason (`checker_capped`, `checker_unavailable:deadline|provider`) instead of the budget code, so the hourly sweep resumes it. Nothing is paid twice: a finished attempt (and the check of its replacement) is stored on the run (`repairs`, keyed by rule id and rule hash, per repair prompt version); a provider failure is not an attempt. Only a hard kill can lose the wave in flight (at most 6 re-drafts).

**Record.** `rubricPublishRuns`: `counts.ordinaryRepairs {eligible, attempted, repaired, failedCheck, invalid, mergedDuplicates, checkPending, notAttempted, requests {redraft, check}, skipped?, cutOff?}`, one `ordinaryRepairs` line per eligible rule (status, failed aspects, original and replacement verdict letters, `sameLine`, `coveredBy`), and a gate line. The alert lists the repaired rules by title.

**Estimate offline.** `npm run build && node lib/scrapers/rubric/scripts/replay-check-verdicts.js --rules <stored.json> --primary <sourceId> --repair [--rates 0.5,0.62,0.75]` prints the eligible rules, the guard, the request estimate against the cap and the shares under stated repair-success assumptions. Zero requests; the success rates are assumptions, not measurements.

## A bar whose trigger is not confirmed: served without it, judged, never code-decided (issue #248)

Before #248 a bar (a mandatory bar on a named group) whose rule BOTH check models confirmed on every judged aspect, but whose `trigger` (the intake question and answers that narrow which applicants it is put to) they did not, held the whole rulebook: `trigger_not_repairable` on the rule as drafted, `failed_check` / `trigger_not_confirmed` on its one re-draft. Now neither holds.

- **What happens.** The bar (as drafted, or its re-draft from #223) is served with the trigger REMOVED and is NEVER decided by code. The check returns it in `droppedTriggerIds` (as for an ordinary rule) and in `judgedBars`; a repaired one keeps status `repaired` with `detail: trigger_not_confirmed_served_judged`. A bar that fails any ASPECT (title, kind, condition, check, group) with either model is handled exactly as before (one re-draft, then hold). Any protected rule that is not a bar (an objective or judgement rule scoped to a group) still holds on its trigger alone (`servableWithoutTrigger`). No threshold, prompt, request or ordinary rule changed.
- **Why it is safe, both ways.** A barred applicant told they may apply: removing a trigger only WIDENS who the bar is put to, so it cannot hide the bar from anyone its condition covers. An eligible applicant wrongly barred: a bar code decides from nationality would, without its trigger, bar EVERY applicant of that nationality, so such a bar is never decided by code.
- **Where the mark lives.** Nowhere stored. The question plan's `droppedTriggerCriterionIds` (already written by the pipeline with the approval) now may list a bar; `applyExclusions` (the one read-side filter, behind `getApprovedRubric`) removes its trigger AND sets `notCodeDecided: true` on the served rule (`isJudgedBarShape`: kind `mandatory_bar`). It is derived on every read, so the same stored version always serves the same rule, and a stored `notCodeDecided` is stripped (only this filter can stop code deciding a bar). A version approved before #248 never lists a bar there, so it reads exactly as before.
- **The question links.** The removed trigger's question stops linking to the bar (both `criterionIds` and `intakeQuestionIds`), but only when the question still serves another rule: a question is never orphaned or deleted, so its answer still reaches the assessment model. The question plan is built on that view.
- **Serving** (`services/ai`). `mandatoryBarHits` skips a `notCodeDecided` bar; `judgementCriteriaOf` includes it (`isJudgedBar`: uncoded members, #222, or `notCodeDecided`); the model is shown its quote and list lines, "NOT decided by code", the group AS WRITTEN and the original condition words (`applicabilityCondition`), never its codes; `resolveApplicability` puts it to EVERY applicant (never "could not tell"), and `effectiveIntakeQuestions` keeps a question only it reads. A concern the model raises on a judged bar (#222's uncoded bars included) is now a credibility flag with `isMandatoryBar: true`; before #248 such a concern was dropped at assembly, so "the model can raise a concern" had no effect. It is never a refusal ground and never `hasBlockingRule`; a bar code already refused on for this applicant is not flagged twice; a concern on an objective rule or a bar the model was not shown is still ignored. What protection remains for an applicant the bar really covers: no code refusal; the model reads the rule against their answers and statement and a concern caps their readiness below strong and becomes a "check with your agent" action. That is weaker than a code refusal and is the accepted price of not barring eligible applicants by nationality alone.
- **Record and words.** `rubricPublishRuns.barsJudgedWithoutTrigger` (`criterionId`, `ruleRef`, `title`, `replaced`, `removedTrigger`), a gate line `bars_judged_without_trigger`, a section in the published (and held) alert, and `barsJudgedWithoutTrigger` on the approval's audit entry (`criterionId`, `title`, `note`), all with the fixed wording `JUDGED_BAR_NOTE`. Such a bar is not counted in `conditional_rules_without_trigger` / `specialist_rules_unanchored`.
- **Re-running a held draft.** The check's answers, the re-draft and the replacement's check are already stored, so this change alone makes zero model requests (`rubric-bar-trigger.test.ts`, `rubric-bar-trigger-e2e.test.ts`). Steps that never ran because the bar held (the ordinary re-drafts of #244, the question plan) run then, with their usual caps.

## The check is shown where a rule's condition comes from (issue #242, part of #240)

In the first real run 69 rules were `unsure` on `condition_faithful` because the condition is a section heading or a list lead-in far above the quote (outside the 400-character window), or is the intake question that decides who the rule applies to, and 70 judgement rules were `unsure` on `kind_right` because the check defined `judgement` more narrowly than the drafter. Checker prompt `2026-11-checker-v6` (stored answers of v5 are not reused: the request content and the prompt both changed) fixes the CONTEXT, not the standard: "Never guess `yes`. When in doubt, answer `unsure`." and every verdict meaning are unchanged, and nothing turns `unsure` into `yes`.

- **What a rule's view now holds** (`viewOf` in `rubric-checker.ts`, called by `buildViews`; `ruleJson` renders it; every field is cleaned with `sanitizeUntrusted` and sits inside the derived delimiter tag like the rest):
  - `sectionHeadings`: the headings above the quote in its stored snapshot, nearest last, at most 3, each at most 200 characters (`SnapshotQuoteIndex.headingsAbove`, `rubric-quote.ts`). Read by code, never written by a model; `[]` when the page has none. A stored web page is plain lines, so a heading is recognised by shape with no language-specific word: a line that starts with the language's reference label (the lexicon, #220) or a section number and a short unpunctuated title, or a short unpunctuated line that has words, does not start in lower case or with a list marker, and is not directly followed by another short unpunctuated line (a run of those is a list). The chain is the nearest heading, then the labelled sections it sits in (each shallower than the last). For a PDF the lines of the quote's OWN page above the quote are read from the stored per-page text (never another page; a page stored without line breaks has none).
  - `conditionFoundAt` (`conditionSite`): where code found the words of `applicabilityCondition`: `in_quote`, `list_lead_in`, `section_heading`, `text_before`, `elsewhere_on_page` (anywhere in the stored text) or `not_found` (the rule is still checked and the model is told). Case is ignored, an ellipsis splits a condition into parts that must all be found, a part under 8 characters cannot be placed. `null` for a rule with no condition. `conditionLine`: the whole line the condition sits on (at most 400 characters, cut around the condition) for every site except `in_quote` and `not_found`.
  - `triggerQuestion` and `triggerAnswers`: the question label and the labels of the selected answers, as the trigger check shows them (`selectedAnswerLabels`; a yes/no question reads Yes / No). A rule with no usable trigger carries `null` and `[]`. The trigger check's own prompt is untouched.
- **Prompt.** The fields list names the new fields. `condition_faithful`: for a `specialist` rule the activity may be named by a heading or by the trigger's question and answers; faithful when the quote, read under them, applies to exactly those applicants and nothing adds an exception. `kind_right` uses the drafting prompt's meaning (`rubric-kind-wording.ts`: objective = a fixed figure or plain fact a program can compare; mandatory_bar = a bar on a stated group whatever else is true; judgement = everything else a decision maker decides without such a figure, including a requirement the applicant must show, a permitted activity, a definition, a method of calculation and an instruction to the decision maker). Since #243 the drafting prompt (`rubric-prompt.ts`) embeds the same `KIND_WORDING_SENTENCE` (one source of truth); a test pins that both prompts carry it word for word. `stage_right` is `na` for a judgement rule as for a bar (the code of #240 ignores it there).
- **Size.** Typical added per rule about 150 characters (a heading chain and a short line), about 580 at most in a real sample; a trigger adds its question and answers (about 200-300). The hard bound is 3 x 200 + 400 + the labels. The rule check of a 453-rule draft is about 47 requests and 0.8-0.9 million characters, plus the trigger check (about 34 requests, 0.35 million): inside one run's caps (200 requests since #244, 2,000,000 characters).
- **See what is sent, offline.** `scripts/preview-check-context.ts` (`npm run build && node lib/scrapers/rubric/scripts/preview-check-context.js --rules <rules.json> --page <sourceId>=<page.json> [--questions <q.json>] [--sample N | --ids a,b] [--show-headings]`) builds the views with the production `viewOf` and the real requests and prints ids, heading counts and lengths, where each condition was found, characters added and the request count and size. It makes no model call and prints source text only as headings, and only with `--show-headings`.

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

## The layer check: a country's own layer against its shared layer(s) (`rubric-layer-check.ts`; issue #233, P4b of #228)

A route that inherits a shared (bloc / treaty) route is served as a STACK
(`rubric-stack.ts`). After a country's OWN layer drafts, and only when the
automatic publisher is about to publish it (the last step of the pipeline, so a
held draft spends nothing on it), an independent reader compares each of its
rules with the approved shared layer's rules on the same subject.

- **Prompt**: `LAYER_CHECK_SYSTEM_PROMPT`, version `LAYER_CHECK_PROMPT_VERSION`
  (`layer-check-2026-11-14.1`), recorded on every run. Role `verification` (the
  checker's independent reader, never the extractor's model).
- **Evidence**: ONLY the two verbatim quotes, under batch-local ids. Closed
  answers: per national rule, the shared ids it shares a subject with and one of
  `same_requirement | adds_to | disagrees | unsure`, re-validated in code (any
  other shape: `output_invalid`). The model never writes or changes a rule.
- **What code makes of it** (`decideLayerLinks`): `disagrees` is a
  `layerConflicts` entry (both quotes and URLs); `same_requirement` is a
  `restates` link only when it is the rule's single twin, the rule has no
  `disagrees`/`unsure` answer, and `linkRefusal` passes (same kind,
  applicability, trigger presence, coded check and bar groups; the national rule
  not more severe). Refused links and `unsure` pairs are recorded; nothing else.
- **Not checked**: over a cap (refused before any call), a provider failure, a
  refusal or an unusable answer give `status: "not_checked"` with the reason and
  the spend so far, and NOTHING is linked or flagged (repeats stay duplicated).
- **Spend**: hard caps per run (`DEFAULT_LAYER_CHECK_LIMITS`: 40 calls, 400,000
  tokens), lowered further by the publish settings' `checkerMaxRequestsPerRun` and
  `checkerRequestTimeoutMs`. One run per version (the pipeline's run record).
- **Written** with the automatic approval as `layerCheck` + `layerConflicts`
  (planner-writable review fields), shown in `GET /admin/rubrics/:id`, and as a
  `layer_check` gate line of the run record. It NEVER holds a draft.
- **Read side**: the merge folds an honoured link (the national rule leaves the
  merged `criteria`, is listed on its twin's `restatedBy` with its own quote and
  URL, its only-own question is not asked again, its document items name the
  twin) and tags both sides of a conflict (`layerConflictWith`). A link is
  honoured only while the twin is served with the compared quote and the guards
  still hold. A single-layer route is untouched.

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
  Two answers are tolerated since #240 (see "Labels that change no outcome" below): `stage_right` is not
  judged for a `judgement` rule (as for a bar), and `kind_right = unsure` does not fail an ORDINARY
  `judgement` rule.
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
  draft 1000, requests per run 200 (retries count; 120 before #244), input characters per run
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

## Drafting instructions that stop the defects the check found (issue #243, step 3 of #240)

The second check found 57 UK rules WRONG (a `no`) in the first real draft. Reading them, most were drafting defects the prompt itself caused, so `RUBRIC_SYSTEM_PROMPT` (`rubric-prompt.ts`, `RUBRIC_PROMPT_VERSION` `2026-11-rubric-v10`; the intake prompt of call 2 is unchanged) now says, as pure reading instructions (no route, country or publisher knowledge, nothing about producing fewer rules):

- **Titles**: keep every "unless" / "except" / "other than" / "provided that" of the quote (or end with "unless an exception applies"); keep the modal strength ("should" never becomes "must"); add no intent words ("continues to intend").
- **Definitions and alternatives**: a passage that defines a term or lists alternative circumstances is ONE rule quoting its lead-in (the #222 path attaches the list lines), not one rule per item. Sub-conditions that must each be met still get one rule per item.
- **Conditions**: ONE rule replaces the two conflicting instructions (list items carry the lead-in; specialist conditions name the activity): the circumstance, never the outcome; a list item takes its own lead-in, never a sibling's text; a `specialist` rule's condition names the activity, which is the lead-in when it names it, else the section heading.
- **Exemptions**: a quote that exempts a group ("unless they are applying as ...") is `conditional`, not `all_applicants`.
- **Not rules**: examples, summary sentences and link labels in a checklist. Every line that does state a requirement, permission, definition, method or instruction (including caseworker procedure) is still drafted.
- **Kind wording**: `KIND_WORDING_SENTENCE` in `rubric-kind-wording.ts` is the ONE wording of the three kinds, embedded in this prompt and in the check prompt (`judgement` covers what the applicant must show, permitted activities, definitions, methods of calculation and instructions to the decision maker).

The one-time re-draft reuses the system prompt, so it carries all of this. `RUBRIC_REPAIR_PROMPT_VERSION` is `2026-11-repair-v4`: for an ORDINARY rule the REPAIR block allows the lead-in of the definition the rule is an item of, and says it must not become a bar; for a bar it is unchanged (same line only). `RubricExtractionService.redraftRule` accepts an ordinary original's replacement when it is not a bar (same-line is reported as `sameLine`, not required); it still refuses a replacement quote that is not in the stored text, and the bar path is untouched.

### Measure it without a full extraction: `scripts/repair-saved-rule.ts`

`npm run repair:saved-rule -- --page <stored-page.json> --rules <rules.json> [--route <name>] [--live]`. `--rules` is an array of saved rules (`criterionId`, `title`, `kind`, `stage`, `severity`, `quote`, `applicability`, `applicabilityCondition`, `appliesTo`, and `verdicts`: the check's stored six letters). **Offline by default (0 model calls):** per rule it prints whether the quote is found, ordinary or bar, the aspects a re-draft would be told (the stored letters through the production mapping, so labels the check no longer judges are not asked for), the lead-in list and the window size. **`--live`** (the only model use) re-drafts each rule once through `redraftRule`, then runs the production check on all replacements (batches of 10, no repair of its own) and prints, per rule: old letters, new letters, whether the replacement quotes the same line, whether an ordinary rule became a bar, and whether it passes every aspect by the production mapping. Requests = one re-draft per rule with a failed aspect + ceil(replacements / 10) check requests (twice that when replacements are bars). Output is ids, letters, aspect names, code words and counts only: never a title, quote or model text. Nothing is written.
