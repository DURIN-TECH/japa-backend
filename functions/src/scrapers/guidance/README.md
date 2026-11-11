# Guidance source registry: runbook

The registry (`guidanceSources`, issue #39) holds the published rules and
caseworker guidance a rubric is built from. Each source is fetched through the
shared fetch service (bot user agent, robots.txt, per-host delay), its cleaned
text is hashed, and every distinct text is kept as an immutable snapshot keyed
by that hash. This page says how to add sources, seed, crawl and recover.

Everything here is generic: a source is a row of data. No code under
`guidance/` (outside `data/`) names a country, a route or a publisher, and a
unit test enforces that.

## Files

| File | What it is |
| --- | --- |
| `data/seed-guidance-sources.ts` | The entries (data), the validator, the loader |
| `data/guidance-quote-checks.ts` | Passages that must appear verbatim in the stored snapshots (data) |
| `guidance-crawl.service.ts` | Fetch, hash gate, snapshot |
| `guidance-resolve.ts` | Looks up a document's current address on a parent page (`resolveFrom`) |
| `guidance-quote-check.ts` | The quote integrity check |
| `guidance-seed-run.ts` | The script's guards: which project a run may touch, and whether a crawl did its job |
| `guidance-snapshot.store.ts` | Snapshot text in Cloud Storage, read back by hash |
| `scripts/seed-guidance-sources.ts` | The CLI below |

## Adding a source

Add a row to `GUIDANCE_SOURCE_SEEDS`. Before you do, retrieve the document
yourself and record honestly what you got:

- `verificationStatus: "verified"` only if the whole document was retrieved;
  `partial` if part of it was; `unverified` (with `retrievalError`) if it
  could not be retrieved. Only `verified` and `partial` sources are crawled.
- `verificationNote` says what was retrieved, how, and when. Do not copy it
  from an issue or a summary.
- `url` is taken from the publisher's live page, not from memory.
- If `url` redirects, declare `expectedFinalUrl`. Without it the first crawl
  fails with `redirect_changed` and stores nothing.
- `publishedDateSelector` (optional) is a regular expression with one capture
  group around the date. Keep it LITERAL: write the publisher's lead-in words
  out and capture only the date, for example
  `issued to staff on (\d{1,2} [A-Za-z]+ \d{4})`. No leading `.*` / `.+`, no
  quantifier inside a repeated group, and no quantified group that contains
  `|` (not even `(a|b)?`); the validator refuses all three. It is matched in
  the first and last 20,000 characters of the cleaned text only. If the
  cleaned text carries no date, leave the selector out: `publishedDate` stays
  null, which is the truth.

### A document whose address changes with each publication

Some files get a new address at every release (a release id in the path)
while a stable page always links to the current one. Describe that with
`resolveFrom`:

```ts
url: "<the file's address on the day you retrieved it>",
resolveFrom: {
  pageUrl: "<the stable page that links to the file>",
  linkPattern: "https://files\\.publisher\\.example/media/[0-9a-f]+/[^/?#]+\\.pdf",
},
```

At crawl time the page is read first (robots.txt and the per-host delay apply
to it too), the ONE link matching the whole pattern is requested, and the
address used is recorded as `resolvedUrl` on the source and as `url` on the
snapshot (with `resolvedFromUrl` naming the page). `url` in the seed is then
only a record; it is never requested and does not need updating at the next
release.

Rules the validator enforces:

- the pattern begins with a literal `https://<host>/` with the dots escaped,
  and the character after that slash is not a quantifier (`?`, `*`, `+`, `{`);
- no top-level `|`, no nested quantifiers, no quantified group containing `|`;
- the seed's `url` is on the same host as the pattern;
- no `expectedFinalUrl` on the same entry.

The host is also enforced independently of the pattern: each candidate link
is parsed as a URL and must be https, on exactly the pattern's host, with no
user name, password or explicit port. A link longer than 512 characters is
not considered. No match, or more than one distinct match, fails the crawl
with `resolve_failed` and stores nothing: tighten the pattern.

### Pinning passages

For passages a later stage will rely on, add rows to `GUIDANCE_QUOTE_CHECKS`:
the passage copied character for character from the published document, and
the ids of the entries whose snapshot must contain it. List two ids to assert
that two renditions of one document (web page and PDF) agree. Only whitespace
is normalised when matching; quote marks, dashes, case and wording must be
exact. Never adjust a passage to make the check pass: if it fails, re-read
the source. Give every source at least one passage (a sentence from its
opening is enough): a unit test requires it, and a check that finds no
passage to check fails.

## Seeding and crawling

Run from `functions/`. The target project is always named explicitly.

### Which project a run may touch

The script decides this before it reads or writes anything, and prints which
project and which stores (both emulators, or the real project) it will use.

- **Emulators**: set a `demo-*` project id and BOTH emulator hosts. One host
  without the other, an emulator host with a non-demo project id, or a
  `demo-*` id with no emulator host are refused.
- **A real project**: any run that writes (`--apply`) must repeat the project
  id in `--confirm-project=<project>`. Without it, or with a different id,
  nothing is written. Read-only runs (dry run, `--check-quotes`) need no
  confirmation.

```bash
# Local: emulators on non-default ports, a demo project id.
export GCLOUD_PROJECT=demo-guidance
export FIRESTORE_EMULATOR_HOST=127.0.0.1:<port> FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:<port>
npm run seed:guidance-sources -- --apply --crawl
```

### Commands (a real project)

```bash
# Dry run: validate the entries and print them. Writes nothing.
GCLOUD_PROJECT=<project> npm run seed:guidance-sources

# Write the registry entries (no network request).
GCLOUD_PROJECT=<project> npm run seed:guidance-sources -- --apply --confirm-project=<project>

# Write, then crawl whatever is due, then run the quote check.
GCLOUD_PROJECT=<project> npm run seed:guidance-sources -- --apply --crawl --confirm-project=<project>

# Crawl named sources now, due or not (also retries a `failing` source).
GCLOUD_PROJECT=<project> npm run seed:guidance-sources -- --apply --crawl --only=<id>,<id> --confirm-project=<project>

# Quote check only, against what is already stored. No network, no write.
GCLOUD_PROJECT=<project> npm run seed:guidance-sources -- --check-quotes
```

An `--only` id that is not a seed entry is an error: the script stops before
doing anything.

A crawl prints the run summary (counters and one line per source), then the
registry state (final URL, hash, publisher's date, snapshot size and page
count), then the quote check. The script exits non-zero when:

- any source the run was for did not end `changed`, `unchanged` or `not_due`
  with a stored snapshot (so skipped, deferred, failed, dropped after an
  unexpected error, or never fetched);
- any passage was not found, or the quote check had nothing to check.

A second crawl of unchanged sources writes nothing: `unchanged` goes up,
`snapshotsWritten`, `storageObjectsWritten` and `downstreamCalls` stay 0.
Without `--only`, sources checked within their `checkIntervalHours` are not
requested at all (`notDue`).

Local runs use the Firestore and Storage emulators with a `demo-` project id
and non-default ports. Do not seed or crawl a shared project from a feature
branch.

## Recovering a source

The admin list (`GET /admin/guidance-sources`) shows `status`, `lastError`
and `lastErrorKind` per source.

- **`redirect_changed`**: the address now ends somewhere else. Open both
  addresses, confirm the new one is the same document, then set
  `expectedFinalUrl` (or the new `url`) in the seed and re-seed.
  If the source already went `failing`, re-seeding alone does NOT bring it
  back: a scheduled crawl skips `failing` sources, and a re-seed with an
  unchanged `url` never un-fails one. Crawl it by id after re-seeding:

  ```bash
  GCLOUD_PROJECT=<project> npm run seed:guidance-sources -- --apply --crawl --only=<id> --confirm-project=<project>
  ```

  A successful by-id crawl sets it back to `active`.
- **`resolve_failed`**: the parent page no longer links to exactly one file
  that matches `linkPattern` (the page was restructured, or a second
  attachment was added). Fix the pattern, re-seed, and crawl by id as above.
- **`content_type_changed`**, **`pdf_unreadable`**, **`text_too_long`**: the
  document itself changed shape. Retrieve it by hand, correct the entry (or
  mark it `partial` / `unverified` with what happened), re-seed, crawl by id.
- **`http_error`**, **`fetch_error`**, **`host_backoff`**, **`robots_blocked`**:
  nothing to change in the data unless the document moved. The crawl never
  works around a block or a rate limit.

A quote check that starts failing after a crawl means the publisher changed
the wording (a new snapshot was written; the old one is still readable by its
hash). That is a signal for the rubric owner, not something to patch here.
