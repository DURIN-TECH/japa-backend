import type { SourceSection } from "./types";

// ============================================
// VISA CATALOG — SECTION SELECTION + FORMATTING (pure)
// ============================================
//
// Structured sources (GOV.UK guides) come back as separate parts. Only the
// parts that feed the `VisaType` shape are sent to the LLM: dependants,
// switching and job-change parts are not in that shape, cost tokens, and would
// re-trigger extraction whenever they change. See
// src/scrapers/visa-catalog/docs/visa-scraper-uk-reference.md §3.2.
//
// Selection is by SLUG PATTERN (not a hard-coded per-guide list) because slugs
// vary a little between guides ("documents-you-must-provide" vs
// "documents-youll-need-to-apply", "apply" vs "apply-online"…).
//
// Pattern syntax: case-insensitive, whole-slug match, `*` = any run of
// characters (possibly empty). No other wildcards.
//
// Rules:
//  - A part is selected when it matches an INCLUDE pattern and no EXCLUDE
//    pattern. Exclude wins over include. Anything matching no include pattern
//    is left out ("anything else" in §3.2).
//  - A page's `includeSections` / `excludeSections` (registry) REPLACE the code
//    defaults below, each list independently.

/**
 * Default INCLUDE patterns: the parts that describe the visa itself —
 * overview, eligibility/requirements, money/fees, how to apply (which carries
 * processing time), extensions and documents.
 */
export const DEFAULT_INCLUDE_SECTIONS: readonly string[] = [
  // What the visa is, who it is for, how long it lasts.
  "overview",
  // Eligibility / requirements parts (names vary per guide).
  "eligibility",
  "your-job",
  "when-you-can-be-paid-less",
  "if-you-work-in-*",
  "*-requirements",
  "knowledge-of-english",
  "money",
  "course",
  "course-*",
  // Fees.
  "how-much-it-costs",
  "*fees*",
  // How to apply + processing time.
  "how-long*",
  "apply",
  "apply-*",
  // Extensions (validity / isExtendable).
  "extend-your-visa",
  "extend-*",
  // Documents.
  "documents-*",
];

/**
 * Default EXCLUDE patterns: parts outside the `VisaType` shape (dependants,
 * switching, job changes, settlement/citizenship). Most would not match an
 * include pattern anyway; listing them makes the intent explicit and guards
 * against a future broad include pattern pulling them in.
 */
export const DEFAULT_EXCLUDE_SECTIONS: readonly string[] = [
  "switch-to-this-visa",
  "switch-*",
  "your-partner-and-children",
  "your-family-members",
  "family-members",
  "certificate-of-sponsorship-before-*",
  "update-your-visa-*",
  "second-job",
  "taking-a-second-job",
  "settle-*",
  "becoming-a-british-citizen",
];

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `slug` matches the glob `pattern` (case-insensitive, whole-slug,
 * `*` = any characters). Blank patterns never match.
 */
export function slugMatches(slug: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  // Escape everything, then turn each (escaped-free) `*` into `.*`.
  const re = new RegExp(`^${p.split("*").map(escapeRegExp).join(".*")}$`, "i");
  return re.test(slug);
}

/** Effective pattern lists for one page: page overrides replace the defaults. */
export function effectiveSectionPatterns(page: {
  includeSections?: string[];
  excludeSections?: string[];
}): { include: readonly string[]; exclude: readonly string[] } {
  return {
    include: page.includeSections ?? DEFAULT_INCLUDE_SECTIONS,
    exclude: page.excludeSections ?? DEFAULT_EXCLUDE_SECTIONS,
  };
}

/**
 * Pick the sections to send to the extractor, KEEPING source order.
 * Selected = matches some include pattern AND no exclude pattern.
 */
export function selectSections<T extends { slug: string }>(
  sections: T[],
  patterns: { include: readonly string[]; exclude: readonly string[] }
): T[] {
  return sections.filter(
    (s) =>
      patterns.include.some((p) => slugMatches(s.slug, p)) &&
      !patterns.exclude.some((p) => slugMatches(s.slug, p))
  );
}

/**
 * Format selected sections as the extractor input: one `## <title>\n<text>`
 * block per section, in order, separated by a blank line. The headings let the
 * model's verbatim citations name the section they came from.
 */
export function formatSections(sections: SourceSection[]): string {
  return sections.map((s) => `## ${s.title.trim()}\n${s.text}`).join("\n\n");
}

/**
 * Apply a hard length cap. Returns the (possibly cut) text and whether it was
 * cut, so the caller can record `truncated` — text is never cut silently.
 */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}
