// ============================================
// Unit tests — the shared "no seed country code" rule (issue #322)
// ============================================
// The examples are the ones the issue lists: a code in a comment or inside a
// sentence string passes; a code as an identifier, a property name, a whole
// string literal or inside a string with no space fails. The codes used here
// (NO, IS, HU, MT) are only test inputs to the helper; no file under src/ is read.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { codeWithoutCommentsAndSentences, findCountryCode, hasCountryCode } from "./country-code-guard";

describe("country-code guard (#322): ignored in comments and sentences", () => {
  test("a line comment passes", () => {
    assert.equal(hasCountryCode("// There is NO delete\nconst x = 1;", "NO"), false);
  });

  test("a multi-line block comment and a JSDoc comment pass", () => {
    assert.equal(hasCountryCode("/*\n * The record IS kept\n * as written.\n */\nconst x = 1;", "IS"), false);
    assert.equal(hasCountryCode("/** NO country is named. */\nexport function f(): void {}", "NO"), false);
  });

  test("a string that is a sentence (contains a space) passes, in any quote style", () => {
    assert.equal(hasCountryCode('const p = "list NO country among its options";', "NO"), false);
    assert.equal(hasCountryCode("const p = 'list NO country';", "NO"), false);
    assert.equal(hasCountryCode("const p = `list NO country`;", "NO"), false);
    // A template with a substitution is one string: a space in any part makes it a sentence.
    assert.equal(hasCountryCode("const p = `list ${n} NO country`;", "NO"), false);
  });

  test("a comment after a URL string is still a comment", () => {
    assert.equal(hasCountryCode('const u = "https://x.example.org/a"; // NO more', "NO"), false);
  });
});

describe("country-code guard (#322): still a failure in code", () => {
  test("a whole string literal fails, in any quote style", () => {
    assert.equal(hasCountryCode('const c = "NO";', "NO"), true);
    assert.equal(hasCountryCode("const c = 'IS';", "IS"), true);
    assert.equal(hasCountryCode("const c = `IS`;", "IS"), true);
  });

  test("a comparison and a list of codes fail", () => {
    assert.equal(hasCountryCode('if (countryCode === "IS") { run(); }', "IS"), true);
    assert.equal(hasCountryCode('const list = ["HU", "MT"];', "HU"), true);
    assert.equal(hasCountryCode('const list = ["HU", "MT"];', "MT"), true);
  });

  test("a string with no space fails (a hard-coded path)", () => {
    assert.equal(hasCountryCode("const p = `countries/NO/visaTypes`;", "NO"), true);
    assert.equal(hasCountryCode('const p = "countries/NO/visaTypes";', "NO"), true);
    // ...also when its `${...}` parts hold no space either.
    assert.equal(hasCountryCode("const p = `countries/${x}/NO`;", "NO"), true);
  });

  test("an identifier or a property name fails", () => {
    assert.equal(hasCountryCode("const NO = 1;", "NO"), true);
    assert.equal(hasCountryCode("const o = { IS: 1 };", "IS"), true);
    assert.equal(hasCountryCode("const v = codes.IS;", "IS"), true);
    assert.equal(hasCountryCode('const o = { "NO": 1 };', "NO"), true);
  });

  test("a `//` inside a string does not hide the code after it", () => {
    assert.equal(hasCountryCode('const s = "a//b"; const c = "NO";', "NO"), true);
    assert.equal(hasCountryCode("const s = 'a/*b'; const c = 'NO'; // */", "NO"), true);
  });

  test("a URL with `://` is not treated as a comment", () => {
    assert.equal(hasCountryCode('const u = "https://x.example.org/NO";', "NO"), true);
    assert.equal(hasCountryCode('const u = "https://x.example.org"; const c = "NO";', "NO"), true);
  });

  test("a regular expression with `//` in it does not start a comment", () => {
    assert.equal(hasCountryCode('const r = /a\\/\\/b/; const c = "NO";', "NO"), true);
  });

  test("whole word and case-sensitive: lower case and parts of words pass", () => {
    assert.equal(hasCountryCode('const c = "no"; const NOTE = 1;', "NO"), false);
  });
});

describe("country-code guard (#322): output shape", () => {
  test("keeps the length and the line breaks, so line numbers stay true", () => {
    const src = '// NO\nconst a = "x y";\n/* IS\n*/ const b = "NO";\n';
    const out = codeWithoutCommentsAndSentences(src);
    assert.equal(out.length, src.length);
    assert.deepEqual([...out].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0), [...src].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0));
  });

  test("the failure names the offending line of the original text", () => {
    assert.equal(findCountryCode('// NO here\nconst c = "NO";\n', "NO"), 'const c = "NO";');
    assert.equal(findCountryCode("// NO here\n", "NO"), null);
  });
});
