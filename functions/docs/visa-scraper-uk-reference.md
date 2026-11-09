# Visa Scraper — UK Reference Design (GOV.UK first, then every country)

> **Status:** Design, 2026-11-09. Builds on [`visa-catalog-scraping-spike.md`](./visa-catalog-scraping-spike.md)
> (the locked decisions there still hold: official sources only, cheap-LLM extraction,
> **no autopublish**, never auto-delete). This doc makes the UK the reference
> implementation and defines the shape every other country plugs into.
>
> **Source registry:** `official_visa_links_verified_v3.md` (meta-repo root), UK = 12 routes.

---

## 1. Where we actually are (code vs. the spike doc)

The spike's "Build order" says Steps 3–6 are pending. Most of it is in fact built on `dev`:

| Piece | File | State |
|---|---|---|
| Source registry seeded from v3 (26 countries) | `src/data/seed-visa-sources.ts` | ✅ built |
| Fetch + boilerplate strip + hash gate + robots + 1.5s/host | `src/services/visa-catalog-fetch.service.ts` | ✅ built (HTML only) |
| LLM extractor (`LlmExtractor`, DeepSeek-chat, JSON mode, validator) | `src/services/visa-catalog-extract.service.ts` | ✅ built |
| Ingest → `countries/{code}/visaTypes` as `source:"scraped"`, `reviewStatus:"pending_review"`, `isActive:false` | `src/services/visa-catalog.service.ts` | ✅ built (create-only, see §7) |
| Scheduled orchestrator | `crawlVisaCatalogOrchestrator` in `src/index.ts` (`0 */6 * * *` UTC) | ✅ built |
| Local runner | `src/scripts/crawl-visa-catalog.ts` | ✅ built |
| Admin approve/reject | `PATCH /admin/visas/:id/review` → `visaService.reviewVisa` | ✅ built (gaps in §7) |
| `pendingVisaChanges` (diff-based edits to live visas) | — | ❌ not built |

Scale-out work is already filed: #16 (per-page state + DeepSeek budget), #15 (robots/crawl-delay in Firestore),
#13 (Cloud Tasks + Cloud Run worker), #19 (throughput ceiling), #17 (source health view), #33/#38 (PDFs/OCR).
**This doc does not repeat those.** It covers the record shape, the UK source, scheduling, blocking, and modularity.

---

## 2. The target record — one shape for every scraped visa

Scraped visas use **the same `VisaType` shape as the seeded catalog** (`src/types/index.ts`, seeded from
`src/data/seed-countries-visas.ts`), so the mobile Explorer, portal and eligibility code need no changes. The
only additions are provenance, so anyone looking at a record can tell it was scraped, from where, and when.

### 2.1 Field-by-field (UK seed → GOV.UK source)

| `VisaType` field | Seed example (`uk-skilled-worker`) | Where it comes from on GOV.UK | Who fills it |
|---|---|---|---|
| `id` | `uk-skilled-worker` | **Registry**, not the LLM (§4.3) | code |
| `countryCode` | `GB` | registry | code |
| `name` | `Skilled Worker Visa` | guide `title` | LLM (title given) |
| `code` | `SWV` | not on page — short code | LLM, **then pinned in registry** |
| `description` | "For workers who have a job offer…" | `overview` part | LLM |
| `category` | `work` | overview | LLM, constrained to `VisaCategory` enum |
| `processingTime` | `3-8 weeks` | `apply-from-outside-the-uk` ("within 3 weeks") | LLM |
| `processingDaysMin` / `Max` | `21` / `56` | same | LLM, validated min ≤ max |
| `baseCostUsd` | `719` ⚠️ | `how-much-it-costs` | **LLM extracts £ amount + currency; code converts** (§2.3) |
| `validityPeriod` | `Up to 5 years` | overview / `how-long-you-can-stay` | LLM |
| `isExtendable` / `maxExtensions` | `true` / — | `extend-your-visa` part exists → true | LLM |
| `eligibilityCriteria[]` | 6 bullets | `your-job`, `knowledge-of-english`, eligibility parts | LLM (5–8 short bullets, seed tone) |
| `applicationUrl` | — | "Apply" link in apply part | LLM, **must be on `gov.uk`** (validator) |
| `applicationInstructions` | — | apply part | LLM |
| `agentIds` | `[]` | — | code (empty) |
| `isActive` | `true` | — | code: `false` until approved |

### 2.2 Provenance — "this was scraped data"

Already on the record today: `source: "scraped"`, `reviewStatus`, `sourceUrl`, and `scrapeMeta`
(`sourceUrl`, `routeName`, `model`, `confidence`, per-field `citations`, `contentHash`, `extractedAt`).
Approval keeps `source: "scraped"`, so the marker stays on the record after it goes live.

Additions to `VisaScrapeMeta` (all optional, so existing docs stay valid):

```ts
interface VisaScrapeMeta {
  // ---- existing ----
  sourceUrl: string; routeName: string; model: string; confidence: number;
  citations: Record<string, string>; contentHash: string; extractedAt: Timestamp;
  // ---- new ----
  sourceProvider: "govuk-content-api" | "generic-html"; // which adapter fetched it (§4)
  sourceDocumentId?: string;   // GOV.UK `content_id` (stable UUID, survives URL renames)
  sourceUpdatedAt?: string;    // GOV.UK `updated_at` — when the *source* last changed
  sectionsUsed?: string[];     // e.g. ["overview","how-much-it-costs",…] — what the LLM saw
  fee?: {                      // the fee AS PUBLISHED, before conversion (§2.3)
    amount: number; currency: string;   // 1235, "GBP"
    fxRateToUsd: number; fxDate: string;
  };
  extractorPromptVersion: string; // bump when the prompt changes, for the golden-set check
}
```

### 2.3 Fees: stop asking the LLM to do currency conversion

Today the prompt says `baseCostUsd (number; convert local fees to USD)`. That asks the model to know an
exchange rate, which is a hallucination risk on the field users care about most. It also explains the seed:
`uk-skilled-worker.baseCostUsd = 719` matches the old **£719** fee, so the seed most likely stored GBP in a
USD field. **Change:** the LLM returns `{feeAmount, feeCurrency}` exactly as printed (with a citation). Code
converts to `baseCostUsd` using a rate stored in `appConfig/fx` (refreshed by the same nightly job), and
records the original in `scrapeMeta.fee`. The validator rejects a fee with no citation.

### 2.4 A complete scraped UK record (illustrative values)

```json
{
  "id": "uk-skilled-worker",
  "countryCode": "GB",
  "name": "Skilled Worker visa",
  "code": "SWV",
  "description": "For people with a job offer from a UK employer approved by the Home Office.",
  "category": "work",
  "processingTime": "Usually within 3 weeks (outside the UK)",
  "processingDaysMin": 15, "processingDaysMax": 21,
  "baseCostUsd": 1568,
  "validityPeriod": "Up to 5 years",
  "isExtendable": true,
  "eligibilityCriteria": ["Job offer from a Home Office-approved sponsor", "Certificate of sponsorship", "…"],
  "applicationUrl": "https://www.gov.uk/skilled-worker-visa/apply-from-outside-the-uk",
  "isActive": false, "agentIds": [],
  "source": "scraped", "reviewStatus": "pending_review",
  "sourceUrl": "https://www.gov.uk/skilled-worker-visa",
  "scrapeMeta": {
    "sourceProvider": "govuk-content-api",
    "sourceDocumentId": "f9015c31-61c2-4504-8eb0-242cd75aee19",
    "sourceUpdatedAt": "2026-09-14T16:24:44+01:00",
    "sectionsUsed": ["overview","your-job","knowledge-of-english","how-much-it-costs","apply-from-outside-the-uk","extend-your-visa"],
    "fee": { "amount": 1235, "currency": "GBP", "fxRateToUsd": 1.27, "fxDate": "2026-11-09" },
    "model": "deepseek-chat", "extractorPromptVersion": "uk-v1", "confidence": 0.86,
    "citations": { "fee": "£1,235 per person if the certificate of sponsorship is for more than 3 years", "…": "…" },
    "contentHash": "sha256:…", "extractedAt": "2026-11-10T03:21:07Z"
  }
}
```

---

## 3. The UK source: use the GOV.UK Content API, not the HTML

GOV.UK publishes every page as JSON: `https://www.gov.uk/api/content/<path>` (e.g.
`/api/content/skilled-worker-visa`). It is public, needs no key, is served from the CDN
(`cache-control: max-age=300`), and is not disallowed by `robots.txt`. Checked 2026-11-09 against 5 of the
12 routes: all are `schema_name: "guide"` with `details.parts[]` (6–14 parts each).

Why this beats the current HTML fetch for the UK:

| Problem with HTML today | Content API |
|---|---|
| Skilled Worker page is ~57k chars of text; `MAX_CLEAN_TEXT_CHARS = 24_000` cuts it **silently** mid-guide (dependants, extensions, switching lost) | Each part comes back separately; we **choose** the parts (§3.2) and send ~36k chars (~9k tokens) |
| Hash changes on any markup/banner tweak → unneeded LLM calls (#16 is fixing this with a normalizer) | Hash the selected parts' text only; `updated_at` is an extra cheap change signal |
| URL is the only identity | `content_id` is a stable UUID |
| Retired visa = 404 / redirect guesswork | `withdrawn_notice` says so explicitly → mark `isActive:false` + `staleSince` (never delete) |

### 3.1 The 12 UK routes and their record IDs

| Route | Path | Record `id` |
|---|---|---|
| Standard Visitor | `/standard-visitor` | `uk-visitor` *(seeded)* |
| Skilled Worker | `/skilled-worker-visa` | `uk-skilled-worker` *(seeded)* |
| Student | `/student-visa` | `uk-student` *(seeded)* |
| Family | `/uk-family-visa` | `uk-family` *(seeded)* |
| Health and Care Worker | `/health-care-worker-visa` | `uk-health-care-worker` |
| Child Student | `/child-study-visa` | `uk-child-student` |
| Graduate | `/graduate-visa` | `uk-graduate` |
| Global Talent | `/global-talent` | `uk-global-talent` |
| High Potential Individual | `/high-potential-individual-visa` | `uk-hpi` |
| Youth Mobility Scheme | `/youth-mobility` | `uk-youth-mobility` |
| India Young Professionals | `/india-young-professionals-scheme-visa` | `uk-india-young-professionals` |
| British National (Overseas) | `/british-national-overseas-bno-visa` | `uk-bno` |

Family is one guide covering partner/child/parent routes. v1 keeps it as **one** record, matching the seed.
Splitting it into sub-routes is a later decision.

### 3.2 Which parts go to the LLM

Pick by slug pattern rather than a hard-coded list, because slugs vary a little between guides:

- **include:** `overview`, `eligibility|your-job|knowledge-of-english|money|…-requirements`, `how-much-it-costs|fees`,
  `how-long|apply-from-outside-the-uk|apply` (processing time), `extend-your-visa`, `documents-you-must-provide`
- **exclude:** `switch-to-this-visa`, `your-partner-and-children`, `certificate-of-sponsorship-before-*`,
  `update-your-visa-*`, `second-job`, anything else (dependants and switching aren't in the `VisaType` shape)

Parts are sent as `## <part title>\n<plain text>` blocks, so the model's citations can name the section.

---

## 4. Modular design — how other countries plug in

### 4.1 Pipeline (shared) vs. adapters (per source type)

```
registry row (visaSources/{CC}) ──► SourceAdapter.fetch(page) ──► SourceDocument
                                     │  govuk-content-api  (GB)
                                     │  generic-html       (everyone else, today's fetch service)
                                     ▼
                 section selection ──► LlmExtractor (shared, DeepSeek) ──► validator (shared + per-country rules)
                                     ──► ingest (shared: create / pending-edit / unchanged / stale)
```

```ts
/** One implementation per kind of source, not per country. */
interface SourceAdapter {
  readonly id: "govuk-content-api" | "generic-html";
  canHandle(url: string): boolean;
  fetch(page: VisaSourcePage): Promise<SourceDocument>;
}

/** What every adapter returns. The rest of the pipeline only sees this. */
interface SourceDocument {
  url: string; canonicalUrl: string;
  sourceProvider: SourceAdapter["id"];
  sourceDocumentId?: string; sourceUpdatedAt?: string; withdrawn: boolean;
  sections: { slug: string; title: string; text: string }[]; // generic-html → one section
  contentHash: string;                                       // over the SELECTED sections
}
```

### 4.2 Per-country config lives in the registry, not in code

New optional fields on `VisaSource` (country level) and `VisaSourcePage`:

```ts
interface VisaSource {
  // …existing…
  adapter?: SourceAdapter["id"];           // default "generic-html"
  crawlWindow?: { timeZone: string; startHour: number; endHour: number }; // §5
  feeCurrency?: string;                    // "GBP" — validator sanity check
  officialHosts?: string[];                // ["www.gov.uk"] — applicationUrl allowlist
}
interface VisaSourcePage {
  // …existing…
  visaId?: string;        // pinned record id (§4.3)
  visaCode?: string;      // pinned short code, e.g. "SWV"
  includeSections?: string[]; excludeSections?: string[]; // override §3.2 defaults
}
```

**Adding a country is then a registry row** (seeded from the verified-links markdown). Code is only needed when
a country has a structured source worth its own adapter, such as an API or a predictable CMS.

### 4.3 Record identity comes from the registry, never from the LLM

Today `buildVisaId` is `${CC}_${slug(extracted.code || extracted.name)}`, where `code` is whatever the model
invents. Seeded UK docs are `uk-skilled-worker` etc., so a scraped Skilled Worker would be written as
`GB_swv` (or `GB_skilled_worker`, depending on the run), **next to** the curated one. That creates duplicates,
and the ID can also change between runs. **Change:** use `page.visaId` when it's set, otherwise
`${cc}-${slug(path)}`, which is deterministic. The seed for the 4 existing UK visas is backfilled with their
`visaId`.

---

## 5. When to scrape — recommendation

**UK: check every night, starting 03:15 Europe/London, window 02:00–05:00 local.** The LLM only runs
for routes whose content changed.

Why:

1. **Politeness.** UK overnight is when the fewest real people use GOV.UK, so our requests compete with no one.
2. **Freshness.** GOV.UK publishes during the UK working day. A 03:00 run picks up the previous day's edits
   within about 18 hours. Fee and rule changes have announced effective dates, so a weekly run could leave a
   wrong fee live for up to 6 days.
3. **It's nearly free to check.** 12 Content API calls a night (~1.5s apart, about 20 seconds total). The LLM
   only runs on routes that changed, so most nights it makes zero calls.
4. **Review queue is ready by morning.** London is UTC+0/+1 and Lagos is UTC+1, so proposals made at 03:00 are
   waiting when agents start work. Weekend-published changes are reviewed on Monday.
5. **`:15`, not `:00`.** It keeps us off the top of the hour, when most other people's cron jobs fire.

Use `.timeZone("Europe/London")` so the run follows GMT/BST automatically. The function currently uses
`"UTC"`, so its local time would shift by an hour in summer.

**This changes a locked decision** (the spike set a weekly cadence): UK goes to a daily *check*, with
extraction still only on change. Other countries stay weekly until they have a cheap change signal like GOV.UK's.

**Generalised for other countries:** each source has a `crawlWindow` in its own timezone (e.g. Ireland
`Europe/Dublin`, Canada `America/Toronto`, UAE `Asia/Dubai`). The orchestrator ticks hourly at `:15`,
queries due sources (`status == active && nextCrawlAt <= now`), and keeps only those whose local hour is
inside their window. That in-memory filter is fine at ~30 countries. After a run it sets `nextCrawlAt` to the
next window opening plus `crawlIntervalHours`.

> *Optional:* DeepSeek has at times offered an off-peak price window. If it currently does, extraction can be
> queued and drained in that window separately from the fetch, because the stages are already decoupled.
> Check current pricing before building this.

---

## 6. Getting blocked: what the risk actually is

**Facts about our setup.** The crawler runs as a gen-1 Cloud Function with no region set (so `us-central1`).
Its outbound requests leave from Google Cloud's shared egress IP pool, not from a Seli-owned address.

**What this means for the concern that we share the Seli Firebase project:**

- **A block cannot take the app down.** Users talk to *our* API. GOV.UK never sees user traffic routed
  through us, and no user-facing feature calls a government site server-side. If a site blocked our crawler,
  the result would be that *scraping* stops and the source auto-pauses after 5 failures (already built).
- **Running at night doesn't make us harder to identify, and that's fine.** When traffic is low, our requests
  are a *larger* share of it, so they're more visible. We aren't hiding: we identify ourselves. The reasons
  to run at night are courtesy and freshness (§5), not stealth.
- **The real block risk is not about time of day.** Some sites' bot protection scores *datacenter IP
  ranges* regardless of what we do. (The v3 list already notes GOV.UK pages that returned errors for Marriage
  Visitor and Seasonal Worker; canada.ca sits behind Akamai.) For the UK this is very unlikely: the Content
  API is a published machine interface and we make ~12 requests a day.

**Responsible-crawler checklist** (most of this already exists):

- [x] Honest User-Agent `Seli-VisaCatalogBot/1.0 (+https://weareseli.com/bot)`
- [ ] **`/bot` currently serves the marketing homepage.** Add a real page in `seli-website`: what we crawl,
      how often, a contact email, and how to ask us to stop.
- [x] robots.txt respected (#15 adds `Crawl-delay` + shared state); [x] ≥1.5s per host
- [ ] On `429`/`503`, honour `Retry-After`, back off exponentially, and count it toward auto-pause (today a 429 is just "a failure")
- [ ] Conditional requests (`If-None-Match`/`If-Modified-Since`) where the source supports them
- [ ] If a site *does* block datacenter IPs: route that source through the #13 Cloud Run worker with a
      **static egress IP** (Cloud NAT) and ask the site to allowlist it, or drop the source. We do **not**
      rotate IPs or use residential proxies to get around a block. That would be evasion, and it would
      undermine our "official sources" story.

---

## 7. Gaps to close for the UK (proposed issues)

| # | Gap | Fix |
|---|---|---|
| A | No GOV.UK adapter; HTML truncated at 24k chars | `SourceAdapter` interface + `govuk-content-api` adapter + part selection (§3, §4.1) |
| B | LLM-invented IDs → duplicates of seeded UK visas | Registry-pinned `visaId`/`visaCode`; backfill the 4 seeded UK visas (§4.3) |
| C | LLM converts currency | `{feeAmount, feeCurrency}` + code FX + `scrapeMeta.fee` (§2.3); re-check the seed's GBP-in-USD values |
| D | Ingest **skips** any approved/seeded visa → curated UK data never updates | Build the spike's `pendingVisaChanges` (diff + citations) for live visas; approval applies the diff |
| E | Approval doesn't set `lastVerifiedAt` or recompute `Country` stats (`recomputeCountryStats` exists but isn't called) | Call both in `reviewVisa` on approve |
| F | Schedule: `0 */6 * * *` UTC, weekly per source | Per-source `crawlWindow` + `Europe/London` daily UK check (§5) |
| G | Bot hygiene | Real `/bot` page; `Retry-After`/429 backoff (§6) |
| H | No accuracy bar for the UK | Golden set = the 4 seeded UK visas, hand-corrected against today's GOV.UK; CI check per `extractorPromptVersion` |

Order: **B → A → C → H → D → E → F → G**. B comes first because it stops new duplicates. A and C determine
data quality. H has to exist before anyone trusts a prompt change. D and E keep approved data current.

## 8. LLM: stay on the cheap model, send it less

Keep **DeepSeek-chat** behind `LlmExtractor`. It's already wired, and `DEEPSEEK_API_KEY` is already a
secret. The code does almost no parsing: the adapter returns plain-text sections, and the model fills the
schema. Per changed UK route: ~9k tokens in, ~1.5k out, roughly **$0.004** at the spike's prices (re-verify).
A full UK backfill of 12 routes costs about 5 cents. A typical night costs $0, because nothing changed.
The system prompt + schema + 2 UK few-shot examples are identical on every call, so they're the cached prefix.
