import * as fs from "fs";
import * as path from "path";

import {
  VISA_CATALOG_USER_AGENT,
  visaCatalogFetchService,
  type RawResponse,
  type VisaCatalogFetchService,
} from "../src/services/visa-catalog-fetch.service";
import { govukContentApiUrl, isWithdrawnNotice } from "../src/services/visa-source-adapters";
import { EVAL_ROUTES, GOLDEN_DIR, findEvalRoute, type EvalRoute } from "./config";
import { unifiedDiff } from "./diff";
import { guidePath, guidePlainText, type GuideBody, type GuideFixture, type GuidePart } from "./golden";

// ============================================
// VISA EXTRACTION EVAL — FIXTURE REFRESH (`npm run eval:record`, issue #60)
// ============================================
//
//   npm run eval:record -- <route|--all> [--write]
//
// Re-records a golden route's guide.json from the live GOV.UK Content API and
// prints a unified diff of `updated_at`, the part slugs and the guide's part text against the
// stored fixture.
//   - Without --write: shows the diff only, changes NO file.
//   - With --write:    overwrites guide.json of every CHANGED route (an
//                      unchanged one is left byte-for-byte) and reminds you to
//                      re-verify expected.json (values + quotes + verifiedBy/verifiedOn).
// So a GOV.UK change only enters the golden set as a deliberate, reviewed commit.
//
// Politeness (reference doc §6): every request goes through the SHARED
// production `visaCatalogFetchService` — our honest bot User-Agent, robots.txt
// check on the API URL, >= 1.5s between requests to www.gov.uk — and routes
// are fetched one at a time (no parallelism).
//
// Safety: a non-200, non-JSON, non-guide, withdrawn or part-less response
// aborts WITHOUT writing. With --all every route is fetched and checked first;
// if any fails, nothing is written at all.
//
// Exit codes: 0 ok, 1 a recording failed (nothing written), 2 usage error.

/** Accept header sent with every Content API request (recorded in `_fixture`). */
const ACCEPT_JSON = "application/json";

/** Thrown when a response must not be recorded (non-200, non-guide, withdrawn…). */
export class RecordRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordRejectedError";
  }
}

/**
 * Validate a raw Content API response and trim it to the recorded shape: the
 * identity fields + `withdrawn_notice` + `details.parts[{slug,title,body}]`
 * (part bodies kept VERBATIM). Same trimming as test/fixtures/govuk-*.json.
 * Throws RecordRejectedError for anything that must not become a fixture.
 */
export function toRecordedBody(resp: RawResponse, apiUrl: string): GuideBody {
  if (resp.status !== 200) {
    throw new RecordRejectedError(`HTTP ${resp.status} from ${apiUrl} — not recorded`);
  }
  let item: Record<string, unknown>;
  try {
    item = JSON.parse(resp.body) as Record<string, unknown>;
  } catch {
    throw new RecordRejectedError(`non-JSON body from ${apiUrl} — not recorded`);
  }
  if (!item || typeof item !== "object") {
    throw new RecordRejectedError(`non-object body from ${apiUrl} — not recorded`);
  }
  if (item.schema_name !== "guide") {
    throw new RecordRejectedError(
      `${apiUrl} is not a guide (schema_name "${String(item.schema_name)}") — not recorded`
    );
  }
  if (isWithdrawnNotice(item.withdrawn_notice)) {
    throw new RecordRejectedError(`${apiUrl} is WITHDRAWN — not recorded`);
  }
  const details = (item.details ?? {}) as { parts?: unknown };
  const rawParts = Array.isArray(details.parts) ? (details.parts as Record<string, unknown>[]) : [];
  const parts: GuidePart[] = rawParts
    .filter((p) => p && typeof p.slug === "string" && typeof p.body === "string")
    .map((p) => ({
      body: p.body as string,
      slug: p.slug as string,
      title: typeof p.title === "string" ? p.title : (p.slug as string),
    }));
  if (parts.length === 0) {
    throw new RecordRejectedError(`${apiUrl} has no details.parts — not recorded`);
  }

  // Only string-typed identity fields are kept (absent stays absent).
  const pick = (k: string) => (typeof item[k] === "string" ? (item[k] as string) : undefined);
  const body: GuideBody = {
    content_id: pick("content_id"),
    base_path: pick("base_path"),
    title: pick("title"),
    schema_name: "guide",
    document_type: pick("document_type"),
    locale: pick("locale"),
    updated_at: pick("updated_at") ?? null,
    public_updated_at: pick("public_updated_at") ?? null,
    withdrawn_notice: item.withdrawn_notice ?? {},
    details: { parts },
  };
  // Drop undefined keys so the JSON file stays clean.
  return JSON.parse(JSON.stringify(body)) as GuideBody;
}

/** Wrap a recorded body in the fixture envelope (`_fixture` provenance). */
export function buildFixture(
  body: GuideBody,
  apiUrl: string,
  contentType: string,
  recordedAt: string
): GuideFixture {
  const n = body.details?.parts?.length ?? 0;
  return {
    _fixture: {
      sourceUrl: apiUrl,
      recordedAt,
      recordedBy: `${VISA_CATALOG_USER_AGENT}, Accept: ${ACCEPT_JSON}`,
      notes: `Real response, trimmed to the fields the adapter reads (parts bodies kept verbatim). ${n} parts.`,
    },
    status: 200,
    contentType: contentType || "application/json",
    body,
  };
}

/**
 * The text that the diff compares: `updated_at`, the ordered part SLUGS (a
 * renamed / added / removed slug changes section selection, so it must show
 * even when the text is the same), then every part as plain text.
 */
export function diffableText(body: GuideBody | undefined): string {
  if (!body) return "";
  const slugs = (body.details?.parts ?? []).map((p) => p.slug).join(", ");
  return `updated_at: ${String(body.updated_at ?? "")}\nparts: ${slugs}\n\n${guidePlainText(body)}`;
}

/** Options for recordRoutes (injectable for tests). */
export interface RecordOptions {
  routes: readonly EvalRoute[];
  write: boolean;
  fetchService?: VisaCatalogFetchService; // default: the production singleton
  goldenDir?: string; // default: eval/golden
  log?: (line: string) => void; // default: console.log
  today?: string; // YYYY-MM-DD stamp; default: today (UTC)
}

/**
 * Fetch every route (sequentially), validate, diff against the stored fixture
 * and — only when `write` and EVERY route recorded fine — overwrite guide.json.
 * Returns the exit code (0 ok, 1 a recording was rejected / failed).
 */
export async function recordRoutes(opts: RecordOptions): Promise<number> {
  const fetchService = opts.fetchService ?? visaCatalogFetchService;
  const goldenDir = opts.goldenDir ?? GOLDEN_DIR;
  const log = opts.log ?? ((l: string) => console.log(l));
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  // ---- Phase 1: fetch + validate every route (no file touched) ----
  const recorded: { route: EvalRoute; fixture: GuideFixture; changed: boolean }[] = [];
  for (const route of opts.routes) {
    const apiUrl = govukContentApiUrl(route.url);
    try {
      // Same politeness path as the adapter: robots for the API URL, then a
      // rate-limited GET with our UA (shared client).
      if (!(await fetchService.isAllowedByRobots(apiUrl))) {
        throw new RecordRejectedError(`blocked by robots.txt: ${apiUrl}`);
      }
      const resp = await fetchService.getRaw(apiUrl, { Accept: ACCEPT_JSON });
      const body = toRecordedBody(resp, apiUrl);
      const fixture = buildFixture(body, apiUrl, resp.contentType, today);

      // Diff against what is stored (a missing file diffs against "").
      const file = guidePath(route.route, goldenDir);
      const stored = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as GuideFixture)
        : undefined;
      const diff = unifiedDiff(
        diffableText(stored?.body),
        diffableText(body),
        `${route.route}/guide.json (stored${stored ? `, recorded ${stored._fixture.recordedAt}` : ": none"})`,
        `${route.route} (live ${apiUrl})`
      );
      if (diff) {
        log(`\n=== ${route.route}: CHANGED ===\n${diff}`);
      } else {
        log(`=== ${route.route}: no text or updated_at change ===`);
      }
      recorded.push({ route, fixture, changed: Boolean(diff) });
    } catch (err) {
      log(`ABORT ${route.route}: ${(err as Error).message}`);
      log("Nothing was written.");
      return 1;
    }
  }

  // ---- Phase 2: write (only with --write, only after every route passed) ----
  if (!opts.write) {
    log("\nDry run: no file changed. Re-run with --write to overwrite the fixture(s).");
    return 0;
  }
  for (const { route, fixture, changed } of recorded) {
    const file = guidePath(route.route, goldenDir);
    // Unchanged on GOV.UK → keep the stored file byte-for-byte (its recordedAt
    // and expected.fixtureRecordedAt stay valid; SW/Graduate stay identical to
    // test/fixtures). Only a real change is rewritten.
    if (!changed) {
      log(`unchanged, not rewritten: ${path.relative(process.cwd(), file)}`);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
    log(`wrote ${path.relative(process.cwd(), file)}`);
    log(
      `  -> RE-VERIFY eval/golden/${route.route}/expected.json against the live page: ` +
        "values, `source` quotes (npm test checks they are still in guide.json), " +
        "fixtureRecordedAt, and reset verifiedBy/verifiedOn to the person who checked."
    );
  }
  return 0;
}

/** Parse argv; returns the routes + write flag, or a usage error message. */
export function parseRecordArgs(argv: string[]): { routes: EvalRoute[]; write: boolean } | { error: string } {
  const write = argv.includes("--write");
  const rest = argv.filter((a) => a !== "--write");
  if (rest.length !== 1) {
    return { error: "usage: npm run eval:record -- <route|--all> [--write]" };
  }
  if (rest[0] === "--all") return { routes: [...EVAL_ROUTES], write };
  const route = findEvalRoute(rest[0]);
  if (!route) {
    return { error: `unknown route "${rest[0]}" (known: ${EVAL_ROUTES.map((r) => r.route).join(", ")})` };
  }
  return { routes: [route], write };
}

// ----- CLI entry -----

if (require.main === module) {
  const parsed = parseRecordArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }
  recordRoutes(parsed).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
