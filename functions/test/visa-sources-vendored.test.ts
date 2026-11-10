// ============================================
// Unit tests — vendored verified-links markdown (issue #78)
// ============================================
//
// Run with `npm test`. No Firestore / emulator needed.
//
// The seed reads a copy of official_visa_links_verified_v3.md vendored into
// functions/src/data/ (the meta-repo file is not in CI's checkout). These
// tests check that:
//   - the vendored copy is found from both src/data and compiled lib/data;
//   - it parses to all 26 registry countries (what a dev deploy must seed);
//   - it never drifts from the meta-repo copy (checked when that copy is
//     reachable; skipped in a standalone checkout such as CI);
//   - a missing file FAILS the seed when CI=true and only warns locally.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  COUNTRY_CODES,
  KR_TEMPORARY_VISIT_URL,
  KR_VISA_FEE_TABLE_URL,
  MARKDOWN_FILENAME,
  META_MARKDOWN_ENV,
  findMetaRepoVisaSourcesMarkdown,
  findVisaSourcesMarkdown,
  parseVisaSourcesMarkdown,
  seedVisaSources,
  vendoredVisaSourcesMarkdownPath,
} from "../src/data/seed-visa-sources";

// functions/src/data — where the copy is committed.
const SRC_DATA = path.resolve(__dirname, "../src/data");
// functions/lib/data — where the compiled seed module runs in CI (seed:dev).
// Only path math: the directory doesn't need to exist for these tests.
const LIB_DATA = path.resolve(__dirname, "../lib/data");
const VENDORED = path.join(SRC_DATA, MARKDOWN_FILENAME);

describe("vendored verified-links markdown", () => {
  test("is committed in src/data and found from src/data and lib/data", () => {
    assert.ok(fs.existsSync(VENDORED), `missing ${VENDORED}`);
    assert.equal(findVisaSourcesMarkdown(SRC_DATA), VENDORED);
    // Compiled lib/data has no .md (tsc doesn't copy it) -> falls back to src/data.
    assert.equal(findVisaSourcesMarkdown(LIB_DATA), VENDORED);
    // The sync script's destination is the same committed file from either layout.
    assert.equal(vendoredVisaSourcesMarkdownPath(SRC_DATA), VENDORED);
    assert.equal(vendoredVisaSourcesMarkdownPath(LIB_DATA), VENDORED);
  });

  test("does not walk up to a different copy", () => {
    // A directory with no vendored copy at either probed location
    // (<dir>/ and <dir>/../../src/data/) -> undefined, even if some ancestor
    // had the file. An empty temp tree guarantees neither location exists.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visa-md-"));
    try {
      assert.equal(findVisaSourcesMarkdown(path.join(tmp, "lib", "data")), undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("parses to all 26 registry countries, each with at least one page", () => {
    const parsed = parseVisaSourcesMarkdown(fs.readFileSync(VENDORED, "utf8"));
    const codes = parsed.filter((c) => c.pages.length > 0).map((c) => c.countryCode).sort();
    assert.equal(codes.length, 26);
    assert.deepEqual(codes, Object.values(COUNTRY_CODES).sort());
  });

  // #67 added the HiKorea C-3 route; #86 added the Korea Visa Portal fee
  // table as a supplement-only row right after it.
  test("carries the KR rows (#67 HiKorea C-3 page + #86 visa fee table)", () => {
    const parsed = parseVisaSourcesMarkdown(fs.readFileSync(VENDORED, "utf8"));
    const kr = parsed.find((c) => c.countryCode === "KR");
    assert.ok(kr, "no South Korea section");
    assert.deepEqual(kr.pages.map((p) => p.url), [KR_TEMPORARY_VISIT_URL, KR_VISA_FEE_TABLE_URL]);
    // Both rows are TEXT-VERIFIED in the source of truth.
    assert.ok(kr.pages.every((p) => p.validation === "text_verified"));
  });
});

describe("vendored copy vs. meta-repo source of truth", () => {
  // Byte-for-byte, so whitespace / row-order edits in the meta-repo are caught
  // too. Fix a failure with `npm run sync:visa-sources` and commit the result.
  test("is byte-identical to the meta-repo copy (when present)", (t) => {
    const meta = findMetaRepoVisaSourcesMarkdown(SRC_DATA);
    if (!meta) {
      t.skip("meta-repo copy not reachable (standalone seli-backend checkout, e.g. CI)");
      return;
    }
    assert.notEqual(path.resolve(meta), VENDORED, "meta-repo lookup returned the vendored file");
    assert.ok(
      fs.readFileSync(meta).equals(fs.readFileSync(VENDORED)),
      `${VENDORED} differs from ${meta} — run \`npm run sync:visa-sources\` and commit`
    );
  });

  test(`${META_MARKDOWN_ENV} overrides the walk-up (and a bad path finds nothing)`, () => {
    const saved = process.env[META_MARKDOWN_ENV];
    try {
      process.env[META_MARKDOWN_ENV] = VENDORED;
      assert.equal(findMetaRepoVisaSourcesMarkdown(SRC_DATA), VENDORED);
      process.env[META_MARKDOWN_ENV] = path.join(SRC_DATA, "does-not-exist.md");
      assert.equal(findMetaRepoVisaSourcesMarkdown(SRC_DATA), undefined);
    } finally {
      if (saved === undefined) delete process.env[META_MARKDOWN_ENV];
      else process.env[META_MARKDOWN_ENV] = saved;
    }
  });
});

describe("seedVisaSources with a missing source list", () => {
  // The missing-file check runs BEFORE getFirestore(), so no Firebase init is
  // needed here. CI is restored after the block (GitHub Actions sets it).
  const savedCi = process.env.CI;
  after(() => {
    if (savedCi === undefined) delete process.env.CI;
    else process.env.CI = savedCi;
  });
  const missing = path.join(SRC_DATA, "no-such-visa-links.md");

  test("fails when CI=true (no silent skip on a deploy)", async () => {
    process.env.CI = "true";
    await assert.rejects(seedVisaSources(missing), /not found.*refusing to skip in CI/);
  });

  test("only warns and seeds nothing locally", async () => {
    delete process.env.CI;
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      assert.equal(await seedVisaSources(missing), 0);
    } finally {
      console.warn = warn;
    }
    assert.match(warnings.join("\n"), /not found.*skipping/);
  });
});
