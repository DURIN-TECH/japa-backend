import { LIMB_RE, isShortRunLine, lineLabelReFor, looksLikeTitle, type QuoteLookup, type SnapshotQuoteIndex } from "./rubric-quote";
import { markerFollows, nextMarkerLevels, type MarkerKind, type MarkerLevel } from "./rubric-marker-chain";
import { productLexicon, type Lexicon } from "../language/language-lexicon";
import type { RubricFlag } from "../../types/rubric";

// ============================================
// RUBRIC — LISTS AFTER A LEAD-IN (issue #222)
// ============================================
//
// THE PROBLEM. A rule whose sentence ends in a lead-in ("... except where they
// are subject to any of the following:") is only half a rule: the exceptions
// are the list lines under it. The quote validator accepts ONE continuous
// passage inside ONE line of the page, so a quote cannot span the list, and
// asking the model to write several quotes invites mismatches.
//
// THE FIX. CODE attaches the list. When a rule's validated quote ends with a
// lead-in, this module reads the lines that directly follow it in the STORED
// snapshot and returns them, each one a whole line of that snapshot, verbatim.
// They are stored in `source.listItems`. Nothing the model writes ever enters
// that field, so the "every stored sentence is verbatim from the official text"
// rule holds by construction, and `verifyListItems` re-proves it against the
// snapshot (at extraction, and again wherever the rule is re-checked).
//
// WHERE THE LIST ENDS. Two layouts exist in the stored text:
//
//  1. MARKED items: lines that begin with a bracketed marker, "(a)", "(ii)",
//     "(3)". (#335, fix round 1) The end of a marked list is decided
//     POSITIVELY. After each item the next line must be one of:
//
//       a. THE NEXT MARKER OF THIS LIST. It must be in order: the marker that
//          directly follows the one before it at its level ("(b)" after "(a)",
//          "(iii)" after "(ii)"), or the first marker of a deeper list ("(a)",
//          "(i)", "(1)"), or an INSERTED marker, which amended legal texts
//          write as the marker before it plus a letter ("(iia)" after "(ii)").
//          The levels are those of `rubric-marker-chain.ts`, the same function
//          that builds rule references. A marker that is none of these is
//          refused (`marker_out_of_order`): it belongs to a list this reader
//          was not shown, and attaching it would invent a case.
//       b. A MARKER OF THE LEAD-IN'S OWN LEVEL (or shallower): the lead-in's
//          next sibling. The list is over. The lead-in's own marker is on its
//          line ("(c) ... all of the following apply:") or, where the page
//          sets every marker alone on a line (EUR-Lex), on the line BEFORE it;
//          both are read (`ListContext.before`). Without it, a nested lead-in
//          would be given its parent's later items.
//       c. A CONNECTOR LINE: a line that is only "or", "and", "and/or" (the
//          words are language data, in the lexicon). It must be followed by a
//          marker. If that marker continues this list, the connector is kept
//          as a line of its own, verbatim, between the two items, exactly as
//          the page sets it. If that marker ends the list (b.), the connector
//          belongs to the list around this one and is not stored.
//       d. AN EDITORIAL AMENDMENT MARK of the publisher ("▼M5", "▼B", "◄"),
//          recognised by shape. It is not official wording: it is skipped
//          between items and never stored. Inside an item's words it makes the
//          list unreadable (`editorial_mark_in_item`).
//       e. A KNOWN END: the end of the page; a paragraph number alone on its
//          line ("2.", "1a.", but not "1.", which would open a numbered list
//          inside the item); a line that begins with a reference label
//          ("V 4.3. ..."); a division heading ("Article 7", "CHAPTER III",
//          "ANNEX II": the words are lexicon data); or an unlabelled heading
//          by the index's own test (`looksLikeTitle`): one title-shaped line
//          followed by an ordinary long line, or up to three stacked ones
//          followed by a labelled paragraph. Never when a list marker follows.
//       An item that ends with a COLON introduces something: only a marker
//       (its own nested list) may follow it, never an end or the lead-in's
//       sibling, or the item would be stored without what it introduces.
//
//     ANYTHING ELSE IS REFUSED (`line_after_item_not_recognised`): a second
//     unmarked paragraph inside an item, closing words under the list ("and
//     the applicant must ..."), a row of dashes, a bullet, a table cell. Before
//     this round the list simply stopped at the first line without a marker,
//     so a list could be cut short and still look whole (Article 25(1) of the
//     Visa Code lost case (b) at the "or" line before it).
//
//     Some official pages (EUR-Lex) set each marker in a cell of its own, so
//     the cleaned text has the marker ALONE on a line and the item's words on
//     the NEXT line:
//         (a)
//         the Member State whose territory constitutes the sole destination ...
//     Such a bare marker line is joined with the one line that follows it,
//     with one space ("(a) the Member State ..."), which is how the page reads
//     and how the snapshot's whitespace-normalised text reads. Both halves are
//     whole lines of the snapshot, verbatim; nothing is added or cut. The line
//     joined to a bare marker must be WORDS: not another marker, a paragraph
//     number, a reference label, a division heading, an amendment mark or a
//     connector-only line, and not a line without a letter or digit. Otherwise
//     the list is refused as `marker_without_text`, never stored half.
//     Nested lists inside the list are included, in document order.
//
//  2. UNMARKED items: plain lines (a web page's bullets lose their bullet in
//     the cleaned text). Nothing in the text says where such a list ends, so
//     the reader is deliberately STRICT: items must begin with a lower-case
//     letter (they continue the lead-in's sentence); the list ends at the first
//     line that does not (a heading, a new paragraph, a numbered label) or
//     after an item that ends with a sentence-ending mark, or at the end of the
//     page. A list whose first item begins with a capital letter cannot be told
//     from a run of headings and paragraphs, and is reported as ambiguous.
//     (Unchanged by #335, except fix round 2: a line that is only a
//     connector word, "or", is lower case but is never an item; it is refused
//     as `connector_out_of_place`.)
//
// NEVER A GUESS. Anything the reader cannot decide cleanly returns
// `unreadable` with a NAMED reason, and the caller holds a protected rule /
// leaves out an ordinary one. An item over LIST_ITEM_MAX_CHARS is
// `item_too_long`, not truncated. What the reader can NOT tell, and so does not
// claim: whether a short unpunctuated line joined to a bare marker is the
// item's words or a title (both are plain words), and whether a bracketed
// number after the last item of an unmarked lead-in opens a nested list or is
// a footnote (it is refused only when the item before it ends with a full
// stop, see `placeMarker`).
//
// A SECOND PROOF. `verifyListItems` does not only re-run the reader: it also
// walks the snapshot's lines itself (`proveStoredList`). That walk SHARES some
// line tests with the reader (what a connector, an amendment mark, a hard
// start and a heading-shaped line look like, and the lead-in's own marker), so
// on its own it would only restate the reader's decision. (#335, fix round 2:
// review round 2 fuzzed ~54,000 marked lists and the walk refused none.) What
// it adds that the reader does NOT do: after a HEADING-SHAPED end (the one
// judgement most likely to be wrong), it looks on to the next hard start or the
// end of the page, and refuses the list when ANY marker met there would
// continue it, or cannot be explained as a new list opened under the heading
// (its own marker arithmetic, `successorsOf` and the open LEVELS at the last
// stored item, not the reader's). (#335, fix round 4: QA round 3 found a
// repeated sub-list marker, "(i)", "(ii)" under both (a) and (b), and a
// footnote "(1)" before the continuing marker, both slipped through when only
// the first marker met decided and every stored marker was "already seen".)
// What this does NOT guarantee: a list cut at a heading where no marker at all
// follows before the next hard start (closing words with no marker, or up to
// three heading-shaped lines followed by a hard start) is not caught; nor is a
// cut whose end is a hard start or the lead-in's sibling, which both proofs
// take as ends by shape (except that a last line ending "; or" / "; and" is
// refused unless the lead-in's sibling follows, review round 4); nor a cut
// followed, before the next hard start, by a new list that opens with a first
// marker ("(a)", "(1)", "(i)") and then runs in order, even when the stored
// list's own next marker appears and reads as that new list's next item
// ("(a) one;" / "(b) two;" / a heading / a sentence / "(a) new one;" /
// "(b) new two;" / "(c) old three." proves with only (a) and (b) stored).
//
// Pure functions over the snapshot's lines. Nothing here knows what any
// document is about, which route, country or nationality it concerns.

/**
 * Longest single list line stored. A longer line is `item_too_long`: it is
 * never cut, because a cut item is no longer verbatim and could change what an
 * exception says. Generous: a real item is a clause or a sentence.
 */
export const LIST_ITEM_MAX_CHARS = 2000;

/** Why a lead-in's list could not be read cleanly. Stable, machine-readable. */
export const LIST_UNREADABLE_REASONS = [
  "no_list_follows", // the quote is a lead-in but no list line follows it
  "item_too_long", // a list line is over LIST_ITEM_MAX_CHARS (never truncated)
  "ambiguous_list_end", // unmarked items that start with a capital: cannot tell where the list ends
  "nested_unmarked_lead_in", // an unmarked item is itself a lead-in ("...the following:")
  "pdf_layout_lost", // PDF page text has no reliable line layout
  "items_not_in_snapshot", // stored items do not match the snapshot (verification only)
  "marker_without_text", // (#335) a marker alone on its line with no item words on the next line
  "marker_out_of_order", // (#335) a marker that neither continues this list in order nor ends it
  "line_after_item_not_recognised", // (#335) a line after an item that is no marker, connector or known end
  "editorial_mark_in_item", // (#335) a publisher's amendment mark inside an item's words
  "list_end_not_proven", // (#335) the line after the last stored item is not a known end (verification only)
  "connector_out_of_place", // (#335, fix round 2) a connector word ("or") read as a list line of an unmarked list
] as const;
export type ListUnreadableReason = (typeof LIST_UNREADABLE_REASONS)[number];

/** What `readLeadInList` found. */
export type ListRead =
  // The quote is not a lead-in: nothing to attach, nothing wrong.
  | { kind: "none" }
  // The quote is a lead-in and its list was read: the items, in order.
  | { kind: "items"; items: string[] }
  // The quote is a lead-in and the list cannot be read cleanly.
  | { kind: "unreadable"; reason: ListUnreadableReason };

/** Fixed, code-written wording for each reason (flag messages; never source text). */
export const LIST_UNREADABLE_DETAIL: Record<ListUnreadableReason, string> = {
  no_list_follows: "the quote ends with a lead-in (a colon) but no list line follows it in the stored text",
  item_too_long: `a list line after the lead-in is longer than ${LIST_ITEM_MAX_CHARS} characters; it was not cut`,
  ambiguous_list_end: "the lines after the lead-in are not marked as a list and start with a capital letter, so where the list ends cannot be told",
  nested_unmarked_lead_in: "an unmarked list line after the lead-in is itself a lead-in (ends with a colon), so the nesting cannot be told",
  pdf_layout_lost: "the quote ends with a lead-in on a PDF page, whose line layout is lost, so its list lines cannot be read",
  items_not_in_snapshot: "the stored list lines are not the lines that follow the lead-in in the stored text",
  marker_without_text: "a list marker stands alone on its line and the line after it is not the item's words (it is missing, another marker, a paragraph number, a label, a heading, an amendment mark or a connector word), so the item cannot be read",
  marker_out_of_order: "a list marker after the lead-in does not follow the marker before it and does not start a deeper list at its first marker, so which list it belongs to cannot be told",
  line_after_item_not_recognised: "a line after a list item is not the next marker, a connector word between two items, or a known end of the list (the end of the page, a paragraph number, a reference label or a heading), so where the list ends cannot be told; the list was not cut there",
  editorial_mark_in_item: "a list line holds the publisher's amendment mark, which is not part of the official words, so the item cannot be stored verbatim",
  list_end_not_proven: "the line after the last stored list line is not a known end of the list (the end of the page, a paragraph number, a reference label, a heading or the lead-in's next sibling), or the last stored line ends with a connector word after its semicolon (as in ; or) and the lead-in's next sibling does not follow, or, after a heading-shaped end and before the next paragraph, a list marker would continue the list or cannot be read as part of a new list opened under the heading, so the stored list may be cut short",
  connector_out_of_place: "a line that is only a connector word (such as \"or\" or \"and\") stands where an unmarked list line should be, for example straight after the lead-in, so which items it joins cannot be told",
};

// ============================================
// What one line is (shape tests; the only language words come from the lexicon)
// ============================================

/**
 * What the reader may be told about the lead-in, beyond its own line.
 * Both fields are optional so the pure reader stays easy to call in tests.
 */
export interface ListContext {
  /**
   * The line directly BEFORE the lead-in line (empty lines removed). When it
   * is a marker alone on its line, it is the lead-in's own marker (the EUR-Lex
   * layout), and the list ends at that marker's next sibling.
   */
  before?: string;
  /**
   * How to read the document's language (#220): its reference-label shape,
   * its connector words and its division-heading words. Default: the product
   * language's. The other cues (a colon, a bracketed marker, a sentence end,
   * a lower-case start, an amendment mark's shape) are not language words.
   */
  lexicon?: Lexicon;
}

/** True when a line is an item of a MARKED list ("(a) ...", "(iv) ..."). */
const isMarked = (line: string): boolean => LIMB_RE.test(line);

/** Inner text of a line's list marker ("a" for "(a) ..."), or undefined. */
const markerOf = (line: string): string | undefined => LIMB_RE.exec(line)?.[1];

/**
 * (#335) True when a line is a list marker and NOTHING else ("(a)"): the
 * page set the marker apart from the item's words, which are on the next
 * line. The lines reach the reader already whitespace-normalised, so a
 * trailing no-break space is gone.
 */
export const isBareMarker = (line: string): boolean => {
  const m = LIMB_RE.exec(line);
  return m !== null && line.slice(m[0].length).trim() === "";
};

/**
 * (#335) True when a line is only a number ("2.", "3)", "4.1", "16"): never
 * the WORDS of a bare marker before it. Loose on purpose (a number with or
 * without its full stop): this test only ever refuses.
 */
const isNumberOnly = (line: string): boolean => /^\d+[a-z]{0,2}(?:\.\d+[a-z]{0,2})*[.)]?$/u.test(line);

/**
 * (#335) True when a line is a PARAGRAPH NUMBER alone on its line, the way
 * EUR-Lex sets "2." (or an inserted "1a."): the start of the next paragraph,
 * so a known end of the list. Stricter than `isNumberOnly`, because this test
 * ENDS a list: the number must carry its full stop or bracket (or be dotted,
 * "4.2"), so a stray table cell ("16") is not an end; and it must not be the
 * number ONE ("1.", "1)"), which right after a list item would open a
 * numbered list inside that item rather than continue the paragraphs.
 */
const isParagraphNumber = (line: string): boolean => (/^\d+[a-z]{0,2}(?:\.\d+[a-z]{0,2})*[.)]$/u.test(line) || /^\d+(?:\.\d+)+$/u.test(line)) && !/^1[.)]$/u.test(line);

/**
 * (#335) The publisher's editorial amendment glyphs. EUR-Lex consolidated
 * texts mark where an amending act starts and stops with a triangle and the
 * act's code ("▼M5", "▼B", "►C1", "◄"). They are layout, not law.
 */
const EDITORIAL_GLYPH_RE = /[▲►▼◄]/u;

/**
 * (#335) True when a line is ONLY amendment marks ("▼M5", "▼B", "◄",
 * "►M5 ◄"): one or more glyphs, each optionally followed by an act code (one
 * or two capital letters and up to three digits). Recognised by SHAPE: no list
 * of act codes is kept.
 */
export const isAmendmentMark = (line: string): boolean => /^(?:[▲►▼◄]\s*(?:[A-Z]{1,2}\d{0,3})?\s*)+$/u.test(line);

/** True when a line ends a sentence ("... 1971."): an unmarked list stops after such an item. */
const endsSentence = (line: string): boolean => /[.!?]["'’”)]*$/u.test(line);

/** True when a line ends with a colon: it introduces what follows it. */
const endsWithColon = (line: string | undefined): boolean => line !== undefined && line.endsWith(":");

/** True when a line begins with a lower-case letter (an unmarked item continues the lead-in's sentence). */
const startsLower = (line: string): boolean => /^\p{Ll}/u.test(line);

/** The line tests that need the document's language, built once per read. */
interface LineTests {
  /** The line begins with a reference label of this language ("V 4.3.", "5.2 Another paragraph"). */
  isLabel: (line: string) => boolean;
  /** The line is only a connector word between two items ("or", "and", "and/or"). */
  isConnector: (line: string) => boolean;
  /** (#335, review round 4) True when a line ends with a connector word after its last semicolon ("...; or"). */
  endsWithConnector: (line: string) => boolean;
  /** The whole line is a division heading ("Article 7", "CHAPTER III", "ANNEX II"). */
  isDivisionHeading: (line: string) => boolean;
  /** The line is a HARD start of something else: a paragraph number, a label or a division heading. */
  isHardStart: (line: string) => boolean;
  /**
   * Is the line at `at` a KNOWN END of a marked list? (The end of the page is
   * the caller's to see.) It is when it is
   *  - a hard start (a paragraph number, a reference label, a division
   *    heading); or
   *  - an unlabelled heading, by the index's own test (`looksLikeTitle`):
   *    one title-shaped line followed by an ordinary long line (the index's
   *    rule: a title directly followed by another short line is part of a run,
   *    a list or a table, not a heading), or a short stack of up to
   *    MAX_STACKED_TITLES title-shaped lines (a heading and its sub-heading)
   *    followed by a hard start or the end of the page.
   * A title-shaped line followed by a list marker is never an end: the list
   * may still be going on. Amendment marks between the lines are stepped over.
   */
  isKnownEnd: (following: readonly string[], at: number) => boolean;
  /** The line can be the WORDS joined to a bare marker (see the header). */
  isItemWords: (line: string | undefined) => line is string;
}

/**
 * (#335) A reference label whose LAST number carries a letter ("SW 6.1A.",
 * "SW 1.5ZA.", "SUI 9.2A"): paragraphs inserted into numbered rules are
 * labelled this way. The quote index's label shape (`lineLabelReFor`) allows a
 * letter after the first number only, because it also builds rule references
 * and must stay narrow there; the list reader only asks "does a new labelled
 * paragraph start here", so it reads the wider shape too. Shape only: a short
 * capital prefix, dotted numbers each with up to two capital letters, then a
 * full stop or a space.
 */
const SUFFIXED_LABEL_RE = /^[A-Z]{1,6}\.?\s?\d+[A-Z]{0,2}(?:\.\d+[A-Z]{0,2})+\.?(?=\s|$)/u;

/** Most title-shaped lines that may be stacked after a list and still read as headings (a heading, a sub-heading, one more). */
const MAX_STACKED_TITLES = 3;

/** Build the line tests for a language. */
function lineTestsFor(lexicon: Lexicon): LineTests {
  const labelRe = lineLabelReFor(lexicon);
  const isLabel = (line: string): boolean => labelRe.test(line) || SUFFIXED_LABEL_RE.test(line);
  const isConnector = (line: string): boolean => lexicon.listConnectors.has(line.trim().toLocaleLowerCase());
  const isDivisionHeading = (line: string): boolean => lexicon.divisionHeadingRe !== null && lexicon.divisionHeadingRe.test(line);
  const isHardStart = (line: string): boolean => isParagraphNumber(line) || isLabel(line) || isDivisionHeading(line);
  /**
   * A title-shaped line that is nothing more specific (not a connector, not an
   * editorial mark, not a hard start). Stricter than the index's test in one
   * way, because here the answer ENDS a list: the line must begin with a
   * capital letter or a digit, so a bullet ("• ..."), a dash or a bracket that
   * happens to be short and unpunctuated is not taken for a heading.
   */
  const isTitle = (line: string): boolean => looksLikeTitle(line) && /^[\p{Lu}\p{N}]/u.test(line) && !isConnector(line) && !EDITORIAL_GLYPH_RE.test(line) && !isHardStart(line);
  const isKnownEnd = (following: readonly string[], at: number): boolean => {
    /** The next index at or after `from` that is not an amendment mark. */
    const step = (from: number): number => {
      let k = from;
      while (k < following.length && isAmendmentMark(following[k])) k += 1;
      return k;
    };
    if (isHardStart(following[at])) return true;
    // Count the title-shaped lines stacked from here.
    let titles = 0;
    let k = at;
    while (k < following.length && titles < MAX_STACKED_TITLES && isTitle(following[k])) {
      titles += 1;
      k = step(k + 1);
    }
    if (titles === 0) return false;
    const after: string | undefined = following[k];
    // Heading(s), then the end of the page or a new labelled paragraph / division.
    if (after === undefined || isHardStart(after)) return true;
    // One heading, then an ordinary long line that is not a list marker (the
    // index's own rule) and does not start in lower case (which would carry a
    // sentence on, so the "heading" would be words in the middle of one).
    return titles === 1 && !isMarked(after) && !isShortRunLine(after) && !startsLower(after);
  };
  const isItemWords = (line: string | undefined): line is string =>
    line !== undefined && !isMarked(line) && !isNumberOnly(line) && !isLabel(line) && !isDivisionHeading(line) && !isAmendmentMark(line) && !isConnector(line) && /[\p{L}\p{N}]/u.test(line);
  /** The words after the line's LAST semicolon, when they are one connector ("(b) two; or" -> "or"). */
  const endsWithConnector = (line: string): boolean => {
    const semi = line.lastIndexOf(";");
    return semi >= 0 && isConnector(line.slice(semi + 1));
  };
  return { isLabel, isConnector, endsWithConnector, isDivisionHeading, isHardStart, isKnownEnd, isItemWords };
}

/**
 * (#335) The lead-in's OWN list marker: on its line ("(c) ... apply:"), or,
 * where the page sets markers alone on a line, the bare marker on the line
 * before it. Undefined when the lead-in is not a list item itself.
 */
function leadMarkerOf(leadLine: string, before: string | undefined): string | undefined {
  return markerOf(leadLine) ?? (before !== undefined && isBareMarker(before) ? markerOf(before) : undefined);
}

// ============================================
// Marked lists: where each marker belongs
// ============================================

/** The first marker a list of each kind can open with. */
const OPENERS: ReadonlySet<string> = new Set(["a", "i", "1"]);

/** The letter after a one-letter suffix ("a" -> "b"), or undefined after "z". */
const nextLetter = (ch: string): string | undefined => (ch >= "a" && ch < "z" ? String.fromCharCode(ch.charCodeAt(0) + 1) : undefined);

/**
 * The reader's place in a marked list: the open levels (outermost first, the
 * lead-in's own marker at level 0 when it has one) and, per level, the suffix
 * of the last INSERTED marker met there ("a" after "(iia)"), so "(iib)" can
 * follow "(iia)".
 */
interface ListPlace {
  levels: MarkerLevel[];
  inserted: (string | undefined)[];
  /** True when level 0 is the lead-in's own marker (not an item of the list). */
  hasLead: boolean;
}

/** What a marker is, for the list being read. */
type MarkerPlacement = "item" | "end" | "refuse";

/**
 * (#335) Decide what the marker `inner` is, given the place reached, and move
 * the place forward when it is an item.
 *
 *  - "item": the next marker of this list, IN ORDER: it directly follows the
 *    marker before it at its level, or opens a deeper list at that list's
 *    first marker, or is an inserted marker (the marker before it at some
 *    level plus the next suffix letter: "(iia)" after "(ii)").
 *  - "end": a marker of the lead-in's own level: the lead-in's next sibling.
 *  - "refuse": none of these. The marker is not the next one of any list the
 *    reader was shown, so it is not attached and the list is not cut there.
 *
 * @param previousItem the item stored just before this marker (undefined for
 *   the first). A deeper list may not open under an item that ends with a full
 *   stop: a closed sentence introduces nothing, and a bracketed number after
 *   it is more likely a footnote of the page than a case of the rule.
 */
function placeMarker(place: ListPlace, inner: string, previousItem: string | undefined): MarkerPlacement {
  const next = nextMarkerLevels(place.levels, inner);
  const deeper = next.length > place.levels.length;
  const k = next.length - 1; // the level this marker sits at
  // In order, by the ordinary rule of its kind?
  const inOrder = deeper ? OPENERS.has(inner) : markerFollows(next[k].kind as MarkerKind, place.levels[k].inner, inner);
  if (inOrder) {
    // Back at the lead-in's own level: its next sibling, the list is over.
    if (place.hasLead && next.length <= 1) return "end";
    if (deeper && previousItem !== undefined && /\.["'’”)]*$/u.test(previousItem)) return "refuse";
    place.levels = next;
    place.inserted = place.inserted.slice(0, k);
    return "item";
  }
  // An inserted marker: the current marker of a level plus the next suffix
  // letter. Deepest level first (the nearest list is the likeliest home).
  for (let level = place.levels.length - 1; level >= 0; level--) {
    const last = place.inserted[level];
    const suffix = last === undefined ? "a" : nextLetter(last);
    if (suffix === undefined || inner !== `${place.levels[level].inner}${suffix}`) continue;
    // Inserted after the lead-in's own marker: a sibling of the lead-in.
    if (place.hasLead && level === 0) return "end";
    place.levels = place.levels.slice(0, level + 1);
    place.inserted = place.inserted.slice(0, level);
    place.inserted[level] = suffix;
    return "item";
  }
  return "refuse";
}

/**
 * Read the list that follows a lead-in line. PURE: the caller has already
 * decided that the quote is a lead-in.
 *
 * @param leadLine the (normalised) line the lead-in is on
 * @param following the lines after it, in order, empty lines removed
 * @param ctx the line before the lead-in and the document's language (both optional)
 */
export function readListLines(leadLine: string, following: readonly string[], ctx: ListContext = {}): ListRead {
  const t = lineTestsFor(ctx.lexicon ?? productLexicon());
  // Amendment marks straight after the lead-in are layout: the list starts after them.
  let start = 0;
  while (start < following.length && isAmendmentMark(following[start])) start += 1;
  if (start >= following.length) {
    // Nothing follows the lead-in at all.
    return { kind: "unreadable", reason: "no_list_follows" };
  }
  const items: string[] = [];
  const first = following[start];

  if (isMarked(first)) {
    // ---- marked list ----
    const leadMarker = leadMarkerOf(leadLine, ctx.before);
    // A marked lead-in starts the chain, so its own level is level 0 and an
    // item that is back at level 0 is the lead-in's sibling: the list is over.
    const place: ListPlace = { levels: leadMarker !== undefined ? nextMarkerLevels([], leadMarker) : [], inserted: [], hasLead: leadMarker !== undefined };
    // A connector line met after an item, not yet known to be inside this list.
    let connector: string | undefined;
    // An index loop (not for-of): a bare marker line consumes the line after it too.
    for (let i = start; ; i++) {
      const line: string | undefined = following[i];
      // d. An amendment mark between two lines of the list: skipped, never stored.
      if (line !== undefined && isAmendmentMark(line)) continue;
      if (line !== undefined && isMarked(line)) {
        // a. / b. A marker: the next item, the lead-in's sibling, or out of order.
        const placement = placeMarker(place, markerOf(line) as string, items[items.length - 1]);
        if (placement === "refuse") return { kind: "unreadable", reason: "marker_out_of_order" };
        // The lead-in's sibling: the list is over. A connector waiting before
        // it joins the lead-in to that sibling, so it is not this list's.
        // (An item ending with a colon, left without what it introduces: refused.)
        if (placement === "end") {
          if (endsWithColon(items[items.length - 1])) return { kind: "unreadable", reason: "line_after_item_not_recognised" };
          break;
        }
        // c. The connector was between two items of THIS list: kept, verbatim, as its own line.
        if (connector !== undefined) {
          items.push(connector);
          connector = undefined;
        }
        // (#335) A bare marker ("(a)" alone): the item's words are the NEXT line,
        // and that line must be words (see `isItemWords`); otherwise the item
        // cannot be read and the list is refused, never stored as half an item.
        let item = line;
        if (isBareMarker(line)) {
          const words = following[i + 1];
          if (!t.isItemWords(words)) return { kind: "unreadable", reason: "marker_without_text" };
          // One space between the two whole, verbatim lines: what the page shows
          // and what the snapshot's normalised text (lines joined by a space) holds.
          item = `${line} ${words}`;
          i += 1;
        } else {
          // Two markers on one line ("(a) (i) the applicant ..."): the item is
          // also the FIRST item of a deeper list. Each further marker must
          // open that deeper list in order, or the nesting cannot be told.
          for (let rest = line.slice((LIMB_RE.exec(line) as RegExpExecArray)[0].length).trimStart(); isMarked(rest); rest = rest.slice((LIMB_RE.exec(rest) as RegExpExecArray)[0].length).trimStart()) {
            const depthBefore = place.levels.length;
            if (placeMarker(place, markerOf(rest) as string, undefined) !== "item" || place.levels.length <= depthBefore) return { kind: "unreadable", reason: "marker_out_of_order" };
          }
        }
        // The publisher's mark inside the words: not official wording, and
        // dropping it would no longer be the line as stored. Refused.
        if (EDITORIAL_GLYPH_RE.test(item)) return { kind: "unreadable", reason: "editorial_mark_in_item" };
        if (item.length > LIST_ITEM_MAX_CHARS) return { kind: "unreadable", reason: "item_too_long" };
        items.push(item);
        continue;
      }
      // Not a marker. Two unmarked lines in a row (a connector and then
      // something that is not a marker) cannot be placed.
      if (connector !== undefined) return { kind: "unreadable", reason: "line_after_item_not_recognised" };
      // An item that ends with a colon introduces something. Only a marker
      // may follow it (its own nested list). Anything else, an end included,
      // means what it introduces is not marked (bullets, a table, sub-headings)
      // or is missing: the item would be stored without it. Refused.
      if (endsWithColon(items[items.length - 1])) return { kind: "unreadable", reason: "line_after_item_not_recognised" };
      // e. The end of the page: a known end.
      if (line === undefined) break;
      // c. A connector word alone on its line: decided by the marker after it.
      if (t.isConnector(line)) {
        connector = line;
        continue;
      }
      // e. A paragraph number, a reference label or a heading: a known end.
      if (t.isKnownEnd(following, i)) break;
      // Anything else: the list is NOT cut here. Refused, with its reason.
      return { kind: "unreadable", reason: "line_after_item_not_recognised" };
    }
  } else {
    // ---- unmarked list ----
    // A capital-letter first line cannot be told from a heading or a new
    // paragraph: refuse rather than guess.
    if (!startsLower(first)) {
      return { kind: "unreadable", reason: t.isLabel(first) || endsSentence(first) ? "no_list_follows" : "ambiguous_list_end" };
    }
    for (const line of following.slice(start)) {
      // A capital letter, a label ("2.4 ...") or a marker ends the list.
      if (!startsLower(line) || t.isLabel(line)) break;
      // (#335, fix round 2) A line that is only a connector word ("or") is
      // lower case, so it would pass as an item. It joins two items, it is not
      // one; straight after a lead-in it means the list's shape is not what
      // this reader sees ("shall be:" / "or" / "(a) one;"). Refused.
      if (t.isConnector(line)) return { kind: "unreadable", reason: "connector_out_of_place" };
      if (line.length > LIST_ITEM_MAX_CHARS) return { kind: "unreadable", reason: "item_too_long" };
      // An unmarked item that is itself a lead-in: its own list would follow
      // as more unmarked lines and the nesting is invisible.
      if (line.endsWith(":")) return { kind: "unreadable", reason: "nested_unmarked_lead_in" };
      items.push(line);
      // A list written as one run ends with a full stop on its last item.
      if (endsSentence(line)) break;
    }
  }
  if (items.length === 0) return { kind: "unreadable", reason: "no_list_follows" };
  return { kind: "items", items };
}

// ============================================
// The second proof: stored lines against the snapshot, without the reader
// ============================================

/**
 * (#335) Prove, without RE-RUNNING the reader above, that stored list lines are
 * the snapshot's lines after the lead-in, and check where the list ends. This
 * is a plain walk over the lines. It does not use the reader's level logic
 * (`placeMarker`, `nextMarkerLevels`), but it does share its line tests
 * (`lineTestsFor`: connectors, hard starts, `isKnownEnd` for heading-shaped
 * lines) and `leadMarkerOf` / `markerFollows` for the lead-in's sibling, so for
 * those judgements it agrees with the reader by construction. Point 4 is the
 * check the reader does not make. The steps:
 *
 *  1. every stored line is, in order, a whole line of the snapshot, or a bare
 *     marker line and the line after it joined by one space; only amendment
 *     marks may sit between two stored lines;
 *  2. no stored line is a bare marker or holds an amendment mark, and the list
 *     neither starts nor ends with a connector word;
 *  3. THE LINE AFTER THE LAST STORED LINE IS A KNOWN END: the end of the page,
 *     a paragraph number, a reference label, a heading, or (when the lead-in
 *     has its own marker) the marker that directly follows the lead-in's,
 *     possibly after one connector word. A marker that is not the lead-in's
 *     next sibling, a connector with no such marker after it, or any other
 *     line means the stored list may be cut short: `list_end_not_proven`;
 *  4. (#335, fix round 2) WHEN THAT END IS ONLY HEADING-SHAPED (not the end of
 *     the page, a hard start or the lead-in's sibling), the walk goes on to the
 *     next hard start or the end of the page, and NO list marker met
 *     there may continue the stored list (a successor of a marker at a
 *     level still OPEN at the last stored item, or of the lead-in's, see
 *     `continuingAfter`), and every marker met must be explained by a new
 *     list opened under the heading (fix round 4, see
 *     `continuesAfterSoftEnd`): otherwise `list_end_not_proven`. This catches
 *     "(a) ...;" / "Exceptions for minors" / a sentence / "(b) ...", which both
 *     earlier checks accepted, a cut inside a second sub-list that repeats the
 *     first one's markers, and a footnote line before the continuing marker.
 *     It does not catch a cut with no marker before the next hard start, nor
 *     a cut followed, before the next hard start, by a new list that opens
 *     with a first marker and then runs in order, even when the stored list's
 *     own next marker appears and reads as that new list's next item (see
 *     the header).
 *
 * An unmarked list has no markers to prove an end with, so point 3 is the
 * reader's own strict rule restated (the last line ends its sentence, or the
 * next line does not continue it).
 *
 * @param leadLine the (normalised) line the lead-in is on
 * @param following the lines after it, in order, empty lines removed
 * @param items the stored list lines
 * @param ctx the line before the lead-in and the document's language
 */
export function proveStoredList(leadLine: string, following: readonly string[], items: readonly string[], ctx: ListContext = {}): { ok: true } | { ok: false; reason: ListUnreadableReason } {
  const t = lineTestsFor(ctx.lexicon ?? productLexicon());
  const no = (reason: ListUnreadableReason): { ok: false; reason: ListUnreadableReason } => ({ ok: false, reason });
  if (items.length === 0) return no("items_not_in_snapshot");
  /** Move past amendment marks (layout, never stored). */
  const skipMarks = (from: number): number => {
    let at = from;
    while (at < following.length && isAmendmentMark(following[at])) at += 1;
    return at;
  };
  const marked = isMarked(items[0]);
  let at = 0;

  if (!marked) {
    // ---- unmarked list: consecutive whole lines, then the reader's own end rule ----
    // (#335, fix round 2) Amendment marks straight after the lead-in are layout,
    // stepped over exactly as the reader steps over them (they disagreed before:
    // the reader skipped them and this walk did not, so such a list never verified).
    at = skipMarks(0);
    for (const item of items) {
      // A connector word is never an unmarked item (see the reader).
      if (t.isConnector(item)) return no("connector_out_of_place");
      if (following[at] !== item) return no("items_not_in_snapshot");
      at += 1;
    }
    const next: string | undefined = following[at];
    const ended = endsSentence(items[items.length - 1]) || next === undefined || !startsLower(next) || t.isLabel(next);
    return ended ? { ok: true } : no("list_end_not_proven");
  }

  // ---- marked list ----
  // 2. The shape of the stored lines themselves.
  if (t.isConnector(items[items.length - 1])) return no("items_not_in_snapshot");
  for (const item of items) {
    if (EDITORIAL_GLYPH_RE.test(item)) return no("editorial_mark_in_item");
    if (isBareMarker(item)) return no("items_not_in_snapshot");
    if (!isMarked(item) && !t.isConnector(item)) return no("items_not_in_snapshot");
  }
  // 1. Each stored line against the snapshot, in order.
  for (const item of items) {
    at = skipMarks(at);
    const line: string | undefined = following[at];
    if (line === item) {
      at += 1;
    } else if (line !== undefined && isBareMarker(line) && following[at + 1] !== undefined && `${line} ${following[at + 1]}` === item) {
      at += 2;
    } else {
      return no("items_not_in_snapshot");
    }
  }
  // 3. What comes after the last stored line. A last line that ends with a
  // colon introduces something that is not stored: never a whole list.
  if (endsWithColon(items[items.length - 1])) return no("list_end_not_proven");
  at = skipMarks(at);
  let end: string | undefined = following[at];
  const leadMarker = leadMarkerOf(leadLine, ctx.before);
  /** Is this line the marker that directly follows the lead-in's own (in any kind of list, or as an inserted marker)? */
  const isLeadSibling = (line: string): boolean => {
    const inner = markerOf(line);
    if (inner === undefined || leadMarker === undefined) return false;
    return (["letter", "roman", "digit"] as const).some((kind) => markerFollows(kind, leadMarker, inner)) || inner === `${leadMarker}a`;
  };
  // (#335, review round 4) A last stored line that ENDS WITH A CONNECTOR after
  // its semicolon ("(b) two; or", "; and", words from the language file's
  // `listConnectors`) promises another item. It is a whole list only when that
  // next item is the lead-in's own sibling (a nested lead-in's last sub-item
  // may end "; or" right before the parent's next point). Anywhere else (a
  // paragraph number, a heading, the end of the page) the list was cut there:
  // this closes most of the "cut at a hard start" class the header names.
  if (t.endsWithConnector(items[items.length - 1]) && !(end !== undefined && isLeadSibling(end))) return no("list_end_not_proven");
  if (end === undefined) return { ok: true }; // the end of the page
  // One connector word may join the lead-in to its sibling ("...; or" / "(b)").
  if (t.isConnector(end)) {
    at = skipMarks(at + 1);
    end = following[at];
    return end !== undefined && isLeadSibling(end) ? { ok: true } : no("list_end_not_proven");
  }
  if (isMarked(end)) return isLeadSibling(end) ? { ok: true } : no("list_end_not_proven");
  // A hard start (paragraph number, reference label, division heading) is an
  // end by its SHAPE alone: nothing of this paragraph can follow it.
  if (t.isHardStart(end)) return { ok: true };
  // Only a HEADING-SHAPED end is left ("Exceptions for minors"). That is the
  // one judgement most likely to be wrong, and the reader makes it with this
  // same `isKnownEnd`, so agreeing with the reader here proves nothing.
  if (!t.isKnownEnd(following, at)) return no("list_end_not_proven");
  // 4. (#335, fix round 2) THE CHECK THE READER DOES NOT MAKE: look PAST the
  // heading-shaped end, up to the next hard start or the end of the page. If
  // the first list marker met there would CONTINUE the stored list, the
  // "heading" was in the middle of the list and the stored list is cut short.
  return continuesAfterSoftEnd(following, at, items, leadMarker, t.isHardStart) ? no("list_end_not_proven") : { ok: true };
}

// ============================================
// The second proof's own marker arithmetic (independent of the reader)
// ============================================
//
// (#335, fix round 2) Review round 2 found that `proveStoredList` refused
// none of ~54,000 fuzzed marked lists: it stopped the same three ways the
// reader stops, with the same functions. The helpers below are deliberately
// NOT `markerFollows` / `nextMarkerLevels` / `placeMarker`: they know no list
// levels and no marker order. They only answer "which markers could come
// straight after some marker already stored?", generously (every reading of
// an ambiguous marker: "i" as a letter AND as a roman numeral). Generous is the
// safe direction: a bigger set only ever refuses more.

/** Lower-case roman numerals the second proof can read (1 to 39 is ample for list items). */
const ROMAN_RE = /^(x{0,3})(ix|iv|v?i{0,3})$/u;

/** The value of a lower-case roman numeral ("iv" -> 4), or undefined when it is not one. */
function romanValue(s: string): number | undefined {
  if (s === "" || !ROMAN_RE.test(s)) return undefined;
  const v: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  for (let k = 0; k < s.length; k++) {
    const cur = v[s[k]];
    const nxt = k + 1 < s.length ? v[s[k + 1]] : 0;
    // Subtractive notation: "iv", "ix".
    total += cur < nxt ? -cur : cur;
  }
  return total;
}

/** The lower-case roman numeral for 1..39 (enough for any list), or undefined. */
function romanOf(n: number): string | undefined {
  if (n < 1 || n > 39) return undefined;
  const units = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"];
  return "x".repeat(Math.floor(n / 10)) + units[n % 10];
}

/**
 * Every marker that could DIRECTLY follow `inner` in some list: the next
 * letter, the next number, the next roman numeral, and the inserted forms
 * ("ii" -> "iia"; "iia" -> "iib", and the base's successors, "iii"). Each
 * reading of an ambiguous marker is included.
 */
function successorsOf(inner: string): string[] {
  const out: string[] = [];
  // Letter: "a" -> "b" (single letters only, as the markers read here are).
  if (/^[a-y]$/u.test(inner)) out.push(String.fromCharCode(inner.charCodeAt(0) + 1));
  // Number: "3" -> "4".
  if (/^\d+$/u.test(inner)) out.push(String(Number(inner) + 1));
  // Roman: "iv" -> "v".
  const r = romanValue(inner);
  if (r !== undefined) {
    const next = romanOf(r + 1);
    if (next !== undefined) out.push(next);
  }
  // Inserted after this marker: "ii" -> "iia".
  out.push(`${inner}a`);
  // This marker is itself inserted ("iia" = "ii" + "a"): the next insertion
  // ("iib") and whatever follows the base ("iii").
  const ins = /^(.+?)([a-y])$/u.exec(inner);
  if (ins !== null && ins[1] !== "" && (romanValue(ins[1]) !== undefined || /^\d+$/u.test(ins[1]) || /^[a-z]$/u.test(ins[1]))) {
    out.push(`${ins[1]}${String.fromCharCode(ins[2].charCodeAt(0) + 1)}`);
    out.push(...successorsOf(ins[1]).filter((m) => m !== inner));
  }
  return out;
}

/** Every list marker at the start of a stored line, in order ("(a) (i) the ..." gives "a", "i"). */
function leadingMarkers(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  for (let m = LIMB_RE.exec(rest); m !== null; m = LIMB_RE.exec(rest)) {
    out.push(m[1]);
    rest = rest.slice(m[0].length).trimStart();
  }
  return out;
}

/**
 * (#335, fix round 4) The markers of a list, as the second proof sees its
 * LEVELS: index 0 is the outermost level, and each level holds the marker(s)
 * last placed at it. Built by the proof's own arithmetic (`successorsOf`), not
 * the reader's `placeMarker` / `nextMarkerLevels`.
 *
 * Placing one marker `m` (in the order the lines give them):
 *  - CONTINUES a level when `m` is a successor of a marker held at that level.
 *    The deepest such level wins (a "(ii)" continues the open "(i)" sub-list
 *    rather than anything further out), and every level inside it CLOSES
 *    ("(b)" after "(a) ... (i) (ii)" closes the roman sub-list);
 *  - otherwise OPENS a new level inside the deepest one ("(i)" under "(a)").
 *
 * AMBIGUITY, resolved generously: a marker that both continues a level AND is
 * a first marker ("i" after "h": the letter i, or a roman sub-list's (i)) is
 * placed BOTH ways: added to the level it continues (keeping what was there,
 * so the letter level still expects what follows "h") and opened as a new
 * level. A bigger set of open levels only makes `continuingAfter` bigger,
 * and a bigger continuing set only ever refuses more.
 */
type ProofLevels = Set<string>[];

/** The markers that open a list or a sub-list: "a", "1" and "i" (every reading of "i"). */
const isFirstMarker = (inner: string): boolean => inner === "a" || inner === "1" || inner === "i";

/** The deepest level of `levels` that `inner` continues, or -1 when it continues none. */
function levelContinued(levels: ProofLevels, inner: string): number {
  for (let d = levels.length - 1; d >= 0; d--) {
    for (const held of levels[d]) if (successorsOf(held).includes(inner)) return d;
  }
  return -1;
}

/** Place one marker (see `ProofLevels`). Mutates and returns `levels`. */
function placeInLevels(levels: ProofLevels, inner: string): ProofLevels {
  const d = levelContinued(levels, inner);
  if (d < 0) {
    // Opens a new level inside the deepest open one.
    levels.push(new Set([inner]));
    return levels;
  }
  // Continues level d: every level inside it closes.
  levels.length = d + 1;
  if (isFirstMarker(inner)) {
    // Ambiguous ("i" after "h"): keep what level d held, AND open a sub-list.
    levels[d].add(inner);
    levels.push(new Set([inner]));
  } else {
    levels[d] = new Set([inner]);
  }
  return levels;
}

/**
 * (#335, fix round 4) Every marker that would CONTINUE the stored list after
 * its last line: the successors of the marker(s) held at EACH level still open
 * at the last stored item, and of the lead-in's own marker. QA round 3 found
 * the round 2 set ("successors of every stored marker, minus every stored
 * marker") lost a marker that a second sub-list repeats: with "(a) (i) (ii)
 * (b) (i)" stored, the next "(ii)" was dropped because the FIRST sub-list had
 * already stored one. Here only the levels open at the end count, so the open
 * "(i)" of (b)'s sub-list expects "(ii)", and the closed one under (a) does not
 * interfere.
 */
function continuingAfter(items: readonly string[], leadMarker: string | undefined): { continuing: Set<string>; held: Set<string> } {
  const levels: ProofLevels = [];
  // The lead-in's own marker is the level outside the list ("(3) ... shall be:"
  // expects "(4)" next): it sits at the bottom, so it is always open.
  if (leadMarker !== undefined) levels.push(new Set([leadMarker]));
  for (const item of items) for (const inner of leadingMarkers(item)) placeInLevels(levels, inner);
  return {
    // What would come next at any open level.
    continuing: new Set(levels.flatMap((level) => [...level].flatMap(successorsOf))),
    // What the open levels end with (used to refuse a "new list" that only
    // repeats an open level's own marker, see `continuesAfterSoftEnd`).
    held: new Set(levels.flatMap((level) => [...level])),
  };
}

/**
 * (#335, fix round 2, rewritten in fix round 4) After a HEADING-SHAPED end at
 * `from`, walk on to the next hard start (or the end of the page) and return
 * true when the stored list may have been cut there.
 *
 * Round 2 let the FIRST marker met decide. QA round 3 found that a marker
 * that is not this list's at all (a footnote "(1) OJ L 243 ..." inside the
 * list, or a fresh "(i)") ended the walk, so a continuing "(b)" after it was
 * never seen. Now EVERY marker up to the hard start must be explained:
 *
 *  - before any new list has opened, a marker that continues the stored list
 *    (`continuingAfter`) means the list was cut: true;
 *  - a FIRST marker ("a", "1", "i") that does not continue it opens a NEW list
 *    under the heading ("Under this heading the rules are:" / "(a) ...");
 *  - once a new list is open, each marker must follow it by the same level
 *    arithmetic (continue one of its levels, or open a sub-list with a first
 *    marker). A marker that does not follow it is not explained by the new
 *    list: if it would continue the stored list, the stored list was cut;
 *    either way the page is not the clean layout the proof can vouch for, so
 *    it is refused too (true). That is how the footnote layout
 *    "(1) OJ L ..." / "(b) two." is refused: "(1)" opens a "new list" that
 *    "(b)" does not follow, and "(b)" continues the stored "(a)";
 *  - any other marker (neither continuing nor a first marker, before a new
 *    list opened) is refused as well: the proof cannot say whose it is;
 *  - a first marker that REPEATS what an open level of the stored list ends
 *    with ("(i)" when the stored list stops on an open "(i)") is refused: a
 *    "new list" from it would explain the stored list's own next marker.
 *
 * Refusing is the safe direction here: a refused list is held or left out,
 * never published cut (rulebooks publish with no human sign-off).
 */
function continuesAfterSoftEnd(following: readonly string[], from: number, items: readonly string[], leadMarker: string | undefined, isHardStart: (line: string) => boolean): boolean {
  const { continuing, held } = continuingAfter(items, leadMarker);
  /** The levels of a new list opened under the heading, once one has. */
  let fresh: ProofLevels | undefined;
  for (let k = from; k < following.length; k++) {
    const line = following[k];
    // A hard start: what comes after it belongs to another paragraph or division.
    // (The heading-shaped line at `from` itself is never a hard start: checked before.)
    if (isHardStart(line)) return false;
    const inner = markerOf(line);
    if (inner === undefined) continue;
    if (fresh === undefined) {
      // No new list yet: a continuing marker means the stored list was cut.
      if (continuing.has(inner)) return true;
      // A first marker opens a new list under the heading; anything else is unexplained.
      if (!isFirstMarker(inner)) return true;
      // ...unless it REPEATS the marker an open level of the stored list ends
      // with: "(d) ...:" / "(i) ...;" / heading / "(i) ..." / "(ii) ...". The
      // second "(i)" would open a "new list" that "(ii)" then follows, while
      // "(ii)" is exactly what the stored "(i)" expects. A new list that
      // starts with the very marker the cut list stopped on cannot be told
      // from a cut, so it is refused (the safe direction).
      if (held.has(inner)) return true;
      fresh = placeInLevels([], inner);
      continue;
    }
    // A new list is open: the marker must follow it (continue a level, or open a sub-list).
    if (levelContinued(fresh, inner) >= 0 || isFirstMarker(inner)) {
      placeInLevels(fresh, inner);
      continue;
    }
    // Not the new list's: continuing the stored list or unexplained, refused either way.
    return true;
  }
  // The end of the page: every marker met was explained by a new list (or none was met).
  return false;
}

// ============================================
// Against a snapshot index
// ============================================

/**
 * Is the located quote a LEAD-IN? It is when it reaches the end of its own
 * line and that line ends with a colon: the quote's last character is the
 * colon, or the quote stops just before the colon that closes the line.
 */
export function quoteIsLeadIn(index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>): boolean {
  // A PDF page is ONE unit whose lines are collapsed: text follows the quote
  // on the page even when it is the end of a line, so only the colon can say.
  if (index.isPaginated) return found.matched.endsWith(":");
  const rest = index.unitText(found.unit).slice(found.at + found.matched.length).trim();
  return (rest === "" && found.matched.endsWith(":")) || rest === ":";
}

/**
 * The lines around a located lead-in, as the pure functions take them: the
 * lead-in's own line, the non-empty lines after it, and the nearest non-empty
 * line before it (#335: where a bare marker of the lead-in's own would be).
 */
function linesAround(index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>): { leadLine: string; following: string[]; ctx: ListContext } {
  const following: string[] = [];
  for (let i = found.unit + 1; i < index.unitCount; i++) {
    const text = index.unitText(i);
    if (text) following.push(text);
  }
  let before: string | undefined;
  for (let i = found.unit - 1; i >= 0 && before === undefined; i--) {
    const text = index.unitText(i);
    if (text) before = text;
  }
  return { leadLine: index.unitText(found.unit), following, ctx: { before, lexicon: index.lexicon } };
}

/**
 * Read the list that follows a located quote, when the quote is a lead-in.
 * `none` for a quote that is not a lead-in. A PDF page has no line layout, so
 * a lead-in there is `unreadable` (the caller holds / leaves out), never read
 * from flattened text.
 */
export function readLeadInList(index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>): ListRead {
  if (!quoteIsLeadIn(index, found)) return { kind: "none" };
  if (index.isPaginated) return { kind: "unreadable", reason: "pdf_layout_lost" };
  const { leadLine, following, ctx } = linesAround(index, found);
  return readListLines(leadLine, following, ctx);
}

/**
 * Prove that `items` are exactly the list lines the snapshot has after the
 * located quote: each is a whole line of the stored text, verbatim, in order
 * (or, #335, a bare marker line and the line after it joined by one space),
 * and the list is WHOLE (no line missing, none added). This is what a stored
 * `source.listItems` is checked with, at extraction and wherever the rule is
 * looked at again. An altered, reordered, truncated or extended list fails.
 *
 * TWO proofs, and both must hold (#335, fix rounds 1 and 2):
 *  1. the reader, run again on the snapshot, returns exactly these lines;
 *  2. `proveStoredList`, a separate walk (it shares the reader's line tests,
 *     not its level logic), finds each line in the snapshot and a known end
 *     after the last one, and, after a heading-shaped end, no marker that
 *     would continue the list before the next hard start.
 * Before fix round 1 only the first existed. In fix round 1 the second
 * restated the reader's ends and caught no cut; the look-past-the-heading
 * check of fix round 2 is what makes it catch the heading-shaped cut. It is
 * not a proof that every list is whole (see the header for what it misses).
 */
export function verifyListItems(index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>, items: readonly string[]): { ok: true } | { ok: false; reason: ListUnreadableReason } {
  const read = readLeadInList(index, found);
  if (read.kind !== "items") return { ok: false, reason: read.kind === "unreadable" ? read.reason : "items_not_in_snapshot" };
  const same = read.items.length === items.length && read.items.every((line, i) => line === items[i]);
  if (!same) return { ok: false, reason: "items_not_in_snapshot" };
  const { leadLine, following, ctx } = linesAround(index, found);
  return proveStoredList(leadLine, following, items, ctx);
}

/** The rule's full source text: its quote followed by its list lines (what a reader or the check is shown). */
export function quoteWithItems(source: { quote: string; listItems?: readonly string[] }): string {
  return source.listItems && source.listItems.length > 0 ? [source.quote, ...source.listItems].join("\n") : source.quote;
}

/**
 * Why a located quote's list is NOT usable, or undefined when it is fine (not
 * a lead-in, or its items were attached). Used by the extraction service to
 * raise the flag below.
 */
export function unreadableListReason(index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>, attached: readonly string[] | undefined): ListUnreadableReason | undefined {
  if (attached !== undefined) return undefined;
  const read = readLeadInList(index, found);
  if (read.kind === "unreadable") return read.reason;
  if (read.kind !== "items") return undefined;
  // The reader returned lines but they were not attached: the second proof
  // refused them. Its own reason is the one to name (#335), when it has one.
  const proof = verifyListItems(index, found, read.items);
  return proof.ok ? "items_not_in_snapshot" : proof.reason;
}

/**
 * Push the `list_not_readable` flag for a rule whose lead-in list could not be
 * read. The gates treat it as a LEAVE-OUT flag: it HOLDS the draft when the
 * rule is protected and leaves an ordinary rule out, with this flag code as the
 * named reason. The message is fixed, code-written text (no source text).
 */
export function listNotReadableFlag(criterionId: string, reason: string | undefined, flags: RubricFlag[]): void {
  if (reason === undefined) return;
  flags.push({
    code: "list_not_readable",
    message: `the quote ends with a lead-in, and its list could not be read cleanly (${reason}): ${LIST_UNREADABLE_DETAIL[reason as ListUnreadableReason] ?? "unknown reason"}. The rule is not complete without its list; it is held (protected rule) or left out (ordinary rule) rather than published with the lead-in alone.`,
    target: criterionId,
  });
}
