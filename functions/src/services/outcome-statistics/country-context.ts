import type { OutcomeSourceInfo, OutcomeStatistic } from "../../types/outcome-statistics";
import { loadOutcomeSettings } from "./config";
import { getCurrentStatistic } from "./outcome-statistics.service";

// ============================================
// COUNTRY CONTEXT NOTE (issue #116)
// ============================================
//
// Builds the "country context" note the assessment attaches to a paid review:
// the PUBLISHED grant figures for the applicant's nationality and the route's
// published category, next to the all-nationality figures for the same
// category and period, with the source.
//
// Rules this module enforces:
//  - Every number is read from a stored, imported statistic. If the lookup
//    finds nothing, or the decisions are below the minimum, the result says so
//    and NO figure is produced: nothing is estimated, defaulted or borrowed
//    from a neighbouring nationality.
//  - The text is deterministic template text built from those numbers. No
//    model is called. It states published figures as context. It never states
//    a cause, never gives a probability for the applicant, and never says the
//    applicant is more or less likely to be refused.
//  - The note is context only. It must not feed the readiness band, score or
//    issues; the caller keeps it out of those computations (see the
//    assessment engine, #42).
//  - Generic: the destination, the category key, the label wording and the
//    rubric areas all arrive as INPUT DATA. No branch on a destination, a
//    route or a nationality name/code.

/** A rubric area where extra evidence helps (from rubric data, never chosen here). */
export interface EvidenceArea {
  id: string;
  label: string;
}

/** Everything the builder needs; all of it is data from the rubric/profile. */
export interface CountryContextInput {
  /** Destination country code of the application. */
  destination: string;
  /**
   * The published category the route's statistics come from (the rubric's
   * route-to-category mapping). No mapping -> no note, so the caller does not
   * call without one.
   */
  categoryKey: string;
  /** Wording for the category, from the mapping (e.g. "all visitor visas"). */
  categoryLabel: string;
  /** Applicant's passport country as an ISO 3166-1 alpha-2 code (User.passportCountry). */
  passportCountry: string | null | undefined;
  /** Rubric criteria tagged "extra evidence helps". Listed only when the rate is lower. */
  evidenceAreas?: EvidenceArea[];
}

/** One figure set as shown in the note. */
export interface ContextFigures {
  granted: number;
  refused: number;
  /** Withdrawn, lapsed and any other published outcome; reported, not rated. */
  other: number;
  /** granted + refused */
  decisions: number;
  /** 0..1 */
  grantRate: number;
}

/** Why no note was produced. */
export type CountryContextUnavailableReason =
  | "no_passport_country"
  | "no_data" // nothing imported for this destination / category / nationality
  | "below_minimum"; // too few decisions to show a rate

/** The builder's result. */
export type CountryContextResult =
  | {
      status: "available";
      destination: string;
      categoryKey: string;
      categoryLabel: string;
      nationalityCode: string;
      nationalityName: string;
      period: { label: string; start: string; end: string; quarters: string[] };
      nationality: ContextFigures;
      allNationalities: ContextFigures;
      /** Rubric areas to show; empty unless the nationality's rate is lower than the all-nationality rate. */
      evidenceAreas: EvidenceArea[];
      source: OutcomeSourceInfo & { retrievedAt: string };
      /** Template text, ready to show. */
      text: { headline: string; lines: string[] };
    }
  | {
      status: "unavailable";
      reason: CountryContextUnavailableReason;
      /** Shown only for below_minimum, where the note says there is not enough published data. */
      text?: string;
    };

/** "62.3%" from 0.623..., one decimal. */
export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Thousands separators for counts. */
function formatCount(n: number): string {
  return n.toLocaleString("en-GB");
}

/** Figures from a stored statistic; null when it has no rated decisions. */
function toFigures(s: OutcomeStatistic): ContextFigures | null {
  if (s.grantRate === null || s.decisions <= 0) return null;
  return {
    granted: s.counts.granted,
    refused: s.counts.refused,
    other: s.counts.other,
    decisions: s.decisions,
    grantRate: s.grantRate,
  };
}

/** Passport country as an upper-case alpha-2 code, or null if it is not one. */
export function normalisePassportCountry(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/**
 * Pure: the rubric areas to list. Only when BOTH rates exist and the
 * nationality's rate is lower than the all-nationality rate; otherwise none.
 * The tag (the input list) and this comparison are the only logic.
 */
export function selectEvidenceAreas(
  nationalityRate: number,
  allRate: number,
  areas: EvidenceArea[] | undefined
): EvidenceArea[] {
  return nationalityRate < allRate ? [...(areas ?? [])] : [];
}

/**
 * Pure: the template text for an available note. Wording notes:
 *  - "published figures" and "decisions", never "chance", "likely" or "risk";
 *  - the definition of the rate and the publisher's caveats are always shown;
 *  - the closing line says the figures describe past decisions in general.
 */
export function buildNoteText(args: {
  categoryLabel: string;
  nationalityName: string;
  periodLabel: string;
  nationality: ContextFigures;
  allNationalities: ContextFigures;
  evidenceAreas: EvidenceArea[];
  source: OutcomeSourceInfo;
}): { headline: string; lines: string[] } {
  const { nationality: n, allNationalities: a } = args;
  const lines: string[] = [
    `Decisions on applications recorded under "${args.nationalityName}", ${args.periodLabel}: ` +
      `${formatCount(n.granted)} of ${formatCount(n.decisions)} decisions were grants (${formatPercent(n.grantRate)}).`,
    `Across all nationalities, same visas and period: ` +
      `${formatCount(a.granted)} of ${formatCount(a.decisions)} decisions were grants (${formatPercent(a.grantRate)}).`,
  ];
  if (n.other > 0) {
    lines.push(
      `${formatCount(n.other)} further applications for this nationality ended in another way (for example withdrawn); ` +
        `they are not counted in the percentages.`
    );
  }
  if (args.evidenceAreas.length > 0) {
    lines.push(`Areas where extra supporting evidence can help: ${args.evidenceAreas.map((e) => e.label).join(", ")}.`);
  }
  lines.push(
    "Here a grant rate means grants divided by grants plus refusals. Withdrawn and lapsed applications are left out.",
    ...args.source.caveats,
    "These are published figures about past decisions in general. They say nothing about any individual application, " +
      "including yours.",
    `Source: ${args.source.publisher}, ${args.source.tableNames.join(", ")}, file ${args.source.fileName}` +
      (args.source.releaseLabel ? ` (${args.source.releaseLabel})` : "") +
      `. ${args.source.pageUrl}`
  );
  return { headline: `Published figures for ${args.categoryLabel}`, lines };
}

/**
 * Look up and build the country context for one assessment.
 *
 * Returns "unavailable" (never a guess) when: there is no usable passport
 * country; there is no imported data for the destination / category /
 * nationality (or no all-nationality figure to compare with); or the
 * nationality's decisions are below the configured minimum.
 *
 * Reads only the imported store and the product settings. The caller (the
 * assessment engine) must keep the result out of band / score / issue logic.
 */
export async function buildCountryContext(input: CountryContextInput): Promise<CountryContextResult> {
  const code = normalisePassportCountry(input.passportCountry);
  if (!code) return { status: "unavailable", reason: "no_passport_country" };

  // Nationality figures for this applicant's passport country, and the
  // all-nationality figures for the same category (same release, same period).
  const [nat, all, settings] = await Promise.all([
    getCurrentStatistic(input.destination, input.categoryKey, code),
    getCurrentStatistic(input.destination, input.categoryKey, "ALL"),
    loadOutcomeSettings(),
  ]);
  if (!nat || !all) return { status: "unavailable", reason: "no_data" };
  // Both must come from the same period or the comparison would be wrong.
  if (nat.periodEnd !== all.periodEnd || nat.releaseId !== all.releaseId) {
    return { status: "unavailable", reason: "no_data" };
  }

  const natFigures = toFigures(nat);
  const allFigures = toFigures(all);
  if (!natFigures || !allFigures) return { status: "unavailable", reason: "no_data" };

  // Too few decisions: say so, show no rate.
  if (natFigures.decisions < settings.minDecisions) {
    return {
      status: "unavailable",
      reason: "below_minimum",
      text: "There is not enough published data to show figures for this nationality.",
    };
  }

  const evidenceAreas = selectEvidenceAreas(natFigures.grantRate, allFigures.grantRate, input.evidenceAreas);
  const nationalityName = nat.nationalityName ?? code;
  const text = buildNoteText({
    categoryLabel: input.categoryLabel,
    nationalityName,
    periodLabel: nat.period.label,
    nationality: natFigures,
    allNationalities: allFigures,
    evidenceAreas,
    source: nat.source,
  });

  return {
    status: "available",
    destination: input.destination,
    categoryKey: input.categoryKey,
    categoryLabel: input.categoryLabel,
    nationalityCode: code,
    nationalityName,
    period: { label: nat.period.label, start: nat.period.start, end: nat.period.end, quarters: nat.period.quarters },
    nationality: natFigures,
    allNationalities: allFigures,
    evidenceAreas,
    source: { ...nat.source, retrievedAt: nat.retrievedAt.toDate().toISOString() },
    text,
  };
}
