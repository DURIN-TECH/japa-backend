/**
 * Sync the vendored verified-links markdown from the meta-repo (issue #78).
 *
 * The source of truth for the visa-catalog source registry is
 * `official_visa_links_verified_v3.md` at the meta-repo root. seli-backend
 * vendors a copy at `functions/src/data/` so the seed works in CI, where only
 * seli-backend is checked out. Run this after editing the meta-repo file, then
 * commit the updated vendored copy:
 *
 *   npm run sync:visa-sources
 *
 * The meta-repo copy is found by walking up from above the seli-backend root
 * (main checkout and `.worktrees/` worktrees both work), or taken from
 * $SELI_META_VISA_SOURCES_MD when set (e.g. to vendor from a meta-repo
 * worktree on another branch).
 *
 * Exit codes: 0 = copied or already identical; 1 = meta-repo copy not found.
 * No Firebase access: this is a pure file copy.
 */
import * as fs from "fs";
import {
  MARKDOWN_FILENAME,
  META_MARKDOWN_ENV,
  findMetaRepoVisaSourcesMarkdown,
  vendoredVisaSourcesMarkdownPath,
} from "../data/seed-visa-sources";

function main(): void {
  // 1. Source: the meta-repo copy. Absent = standalone seli-backend checkout,
  //    which has nothing to sync from — say so and fail, so a typo'd env var
  //    or wrong directory doesn't look like a successful sync.
  const source = findMetaRepoVisaSourcesMarkdown();
  if (!source) {
    console.error(
      `[sync-visa-sources] meta-repo ${MARKDOWN_FILENAME} not found ` +
        `(walked up from above seli-backend; or set ${META_MARKDOWN_ENV}).`
    );
    process.exitCode = 1;
    return;
  }

  // 2. Destination: the committed src/data copy (never lib/, build output).
  const dest = vendoredVisaSourcesMarkdownPath();
  const next = fs.readFileSync(source);
  const current = fs.existsSync(dest) ? fs.readFileSync(dest) : undefined;

  // 3. Byte comparison, the same check the drift test makes.
  if (current && current.equals(next)) {
    console.log(`[sync-visa-sources] already in sync with ${source}`);
    return;
  }
  fs.writeFileSync(dest, next);
  console.log(`[sync-visa-sources] copied ${source} -> ${dest} (commit the change)`);
}

main();
