# Spike: Visa Catalog Scraping (countries + all visa types)

> **Status:** Spike / recommendation. Not yet implemented.
> **Goal:** Keep `countries/{code}/visaTypes/*` populated and up to date across **all** countries by scraping official immigration sources on a daily/weekly schedule — cost-effectively and without corrupting curated data.

## TL;DR recommendation

**Do NOT extend the CSS-selector scraper (news-style) to visa data.** Visa-type details are prose, and every country's immigration site is structured differently — hand-tuned selectors don't scale to "all countries" and can't populate a 15-field structured schema.

**Do build a two-layer pipeline: deterministic fetch + LLM structured extraction.**

```
[Source registry]  official gov URLs per country (index + detail pages)
        │
        ▼
[Fetch layer]      axios + cheerio (already deps) → strip boilerplate → clean text
        │          (content-hash gate: skip pages unchanged since last run)
        ▼
[Extract layer]    LLM (default DeepSeek-chat) with STRICT JSON output
        │          = VisaType shape; one call per visa page; behind a provider interface
        ▼
[Validate layer]   Zod + sanity ranges + per-field confidence/citation → gate
        │
        ▼
[Stage + review]   pendingVisaChanges  →  admin approve  →  countries/{code}/visaTypes
```

- **Cost:** ~**$0.003 per visa page** on DeepSeek-chat. Full first crawl of ~1,000 visas ≈ **$3**. Steady-state weekly cost is **pennies** because the content-hash gate re-extracts only changed pages. (Extraction sits behind a provider interface, so the model is swappable — DeepSeek for cost, a Claude/OpenAI model if you later want max accuracy.)
- **Error-free:** structured output guarantees shape; Zod + range checks guarantee sanity; a **staging + admin-approval** step means scraped data never silently overwrites curated data; nothing is ever auto-deleted.
- **Infra:** reuse the exact `newsSources` + `scrapeNewsOrchestrator` pattern you already have (`functions.pubsub.schedule`, source health/self-healing, staggered `nextCrawlAt`).

---

## Why this shape (and why not the news scraper)

| | News scraper (existing) | Visa catalog (this spike) |
|---|---|---|
| Data shape | Title + summary + link (flat, ~3 fields) | 15-field structured `VisaType` (cost, processing days, eligibility[], validity, extendable…) |
| Source structure | RSS/predictable article lists | Every country's gov site is different; data is buried in prose |
| Extraction | CSS selectors per source | **Impossible to selector-scrape at "all countries" scale** — needs semantic extraction |
| Cadence | Every 30 min (news is time-sensitive) | Daily/weekly (visa rules change slowly) |
| Failure cost | Miss an article | **Corrupt canonical reference data** → wrong info shown to applicants |

The last row is why the design leans hard on validation + human review: this is reference data users make decisions on. "Error-free" here means *never publish a wrong/hallucinated field to the live catalog*, not *never fail a fetch*.

---

## Data model (reuse + additions)

**Canonical store (unchanged):** `countries/{code}/visaTypes/{visaId}` — the existing `VisaType` (see `src/types/index.ts`). Deterministic `visaId = ${countryCode}_${slug(code || name)}` (already the seed convention).

**New collections (mirror `newsSources` / `scrapeRuns`):**

```
visaSources/{sourceId}                 -- per-country source registry + health
visaSources/{sourceId}/crawlRuns/{id}  -- per-run logs (found/new/changed/failed)
pendingVisaChanges/{changeId}          -- staging + review queue (see below)
```

`visaSources` doc (mirrors `NewsSource` — reuse the health/self-healing fields verbatim):

```ts
interface VisaSource {
  id: string;
  countryCode: string;               // "IE"
  name: string;                      // "Irish Immigration Service (ISD)"
  isOfficial: boolean;               // gov domain? (only officials are auto-publishable)
  indexUrl: string;                  // page that LISTS the country's visa types
  // How to find per-visa detail links on the index page (light selector, optional):
  detailLinkSelector?: string;
  // Health + scheduling (identical semantics to NewsSource)
  crawlIntervalHours: number;        // e.g. 168 (weekly), 24 for high-churn countries
  lastCrawledAt?: Timestamp;
  nextCrawlAt?: Timestamp;
  status: "active" | "paused" | "broken" | "retired";
  reliabilityScore: number;
  consecutiveFailures: number;       // auto-pause at 5 (same as news)
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

`pendingVisaChanges` doc — the correctness backbone:

```ts
interface PendingVisaChange {
  id: string;
  countryCode: string;
  visaId: string;                    // deterministic target id
  changeType: "create" | "update";  // never "delete" (see Guardrails)
  proposed: Partial<VisaType>;       // extracted fields
  current?: Partial<VisaType>;       // what's live now (for diff UI)
  diff: string[];                    // changed field names
  confidence: number;                // 0–1 from the extractor
  citations: Record<string, string>; // field -> source quote/URL (audit trail)
  sourceId: string;
  sourceUrl: string;
  contentHash: string;               // SHA-256 of the cleaned page text
  status: "pending" | "approved" | "rejected" | "auto_published";
  createdAt: Timestamp;
}
```

---

## The pipeline, step by step

### 1. Fetch (deterministic, ~free — reuse axios + cheerio)
- Load `visaSources` where `status == "active"` and `nextCrawlAt <= now`; process a bounded batch per invocation (news does ≤5).
- Fetch `indexUrl`, use `detailLinkSelector` (or an LLM "find the visa links" call once per site) to enumerate per-visa detail URLs.
- Fetch each detail page. **Strip boilerplate** with cheerio (drop `nav/header/footer/script/style`, keep main content) → clean text. This cuts tokens ~5–10× vs raw HTML.
- **Content-hash gate:** `sha256(cleanText)`. If unchanged since the last `pendingVisaChanges`/live doc for this visa → **skip extraction entirely.** This is what makes steady-state cost near-zero.
- Respect `robots.txt`, rate-limit per host, send the existing `Seli-VisaNewsBot` UA. Cache raw HTML briefly to allow safe re-runs.

### 2. Extract (LLM, structured output — provider-agnostic, DeepSeek default)
- One call per changed visa page. **Strict JSON schema mirroring `VisaType`** (tool-use `strict: true` or `output_config.format`), so the response is guaranteed to parse and match the shape. `category` is constrained to the `VisaCategory` enum via `enum` in the schema.
- Ask for a **`confidence` (0–1)** and a **`citations` map** (field → verbatim source quote) in the same schema — this is the audit trail and the review-gate signal, and it measurably reduces hallucination (the model must point at text).
- Ground with **2–3 few-shot examples pulled from `seed-countries-visas.ts`** (Ireland/UK) so output matches your exact tone and field conventions.
- **Prompt caching:** the system prompt + schema + few-shots are identical across all ~1,000 calls — mark them as the cached prefix (cache reads ≈ 0.1× input). Only the per-page text is volatile.
- **Provider interface + tiering (cost lever):** the extractor is a thin `LlmExtractor` interface (one `extract(cleanText, schema)` method). Default impl = **DeepSeek-chat** (OpenAI-compatible API, JSON output mode). On Zod/sanity failure or `confidence < threshold`, optionally **re-run that one page on a stronger model** (a DeepSeek reasoner tier, or a Claude/OpenAI extractor) — swappable without touching the pipeline.

### 3. Validate (deterministic, in code)
- **Zod** parse of the model output (backend can add `zod`; portal already uses it).
- **Range/sanity checks:** `baseCostUsd` within a plausible band, `processingDaysMin ≤ processingDaysMax`, non-empty `eligibilityCriteria`, `applicationUrl` on the official domain, etc.
- Fail → escalate to the stronger model once; still fail → drop to review with an error note. **Never publish an invalid record.**

### 4. Stage → review → publish
- Diff `proposed` against the live `visaTypes` doc. No diff → done.
- Write a `pendingVisaChanges` row.
- **Publish policy — NO autopublish (locked decision):**
  - **Every change — new visas AND edits — requires an agent to approve before it goes live.** Nothing the scraper produces is ever written directly to `visaTypes`; it only ever proposes into `pendingVisaChanges`.
  - The agent review screen shows, per proposed change: the field-level diff (for edits), the extracted values with their **per-field citations** (source quote/URL), the model + confidence, and the source URL. Approve → publish; reject → discard with a reason.
  - Confidence/validation still matter — they rank and pre-flag the queue (high-confidence official-source additions bubble to the top; low-confidence items are flagged) — but they change *ordering and warnings*, never *whether a human is in the loop*.
- On publish: write only changed fields, set `updatedAt`, `source`, `lastVerifiedAt`; recompute `Country.visaTypesCount`/`minCostUsd`/`minProcessingDays`.

---

## Guardrails (how we keep it error-free)

1. **Structured output** → response always matches `VisaType` shape (no parse errors, no missing fields).
2. **Zod + range checks** → no absurd values reach the catalog.
3. **Citations + confidence** → every field traceable to source text; low confidence routes to humans, not to production.
4. **Agent approval for ALL changes (locked)** → scraped data can only *propose* into `pendingVisaChanges`; new visas and edits both require an agent to approve before publish. Nothing auto-publishes.
5. **Never auto-delete.** A visa that vanishes from a source is marked `isActive: false` + `staleSince`, never removed — deletion is the highest-blast-radius error.
6. **Official-domain allowlist** → canonical fields only from `.gov`/official immigration domains; third-party blogs (if ever used) are advisory only and never auto-publish.
7. **Golden set regression** → keep the current `seed-countries-visas.ts` entries as a labelled test set; run the extractor against them in CI and alert if accuracy drops below a bar before trusting a model/prompt change.
8. **Source self-healing** → reuse `consecutiveFailures` auto-pause + `reliabilityScore` so a site redesign pauses that source instead of spraying garbage.

---

## Cost analysis

Approximate pricing per 1M tokens (**verify current DeepSeek pricing** — it changes and has off-peak discounts):

| Model | ID | Input | Output |
|---|---|---|---|
| **DeepSeek-chat (default)** | `deepseek-chat` | ~$0.27 | ~$1.10 |
| DeepSeek-reasoner (escalation) | `deepseek-reasoner` | ~$0.55 | ~$2.19 |
| _(swappable) Claude Haiku 4.5_ | `claude-haiku-4-5` | $1.00 | $5.00 |

**Per-page estimate** (after boilerplate stripping): ~6K input + ~1K output.

| | Per visa | Full crawl (~1,000 visas) |
|---|---|---|
| **DeepSeek-chat** | 6K×$0.27 + 1K×$1.10 /1M ≈ **$0.0027** | **≈ $3** |
| DeepSeek-reasoner (escalations only) | ≈ $0.0055 | n/a — only failed pages |
| Claude Haiku 4.5 (if swapped in) | ≈ $0.011 | ≈ $11 |

**Steady state is the real story:** the content-hash gate means a weekly run only extracts pages that *changed* — realistically tens, not thousands — so ongoing cost is **cents per week** regardless of model. DeepSeek's context caching further discounts the repeated system/schema prefix.

> **Provider is swappable by design.** DeepSeek-chat is the cost-optimal default for per-page schema extraction and is what we'll implement. Because the extractor sits behind the `LlmExtractor` interface, swapping in a Claude/OpenAI model later (for max first-pass accuracy) is a one-file change — the fetch, validate, stage, and review layers don't care which model produced the JSON.

---

## Scheduling & infra (reuse what exists)

- **Backfill (one-off):** a `seed`-style script that crawls the whole registry into `pendingVisaChanges`. Spot-check against the golden set before trusting output.
- **Incremental (scheduled):** `functions.pubsub.schedule("0 3 * * 0")` weekly orchestrator (mirror `scrapeNewsOrchestrator`: `512MB` / `540s`, process a bounded batch, stagger via `nextCrawlAt`). Daily cadence for a few high-churn countries.
- **Secrets:** DeepSeek exposes an OpenAI-compatible API, so use the `openai` SDK pointed at `https://api.deepseek.com` (or a small `fetch` wrapper — no heavy dep). Bind `DEEPSEEK_API_KEY` via Firebase secrets and `functions.runWith({ secrets: [...] })` (same pattern as `EMAIL_SECRETS`).
- **Cleanup:** weekly job prunes old `crawlRuns` and resolved `pendingVisaChanges` (mirror `cleanupOldNews`).

---

## Files (proposed)

| File | Purpose |
|---|---|
| `src/types/visa-catalog.ts` | `VisaSource`, `PendingVisaChange`, extraction schema |
| `src/services/visa-catalog-fetch.service.ts` | axios/cheerio fetch + boilerplate strip + hash gate |
| `src/services/visa-catalog-extract.service.ts` | `LlmExtractor` interface + DeepSeek impl (OpenAI-compatible, JSON mode), tiering |
| `src/services/visa-catalog.service.ts` | validate → stage → diff → publish; Country stat rollups |
| `src/data/seed-visa-sources.ts` | initial per-country official source registry |
| `src/scripts/backfill-visa-catalog.ts` | one-off Batch-API backfill runner |
| `src/index.ts` | add `crawlVisaCatalogOrchestrator` + `cleanupVisaCatalog` scheduled fns |
| portal `admin/visa-review` | extend to review/approve `pendingVisaChanges` diffs |

---

## Phased rollout

- **Phase 0 — Prove extraction.** Build fetch + extract + validate for **2–3 countries you already have** (IE/GB). Run against the golden set; measure field accuracy. No writes to live catalog.
- **Phase 1 — Backfill.** Batch-API crawl the target country set into `pendingVisaChanges`; human spot-check; approve.
- **Phase 2 — Scheduled incremental.** Weekly orchestrator + hash gate + auto-publish-new-from-official; edits to review queue.
- **Phase 3 — Review UI + expand.** Admin diff/approve screen; widen the source registry to all countries; tune per-country cadence.

## Decisions (locked 2026-07-10)

1. **Source registry seed:** `official_visa_links_verified_v3.md` (repo root) — **26 countries, 93 verified official links**, per-country tables of `route | official link | validation`. `official_visa_links_world_v1.md` (~474 links, looser format) is the expansion backlog; `v2` is a subset of v3, ignore it.
2. **No autopublish.** Every proposed change (new visa or edit) requires an **agent to approve** before it goes live.
3. **Cadence:** weekly (`crawlIntervalHours: 168`) for the full sweep. Daily reserved for a hot subset later if needed.

## Build order (from here)

- **Step 1 (done):** `visaSources` registry seeded from v3 + `PendingVisaChange`/`VisaSource` types.
- **Step 2 (done):** `visa-catalog-fetch.service.ts` — axios/cheerio boilerplate-strip + content-hash gate + polite per-host rate limiting + robots.txt check. Model-agnostic, verifiable.
- **Step 3:** extract service — `LlmExtractor` interface + **DeepSeek** impl (OpenAI-compatible JSON mode); `DEEPSEEK_API_KEY` secret; strict schema. *(External dependency: a DeepSeek API key.)*
- **Step 4:** validate → stage into `pendingVisaChanges` (no writes to live catalog).
- **Step 5:** weekly `crawlVisaCatalogOrchestrator` scheduled fn.
- **Step 6:** portal agent-review screen (approve/reject the queue with diff + citations).
