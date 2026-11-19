# Page reader (`shared/fetch`)

`visa-catalog-fetch.service.ts` is the one reader every scraper uses (robots.txt,
per-host politeness, address guard, 429/503 backoff). Text limits:

| Kind | Cap | When over |
| --- | --- | --- |
| Ordinary web page | 24,000 characters (`MAX_CLEAN_TEXT_CHARS`) | sliced (visa pages) |
| Guidance web page (caller passes `maxHtmlTextChars`) | 1,000,000 | fails (`HtmlTextTooLongError`) |
| PDF | 1,000,000 (`DEFAULT_PDF_LIMITS.maxTextChars`) | fails |
| EU law (below) | 1,000,000 unless the caller names a limit | fails |

## EU law: use the `publications.europa.eu` machine address

`eur-lex.europa.eu` pages answer our reader with an empty shell (a redirect to the
site root, about 250 characters of menu). Register EU legal texts instead as

    https://publications.europa.eu/resource/celex/{CELEX}

for example `02009R0810-20240628` (the Visa Code, consolidated 28 June 2024).
The reader (`eu-law.ts`) recognises that address form and, only for it:

- sends `Accept: application/xhtml+xml` and `Accept-Language: eng` (without the
  Accept header the address is a 404), keeping our normal user agent, robots and
  politeness;
- follows the redirect to `/resource/cellar/<uuid>/DOC_1`, on the same host only
  (any other host, or a redirect to the site root, is refused);
- returns the whole text, never cut; over the cap it fails;
- removes consolidation marker tokens (`▼B`, `▼M7`, `▼C1`, `►M5 ... ◄`) from the
  cleaned text and keeps everything else. A quote copied by hand from EUR-Lex
  must therefore be copied without the marker tokens;
- records the address requested and the final address, as for any page. The
  guidance crawl accepts that redirect as the expected one.

The registry host `publications.europa.eu` must be a confirmed official host
before a source on it can be registered from the portal.

**A newer consolidated version has a new CELEX number** (the date suffix changes
when the law is amended). The admin updates the address; finding the newest
version automatically is a follow-up.
