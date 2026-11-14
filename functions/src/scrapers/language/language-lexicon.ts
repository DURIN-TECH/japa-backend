import fs from "fs";
import path from "path";

// ============================================
// LANGUAGE LEXICONS — language knowledge as DATA (issue #220)
// ============================================
//
// WHY THIS FILE EXISTS. The rulebook's quote validation (`rubric-quote.ts`)
// reads numbers, dates, durations and reference shapes out of a quote to prove
// that everything a rule claims is written in the rule's own quote. Until #220
// that reading knew one language. A government that publishes in another
// language would have lost every rule with a number in it ("treinta días" read
// as no number, "1.000,50" unreadable) and, worse, the code would have grown a
// branch per language.
//
// THE RULE: NO LANGUAGE IS NAMED IN CODE. Everything language-specific is in a
// JSON file in `./lexicons/`, one per language. This loader finds the files by
// reading that folder: adding a language is adding a file (see README.md), and
// a test (rubric-generic.test.ts) fails if code names a language.
//
// WHAT A LEXICON HOLDS (all of it standard facts about the language, none of
// it immigration content): number words, month names, the words that mean
// "day/week/month/year", the decimal and thousands separators, the shape of a
// date, the words that name an appendix or part, and the words that start a
// legal reference ("Art. 12"). `compileLexicon` turns the file into the
// read-only structure the quote code uses.
//
// FAIL CLOSED, ALWAYS.
//  - A language with no file reads LESS, never differently: `lexiconFor` gives
//    a STRICT lexicon (plain whole digits only, no words, no month names), so
//    every claim that needs more is rejected, exactly as before this existed.
//    It never falls back to another language's lexicon: reading Spanish with
//    English rules could turn a date into a wrong date.
//  - A file that is malformed is NOT loaded (logged by code, not text), so the
//    language is simply unavailable: it cannot half-load.
//  - A source with no `language` at all predates the field. It is read as the
//    PRODUCT LANGUAGE (the one lexicon marked `isProductLanguage`): that is the
//    language titles, questions and document names are written in, and the
//    only one every older source can be. Any code that IS written on a source
//    is used as written (never guessed from the text).
//
// Pure apart from reading the lexicon folder once.

/** One lexicon file as written (see README.md for each field). */
export interface RawLexicon {
  code: string;
  name: string;
  isProductLanguage?: boolean;
  decimalSeparator: string | null;
  thousandsSeparators: string[];
  numberWords: {
    units: Record<string, number>;
    tens: Record<string, number>;
    hundreds: Record<string, number>;
    scales: Record<string, number>;
    scaleJoiners: string[];
    tensUnitsJoiners: string[];
    tensUnitsNeedJoiner: boolean;
    loneOneWords: string[];
  };
  durationWords: string[];
  months: Record<string, number>;
  dateTemplates: string[];
  scopeWords: string[];
  referenceWords: string[];
}

/** A compiled date template: where the three parts are, as named groups. */
export interface DateTemplate {
  re: RegExp;
}

/** The read-only structure the quote code reads with (built once per language). */
export interface Lexicon {
  code: string;
  name: string;
  /** True when this is the strict fallback of a language with no file. */
  strict: boolean;
  /** A digit run in a recognised shape (null: only whole digits are readable). */
  digitRunRe: RegExp;
  thousandsSeparators: ReadonlySet<string>;
  decimalSeparator: string | null;
  units: ReadonlyMap<string, number>;
  tens: ReadonlyMap<string, number>;
  hundreds: ReadonlyMap<string, number>;
  scales: ReadonlyMap<string, number>;
  scaleJoiners: ReadonlySet<string>;
  tensUnitsJoiners: ReadonlySet<string>;
  tensUnitsNeedJoiner: boolean;
  loneOneWords: ReadonlySet<string>;
  durationWords: ReadonlySet<string>;
  months: ReadonlyMap<string, number>;
  dateTemplates: readonly DateTemplate[];
  scopeWords: readonly string[];
  /** Regex source of the reference words ("Art|Arts"), or "" when there are none. */
  referenceWordsAlt: string;
}

/** Where the lexicon files live: next to the compiled code too (the build copies them). */
export const LEXICON_DIR = path.join(__dirname, "lexicons");

/** Escape a string for use inside a RegExp. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&");

/** Alternation of words, longest first so "march" wins over "mar". */
const alternation = (words: Iterable<string>): string => [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe).join("|");

/** The primary subtag of a language code: lower case, region and script removed ("es-SV" -> "es"). */
export function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

// ============================================
// Validation and compilation
// ============================================

/** True for a plain object of string keys to finite non-negative integers. */
function isNumberMap(v: unknown): v is Record<string, number> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((n) => Number.isInteger(n) && (n as number) >= 0);
}
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

/**
 * Check a parsed file has every field in the right shape. Returns the problems
 * (empty = usable). A lexicon with problems is never compiled.
 */
export function lexiconProblems(raw: unknown): string[] {
  const problems: string[] = [];
  const r = raw as Partial<RawLexicon> | null;
  if (!r || typeof r !== "object") return ["not an object"];
  if (typeof r.code !== "string" || !/^[a-z]{2,3}$/.test(r.code)) problems.push("code: two or three lower-case letters");
  if (typeof r.name !== "string" || r.name.length === 0) problems.push("name: required");
  if (!(r.decimalSeparator === null || (typeof r.decimalSeparator === "string" && r.decimalSeparator.length === 1))) problems.push("decimalSeparator: one character or null");
  if (!isStringList(r.thousandsSeparators) || r.thousandsSeparators.some((s) => s.length !== 1)) problems.push("thousandsSeparators: a list of one-character strings");
  // A separator may not be both: "1.000" could not be read.
  if (typeof r.decimalSeparator === "string" && Array.isArray(r.thousandsSeparators) && r.thousandsSeparators.includes(r.decimalSeparator)) problems.push("a character is both the decimal and a thousands separator");
  const w = r.numberWords as Partial<RawLexicon["numberWords"]> | undefined;
  if (!w || typeof w !== "object") problems.push("numberWords: required");
  else {
    for (const k of ["units", "tens", "hundreds", "scales"] as const) if (!isNumberMap(w[k])) problems.push(`numberWords.${k}: a map of word to whole number`);
    for (const k of ["scaleJoiners", "tensUnitsJoiners", "loneOneWords"] as const) if (!Array.isArray(w[k]) || !(w[k] as unknown[]).every((s) => typeof s === "string")) problems.push(`numberWords.${k}: a list of words`);
    if (typeof w.tensUnitsNeedJoiner !== "boolean") problems.push("numberWords.tensUnitsNeedJoiner: true or false");
    // Words are looked up lower-case (the text is lower-cased first), so an upper-case word could never match.
    for (const k of ["units", "tens", "hundreds", "scales"] as const) {
      const m = w[k];
      if (isNumberMap(m) && Object.keys(m).some((word) => word !== word.toLowerCase() || /\s/.test(word))) problems.push(`numberWords.${k}: words are single and lower case`);
    }
  }
  if (!isStringList(r.durationWords)) problems.push("durationWords: a list of words");
  if (!isNumberMap(r.months) || Object.values(r.months).some((n) => n < 1 || n > 12)) problems.push("months: a map of word to 1..12");
  if (!Array.isArray(r.dateTemplates) || !r.dateTemplates.every((t) => typeof t === "string" && t.includes("(?<day>") && t.includes("(?<month>") && t.includes("(?<year>") && t.includes("{months}"))) {
    problems.push("dateTemplates: each a pattern with named groups day, month, year and {months}");
  }
  if (!isStringList(r.scopeWords)) problems.push("scopeWords: a list of words");
  if (!Array.isArray(r.referenceWords) || !r.referenceWords.every((x) => typeof x === "string" && x.length > 0)) problems.push("referenceWords: a list of words");
  return problems;
}

/** Compile a validated lexicon. Throws if a date template is not a valid pattern. */
export function compileLexicon(raw: RawLexicon, strict = false): Lexicon {
  const T = raw.thousandsSeparators;
  const D = raw.decimalSeparator;
  // The digit-run shape: whole digits, or digits grouped by a thousands
  // separator in threes; either may carry a decimal part. English reads
  // `(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?`, the shape this was built from.
  const grouped = T.length > 0 ? `|\\d{1,3}(?:[${T.map(escapeRe).join("")}]\\d{3})+` : "";
  const decimal = D !== null ? `(?:${escapeRe(D)}\\d+)?` : "";
  const months = new Map(Object.entries(raw.months));
  const monthAlt = alternation(months.keys());
  return {
    code: raw.code,
    name: raw.name,
    strict,
    digitRunRe: new RegExp(`^(?:\\d+${grouped})${decimal}$`),
    thousandsSeparators: new Set(T),
    decimalSeparator: D,
    units: new Map(Object.entries(raw.numberWords.units)),
    tens: new Map(Object.entries(raw.numberWords.tens)),
    hundreds: new Map(Object.entries(raw.numberWords.hundreds)),
    scales: new Map(Object.entries(raw.numberWords.scales)),
    scaleJoiners: new Set(raw.numberWords.scaleJoiners),
    tensUnitsJoiners: new Set(raw.numberWords.tensUnitsJoiners),
    tensUnitsNeedJoiner: raw.numberWords.tensUnitsNeedJoiner,
    loneOneWords: new Set(raw.numberWords.loneOneWords),
    durationWords: new Set(raw.durationWords),
    months,
    // The templates run on lower-cased text, so they are compiled without the
    // `i` flag and the month words are matched as written in the file (lower case).
    dateTemplates: raw.dateTemplates.map((t) => ({ re: new RegExp(t.split("{months}").join(monthAlt), "gu") })),
    scopeWords: raw.scopeWords,
    referenceWordsAlt: alternation(raw.referenceWords),
  };
}

/**
 * The strict lexicon of a language with no file: whole digits only, no words,
 * no month names, no reference words. It reads strictly LESS than any real one.
 */
function strictRaw(code: string): RawLexicon {
  return {
    code: code || "und",
    name: "unknown language",
    decimalSeparator: null,
    thousandsSeparators: [],
    numberWords: { units: {}, tens: {}, hundreds: {}, scales: {}, scaleJoiners: [], tensUnitsJoiners: [], tensUnitsNeedJoiner: false, loneOneWords: [] },
    durationWords: [],
    months: {},
    dateTemplates: [],
    scopeWords: [],
    referenceWords: [],
  };
}

// ============================================
// The registry of lexicons (read once)
// ============================================

interface Loaded {
  byCode: Map<string, Lexicon>;
  productCode: string;
}

let loaded: Loaded | undefined;

/** Read and compile every lexicon file in the folder (once). */
function load(dir: string = LEXICON_DIR): Loaded {
  const byCode = new Map<string, Lexicon>();
  let productCode = "";
  let products = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as RawLexicon;
      const problems = lexiconProblems(raw);
      if (problems.length > 0) {
        // Never half-load: the language is unavailable. Only the file name and the problems (no text).
        console.error(`[language] lexicon file ${file} was not loaded: ${problems.join("; ")}`);
        continue;
      }
      if (byCode.has(raw.code)) {
        console.error(`[language] lexicon file ${file} was not loaded: language code ${raw.code} is already defined`);
        continue;
      }
      byCode.set(raw.code, compileLexicon(raw));
      if (raw.isProductLanguage === true) {
        products += 1;
        productCode = raw.code;
      }
    } catch (err) {
      console.error(`[language] lexicon file ${file} was not loaded (${(err as Error)?.name ?? "error"})`);
    }
  }
  // Exactly one product language: it is where titles are written and what an undeclared source is read as.
  if (products !== 1) throw new Error(`exactly one lexicon must be marked isProductLanguage (found ${products})`);
  return { byCode, productCode };
}

/** The loaded lexicons (read on first use). */
function registry(): Loaded {
  return (loaded ??= load());
}

/** Test hook: load a lexicon folder other than the shipped one (and forget it again with no argument). */
export function useLexiconFolderForTests(dir?: string): void {
  loaded = dir ? load(dir) : undefined;
}

/** The codes of every language that has a usable lexicon. */
export function availableLanguageCodes(): string[] {
  return [...registry().byCode.keys()].sort();
}

/** The language titles, questions and document names are written in (and an undeclared source is read as). */
export function productLanguageCode(): string {
  return registry().productCode;
}

/** True when a language has a usable lexicon. */
export function hasLexicon(code: string | null | undefined): boolean {
  return typeof code === "string" && registry().byCode.has(baseLanguage(code));
}

/**
 * The code a source is treated as: what it says, reduced to its primary part,
 * or the product language when it says nothing (a source registered before the
 * field existed). Never guessed from text.
 */
export function resolveSourceLanguage(code: string | null | undefined): string {
  if (typeof code === "string" && code.trim().length > 0) return baseLanguage(code);
  return productLanguageCode();
}

/**
 * The lexicon a source is read with. No code = the product language. A code
 * with no file = the STRICT lexicon (never another language's).
 */
export function lexiconFor(code: string | null | undefined): Lexicon {
  const resolved = resolveSourceLanguage(code);
  return registry().byCode.get(resolved) ?? compileLexicon(strictRaw(resolved), true);
}

/** The lexicon of the product language (what titles, questions and document names are read with). */
export function productLexicon(): Lexicon {
  return lexiconFor(productLanguageCode());
}

/** What the publish gate says about a version's source languages. */
export interface LanguageSupport {
  ok: boolean;
  /** Languages that are not supported (not in the settings list, or with no lexicon). Sorted. */
  unsupported: string[];
}

/**
 * Are ALL of a version's source languages supported? A language is supported
 * only when BOTH hold: the settings list it (`supportedLanguages`) AND a
 * lexicon file exists for it. The second condition means that listing a
 * language in settings before its data exists cannot publish anything: the
 * quote reading would be the strict one, so its rules with numbers would
 * already have been rejected, and this keeps the whole version held instead of
 * publishing a thinner rulebook silently.
 *
 * Codes are compared by primary part ("es-SV" and "es" are the same language).
 * An empty settings list supports nothing.
 */
export function languageSupport(sourceLanguages: readonly string[], supportedLanguages: readonly string[]): LanguageSupport {
  const listed = new Set(supportedLanguages.map(baseLanguage));
  const unsupported = [...new Set(sourceLanguages.map((l) => resolveSourceLanguage(l)))].filter((l) => !listed.has(l) || !registry().byCode.has(l)).sort();
  return { ok: unsupported.length === 0, unsupported };
}

/** The sorted, de-duplicated languages of a set of sources (each undeclared one counted as the product language). */
export function sourceLanguagesOf(sources: readonly { language?: string | null }[]): string[] {
  return [...new Set(sources.map((s) => resolveSourceLanguage(s.language)))].sort();
}

/**
 * True for a language other than the product language: the quotes of its sources
 * get an (unofficial) translation into the product language.
 */
export function needsTranslation(code: string | null | undefined): boolean {
  return resolveSourceLanguage(code) !== productLanguageCode();
}
