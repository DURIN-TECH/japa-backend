import type { AssessmentCriterion, QuoteTranslation, RubricDiscard } from "../../types/rubric";
import { lexiconFor, type Lexicon } from "../language/language-lexicon";
import { sampleAudit } from "./rubric-gates";
import { CHECKER_ASPECTS, decodeRow, type VerdictRow } from "./rubric-checker-prompt";
import { SnapshotQuoteIndex, dateSupported, unitAdjacentToNumber, unitSupported, unsupportedNumbers, withoutLeadingParagraphNumber } from "./rubric-quote";
import type { GuidanceSnapshotContent } from "../guidance/types";
import { UNOFFICIAL_TRANSLATION_LABEL } from "./rubric-translation";

// ============================================
// LANGUAGE EVALUATION — the pure part (issue #220)
// ============================================
//
// WHY. Before a language is added to `supportedLanguages`, a person must see
// how the whole chain (extraction prompt, quote validation in that language,
// the independent check) behaves on a REAL official page in it. This module is
// the arithmetic and the paperwork of that evaluation, with no model, no
// database and no network, so it is testable and the script around it
// (scripts/evaluate-language.ts) is thin.
//
// What the evaluation reports:
//   - rules KEPT, rules DISCARDED by reason (the discard table of the draft);
//   - a RECHECK of every kept rule against the stored page, in the page's own
//     language (quote found, numbers / unit / dates read), which is the proof
//     the lexicon reads what the model claimed;
//   - a 20-rule SAMPLE SHEET for a human to read against the official wording:
//     the quote, its URL, the rule's English title and fields, the checker's
//     verdict row, and EMPTY fields for the human verdict;
//   - once a person has filled the sheet: the AGREEMENT between the checker and
//     the human on those 20 rules (`scoreSheet`).
//
// It decides NOTHING about enabling a language: it never edits settings. The
// owner enables a language by adding it to `supportedLanguages` after reading
// the report; if the evaluation is not good enough the list stays as it is.
//
// Generic: no language, country or publisher is named here.

/** How many rules the sample sheet lists. */
export const SAMPLE_SHEET_SIZE = 20;

/** What a human writes for one sampled rule. */
export const HUMAN_VERDICTS = ["faithful", "not_faithful", "unsure"] as const;
export type HumanVerdict = (typeof HUMAN_VERDICTS)[number];

/** The checker's reading of one rule, summarised. */
export type CheckerReading = "kept" | "left_out" | "no_verdict";

/** One line of the sample sheet. */
export interface SampleSheetRow {
  criterionId: string;
  title: string;
  ruleRef: string | null;
  quote: string;
  url: string;
  // The fields a reader compares with the quote.
  kind: string;
  stage: string;
  check: AssessmentCriterion["check"] | null;
  appliesTo: AssessmentCriterion["appliesTo"] | null;
  // The independent check's verdict letters per model (y n u a, one per aspect), when there are any.
  checkerVerdicts: { verification?: string; judgement?: string } | null;
  checkerReading: CheckerReading;
  // The unofficial translation, always with its label: a reading aid, NEVER the evidence.
  translation: { text: string; label: string } | null;
  // FOR THE HUMAN: one of HUMAN_VERDICTS, and a free note.
  humanVerdict: HumanVerdict | null;
  humanNote: string;
}

/** The recheck of one kept rule against its stored page. */
export interface RecheckResult {
  criterionId: string;
  // Empty = every claim was found in the quote in the page's language.
  problems: string[];
}

/**
 * Read a rule's check, dates and title numbers again from its quote, in the
 * page's language. A problem is a code, never text. This is the validation
 * `assessCriterion` runs, repeated on what was stored: a lexicon or rule that
 * reads differently now than it did at extraction shows up here.
 */
export function recheckRule(rule: AssessmentCriterion, index: SnapshotQuoteIndex, lexicon: Lexicon = index.lexicon): RecheckResult {
  const problems: string[] = [];
  const found = index.locate(rule.source.quote);
  if (!found.ok) return { criterionId: rule.criterionId, problems: [`quote_${found.reason}`] };
  const quote = found.matched;
  const content = withoutLeadingParagraphNumber(quote, lexicon);
  const c = rule.check;
  if (c) {
    const v = c.value;
    if (typeof v === "number" && unsupportedNumbers(v, content, { outsideDates: true, lexicon }).length > 0) problems.push("check_number_not_in_quote");
    if (c.unit && !unitSupported(c.unit, quote)) problems.push("check_unit_not_in_quote");
    if (c.unit && typeof v === "number" && !unitAdjacentToNumber(v, c.unit, content, lexicon)) problems.push("check_unit_not_next_to_number");
  }
  if (unsupportedNumbers(rule.title, withoutLeadingParagraphNumber(quote, lexicon), { lexicon }).length > 0) problems.push("title_number_not_in_quote");
  for (const key of ["validFrom", "validUntil"] as const) {
    const d = rule[key];
    if (d && !dateSupported(d, quote, lexicon)) problems.push(`${key}_not_in_quote`);
  }
  return { criterionId: rule.criterionId, problems };
}

/** What the checker said about a rule, as a reading. */
function readingOf(verdicts: { verification?: string; judgement?: string } | undefined, leftOut: ReadonlySet<string>, criterionId: string): CheckerReading {
  if (leftOut.has(criterionId)) return "left_out";
  if (!verdicts) return "no_verdict";
  const rows = [verdicts.verification, verdicts.judgement].map((r) => (r ? decodeRow(r) : null)).filter((r): r is VerdictRow => r !== null);
  if (rows.length === 0) return "no_verdict";
  // Kept = every aspect is `yes` or `na` in every row the check produced.
  return rows.every((row) => CHECKER_ASPECTS.every((a) => row[a] === "yes" || row[a] === "na")) ? "kept" : "left_out";
}

/** Inputs of the sample sheet. */
export interface SampleSheetInput {
  kept: readonly AssessmentCriterion[];
  // The version number the sample is keyed to (the draw is reproducible for a version).
  version: number;
  translations?: Readonly<Record<string, QuoteTranslation>>;
  // criterionId -> the check's letters per model (the checker ledger's `ruleVerdicts`).
  verdicts?: Readonly<Record<string, { verification?: string; judgement?: string }>>;
  // Rules the check left out (their ids).
  checkerLeftOut?: readonly string[];
  size?: number;
}

/**
 * The reproducible sample sheet: the same rules `sampleAudit` draws (the
 * smallest hashes of `criterionId:version`), whatever order the rules are in.
 */
export function buildSampleSheet(input: SampleSheetInput): SampleSheetRow[] {
  const byId = new Map(input.kept.map((c) => [c.criterionId, c]));
  const left = new Set(input.checkerLeftOut ?? []);
  return sampleAudit(input.kept, input.version, input.size ?? SAMPLE_SHEET_SIZE).map((s) => {
    const rule = byId.get(s.criterionId) as AssessmentCriterion;
    const t = input.translations?.[s.criterionId];
    const verdicts = input.verdicts?.[s.criterionId];
    return {
      criterionId: s.criterionId,
      title: s.title,
      ruleRef: s.ruleRef,
      quote: s.quote,
      url: s.url,
      kind: rule.kind,
      stage: rule.stage,
      check: rule.check ?? null,
      appliesTo: rule.appliesTo ?? null,
      checkerVerdicts: verdicts ?? null,
      checkerReading: readingOf(verdicts, left, s.criterionId),
      translation: t ? { text: t.text, label: UNOFFICIAL_TRANSLATION_LABEL } : null,
      humanVerdict: null,
      humanNote: "",
    };
  });
}

/** Agreement between the checker and a person on the sampled rules. */
export interface Agreement {
  sampled: number;
  // Rules the human answered (`faithful` or `not_faithful`); `unsure` and blanks are not counted either way.
  decided: number;
  unsure: number;
  blank: number;
  agree: number;
  // Checker kept a rule the human says is not faithful: the dangerous direction.
  checkerKeptHumanRejected: number;
  // Checker left out a rule the human says is faithful: lost coverage, safe.
  checkerLeftOutHumanAccepted: number;
  noCheckerVerdict: number;
  // agree / decided, or null when nobody decided anything.
  rate: number | null;
}

/** Score a filled sheet. A rule the checker has no verdict for is counted apart, never as agreement. */
export function scoreSheet(rows: readonly SampleSheetRow[]): Agreement {
  const a: Agreement = { sampled: rows.length, decided: 0, unsure: 0, blank: 0, agree: 0, checkerKeptHumanRejected: 0, checkerLeftOutHumanAccepted: 0, noCheckerVerdict: 0, rate: null };
  for (const r of rows) {
    if (r.humanVerdict === null) {
      a.blank += 1;
      continue;
    }
    if (r.humanVerdict === "unsure") {
      a.unsure += 1;
      continue;
    }
    if (r.checkerReading === "no_verdict") {
      a.noCheckerVerdict += 1;
      continue;
    }
    a.decided += 1;
    const humanOk = r.humanVerdict === "faithful";
    const checkerOk = r.checkerReading === "kept";
    if (humanOk === checkerOk) a.agree += 1;
    else if (checkerOk) a.checkerKeptHumanRejected += 1;
    else a.checkerLeftOutHumanAccepted += 1;
  }
  a.rate = a.decided > 0 ? a.agree / a.decided : null;
  return a;
}

/** Count discards by reason, most frequent first (ties by name). */
export function discardTally(discards: readonly Pick<RubricDiscard, "reason">[]): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const d of discards) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count || (x.reason < y.reason ? -1 : 1));
}

/** The evaluation report (JSON). */
export interface LanguageEvaluationReport {
  generatedAt: string;
  // `offline`: read a stored version; `live`: drafted and checked now (spent model calls).
  mode: "offline" | "live";
  routeKey: string;
  sourceLanguages: string[];
  pages: { sourceId: string; language: string; hasLexicon: boolean; characters: number }[];
  rulesKept: number;
  // Discards by reason (the draft's own table; a stored version keeps at most 200 records, `discardedCount` is exact).
  discardedTotal: number;
  discardedByReason: { reason: string; count: number }[];
  recheck: { checked: number; withProblems: number; problems: { criterionId: string; problems: string[] }[] };
  checker: { ran: boolean; kept: number; leftOut: number; noVerdict: number } | null;
  translations: { stored: number };
  usage: { requests: number; inputTokens: number; outputTokens: number } | null;
  sampleSheetFile: string;
  // Present only after `--score`.
  agreement: Agreement | null;
  // Said plainly in every report: the tool never enables a language.
  note: string;
}

/** The sentence every report carries. */
export const EVALUATION_NOTE = "This report enables nothing. A language is added to supportedLanguages (appConfig/routeOnboardingSettings) by a person, only after reading this report and the sample sheet; if the evaluation is not good enough the list stays as it is.";

/** A short markdown summary of a report (what a person reads first). */
export function renderMarkdown(r: LanguageEvaluationReport): string {
  const lines = [
    `# Language evaluation: ${r.routeKey}`,
    "",
    `Mode: ${r.mode}. Languages: ${r.sourceLanguages.join(", ") || "none"}. Generated ${r.generatedAt}.`,
    "",
    `- Rules kept: ${r.rulesKept}`,
    `- Rules discarded: ${r.discardedTotal}${r.discardedByReason.length > 0 ? ` (${r.discardedByReason.map((d) => `${d.reason}: ${d.count}`).join(", ")})` : ""}`,
    `- Recheck against the stored page, read in the page's language: ${r.recheck.checked} checked, ${r.recheck.withProblems} with problems`,
    r.checker ? `- Independent check: ${r.checker.ran ? `${r.checker.kept} kept, ${r.checker.leftOut} left out, ${r.checker.noVerdict} without a verdict` : "not run"}` : "- Independent check: not available in this mode",
    `- Unofficial translations stored: ${r.translations.stored}`,
    r.usage ? `- Model usage: ${r.usage.requests} requests, ${r.usage.inputTokens} tokens in, ${r.usage.outputTokens} out` : "- Model usage: none (offline)",
    "",
    "Pages:",
    ...r.pages.map((p) => `- ${p.sourceId}: language ${p.language}${p.hasLexicon ? "" : " (NO language data: read strictly)"}, ${p.characters} characters`),
    "",
    `Sample sheet (read these ${SAMPLE_SHEET_SIZE} rules against the official wording and fill in \`humanVerdict\`): ${r.sampleSheetFile}`,
    r.agreement
      ? `Agreement of the check with the human read: ${r.agreement.rate === null ? "nothing decided yet" : `${r.agreement.agree} of ${r.agreement.decided} (${Math.round(r.agreement.rate * 100)}%)`}; the check kept ${r.agreement.checkerKeptHumanRejected} rule(s) the human rejected; it left out ${r.agreement.checkerLeftOutHumanAccepted} the human accepted; ${r.agreement.unsure} unsure, ${r.agreement.blank} blank.`
      : "Agreement: run the script again with --score=<filled sheet> after the human read.",
    "",
    r.note,
    "",
  ];
  return lines.join("\n");
}

/** One page, as the evaluation script holds it. */
export interface EvaluationPage {
  content: GuidanceSnapshotContent;
  language: string | undefined;
}

/** Index every page in its own language (for the recheck). */
export function indexPages(pages: readonly EvaluationPage[]): Map<string, SnapshotQuoteIndex> {
  return new Map(pages.map((p) => [p.content.sourceId, new SnapshotQuoteIndex(p.content, lexiconFor(p.language))]));
}
