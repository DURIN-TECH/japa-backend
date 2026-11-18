// ============================================
// Test helper — the shared rule for the "no seed country code" guards (issue #322)
// ============================================
// Four guard tests (rubric-review, rubric-auto-publish, rubric-generic and
// registry-pure) fail when a two-letter country code from the countries seed
// appears in the source code they scan. They used to search the WHOLE text,
// so a capitalised English word that happens to be a code ("There is NO
// delete", "IS" in a comment, "SE" in a prompt sentence) tripped them as soon
// as that country was seeded. #322 seeds twenty more countries (NO, IS, SE,
// ...), so the guards now share this one rule instead:
//
//   IGNORED  - a code inside a comment (`//`, `/* */`, JSDoc),
//            - a code inside a string literal that is a sentence, i.e. whose
//              text contains a space (a prompt line, a log or error message).
//   STILL A FAILURE
//            - a code in code: an identifier or property name (`NO`, `x.IS`),
//            - a whole string literal (`"NO"`, `'IS'`, `` `SE` ``),
//            - a code inside a string with no space (`` `countries/NO/visaTypes` ``,
//              `"NO_x"`), which is how a hard-coded route or path looks.
//
// How comments and strings are told apart from code: the file is PARSED with
// the TypeScript compiler (already a devDependency; no new library). The
// parser finds every string, template and regular-expression literal, so a
// `//` inside a string ("a//b", "https://...") is never mistaken for a
// comment. Everything between two literals is code or comments only, and
// there a `//` or `/*` can only start a comment.
//
// The country-NAME and visa-ID checks in those tests do NOT use this helper:
// they still search the full text, case-insensitively (unchanged by #322).

import ts from "typescript";

/** One literal found by the parser: its text range in the file and its kind. */
interface LiteralRange {
  start: number;
  end: number;
  /** True for a string or template part whose text should be blanked (a sentence). */
  blank: boolean;
}

/** Replace every character of `s` except line breaks with a space (keeps offsets and lines). */
const blankOut = (s: string): string => s.replace(/[^\r\n]/g, " ");

/**
 * Blank the comments of a stretch of text that holds NO string, template or
 * regex literal (the parser has already taken those out): a `//` runs to the
 * end of its line, a `/*` to the next `*\/` (or the end of the stretch).
 */
function blankComments(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    if (code.startsWith("//", i)) {
      // A line comment: blank up to (not including) the line break.
      let j = code.indexOf("\n", i);
      if (j === -1) j = code.length;
      out += blankOut(code.slice(i, j));
      i = j;
    } else if (code.startsWith("/*", i)) {
      // A block or JSDoc comment: blank up to and including the closing `*/`.
      const close = code.indexOf("*/", i + 2);
      const j = close === -1 ? code.length : close + 2;
      out += blankOut(code.slice(i, j));
      i = j;
    } else {
      out += code[i];
      i++;
    }
  }
  return out;
}

/** True when a literal's source text (quotes included) contains a space: it reads as a sentence. */
const isSentence = (raw: string): boolean => raw.includes(" ");

/**
 * Every literal in the file, in order. A template with substitutions
 * (`` `a ${x} b` ``) is ONE string to the reader: its parts are blanked
 * together when any part contains a space, and the `${...}` expressions in
 * between are code (scanned like any other code). Regex literals are kept as
 * code, but listed so a `//` inside one is not taken for a comment.
 */
function literalRanges(sf: ts.SourceFile): LiteralRange[] {
  const text = sf.text;
  const out: LiteralRange[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sf);
      out.push({ start, end: node.end, blank: isSentence(text.slice(start, node.end)) });
      return;
    }
    if (ts.isRegularExpressionLiteral(node)) {
      out.push({ start: node.getStart(sf), end: node.end, blank: false });
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // The literal parts: the head, then the text after each `${...}`.
      const parts: ts.Node[] = [node.head, ...node.templateSpans.map((s) => s.literal)];
      const sentence = parts.some((p) => isSentence(text.slice(p.getStart(sf), p.end)));
      for (const p of parts) out.push({ start: p.getStart(sf), end: p.end, blank: sentence });
      // The expressions inside `${...}` are code: visit them for nested literals.
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The CODE of a TypeScript source text, as the guards see it: the same length
 * and lines as the input, with comments and sentence strings replaced by
 * spaces. Strings with no space, identifiers and property names are kept.
 */
export function codeWithoutCommentsAndSentences(text: string, fileName = "guarded.ts"): string {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  let out = "";
  let at = 0;
  for (const lit of literalRanges(sf)) {
    // The stretch before this literal holds only code and comments.
    out += blankComments(text.slice(at, lit.start));
    const raw = text.slice(lit.start, lit.end);
    out += lit.blank ? blankOut(raw) : raw;
    at = lit.end;
  }
  return out + blankComments(text.slice(at));
}

/**
 * The first place a seed country code appears in the code of a source text
 * (see the rule at the top), or null when it does not. Case-sensitive, whole
 * word: "IE" the code, never "ie" inside a word.
 */
export function findCountryCode(text: string, code: string): string | null {
  const m = new RegExp(`\\b${code}\\b`).exec(codeWithoutCommentsAndSentences(text));
  if (!m) return null;
  // The failure message shows the line the code is on, from the original text.
  const lineStart = text.lastIndexOf("\n", m.index) + 1;
  const lineEnd = text.indexOf("\n", m.index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}

/** True when a seed country code appears in the code of a source text (the guards' failure case). */
export const hasCountryCode = (text: string, code: string): boolean => findCountryCode(text, code) !== null;
