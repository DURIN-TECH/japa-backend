import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { publishedDateSelectorProblem } from "../guidance-published-date";
import { linkPatternHost, resolveFromProblems } from "../guidance-resolve";
import { GUIDANCE_SOURCE_ID_RE } from "../guidance-snapshot.store";
import {
  GUIDANCE_DOC_TYPES,
  GUIDANCE_VERIFICATION_STATUSES,
  type GuidanceSourceSeed,
} from "../types";

// ============================================
// GUIDANCE SOURCE REGISTRY — SEED (issue #39)
// ============================================
//
// Data plus a loader, the same shape as news/seed-news-sources.ts: a static
// list of entries, a pure builder that turns one entry into the doc to
// write, and `seedGuidanceSources()` which writes them under deterministic
// ids with `{ merge: true }` so re-running is idempotent. No fetching happens
// here: seeding only writes the registry; the crawl fetches.
//
// NOTE: the Firestore handle is resolved LAZILY inside seedGuidanceSources()
// (not at module load), like the other seeders: this module is reachable from
// scrapers/index.ts, which is loaded on every cold start.
//
// ---- Verification honesty ----
//
// Every entry must say how far a human got when retrieving the document by
// hand: `verificationStatus` plus a free-text `verificationNote` recording
// what was actually retrieved and when. The validator below refuses an entry
// that claims more than it records:
//  - `verified` needs a `retrievedAt` and must NOT carry a `retrievalError`;
//  - `partial` needs a `retrievedAt` (something was retrieved);
//  - `unverified` needs the `retrievalError` of the failed attempt.
// So a source that could not be fully retrieved cannot be seeded as verified
// by leaving the failure out: recording the failure forces the lower status.
// The crawl skips `unverified` sources (guidance-crawl.service.ts).

/**
 * How often the entries below are re-checked: weekly. The documents change a
 * few times a year, and the crawl is a hash gate, so a weekly look is enough
 * to notice a re-issue without asking the publisher's servers more than that.
 */
const WEEKLY_HOURS = 24 * 7;

/**
 * The registry entries to seed.
 *
 * Add an entry here as DATA only; no code in this module (or anywhere in
 * guidance/) may depend on what an entry's jurisdiction, route or publisher
 * is. Adding another route's sources means adding rows to this list (and,
 * for passages worth pinning, rows to guidance-quote-checks.ts).
 *
 * ---- The first entries (issue #111) ----
 *
 * Five documents, all sharing one `jurisdiction` + `route` key pair, which is
 * the pair the rubric built from them will be keyed by. Two of them (the
 * suitability rules and the finance appendix) are general documents that the
 * route's own rules refer to; they are registered under the same route key
 * because that is the route they are read for here.
 *
 * Every `verificationNote` below records what was ACTUALLY retrieved, by
 * whom and when: each document was requested once on 2026-11-11 through the
 * shared fetch service (bot user agent, robots.txt checked, per-host delay),
 * the same code path the crawl uses, and the numbers in the note are that
 * request's. The addresses were taken from the publisher's live pages on
 * that day, not from the issue text. Nothing here is copied from a summary.
 *
 * Publisher's date: only the two renditions of the caseworker guidance carry
 * their own "published for staff on" line in the text that is stored, so
 * only they have a `publishedDateSelector`. The three rules pages show their
 * "updated" date in page furniture OUTSIDE the main content the fetch
 * service keeps, so their snapshots report no date and `publishedDate`
 * stays null for them (recorded per entry; not guessed, not copied).
 */
export const GUIDANCE_SOURCE_SEEDS: GuidanceSourceSeed[] = [
  {
    id: "gb-appendix-v-visitor",
    title: "Immigration Rules Appendix V: Visitor",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-v-visitor",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "31,960 characters of cleaned text, sha256 fc9142666910e764a61bcf377bc52e84653dbfc231d5b8b3ed9095da94fbd6aa. " +
      "The text runs from the page title to the last rule of the last section (it is not cut short). " +
      "Read closely: V 3.1, V 4.2 and V 4.3; the rest was retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-11T10:48:37Z",
  },
  {
    id: "gb-visit-guidance-html",
    title: "Visit caseworker guidance (accessible web version)",
    url: "https://www.gov.uk/government/publications/visit-guidance/visit-caseworker-guidance-accessible--2",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    // The document's own line, e.g. "published for Home Office staff on <date>".
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "147,856 characters of cleaned text, sha256 4427af933123fdb6273c4d0f27165e11bc41b03cd2ab0605041b8fda0cb27a0c. " +
      "The address is the one the publication page linked to on that day. The text states version 18.0, " +
      "published for staff on 8 October 2026, and runs through the last numbered section (19.9). " +
      "Read closely: sections 7.2, 7.3, 7.4 and 8.2; the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-11T10:48:38Z",
  },
  {
    id: "gb-visit-guidance-pdf",
    title: "Visit caseworker guidance (PDF)",
    // The file's address ON THE DAY IT WAS RETRIEVED. It carries a per-release
    // id and changes with every publication, so the crawl does not request
    // this value: it reads the current address from `resolveFrom` each time.
    url: "https://assets.publishing.service.gov.uk/media/6ab66e8ba9c3d267bcccef22/Visit__updated_.pdf",
    resolveFrom: {
      // The stable publication page that always links to the current file.
      pageUrl: "https://www.gov.uk/government/publications/visit-guidance",
      // The one PDF attachment on that page: any release id, any file name.
      linkPattern: "https://assets\\.publishing\\.service\\.gov\\.uk/media/[0-9a-f]+/[^/?#]+\\.pdf",
    },
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "pdf",
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "814,372-byte PDF, 80 pages, every page with a text layer, 169,325 characters of cleaned text, " +
      "sha256 9d4d1a72479fc64f8a5da0a92a12a8c6f129a2f6fdef62101177aeb02bb5ec6f. The file's address was read " +
      "from the publication page on that day (it was the only PDF linked there). Each page is headed " +
      "'Published for Home Office staff on 8 October 2026'; page 1 states version 18.0. " +
      "Read closely: the passages on pages 21 to 23 and 26 that correspond to sections 7.2, 7.3, 7.4 and 8.2 of the " +
      "web version (the PDF's headings are not numbered); the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-11T10:48:43Z",
  },
  {
    id: "gb-part-suitability",
    title: "Immigration Rules: Part Suitability",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-part-suitability",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "36,186 characters of cleaned text, sha256 75e7884bf7a91b9d7064c6bbe9ef884c617a30c9c48b19f9f6cf6311c25c7e35. " +
      "The address is the one the publisher's index of the rules linked to on that day; this is the document " +
      "the visitor rules name for refusal grounds (V 3.1 of the entry above). The text runs from the title to the " +
      "last numbered paragraph (it is not cut short). Read closely: the opening and the closing paragraphs only; " +
      "the rest was retrieved, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-11T10:48:40Z",
  },
  {
    id: "gb-appendix-finance",
    title: "Immigration Rules Appendix Finance",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-finance",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "9,076 characters of cleaned text, sha256 12d7089b98578dc7379bc40672a99364e4b0fa10a199004b1aaf0d3c20596847. " +
      "The address is the one the publisher's index of the rules linked to on that day. Registered because the " +
      "visitor rules (V 4.2(e) of the first entry) refer to FIN 2.1 of this document. The text runs from the title to " +
      "the last numbered paragraph (it is not cut short). Read closely: FIN 2.1; the rest was retrieved and skimmed, " +
      "not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-11T10:48:41Z",
  },
];

/** Statuses a seed may set (`failing` belongs to the crawler). */
const SEEDABLE_STATUSES = ["active", "paused", "retired"] as const;

/** A route / jurisdiction key: letters, digits and inner hyphens. */
const KEY_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** Bounds for `checkIntervalHours`: hourly at most, yearly at least. */
export const MIN_CHECK_INTERVAL_HOURS = 1;
export const MAX_CHECK_INTERVAL_HOURS = 24 * 366;

/** Crawl-state fields the crawler owns; a re-seed never resets them. */
export const GUIDANCE_CRAWL_STATE_DEFAULTS = {
  lastFetchedAt: null,
  lastContentHash: null,
  finalUrl: null,
  resolvedUrl: null,
  publishedDate: null,
  publishedDateText: null,
  latestSnapshotId: null,
  lastChangedAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
  lastError: null,
  lastErrorKind: null,
  lastErrorAt: null,
  backoffUntil: null,
} as const;

/** True for an absolute https URL. */
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** True for a non-empty string. */
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Everything wrong with one seed entry (empty = valid). Pure. The messages
 * name the field so a failed seed says exactly what to fix.
 */
export function validateGuidanceSourceSeed(seed: GuidanceSourceSeed): string[] {
  const problems: string[] = [];
  const s = seed as Partial<GuidanceSourceSeed>;

  // ---- Identity and location ----
  if (typeof s.id !== "string" || !GUIDANCE_SOURCE_ID_RE.test(s.id)) {
    problems.push("id must be lowercase letters, digits and hyphens");
  }
  if (!isText(s.title)) problems.push("title is required");
  if (!isHttpsUrl(s.url)) problems.push("url must be an absolute https URL");
  if (s.expectedFinalUrl !== undefined && !isHttpsUrl(s.expectedFinalUrl)) {
    problems.push("expectedFinalUrl must be an absolute https URL");
  }
  // A document whose address changes per publication (issue #111): where to
  // look the current one up. The resolved address is then the redirect
  // baseline, so a fixed `expectedFinalUrl` would contradict it.
  if (s.resolveFrom !== undefined) {
    problems.push(...resolveFromProblems(s.resolveFrom));
    if (s.expectedFinalUrl !== undefined) {
      problems.push("expectedFinalUrl cannot be combined with resolveFrom (the resolved address is the redirect baseline)");
    }
    // `url` records where the document WAS; the pattern says where it may
    // be. They must name the same host, or one of the two is a mistake.
    const patternHost =
      typeof s.resolveFrom?.linkPattern === "string" ? linkPatternHost(s.resolveFrom.linkPattern) : null;
    if (patternHost && isHttpsUrl(s.url) && new URL(s.url as string).hostname !== patternHost) {
      problems.push(`url must be on the host resolveFrom.linkPattern names (${patternHost})`);
    }
  }
  if (typeof s.jurisdiction !== "string" || !KEY_RE.test(s.jurisdiction)) {
    problems.push("jurisdiction must be a key of letters, digits and hyphens");
  }
  // The route key is generic and lowercase so two seeders cannot spell the
  // same route two ways.
  if (typeof s.route !== "string" || !KEY_RE.test(s.route) || s.route !== s.route.toLowerCase()) {
    problems.push("route must be a lowercase key of letters, digits and hyphens");
  }

  // ---- Document kind, schedule, status ----
  if (!GUIDANCE_DOC_TYPES.includes(s.docType as never)) problems.push(`docType must be one of ${GUIDANCE_DOC_TYPES.join(", ")}`);
  if (
    typeof s.checkIntervalHours !== "number" ||
    !Number.isFinite(s.checkIntervalHours) ||
    s.checkIntervalHours < MIN_CHECK_INTERVAL_HOURS ||
    s.checkIntervalHours > MAX_CHECK_INTERVAL_HOURS
  ) {
    problems.push(`checkIntervalHours must be between ${MIN_CHECK_INTERVAL_HOURS} and ${MAX_CHECK_INTERVAL_HOURS}`);
  }
  if (s.status !== undefined && !SEEDABLE_STATUSES.includes(s.status as never)) {
    problems.push(`status must be one of ${SEEDABLE_STATUSES.join(", ")} (the crawler sets "failing")`);
  }
  if (s.publishedDateSelector !== undefined) {
    const problem = typeof s.publishedDateSelector === "string"
      ? publishedDateSelectorProblem(s.publishedDateSelector)
      : "publishedDateSelector must be a string";
    if (problem) problems.push(problem);
  }

  // ---- Verification honesty ----
  if (!GUIDANCE_VERIFICATION_STATUSES.includes(s.verificationStatus as never)) {
    problems.push(`verificationStatus must be one of ${GUIDANCE_VERIFICATION_STATUSES.join(", ")}`);
  }
  if (!isText(s.verificationNote)) {
    problems.push("verificationNote is required: say what was actually retrieved, and when");
  }
  if (s.retrievedAt !== undefined && (typeof s.retrievedAt !== "string" || Number.isNaN(Date.parse(s.retrievedAt)))) {
    problems.push("retrievedAt must be an ISO-8601 date or date-time");
  }
  if (s.retrievalError !== undefined && !isText(s.retrievalError)) {
    problems.push("retrievalError must be a non-empty string when present");
  }
  if (s.verificationStatus === "verified") {
    if (s.retrievedAt === undefined) problems.push("a verified source needs retrievedAt (when it was retrieved in full)");
    // The rule that stops a failed retrieval being seeded as verified.
    if (s.retrievalError !== undefined) {
      problems.push("a source with a retrievalError cannot be verified: seed it as partial or unverified");
    }
  }
  if (s.verificationStatus === "partial" && s.retrievedAt === undefined) {
    problems.push("a partial source needs retrievedAt (when the part that was retrieved was retrieved)");
  }
  if (s.verificationStatus === "unverified" && s.retrievalError === undefined) {
    problems.push("an unverified source needs retrievalError (what the failed retrieval returned)");
  }
  return problems;
}

/**
 * Validate a whole list: every entry's problems, plus duplicate ids and
 * duplicate URLs. Returns messages prefixed with the entry they belong to.
 */
export function validateGuidanceSourceSeeds(seeds: readonly GuidanceSourceSeed[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  seeds.forEach((seed, i) => {
    const label = typeof seed?.id === "string" && seed.id ? seed.id : `entry ${i}`;
    for (const p of validateGuidanceSourceSeed(seed)) problems.push(`${label}: ${p}`);
    if (ids.has(seed.id)) problems.push(`${label}: duplicate id`);
    ids.add(seed.id);
    if (urls.has(seed.url)) problems.push(`${label}: duplicate url ${seed.url}`);
    urls.add(seed.url);
  });
  return problems;
}

/**
 * The doc to write (merged) for one seed entry. Pure.
 *
 *  - Curated fields always come from the seed.
 *  - A NEW source gets the blank crawl state and status `active` (unless the
 *    seed sets one).
 *  - An EXISTING source keeps its crawl state (hash, snapshots pointer,
 *    failure streak): a re-seed must not make the crawler forget what it has
 *    fetched or un-fail a failing source. Its status changes only when the
 *    seed sets one explicitly; a `failing` source is not flipped to `active`
 *    by the seed (only a successful crawl does that).
 *  - If the seed's `url` differs from the stored one, the entry now points at
 *    a different address, so the redirect baseline and the failure streak
 *    are reset and a `failing` source is given a fresh start. The stored
 *    hash is kept: if the text behind the new URL is the same, nothing is
 *    re-snapshotted.
 */
export function buildSeededGuidanceSource(
  seed: GuidanceSourceSeed,
  existing: Record<string, unknown> | undefined,
  now: Timestamp
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    title: seed.title.trim(),
    url: seed.url,
    jurisdiction: seed.jurisdiction,
    route: seed.route,
    docType: seed.docType,
    // null (not undefined) so a selector removed from the seed is removed
    // from the doc by the merge.
    publishedDateSelector: seed.publishedDateSelector ?? null,
    expectedFinalUrl: seed.expectedFinalUrl ?? null,
    // A copy of the two strings (never the seed object itself), or null.
    resolveFrom: seed.resolveFrom
      ? { pageUrl: seed.resolveFrom.pageUrl, linkPattern: seed.resolveFrom.linkPattern }
      : null,
    checkIntervalHours: seed.checkIntervalHours,
    verificationStatus: seed.verificationStatus,
    verificationNote: seed.verificationNote.trim(),
    retrievedAt: seed.retrievedAt ? Timestamp.fromMillis(Date.parse(seed.retrievedAt)) : null,
    retrievalError: seed.retrievalError?.trim() ?? null,
    updatedAt: now,
  };

  if (!existing) {
    // Brand-new source: blank crawl state.
    Object.assign(doc, GUIDANCE_CRAWL_STATE_DEFAULTS, { status: seed.status ?? "active", createdAt: now });
    return doc;
  }

  // Existing source: fill in only the crawl-state fields an older doc lacks.
  for (const [field, value] of Object.entries(GUIDANCE_CRAWL_STATE_DEFAULTS)) {
    if (existing[field] === undefined) doc[field] = value;
  }
  if (existing.createdAt === undefined) doc.createdAt = now;

  const urlChanged = existing.url !== seed.url;
  const wasFailing = existing.status === "failing";
  if (urlChanged) {
    // A different address: forget the old redirect baseline and streak.
    Object.assign(doc, {
      finalUrl: null,
      resolvedUrl: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorKind: null,
      lastErrorAt: null,
      backoffUntil: null,
      autoPaused: false,
      autoPausedAt: null,
      autoPausedReason: null,
      autoPauseCause: null,
    });
  }
  if (seed.status !== undefined && !(wasFailing && seed.status === "active" && !urlChanged)) {
    // An explicit seed status wins, except that "active" does not un-fail a
    // failing source whose URL is unchanged.
    doc.status = seed.status;
  } else if (existing.status === undefined || (wasFailing && urlChanged)) {
    doc.status = "active";
  }
  return doc;
}

/**
 * Seed the `guidanceSources` collection.
 *
 * Validates EVERY entry first and writes nothing if any is invalid (the
 * error lists all problems). Each source is written under its `id` with
 * `{ merge: true }`.
 *
 * @param seeds the entries to write (default: GUIDANCE_SOURCE_SEEDS)
 * @returns the number of sources seeded
 */
export async function seedGuidanceSources(seeds: readonly GuidanceSourceSeed[] = GUIDANCE_SOURCE_SEEDS): Promise<number> {
  const problems = validateGuidanceSourceSeeds(seeds);
  if (problems.length > 0) {
    throw new Error(`Invalid guidance source seed(s), nothing written:\n- ${problems.join("\n- ")}`);
  }
  if (seeds.length === 0) {
    console.log("Guidance sources: no seed entries, nothing to write");
    return 0;
  }

  // Resolved here (not at module load): see the note at the top of the file.
  const db = getFirestore();
  const collection = db.collection("guidanceSources");
  const now = Timestamp.now();

  // Read the existing docs in one round trip so crawl state survives.
  const refs = seeds.map((s) => collection.doc(s.id));
  const snaps = await db.getAll(...refs);

  const batch = db.batch();
  seeds.forEach((seed, i) => {
    const existing = snaps[i]?.exists ? (snaps[i].data() as Record<string, unknown>) : undefined;
    batch.set(refs[i], buildSeededGuidanceSource(seed, existing, now), { merge: true });
  });
  await batch.commit();
  console.log(`Seeded ${seeds.length} guidance source(s)`);
  return seeds.length;
}
