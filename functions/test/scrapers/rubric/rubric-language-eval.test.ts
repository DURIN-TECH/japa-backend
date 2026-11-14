// ============================================
// The language evaluation tooling (issue #220)
// ============================================
//
// The evaluation is DELIVERED AS TOOLING, not run: these tests prove the pure
// parts (recheck in the page's language, the reproducible 20-rule sample, the
// agreement score) and that the script is offline by default, refuses to draft
// without --live, writes its report files, and enables nothing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lexiconFor } from "../../../src/scrapers/language/language-lexicon";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { buildSampleSheet, discardTally, recheckRule, scoreSheet, SAMPLE_SHEET_SIZE, type SampleSheetRow } from "../../../src/scrapers/rubric/rubric-language-eval";
import { UNOFFICIAL_TRANSLATION_LABEL } from "../../../src/scrapers/rubric/rubric-translation";
import type { AssessmentCriterion } from "../../../src/types/rubric";

/* eslint-disable @typescript-eslint/no-explicit-any */

const L1 = "El solicitante debe permanecer en el territorio durante treinta días consecutivos antes de presentar la solicitud.";
const L2 = "La tasa es de 1.000,50 unidades y debe pagarse en la oficina.";
const page = { schemaVersion: 1, sourceId: "pg", contentHash: "b".repeat(64), docType: "html", url: "https://rules.example/es", finalUrl: "https://rules.example/es", fetchedAt: "2026-11-13T00:00:00Z", text: `Art. 1. ${L1}\nArt. 2. ${L2}`, pages: null };
const rule = (id: string, title: string, quote: string, extra: Partial<AssessmentCriterion> = {}): AssessmentCriterion =>
  ({ criterionId: id, title, kind: "objective", stage: "eligibility", severity: "high", source: { quote, sourceId: "pg", url: page.url, contentHash: page.contentHash, retrievedAt: page.fetchedAt }, confidence: 0.9, ...extra }) as AssessmentCriterion;
const idx = new SnapshotQuoteIndex(page as any, lexiconFor("es"));

describe("recheck reads the stored rule in the page's language", () => {
  test("a faithful Spanish rule has no problem; a changed number, unit or date is reported", () => {
    assert.deepEqual(recheckRule(rule("a", "Stays 30 days", L1, { check: { field: "f", op: "heldForDays", value: 30, unit: "días" } as any }), idx).problems, []);
    assert.deepEqual(recheckRule(rule("a", "Fee 1,000.50", L2, { check: { field: "f", op: "eq", value: 1000.5, unit: "unidades" } as any }), idx).problems, []);
    assert.deepEqual(recheckRule(rule("b", "Stays 45 days", L1, { check: { field: "f", op: "heldForDays", value: 45, unit: "días" } as any }), idx).problems, ["check_number_not_in_quote", "check_unit_not_next_to_number", "title_number_not_in_quote"]);
    assert.deepEqual(recheckRule(rule("c", "x", L1, { check: { field: "f", op: "heldForDays", value: 30, unit: "semanas" } as any }), idx).problems, ["check_unit_not_in_quote", "check_unit_not_next_to_number"]);
    assert.deepEqual(recheckRule(rule("d", "x", L1, { validFrom: "2024-03-12" }), idx).problems, ["validFrom_not_in_quote"]);
    assert.deepEqual(recheckRule(rule("e", "x", "A sentence the page does not hold at all."), idx).problems, ["quote_quote_not_found"]);
  });
});

describe("the sample sheet", () => {
  const many = Array.from({ length: 50 }, (_, i) => rule(`r${i}`, `Rule ${i}`, `${L1} ${i}`));
  test("it has 20 rules, is the same for the same version whatever the order, and differs for another version", () => {
    const a = buildSampleSheet({ kept: many, version: 3 });
    assert.equal(a.length, SAMPLE_SHEET_SIZE);
    assert.deepEqual(buildSampleSheet({ kept: [...many].reverse(), version: 3 }).map((r) => r.criterionId), a.map((r) => r.criterionId));
    assert.notDeepEqual(buildSampleSheet({ kept: many, version: 4 }).map((r) => r.criterionId), a.map((r) => r.criterionId));
    assert.equal(buildSampleSheet({ kept: many.slice(0, 5), version: 3 }).length, 5);
  });

  test("a row carries the quote, the url, empty human fields, the check's verdicts and a LABELLED translation", () => {
    const sheet = buildSampleSheet({
      kept: many, version: 1,
      translations: Object.fromEntries(many.map((r) => [r.criterionId, { text: "tr", language: "en", model: "m", promptVersion: "p", unofficial: true as const, quoteHash: "h" }])),
      verdicts: Object.fromEntries(many.map((r) => [r.criterionId, { verification: "yyyyaa", judgement: "yyyyaa" }])),
    });
    for (const row of sheet) {
      assert.ok(row.quote.startsWith("El solicitante"));
      assert.equal(row.url, page.url);
      assert.equal(row.humanVerdict, null);
      assert.equal(row.humanNote, "");
      assert.deepEqual(row.translation, { text: "tr", label: UNOFFICIAL_TRANSLATION_LABEL });
      assert.equal(row.checkerReading, "kept");
    }
  });
});

describe("agreement of the check with the human read", () => {
  const row = (reading: SampleSheetRow["checkerReading"], human: SampleSheetRow["humanVerdict"]): SampleSheetRow => ({ criterionId: "x", title: "t", ruleRef: null, quote: "q", url: "u", kind: "judgement", stage: "eligibility", check: null, appliesTo: null, checkerVerdicts: null, checkerReading: reading, translation: null, humanVerdict: human, humanNote: "" });
  test("counts agreement, the dangerous direction apart, and never counts unsure, blank or no verdict as agreement", () => {
    const a = scoreSheet([row("kept", "faithful"), row("left_out", "not_faithful"), row("kept", "not_faithful"), row("left_out", "faithful"), row("kept", "unsure"), row("kept", null), row("no_verdict", "faithful")]);
    assert.deepEqual(a, { sampled: 7, decided: 4, unsure: 1, blank: 1, agree: 2, checkerKeptHumanRejected: 1, checkerLeftOutHumanAccepted: 1, noCheckerVerdict: 1, rate: 0.5 });
    assert.equal(scoreSheet([row("kept", null)]).rate, null);
  });

  test("discards are tallied by reason, most frequent first", () => {
    assert.deepEqual(discardTally([{ reason: "b" }, { reason: "a" }, { reason: "b" }] as any), [{ reason: "b", count: 2 }, { reason: "a", count: 1 }]);
  });
});

describe("the script", () => {
  const script = path.join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "evaluate-language.ts");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });

  test("offline by default: reads files, writes the report and the sample sheet, calls no model, enables nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "langeval-"));
    try {
      fs.writeFileSync(path.join(dir, "page.json"), JSON.stringify(page));
      const criteria = [rule("a", "Stays 30 days", L1, { check: { field: "f", op: "heldForDays", value: 30, unit: "días" } as any }), rule("b", "Stays 45 days", L2, { check: { field: "f", op: "eq", value: 45, unit: "unidades" } as any })];
      fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ version: 2, criteria, discardedCount: 3, discarded: [{ reason: "number_not_in_quote" }, { reason: "number_not_in_quote" }, { reason: "quote_not_found" }], quoteTranslations: {} }));
      const res = run(["--route=XA_xa-test", `--version=${path.join(dir, "version.json")}`, `--page=${path.join(dir, "page.json")}`, "--language=es", `--out=${dir}`]);
      assert.equal(res.status, 0, res.stderr + res.stdout);
      assert.match(res.stdout, /OFFLINE: no model call/);
      const report = JSON.parse(fs.readFileSync(path.join(dir, "language-eval-XA_xa-test.json"), "utf8"));
      assert.equal(report.mode, "offline");
      assert.deepEqual(report.sourceLanguages, ["es"]);
      assert.equal(report.rulesKept, 2);
      assert.equal(report.discardedTotal, 3);
      assert.deepEqual(report.discardedByReason, [{ reason: "number_not_in_quote", count: 2 }, { reason: "quote_not_found", count: 1 }]);
      assert.equal(report.recheck.withProblems, 1, "the rule whose number is not in its quote");
      assert.equal(report.usage, null);
      assert.match(report.note, /enables nothing/);
      assert.ok(fs.existsSync(path.join(dir, "language-eval-XA_xa-test.md")));
      const sheet = JSON.parse(fs.readFileSync(path.join(dir, "sample-sheet.json"), "utf8"));
      assert.equal(sheet.length, 2);
      assert.equal(sheet[0].humanVerdict, null);

      // Scoring a filled sheet updates the report.
      sheet[0].humanVerdict = "faithful";
      sheet[1].humanVerdict = "not_faithful";
      fs.writeFileSync(path.join(dir, "sample-sheet.json"), JSON.stringify(sheet));
      const scored = run([`--score=${path.join(dir, "sample-sheet.json")}`, `--report=${path.join(dir, "language-eval-XA_xa-test.json")}`]);
      assert.equal(scored.status, 0, scored.stderr);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "language-eval-XA_xa-test.json"), "utf8")).agreement.sampled, 2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("offline mode refuses to run without a stored version (it never drafts)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "langeval-"));
    try {
      fs.writeFileSync(path.join(dir, "page.json"), JSON.stringify(page));
      const res = run(["--route=XA_xa-test", `--page=${path.join(dir, "page.json")}`, `--out=${dir}`]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /--version/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test("the package script exists and the header documents --live", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));
    assert.match(pkg.scripts["evaluate:language"], /evaluate-language\.js/);
    assert.match(fs.readFileSync(script, "utf8"), /--live/);
  });
});
