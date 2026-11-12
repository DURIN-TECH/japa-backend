// ============================================
// RUBRIC — LIST-MARKER CHAIN (issue #112)
// ============================================
//
// A rule printed as a nested list ("(a)", then "(i)", "(ii)", then "(b)") gets
// its reference from the parent paragraph's label plus the chain of markers
// that lead to it: "X 4.2(a)(ii)". This module decides that chain. It is a
// pure function over marker TEXT only: no document, no publisher, no route.
//
// Why a function of its own: the first version stacked every marker it met
// going backwards, so the siblings "(i)", "(iv)", "(v)", "(vi)" of one list
// were composed as if each were a level deeper ("(i)(iv)(v)(vi)(b)"). Two
// facts have to be right:
//   1. only the NEAREST preceding marker of each nesting level counts. A later
//      sibling replaces an earlier one at its level, and a marker of a
//      shallower level ends every deeper list;
//   2. a single letter such as "(i)", "(v)" or "(x)" is ambiguous (a roman
//      numeral or a letter of the alphabet). Its LIST CONTEXT decides: after
//      "(h)" an "(i)" is the next letter; after "(iv)" a "(v)" is the next
//      numeral; an "(i)" that follows a different kind of marker and starts a
//      new deeper list is roman.

/** The three kinds of marker a list level can use. */
export type MarkerKind = "digit" | "roman" | "letter";

/** One level of the chain being built: the marker's inner text and its kind. */
interface Level {
  kind: MarkerKind;
  inner: string;
}

/**
 * Roman numerals up to 39 written in lower case. Used only for markers of two
 * or more characters ("ii", "xiv"): a one-character marker is ambiguous and
 * is decided by context in `composeMarkerChain`.
 */
const ROMAN_RE = /^(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})$/u;

/** The single letters that are also roman numerals. */
const AMBIGUOUS = new Set(["i", "v", "x"]);

/** Kind of an UNAMBIGUOUS marker's inner text; `undefined` for "i", "v", "x". */
function plainKind(inner: string): MarkerKind | undefined {
  if (/^\d+$/u.test(inner)) return "digit";
  if (AMBIGUOUS.has(inner)) return undefined;
  return inner.length > 1 && ROMAN_RE.test(inner) ? "roman" : "letter";
}

/** Value of a lower-case roman numeral ("iv" is 4), or 0 when it is not one. */
function romanValue(inner: string): number {
  if (!ROMAN_RE.test(inner)) return 0;
  const digit: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  for (let i = 0; i < inner.length; i++) {
    const here = digit[inner[i]];
    const next = digit[inner[i + 1]] ?? 0;
    total += here < next ? -here : here;
  }
  return total;
}

/** True when `inner` directly follows `previous` in a list of the given kind. */
function follows(kind: MarkerKind, previous: string, inner: string): boolean {
  if (kind === "digit") return Number(inner) === Number(previous) + 1;
  if (kind === "roman") return romanValue(inner) !== 0 && romanValue(inner) === romanValue(previous) + 1;
  // Alphabetic: the next letter ("h" then "i"; "z" is followed by "aa" in
  // some lists, which is not an ambiguous marker and so not handled here).
  return previous.length === 1 && inner.length === 1 && inner.charCodeAt(0) === previous.charCodeAt(0) + 1;
}

/**
 * The kind an ambiguous single-letter marker ("i", "v", "x") has here.
 * Levels are tried from the DEEPEST up: the first level whose current marker
 * it directly follows decides ("(h)" then "(i)": letter; "(iv)" then "(v)":
 * roman). When it follows none of them it opens a new deeper list, where
 * "(i)" is the roman numeral one; "(v)" and "(x)" cannot open a list, so
 * they read as letters.
 */
function ambiguousKind(inner: string, levels: readonly Level[]): MarkerKind {
  for (let k = levels.length - 1; k >= 0; k--) {
    const level = levels[k];
    if (level.kind !== "digit" && follows(level.kind, level.inner, inner)) return level.kind;
  }
  return inner === "i" ? "roman" : "letter";
}

/**
 * The chain of list markers that leads to the LAST marker of `markers`.
 *
 * @param markers the markers of the list lines between the parent paragraph's
 *   label and the quoted line, in DOCUMENT ORDER, each as its inner text
 *   without brackets ("a", "ii", "3"); the last one is the quoted line's own
 * @returns the chain, outermost first, each marker with its brackets
 *   (["(a)", "(ii)"]); empty for no markers
 *
 * Examples (fictional markers): a, i, ii, iii, b -> ["(b)"] (the later
 * letter ends the numerals' list); a, i, ii -> ["(a)", "(ii)"]; g, h, i -> ["(i)"]
 * ("(i)" is the letter after "(h)"); a, i, iv, v -> ["(a)", "(v)"].
 */
export function composeMarkerChain(markers: readonly string[]): string[] {
  // One level per kind: a list never nests inside a list of its own kind.
  let levels: Level[] = [];
  for (const inner of markers) {
    const kind = plainKind(inner) ?? ambiguousKind(inner, levels);
    const at = levels.findIndex((l) => l.kind === kind);
    // A marker of a kind already on the chain is a later sibling of that
    // level: it replaces it and ends every deeper list. A new kind opens a
    // list one level deeper.
    levels = at === -1 ? [...levels, { kind, inner }] : [...levels.slice(0, at), { kind, inner }];
  }
  return levels.map((l) => `(${l.inner})`);
}

/**
 * Markers that open an item INSIDE a quote: "(a)" at the very start, or after
 * a sentence break, a semicolon or "and" / "or" ("...; and (b) ..."). A
 * bracketed letter in the middle of a sentence ("see paragraph (a)") is a
 * cross-reference and is not matched.
 */
const ITEM_MARKER_RE = /(?:^|[;:.]\s+|\b(?:and|or)\s+)\(([a-z]{1,3}|\d{1,2})\)(?=\s)/gu;

/**
 * True when a quote contains two or more consecutive markers of the same
 * list ("(a) ...; and (b) ..."): the quote spans more than one sub-condition,
 * so one criterion may be standing for several (issue #112). Pure text test.
 */
export function spansSiblingMarkers(quote: string): boolean {
  const inners = [...quote.matchAll(ITEM_MARKER_RE)].map((m) => m[1]);
  for (let i = 1; i < inners.length; i++) {
    const prev = inners[i - 1];
    const cur = inners[i];
    // The second directly follows the first as a letter, numeral or digit.
    if (follows("letter", prev, cur) || follows("roman", prev, cur) || follows("digit", prev, cur)) return true;
  }
  return false;
}
