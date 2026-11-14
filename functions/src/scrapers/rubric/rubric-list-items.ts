import { LIMB_RE, LINE_LABEL_RE, type QuoteLookup, type SnapshotQuoteIndex } from "./rubric-quote";
import { composeMarkerChain } from "./rubric-marker-chain";
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
//     "(3)". The list is the run of marked lines. When the lead-in line is
//     itself marked ("(c) ... all of the following apply:"), its items are the
//     deeper markers under it, and the list ends at the next marker of the
//     lead-in's own level ("(d)") or shallower (the depth is decided by
//     `composeMarkerChain`, the same function that builds rule references).
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
//
// NEVER A GUESS. Anything the reader cannot decide cleanly returns
// `unreadable` with a NAMED reason, and the caller holds a protected rule /
// leaves out an ordinary one. A list is never cut short silently: an item over
// LIST_ITEM_MAX_CHARS is `item_too_long`, not truncated.
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
};

/** True when a line is an item of a MARKED list ("(a) ...", "(iv) ..."). */
const isMarked = (line: string): boolean => LIMB_RE.test(line);

/** Inner text of a line's list marker ("a" for "(a) ..."), or undefined. */
const markerOf = (line: string): string | undefined => LIMB_RE.exec(line)?.[1];

/** True when a line ends a sentence ("... 1971."): an unmarked list stops after such an item. */
const endsSentence = (line: string): boolean => /[.!?]["'’”)]*$/u.test(line);

/** True when a line begins with a lower-case letter (an unmarked item continues the lead-in's sentence). */
const startsLower = (line: string): boolean => /^\p{Ll}/u.test(line);

/**
 * Read the list that follows a lead-in line. PURE: the caller has already
 * decided that the quote is a lead-in.
 *
 * @param leadLine the (normalised) line the lead-in is on
 * @param following the lines after it, in order, empty lines removed
 */
export function readListLines(leadLine: string, following: readonly string[]): ListRead {
  if (following.length === 0) {
    // Nothing follows the lead-in at all.
    return { kind: "unreadable", reason: "no_list_follows" };
  }
  const items: string[] = [];
  const first = following[0];

  if (isMarked(first)) {
    // ---- marked list ----
    const leadMarker = markerOf(leadLine);
    // Markers seen so far, for the depth test below. A marked lead-in starts
    // the chain, so its own level is level 0 and an item that is back at
    // level 0 is the lead-in's sibling: the list is over.
    const markers: string[] = leadMarker !== undefined ? [leadMarker] : [];
    for (const line of following) {
      if (!isMarked(line)) break;
      if (leadMarker !== undefined) {
        const chain = composeMarkerChain([...markers, markerOf(line) as string]);
        if (chain.length <= 1) break;
      }
      if (line.length > LIST_ITEM_MAX_CHARS) return { kind: "unreadable", reason: "item_too_long" };
      markers.push(markerOf(line) as string);
      items.push(line);
    }
  } else {
    // ---- unmarked list ----
    // A capital-letter first line cannot be told from a heading or a new
    // paragraph: refuse rather than guess.
    if (!startsLower(first)) {
      return { kind: "unreadable", reason: LINE_LABEL_RE.test(first) || endsSentence(first) ? "no_list_follows" : "ambiguous_list_end" };
    }
    for (const line of following) {
      // A capital letter, a label ("2.4 ...") or a marker ends the list.
      if (!startsLower(line) || LINE_LABEL_RE.test(line)) break;
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

/**
 * Is the located quote a LEAD-IN? It is when it reaches the end of its own
 * line and that line ends with a colon: the quote's last character is the
 * colon, or the quote stops just before the colon that closes the line.
 */
export function quoteIsLeadIn(index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>): boolean {
  const rest = index.unitText(found.unit).slice(found.at + found.matched.length).trim();
  return (rest === "" && found.matched.endsWith(":")) || rest === ":";
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
  const following: string[] = [];
  for (let i = found.unit + 1; i < index.unitCount; i++) {
    const text = index.unitText(i);
    if (text) following.push(text);
  }
  return readListLines(index.unitText(found.unit), following);
}

/**
 * Prove that `items` are exactly the list lines the snapshot has after the
 * located quote: each is a whole line of the stored text, verbatim, in order,
 * and the list ends where the reader says it ends (no line missing, none
 * added). This is what a stored `source.listItems` is checked with, at
 * extraction and wherever the rule is looked at again. An altered, reordered,
 * truncated or extended list fails.
 */
export function verifyListItems(index: SnapshotQuoteIndex, found: Extract<QuoteLookup, { ok: true }>, items: readonly string[]): { ok: true } | { ok: false; reason: ListUnreadableReason } {
  const read = readLeadInList(index, found);
  if (read.kind !== "items") return { ok: false, reason: read.kind === "unreadable" ? read.reason : "items_not_in_snapshot" };
  const same = read.items.length === items.length && read.items.every((line, i) => line === items[i]);
  return same ? { ok: true } : { ok: false, reason: "items_not_in_snapshot" };
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
  return read.kind === "items" ? "items_not_in_snapshot" : undefined;
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
