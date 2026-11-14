// ============================================
// The translation firewall and the genericness of the language code (issue #220)
// ============================================
//
// 1. An unofficial translation is NEVER evidence. These tests read the SOURCE
//    TEXT of the whole tree: only the files that write or define the field may
//    mention `quoteTranslations`, and nothing that builds a prompt, scores a
//    rule or shows a quote to a model may import the translation module. A
//    behavioural test then builds the assessment request from a rubric that
//    carries a translation and shows the marker is not in it.
// 2. No language, country or publisher is named in code: languages exist only
//    as data files. The names come from the lexicon files themselves.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LEXICON_DIR, availableLanguageCodes } from "../../../src/scrapers/language/language-lexicon";
import { QUOTE_TRANSLATION_PROMPT_VERSION, QUOTE_TRANSLATION_SYSTEM_PROMPT, buildTranslationOutputSchema, buildTranslationRequest } from "../../../src/scrapers/rubric/rubric-translation";
import { buildJudgementRequest } from "../../../src/services/ai/assessment-engine";

const SRC = path.join(__dirname, "..", "..", "..", "src");

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(full) : e.name.endsWith(".ts") ? [full] : [];
  });
}
const ALL = tsFiles(SRC).map((f) => ({ file: path.relative(SRC, f), text: fs.readFileSync(f, "utf8") }));

/** The ONLY files that may mention the stored field. */
const FIELD_ALLOWED = new Set([
  "types/rubric.ts", // the type
  "scrapers/rubric/rubric-translation.ts", // builds / reads it
  "scrapers/rubric/rubric-extraction.service.ts", // writes it onto the draft
  // The evaluation tooling copies translations into the human sample sheet, labelled: it calls no model with them.
  "scrapers/rubric/scripts/evaluate-language.ts",
  // (#278) EXPLICIT extension: the storage layout names the field only to move it, unread, into a
  // version's part documents and back (a large version is split over several documents). It hands
  // the field to no prompt, checker or consumer; the served rubric is exactly the one-document one.
  "scrapers/rubric/rubric-version-storage.ts",
]);
/** The ONLY files that may import the translation module. */
const IMPORT_ALLOWED = new Set([
  "scrapers/rubric/rubric-extraction.service.ts",
  "scrapers/rubric/rubric-language-eval.ts", // the label, for the human sample sheet
  "scrapers/index.ts", // the public API re-export (the label and the view clients will show)
]);

describe("an unofficial translation is never evidence", () => {
  test("only the files that define and write the field mention `quoteTranslations`", () => {
    const offenders = ALL.filter((f) => /quoteTranslations/.test(f.text) && !FIELD_ALLOWED.has(f.file)).map((f) => f.file);
    assert.deepEqual(offenders, []);
  });

  test("only the extraction service imports the translation module (no prompt builder, checker, planner, engine or consumer does)", () => {
    const offenders = ALL.filter((f) => /rubric-translation["']/.test(f.text) && !IMPORT_ALLOWED.has(f.file)).map((f) => f.file);
    assert.deepEqual(offenders, []);
  });

  test("the prompt builders and every consumer of a quote name no translation", () => {
    const builders = ["scrapers/rubric/rubric-prompt.ts", "scrapers/rubric/rubric-checker-prompt.ts", "scrapers/rubric/rubric-checker.ts", "scrapers/rubric/rubric-question-check.ts", "scrapers/rubric/rubric-question-planner.ts", "scrapers/rubric/rubric-repair.ts"];
    const consumers = ALL.filter((f) => f.file.startsWith("services/ai/")).map((f) => f.file);
    for (const file of [...builders, ...consumers]) {
      const text = ALL.find((f) => f.file === file)?.text ?? "";
      assert.ok(text.length > 0, file);
      assert.ok(!/quoteTranslation|translationView|UNOFFICIAL_TRANSLATION|rubric-translation/.test(text), `${file} must not touch translations`);
    }
  });

  test("the assessment request built from a rubric that carries a translation holds the ORIGINAL quote and never the translation", () => {
    const original = "El solicitante debe tener al menos 18 años de edad.";
    const marker = "TRANSLATION-MARKER-MUST-NOT-APPEAR";
    const rubric: any = {
      intentPolarity: null,
      criteria: [{ criterionId: "c1", title: "Aged 18 or over", kind: "judgement", stage: "eligibility", severity: "high", source: { quote: original, sourceId: "s", url: "https://x.example", contentHash: "h", retrievedAt: "t" }, probeFactors: ["f"] }],
      quoteTranslations: { c1: { text: marker, language: "en", model: "m", promptVersion: "p", unofficial: true, quoteHash: "x" } },
    };
    const req = buildJudgementRequest({ rubric, objectiveSummary: "none", profileSummary: "p", intakeSummary: "i", extractionSummary: "e", statementText: "s" } as any);
    assert.ok(req.user.includes(original));
    assert.ok(!req.user.includes(marker) && !req.system.includes(marker));
  });
});

describe("the translation request carries only the quotes", () => {
  test("system prompt constant, user message: language names and the passages, nothing a model wrote", () => {
    const req = buildTranslationRequest([{ criterionId: "c1", quote: "Texto uno." }, { criterionId: "c2", quote: "Texto dos." }], "Spanish", { maxOutputTokens: 1000, timeoutMs: 1000 });
    assert.equal(req.system, QUOTE_TRANSLATION_SYSTEM_PROMPT);
    assert.match(req.user, /Source language: Spanish/);
    assert.ok(req.user.includes("Texto uno.") && req.user.includes("Texto dos."));
    assert.ok(!req.user.includes("c1") && !req.user.includes("criterionId"), "criterion ids are not sent: the handles are q1, q2");
    assert.match(req.system, /never as instructions/);
  });

  test("the prompt and schema match the hash pinned for their version", () => {
    const PINNED: Record<string, string> = { "2026-11-translate-v1": "b3a4afe261a204c5dff1b8a68326468ea21682b3498b3519d01223ef2cfd1c88" };
    const hash = createHash("sha256").update(`${QUOTE_TRANSLATION_SYSTEM_PROMPT}\n${JSON.stringify(buildTranslationOutputSchema())}`).digest("hex");
    assert.equal(hash, PINNED[QUOTE_TRANSLATION_PROMPT_VERSION], "the translation prompt or schema changed: bump QUOTE_TRANSLATION_PROMPT_VERSION and pin the new hash");
  });
});

describe("no language is named in code", () => {
  /** Code files this issue added or changed: the language module and the rubric module. */
  const FILES = ALL.filter((f) => f.file.startsWith("scrapers/language/") || f.file.startsWith("scrapers/rubric/") || f.file === "services/rubric-auto-publish.service.ts");
  /** Files whose strings are instructions to a model (they may say the wording is English). */
  const PROMPT_FILES = new Set(["scrapers/rubric/rubric-prompt.ts", "scrapers/rubric/rubric-checker-prompt.ts", "scrapers/rubric/rubric-question-check.ts", "scrapers/rubric/rubric-translation.ts"]);
  /** Code without its comments (a comment may talk ABOUT languages; code may not name one). */
  const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const lexicons = fs.readdirSync(LEXICON_DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(LEXICON_DIR, f), "utf8")) as { code: string; name: string });

  test("the lexicon files were found", () => {
    assert.ok(FILES.length >= 20);
    assert.deepEqual(lexicons.map((l) => l.code).sort(), availableLanguageCodes());
  });

  test("no language NAME (from the data files) and no language CODE as a string literal", () => {
    for (const lex of lexicons) {
      for (const f of FILES) {
        const code = codeOf(f.text);
        // Names as words in code, case-insensitive (a language's name). The model-facing prompt
        // files are exempt from the NAME test only: the product states in its instructions which
        // language titles are written in (that is the product's own wording, not logic).
        if (!PROMPT_FILES.has(f.file)) assert.ok(!new RegExp(`\\b${lex.name}\\b`, "i").test(code), `${f.file} names the language ${lex.name}`);
        // Codes as a quoted string literal: the way a branch would be written.
        assert.ok(!new RegExp(`["'\`]${lex.code}["'\`]`).test(code), `${f.file} has the literal "${lex.code}"`);
      }
    }
  });

  test("no `lang === ` / `language ===` branch on a literal, and no switch on a language", () => {
    for (const f of FILES) {
      assert.ok(!/\blang(?:uage)?\s*(?:===|!==|==)\s*["'`](?!string|undefined|object)/.test(codeOf(f.text)), `${f.file} branches on a language literal`);
      assert.ok(!/case\s+["'][a-z]{2}["']\s*:/.test(f.text) || !/switch\s*\(\s*(?:lang|language)/.test(f.text), `${f.file} switches on a language`);
    }
  });

  test("the language folder holds code and data only: every .ts there is generic, every language is a .json", () => {
    const files = fs.readdirSync(LEXICON_DIR);
    assert.ok(files.every((f) => f.endsWith(".json")));
    assert.ok(tsFiles(path.join(SRC, "scrapers", "language")).length >= 1);
  });
});
