// ============================================
// Entry requirements (issue #236) — the code names no country or nationality
// ============================================
//
// Every region's English name (from Intl.DisplayNames, so the list is not
// typed into this test either) must be absent from the module's source files,
// as a whole, capitalised word. Codes and names are data in the rules.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "..", "src");

/** Every .ts file under a directory. */
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(full) : e.name.endsWith(".ts") ? [full] : [];
  });
}

/** English names of every two-letter region code (AA..ZZ that Intl knows). */
function regionNames(): string[] {
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const out = new Set<string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name: string | undefined;
      try {
        name = dn.of(code);
      } catch {
        name = undefined;
      }
      // Intl answers the code itself for an unknown region.
      if (name && name !== code && name.length >= 4 && !/unknown/i.test(name)) out.add(name);
    }
  }
  return [...out];
}

describe("entry requirements: no country or nationality name in code", () => {
  test("no region name appears in the module's files", () => {
    const files = [...tsFiles(path.join(SRC, "entry-requirements")), path.join(SRC, "types", "entry-requirements.ts")];
    assert.ok(files.length >= 8, `only ${files.length} files`);
    const names = regionNames();
    assert.ok(names.length > 200, "the region list was built");
    const hits: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const name of names) {
        const re = new RegExp(`(^|[^A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`);
        if (re.test(text)) hits.push(`${path.relative(SRC, f)}: ${name}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
