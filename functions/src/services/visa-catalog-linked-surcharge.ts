import { createHash } from "crypto";
import type {
  ExtractedFeeComponent,
  ExtractedVisa,
  LinkedSurchargeRef,
  SourceAdapterId,
  VisaLinkedSurchargeMeta,
  VisaSourcePage,
} from "../types/visa-catalog";
// Pure adapter contract only (no Firebase): the fetched document shape.
import type { SourceDocument } from "./visa-source-adapters/types";
// Same visa-length cap the validator applies to per-year components.
import { MAX_FEE_YEARS } from "./visa-catalog-extract.service";

// ============================================
// VISA CATALOG — SURCHARGES PUBLISHED ON A LINKED PAGE (issue #69)
// ============================================
//
// The #59 fee rule is "main applicant's application fee + mandatory
// surcharges for the standard visa length". Some route pages only LINK to the
// surcharge instead of printing it: the GOV.UK Student visa page says "You'll
// also have to pay the healthcare surcharge" and links to
// /healthcare-immigration-application/how-much-pay, which holds the £776/year.
// Without this module the scraped Student fee is the application fee only.
//
// How it works (no LLM involved — no extra call and no LLM arithmetic):
//
//   1. COUNTRY-LEVEL CONFIG (LINKED_SURCHARGE_SOURCES below, registry-owned):
//      which page publishes the surcharge, which sections to read, and one
//      regex per rate ("standard", "student") that finds the amount in the
//      page text. The regexes were written against the real page (fixture
//      eval/golden/_linked/healthcare-immigration-application/guide.json).
//   2. ROUTE MARKERS (`linkedSurcharges` on a registry page, set from
//      VISA_SOURCE_OVERRIDES): which routes need it, which rate, and the
//      length to charge (an ASSUMED length for variable-length routes such as
//      Student, or the length EXTRACTED from the route page).
//   3. Once per crawl run the linked page is fetched (LinkedSurchargeCache,
//      through the normal source adapter, so robots / rate limit / host
//      backoff all apply) and parsed in code (parseLinkedSurchargeRates). A
//      rate that is not found THROWS: we never fall back to a remembered or
//      invented amount.
//   4. After extraction, applyLinkedSurcharges() appends a normal per-year
//      surcharge component (rate x years). computeFee() then does the
//      arithmetic exactly as for a surcharge printed on the route page, and
//      the provenance (source URL, verbatim citation, assumed length) is
//      stored in `scrapeMeta.fee.linkedSurcharges`.
//
// Double counting (#73): a route whose OWN page prints the surcharge
// (Skilled Worker, Graduate, Family, Global Talent, ...) is simply not marked.
// As a second guard, applyLinkedSurcharges() never adds a linked surcharge
// when the extractor already returned a surcharge component for the route.
//
// Hash gate: the route's change-detection hash is combined with the linked
// page's hash (linkedGateHash), so a surcharge change re-stages the routes
// that use it even when their own page is unchanged.
//
// Pure module apart from the injected fetch function: importable without
// Firebase Admin (the unit tests and the eval runner use it directly).

// ----- Country-level config -----

/** How to find ONE rate (e.g. the student rate) in the linked page's text. */
export interface LinkedSurchargeRateRule {
  // Matched against the fetched text. Capture group 1 = the amount as printed
  // ("776", "1,035"); thousands separators are stripped in code.
  pattern: RegExp;
  currency: string; // ISO 4217 of the amount, e.g. "GBP"
  description: string; // who pays this rate, for humans / logs
}

/** One surcharge published on its own page (one per country, today only GB). */
export interface LinkedSurchargeSourceConfig {
  id: string; // stable id referenced by route markers, e.g. "gb-ihs"
  countryCode: string; // ISO alpha-2 of the country whose routes use it
  label: string; // component label written on the fee, e.g. "Immigration Health Surcharge"
  // The page that publishes the amounts (fetched through `adapter`).
  url: string;
  adapter: SourceAdapterId;
  // Sections (GOV.UK guide part slugs) holding the amounts.
  includeSections: string[];
  // Rate key -> rule. Every rule must match, or the whole page is rejected
  // (a wording change needs a human to re-check the regexes).
  rates: Record<string, LinkedSurchargeRateRule>;
  // Labels of extractor-DROPPED surcharges (validator "dropped surcharge
  // \"<label>\"" reasons) that this linked surcharge replaces: on a marked
  // route the page's own unprovable IHS line is the same charge, so its
  // "unverified" reason is superseded instead of blocking the fee.
  supersedesDroppedLabel: RegExp;
}

/** GB Immigration Health Surcharge (IHS). */
export const GB_IHS_ID = "gb-ihs";

/**
 * The registry's linked-surcharge config, keyed by id. Re-exported from
 * seed-visa-sources.ts next to the other registry maps.
 *
 * GB IHS — real page text (GOV.UK guide "Pay for UK healthcare as part of your
 * immigration application", part "how-much-pay", recorded 2026-11-10):
 *   "£776 per year for students, their dependants, and those on a Youth
 *    Mobility Scheme visa, for example £1,552 for a 2-year visa"
 *   "£1,035 per year for all other visa and immigration applications, for
 *    example £3,105 for a 3-year visa"
 * The amounts are NOT stored here: they are read from the live page on every
 * crawl run, and the matched line is stored as the citation.
 */
export const LINKED_SURCHARGE_SOURCES: Record<string, LinkedSurchargeSourceConfig> = {
  [GB_IHS_ID]: {
    id: GB_IHS_ID,
    countryCode: "GB",
    label: "Immigration Health Surcharge",
    url: "https://www.gov.uk/healthcare-immigration-application",
    adapter: "govuk-content-api",
    includeSections: ["how-much-pay"],
    rates: {
      // Students (and their dependants) and Youth Mobility Scheme visas.
      student: {
        pattern: /£\s?(\d[\d,]*(?:\.\d+)?) per year for students, their dependants, and those on a Youth Mobility Scheme visa/i,
        currency: "GBP",
        description: "students, their dependants and Youth Mobility Scheme visas",
      },
      // Everyone else.
      standard: {
        pattern: /£\s?(\d[\d,]*(?:\.\d+)?) per year for all other visa and immigration applications/i,
        currency: "GBP",
        description: "all other visa and immigration applications",
      },
    },
    supersedesDroppedLabel: /health/i,
  },
};

// ----- Parsing the linked page (code, never the LLM) -----

/** One rate as read from the live page. */
export interface ResolvedLinkedRate {
  amount: number; // per year, in `currency`
  currency: string;
  citation: string; // the verbatim line of the page that states it
}

/** A linked surcharge page, fetched + parsed for this crawl run. */
export interface ResolvedLinkedSurcharge {
  id: string;
  label: string;
  sourceUrl: string; // the page URL (config.url)
  sourceUpdatedAt?: string; // GOV.UK `updated_at`, when the adapter knows it
  contentHash: string; // hash of the selected text (feeds the routes' hash gate)
  rates: Record<string, ResolvedLinkedRate>;
}

/** Thrown when the linked page can't be used (withdrawn, a rate not found). */
export class LinkedSurchargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedSurchargeError";
  }
}

/**
 * The registry page the adapter fetches for a linked-surcharge config. Same
 * shape as a route page, so the adapter's section selection, robots check and
 * cap apply unchanged.
 */
export function linkedSurchargePage(cfg: LinkedSurchargeSourceConfig): VisaSourcePage {
  return {
    url: cfg.url,
    routeName: cfg.label,
    validation: "text_verified",
    includeSections: [...cfg.includeSections],
  };
}

/**
 * Read every configured rate from a fetched linked page.
 *
 * Each rule's regex must match; the amount is capture group 1 with thousands
 * separators removed, and the citation is the whole text LINE that contains
 * the match (verbatim, trimmed). Throws LinkedSurchargeError on a withdrawn
 * page or when any rate is missing / not a positive number — the caller
 * records it as a page error and the route is NOT extracted with a partial fee.
 */
export function parseLinkedSurchargeRates(
  cfg: LinkedSurchargeSourceConfig,
  doc: SourceDocument
): ResolvedLinkedSurcharge {
  if (doc.withdrawn) {
    throw new LinkedSurchargeError(`linked surcharge page ${cfg.url} is withdrawn`);
  }
  const lines = doc.text.split(/\r?\n/);
  const rates: Record<string, ResolvedLinkedRate> = {};
  for (const [key, rule] of Object.entries(cfg.rates)) {
    const line = lines.find((l) => rule.pattern.test(l));
    const match = line?.match(rule.pattern);
    const amount = match ? Number(match[1].replace(/,/g, "")) : NaN;
    if (!line || !Number.isFinite(amount) || amount <= 0) {
      throw new LinkedSurchargeError(
        `linked surcharge ${cfg.id}: "${key}" rate (${rule.description}) not found on ${cfg.url} — ` +
          "the page wording changed; re-check LINKED_SURCHARGE_SOURCES"
      );
    }
    rates[key] = { amount, currency: rule.currency, citation: line.trim() };
  }
  const resolved: ResolvedLinkedSurcharge = {
    id: cfg.id,
    label: cfg.label,
    sourceUrl: cfg.url,
    contentHash: doc.contentHash,
    rates,
  };
  // Only set when known, so no `undefined` reaches Firestore.
  if (doc.sourceUpdatedAt) resolved.sourceUpdatedAt = doc.sourceUpdatedAt;
  return resolved;
}

// ----- Once-per-run cache -----

/** Fetches the linked page for a config (the crawl wires the source adapter in). */
export type LinkedSurchargeFetcher = (cfg: LinkedSurchargeSourceConfig) => Promise<SourceDocument>;

/** A route marker together with its resolved linked page. */
export interface PageLinkedSurcharge {
  ref: LinkedSurchargeRef;
  resolved: ResolvedLinkedSurcharge;
}

/**
 * Fetch + parse each linked surcharge page AT MOST ONCE per crawl run, however
 * many routes use it. The promise is cached, including a failure: a page that
 * failed (e.g. a 429 from the host) is not requested again in the same run;
 * every route that needs it gets the same error.
 */
export class LinkedSurchargeCache {
  private readonly byId = new Map<string, Promise<ResolvedLinkedSurcharge>>();

  /**
   * @param fetcher fetches the linked page (crawl: the source adapter, behind
   *                the run's host-backoff check)
   * @param sources config map (default: the registry's)
   */
  constructor(
    private readonly fetcher: LinkedSurchargeFetcher,
    private readonly sources: Record<string, LinkedSurchargeSourceConfig> = LINKED_SURCHARGE_SOURCES
  ) {}

  /** The resolved linked page for `id` (fetched on first use). */
  get(id: string): Promise<ResolvedLinkedSurcharge> {
    let pending = this.byId.get(id);
    if (!pending) {
      const cfg = this.sources[id];
      pending = cfg
        ? this.fetcher(cfg).then((doc) => parseLinkedSurchargeRates(cfg, doc))
        : Promise.reject(new LinkedSurchargeError(`unknown linked surcharge "${id}"`));
      this.byId.set(id, pending);
    }
    return pending;
  }

  /**
   * Resolve every linked surcharge a registry page is marked with ([] when the
   * page has none — the common case, no request). Throws the first failure.
   */
  async forPage(page: Pick<VisaSourcePage, "linkedSurcharges">): Promise<PageLinkedSurcharge[]> {
    const refs = Array.isArray(page.linkedSurcharges) ? page.linkedSurcharges : [];
    const out: PageLinkedSurcharge[] = [];
    for (const ref of refs) out.push({ ref, resolved: await this.get(ref.id) });
    return out;
  }
}

// ----- Hash gate -----

/**
 * The change-detection hash of a route page that uses linked surcharges: the
 * page's own hash when it uses none (unchanged behaviour for every other
 * route), else sha256 over the page hash and each linked page's hash (+ the
 * marker, so editing a route's rate/length in the registry re-stages it too).
 */
export function linkedGateHash(pageHash: string, linked: PageLinkedSurcharge[]): string {
  if (linked.length === 0) return pageHash;
  const parts = [pageHash, ...linked.map((l) => `${l.resolved.id}:${l.resolved.contentHash}:${JSON.stringify(l.ref)}`)];
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

// ----- Visa length taken from the extraction ("extracted" mode) -----

// Number words the extractor may write in `validityPeriod`.
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * The visa's standard length in WHOLE years, read in code from the extracted
 * `validityPeriod` ("up to 5 years" -> 5, "two years" -> 2). The LONGEST
 * whole-year duration stated wins (same "longest standard length" rule as the
 * #59 fee). Returns undefined when no whole-year duration is stated, or when
 * a month part is attached to it ("2 years and 9 months": the part-year IHS
 * rules are not modelled, so the fee is left unverified instead of guessed).
 */
export function wholeYearsFromValidity(validityPeriod: string | undefined): number | undefined {
  if (!validityPeriod) return undefined;
  const re = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*years?\b(\s*(?:and|,)?\s*\d+\s*months?)?/gi;
  let best: number | undefined;
  for (const m of validityPeriod.matchAll(re)) {
    if (m[2]) return undefined; // "N years and M months": not a whole number of years
    const raw = m[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (Number.isInteger(n) && n >= 1 && (best === undefined || n > best)) best = n;
  }
  return best;
}

// ----- Applying linked surcharges to one extraction -----

/** What applyLinkedSurcharges() returns: the fee inputs for computeFee(). */
export interface AppliedLinkedSurcharges {
  // The extracted components plus one per-year component per applied surcharge.
  feeComponents: ExtractedFeeComponent[];
  // The extraction's unverified reasons, minus any superseded "dropped
  // surcharge" reason, plus any reason a linked surcharge could not be applied.
  unverifiedReasons: string[];
  // Provenance for scrapeMeta.fee.linkedSurcharges (one per marker).
  meta: VisaLinkedSurchargeMeta[];
}

/**
 * Add the marked linked surcharges to an extraction's fee. Pure; no LLM.
 *
 * Per marker:
 *  - SKIPPED (not added, recorded with `skippedReason`) when the route's own
 *    page already gave a surcharge (the extractor returned a surcharge
 *    component — never double count, #73), or when the page states no fee at
 *    all (feeComponents []: an IHS-only cost would hide the missing
 *    application fee).
 *  - otherwise the rate is taken from the resolved page and `years` from the
 *    marker: `assumed` -> the registry's stated years (variable-length
 *    routes, e.g. Student: 1 year); `extracted` -> wholeYearsFromValidity()
 *    of the extraction. No usable length -> NOT added, and an unverified
 *    reason blocks the fee (no baseCostUsd) rather than under-stating it.
 *  - when applied, an extractor reason `dropped surcharge "<label>"` whose
 *    label matches the config's `supersedesDroppedLabel` is removed: the
 *    linked rate replaces the IHS line the validator could not prove.
 */
export function applyLinkedSurcharges(
  extracted: Pick<ExtractedVisa, "feeComponents" | "feeUnverifiedReasons" | "validityPeriod">,
  linked: PageLinkedSurcharge[],
  sources: Record<string, LinkedSurchargeSourceConfig> = LINKED_SURCHARGE_SOURCES
): AppliedLinkedSurcharges {
  const feeComponents = [...extracted.feeComponents];
  let unverifiedReasons = [...(extracted.feeUnverifiedReasons ?? [])];
  const meta: VisaLinkedSurchargeMeta[] = [];
  // Checked against the EXTRACTED components only (not ones added here).
  const pageHasSurcharge = extracted.feeComponents.some((c) => c.kind === "surcharge");

  for (const { ref, resolved } of linked) {
    const rate = resolved.rates[ref.rate];
    // Provenance common to every outcome (absent optional fields omitted).
    const base: VisaLinkedSurchargeMeta = {
      id: resolved.id,
      label: resolved.label,
      sourceUrl: resolved.sourceUrl,
      sourceContentHash: resolved.contentHash,
      rate: ref.rate,
      lengthBasis: ref.length.mode,
      applied: false,
    };
    if (resolved.sourceUpdatedAt) base.sourceUpdatedAt = resolved.sourceUpdatedAt;
    if (ref.length.mode === "assumed") base.lengthNote = ref.length.note;

    if (!rate) {
      // A marker naming a rate the config doesn't have: registry typo.
      unverifiedReasons.push(`linked surcharge "${resolved.label}": unknown rate "${ref.rate}"`);
      meta.push({ ...base, skippedReason: `unknown rate "${ref.rate}"` });
      continue;
    }
    base.amount = rate.amount;
    base.currency = rate.currency;
    base.citation = rate.citation;

    if (pageHasSurcharge) {
      meta.push({ ...base, skippedReason: "the route page already states a surcharge (not double counted)" });
      continue;
    }
    if (extracted.feeComponents.length === 0) {
      meta.push({ ...base, skippedReason: "the route page states no fee" });
      continue;
    }

    // Visa length to charge.
    const years =
      ref.length.mode === "assumed" ? ref.length.years : wholeYearsFromValidity(extracted.validityPeriod);
    if (years === undefined || !Number.isInteger(years) || years < 1 || years > MAX_FEE_YEARS) {
      const why =
        ref.length.mode === "assumed"
          ? `assumed length ${String(ref.length.years)} is not 1-${MAX_FEE_YEARS} whole years`
          : `no whole-year visa length in validityPeriod ${JSON.stringify(extracted.validityPeriod ?? "")}`;
      unverifiedReasons.push(`linked surcharge "${resolved.label}" not added: ${why}`);
      meta.push({ ...base, skippedReason: why });
      continue;
    }

    feeComponents.push({
      kind: "surcharge",
      label: resolved.label,
      amount: rate.amount,
      currency: rate.currency,
      per: "year",
      years,
    });
    // The page's own unprovable IHS line (dropped by the validator) is the
    // same charge: superseded by the linked rate.
    const cfg = sources[resolved.id];
    if (cfg) {
      unverifiedReasons = unverifiedReasons.filter((r) => {
        const m = r.match(/^dropped surcharge "([^"]*)"/);
        return !(m && cfg.supersedesDroppedLabel.test(m[1]));
      });
    }
    meta.push({ ...base, years, applied: true });
  }
  return { feeComponents, unverifiedReasons, meta };
}
