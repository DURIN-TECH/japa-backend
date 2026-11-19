// ============================================
// Language lexicons (issue #220): English is unchanged, Spanish is read.
// ============================================
//
// 1. GOLDEN: `fixtures/english-readings.golden.json` was produced by the
//    ORIGINAL rubric-quote.ts (before any lexicon existed) over a corpus of
//    numbers, dates, references and units. The product-language lexicon must
//    reproduce every reading: the "English is byte-identical" proof, next to
//    the existing tests, which are untouched.
// 2. SPANISH readings: number words, separators, durations, dates; a mismatch
//    and an unreadable number are still REJECTED.
// 3. The loader: format checks, fail-closed behaviour for an unknown language.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LINE_LABEL_RE,
  SnapshotQuoteIndex,
  appendixNamesIn,
  dateSupported,
  datesIn,
  hasUnreadableDigits,
  lineLabelReFor,
  numbersIn,
  numbersOutsideDates,
  refTokensIn,
  unitAdjacentToNumber,
  unitSupported,
  unsupportedNumbers,
  withoutLeadingParagraphNumber,
} from "../../../src/scrapers/rubric/rubric-quote";
import {
  LEXICON_DIR,
  availableLanguageCodes,
  baseLanguage,
  compileLexicon,
  hasLexicon,
  languageSupport,
  lexiconFor,
  lexiconProblems,
  needsTranslation,
  productLanguageCode,
  productLexicon,
  resolveSourceLanguage,
  sourceLanguagesOf,
  useLexiconFolderForTests,
  type RawLexicon,
} from "../../../src/scrapers/language/language-lexicon";

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "english-readings.golden.json"), "utf8"));
const en = productLexicon();
const es = lexiconFor("es");
const sorted = (s: Iterable<string>) => [...s].sort();

describe("the product-language lexicon reproduces the readings the code had before lexicons", () => {
  test("numbers, dates, references, scope names, leading numbers", () => {
    golden.texts.forEach((t: string, i: number) => {
      assert.deepEqual(sorted(numbersIn(t, en)), sorted(golden.numbersIn[i]), `numbersIn ${JSON.stringify(t)}`);
      assert.deepEqual(sorted(numbersIn(t)), sorted(golden.numbersIn[i]), `numbersIn (default) ${JSON.stringify(t)}`);
      assert.deepEqual(sorted(numbersOutsideDates(t, en)), sorted(golden.numbersOutsideDates[i]), `outside dates ${JSON.stringify(t)}`);
      assert.deepEqual(datesIn(t, en), golden.datesIn[i], `datesIn ${JSON.stringify(t)}`);
      assert.deepEqual(sorted(refTokensIn(t, en)), sorted(golden.refTokens[i]), `refTokensIn ${JSON.stringify(t)}`);
      assert.deepEqual(sorted(appendixNamesIn(t, en)), sorted(golden.appendix[i]), `appendix ${JSON.stringify(t)}`);
      assert.equal(withoutLeadingParagraphNumber(t, en), golden.withoutLeading[i], `leading number ${JSON.stringify(t)}`);
      assert.equal(hasUnreadableDigits(t), golden.unreadable[i]);
      assert.equal(LINE_LABEL_RE.exec(t)?.[1] ?? null, golden.lineLabel[i], `line label ${JSON.stringify(t)}`);
      assert.equal(lineLabelReFor(en).exec(t)?.[1] ?? null, golden.lineLabel[i]);
    });
  });

  test("claims against support, and unit adjacency", () => {
    for (const p of golden.unsupportedPairs) assert.deepEqual(unsupportedNumbers(p.c, p.s, { outsideDates: p.o }), p.r, JSON.stringify(p));
    for (const p of golden.unitAdj) assert.equal(unitAdjacentToNumber(p.v, p.u, p.s, en), p.r, JSON.stringify(p));
  });

  test("the lexicon compiled from the file has the shapes the old code had", () => {
    assert.equal(en.digitRunRe.source, String.raw`^(?:\d+|\d{1,3}(?:[,]\d{3})+)(?:\.\d+)?$`);
    assert.equal(en.referenceWordsAlt, "");
    assert.equal(productLanguageCode(), "en");
  });
});

describe("Spanish is read from the data file", () => {
  test("digits: the Spanish separators, and a shape the lexicon does not list stays unreadable", () => {
    assert.deepEqual(sorted(numbersIn("30 días", es)), ["30"]);
    assert.deepEqual(sorted(numbersIn("la suma de 1.000,50 euros", es)), ["1000.5"]);
    assert.deepEqual(sorted(numbersIn("1.000 euros", es)), ["1000"]);
    assert.deepEqual(sorted(numbersIn("10,20", es)), ["10.2"]);
    // The English shape under Spanish rules is NOT guessed.
    assert.deepEqual(sorted(numbersIn("1,000.50", es)), []);
    assert.deepEqual(sorted(numbersIn("3.5", es)), [], "a point is a thousands separator in Spanish: 3.5 is not in a listed shape");
    assert.deepEqual(sorted(numbersIn("1 270", es)), [], "space grouping stays unreadable");
    // ... and the Spanish shape under English rules is not read either (unchanged).
    assert.deepEqual(sorted(numbersIn("1.000,50", en)), []);
  });

  test("number words", () => {
    const read = (t: string) => sorted(numbersIn(t, es));
    assert.deepEqual(read("treinta días"), ["30"]);
    assert.deepEqual(read("noventa días"), ["90"]);
    assert.deepEqual(read("treinta y cinco días"), ["35"]);
    assert.deepEqual(read("veintiún días"), ["21"]);
    assert.deepEqual(read("veintidós meses"), ["22"]);
    assert.deepEqual(read("ciento veinte días"), ["120"]);
    assert.deepEqual(read("doscientos cincuenta euros"), ["250"]);
    assert.deepEqual(read("dos mil quinientos euros"), ["2500"]);
    assert.deepEqual(read("cien mil"), ["100000"]);
    assert.deepEqual(read("mil"), ["1000"]);
    assert.deepEqual(read("tres millones"), ["3000000"]);
    assert.deepEqual(read("5 mil euros"), ["5000"]);
    // a tens word and a unit with no joiner are two numbers, not one invented sum
    assert.deepEqual(read("treinta cinco"), ["30", "5"]);
    // an article is not a number, except before a duration
    assert.deepEqual(read("una persona"), []);
    assert.deepEqual(read("un mes"), ["1"]);
    assert.deepEqual(read("una semana"), ["1"]);
    // the word for 10^12 is deliberately absent (it differs between standards)
    assert.deepEqual(read("un billón"), []);
  });

  test("dates", () => {
    assert.deepEqual(datesIn("12 de marzo de 2024", es), ["2024-03-12"]);
    assert.deepEqual(datesIn("el 1º de enero del 2025", es), ["2025-01-01"]);
    assert.deepEqual(datesIn("31 de diciembre de 2025", es), ["2025-12-31"]);
    assert.deepEqual(datesIn("30 de febrero de 2025", es), [], "an impossible date is refused");
    assert.deepEqual(datesIn("marzo de 2024", es), [], "a month and year is not a date");
    assert.equal(dateSupported("2024-03-12", "desde el 12 de marzo de 2024", es), true);
    assert.equal(dateSupported("2024-03-13", "desde el 12 de marzo de 2024", es), false);
    // The ISO and unambiguous numeric shapes are language-neutral.
    assert.deepEqual(datesIn("26/03/2026", es), ["2026-03-26"]);
    // English month names are not read under Spanish rules (no cross-language guessing).
    assert.deepEqual(datesIn("26 March 2026", es), []);
    assert.deepEqual(datesIn("12 de marzo de 2024", en), []);
  });

  test("claims written in English are checked against a Spanish quote", () => {
    const quote = "El solicitante debe permanecer treinta días y pagar 1.000,50 euros.";
    const opts = { lexicon: es };
    assert.deepEqual(unsupportedNumbers("30 days", quote, opts), []);
    assert.deepEqual(unsupportedNumbers("thirty days", quote, opts), [], "an English number word claim");
    assert.deepEqual(unsupportedNumbers("1,000.50 euros", quote, opts), []);
    assert.deepEqual(unsupportedNumbers(1000.5, quote, opts), []);
    // mismatches are rejected
    assert.deepEqual(unsupportedNumbers("45 days", quote, opts), ["45"]);
    assert.deepEqual(unsupportedNumbers(31, quote, opts), ["31"]);
    assert.deepEqual(unsupportedNumbers("2,000 euros", quote, opts), ["2000"]);
    // an unreadable number in the quote never supports a claim
    assert.deepEqual(unsupportedNumbers("3 days", "debe permanecer 3.5 días", opts), ["3"]);
  });

  test("duration units stay verbatim, adjacent to their number", () => {
    const quote = "debe permanecer treinta días consecutivos";
    assert.equal(unitSupported("días", quote), true);
    assert.equal(unitAdjacentToNumber(30, "días", quote, es), true);
    assert.equal(unitAdjacentToNumber(30, "semanas", quote, es), false);
    assert.equal(unitAdjacentToNumber(30, "días", "treinta semanas o 4 días", es), false);
    assert.equal(unitAdjacentToNumber(45, "días", quote, es), false);
  });

  test("reference shapes: 'Art. 12' is a reference label and a paragraph number", () => {
    assert.equal(lineLabelReFor(es).exec("Art. 12. Los solicitantes deberán")?.[1], "Art. 12");
    assert.equal(lineLabelReFor(es).exec("Artículo 5 Requisitos")?.[1], "Artículo 5");
    assert.equal(lineLabelReFor(en).exec("Art. 12. Los solicitantes deberán"), null, "English rules do not know the word");
    assert.deepEqual(sorted(refTokensIn("conforme al Art. 12 y al Artículo 7", es)), ["Art. 12", "Artículo 7"]);
    assert.deepEqual(sorted(appendixNamesIn("según el Anexo II y la Parte B", es)), ["Anexo II", "Parte B"]);
    assert.deepEqual(sorted(appendixNamesIn("según el Anexo II", en)), [], "English rules do not know the word");
    // the number after a reference word labels the rule: it supports no threshold
    assert.equal(withoutLeadingParagraphNumber("Art. 12. El plazo es de 30 días", es), "El plazo es de 30 días");
    assert.equal(withoutLeadingParagraphNumber("Art. 12 El plazo es de 30 días", es), "El plazo es de 30 días");
    assert.equal(withoutLeadingParagraphNumber("El plazo es de 12 días", es), "El plazo es de 12 días");
    // the index of a Spanish document derives the reference from the document's own layout
    const idx = new SnapshotQuoteIndex({ text: "Art. 12. Requisitos\nEl solicitante debe permanecer treinta días.", sourceId: "s", contentHash: "h" } as never, es);
    const found = idx.locate("El solicitante debe permanecer treinta días.");
    assert.ok(found.ok);
    assert.equal(found.ok && idx.derivedRuleRef(found), "Art. 12");
  });
});

describe("the loader", () => {
  test("shipped files are valid, one product language, codes match", () => {
    const files = fs.readdirSync(LEXICON_DIR).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 2);
    let products = 0;
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(LEXICON_DIR, f), "utf8")) as RawLexicon;
      assert.deepEqual(lexiconProblems(raw), [], f);
      assert.equal(f, `${raw.code}.json`);
      assert.ok(availableLanguageCodes().includes(raw.code));
      if (raw.isProductLanguage) products += 1;
    }
    assert.equal(products, 1);
  });

  test("a language with no file reads strictly less, never as another language", () => {
    const x = lexiconFor("zz");
    assert.equal(x.strict, true);
    assert.deepEqual(sorted(numbersIn("30 days thirty 1,000 1.5 treinta", x)), ["30"], "whole digits only");
    assert.deepEqual(datesIn("26 March 2026", x), []);
    assert.equal(hasLexicon("zz"), false);
    assert.equal(hasLexicon("es-SV"), true);
  });

  test("a source with no language is the product language; a declared one is used as declared", () => {
    assert.equal(resolveSourceLanguage(undefined), productLanguageCode());
    assert.equal(resolveSourceLanguage("  "), productLanguageCode());
    assert.equal(resolveSourceLanguage("ES-sv"), "es");
    assert.equal(baseLanguage("pt_BR"), "pt");
    assert.deepEqual(sourceLanguagesOf([{}, { language: "es" }, { language: "es-SV" }]), ["en", "es"]);
    assert.equal(needsTranslation(undefined), false);
    assert.equal(needsTranslation("es"), true);
  });

  test("language support needs the settings AND a lexicon", () => {
    assert.deepEqual(languageSupport(["en"], ["en"]), { ok: true, unsupported: [] });
    assert.deepEqual(languageSupport(["en", "es"], ["en"]), { ok: false, unsupported: ["es"] });
    assert.deepEqual(languageSupport(["en", "es"], ["en", "es"]), { ok: true, unsupported: [] });
    assert.deepEqual(languageSupport(["es-SV"], ["es"]), { ok: true, unsupported: [] });
    assert.deepEqual(languageSupport(["zz"], ["zz", "en"]), { ok: false, unsupported: ["zz"] }, "listed but no data: still held");
    assert.deepEqual(languageSupport(["en"], []), { ok: false, unsupported: ["en"] }, "an empty list supports nothing");
  });

  test("a malformed file is not loaded; two product languages are refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lex-"));
    try {
      const good = JSON.parse(fs.readFileSync(path.join(LEXICON_DIR, "en.json"), "utf8"));
      fs.writeFileSync(path.join(dir, "en.json"), JSON.stringify(good));
      fs.writeFileSync(path.join(dir, "xx.json"), JSON.stringify({ ...good, code: "xx", months: { enero: 13 } }));
      fs.writeFileSync(path.join(dir, "yy.json"), "{ not json");
      const errors = console.error;
      console.error = () => undefined;
      try {
        useLexiconFolderForTests(dir);
        assert.deepEqual(availableLanguageCodes(), ["en"]);
        fs.writeFileSync(path.join(dir, "zz.json"), JSON.stringify({ ...good, code: "zz" }));
        assert.throws(() => useLexiconFolderForTests(dir), /isProductLanguage/);
      } finally {
        console.error = errors;
      }
    } finally {
      useLexiconFolderForTests();
      fs.rmSync(dir, { recursive: true });
    }
    assert.deepEqual(availableLanguageCodes(), ["en", "es"]);
    assert.ok(compileLexicon(JSON.parse(fs.readFileSync(path.join(LEXICON_DIR, "es.json"), "utf8"))).months.size > 12);
  });

  test("a separator cannot be both decimal and thousands", () => {
    const good = JSON.parse(fs.readFileSync(path.join(LEXICON_DIR, "en.json"), "utf8"));
    assert.ok(lexiconProblems({ ...good, thousandsSeparators: ["."] }).some((p) => /both/.test(p)));
  });
});
