import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { publishedDateSelectorProblem } from "../guidance-published-date";
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
 * The registry entries to seed.
 *
 * EMPTY ON PURPOSE in this issue: #39 delivers the registry, its schema, the
 * seed shape and the crawl. The first real entries are added by #111, which
 * also records, per entry, what was retrieved. Add an entry here as data
 * only; no code in this module may depend on what an entry's jurisdiction,
 * route or publisher is.
 */
export const GUIDANCE_SOURCE_SEEDS: GuidanceSourceSeed[] = [];

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
