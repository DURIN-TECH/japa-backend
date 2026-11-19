/**
 * One-off migration (issue #179): convert every stored agent and agency
 * price from NAIRA to US DOLLARS, once, at one owner-chosen rate.
 *
 * REPLACES `migrate-agent-consultation-fee-to-naira.ts` (#148). Do not run
 * both: this script reads pre-#148 kobo fees directly, so #148's planned
 * production run is not needed any more.
 *
 * WHAT IT CONVERTS (naira -> US cents, written as a Money
 * `{ amountMinor, currency: "USD" }`):
 *   agents/{id}.consultationFee            -> consultationFeeUsd
 *   agencies/{id}.consultationFee          -> consultationFeeUsd
 *   agencies/{id}.services[].price         -> services[].priceUsd
 *   agencies/{id}/visaPrices/{id}.price    -> priceUsd
 * The old naira field (and the agent's #148 `consultationFeeUnit` marker) is
 * REMOVED in the same write, so no doc ever holds two prices. Each converted
 * value leaves an audit under the doc's `migratedFrom` map, keyed by the old
 * field name: `{ amount (whole naira), currency: "NGN", rate, storedValue,
 * storedUnit, migratedAt }` (services: `migratedFrom.services.<serviceId>`).
 *
 * THE RATE: `--rate <naira per USD>` is REQUIRED; there is no built-in
 * number (owner decision: the Central Bank rate on dev on the day the script
 * runs). It must fall in the plausible naira range of the #178 config
 * (200..5000), which catches a slipped decimal. For reference the script
 * prints the rate stored in `exchangeRates/NGN` (provider + any override); it
 * never uses it by itself.
 *
 * ROUNDING: half up to a whole US cent, once, through the money helpers
 * (`convertLocalToUsd`; minor-unit factors from the currency table). No
 * margin: a migration restates a price, it charges nobody.
 *
 * AGENT FEE UNITS (the #148 history, read the same way the old script did):
 *   - `consultationFeeUnit: "naira"` marker            -> whole naira;
 *   - no marker, created AT/AFTER `--cutoff` (the #148 deploy time on that
 *     project)                                          -> whole naira;
 *   - no marker, created BEFORE the cutoff              -> KOBO (pre-#148);
 *   - no marker and no readable `createdAt`             -> manual review.
 * Agency fees, services and visa prices were always whole naira (#144/#103).
 *
 * SAFETY (same guards as the #148 script):
 *   1. `--project` is mandatory and checked by the shared target guard
 *      (prints the resolved project, aborts on mismatch).
 *   2. A set FIRESTORE_EMULATOR_HOST aborts unless `--emulator` is passed.
 *   3. DRY RUN by default: nothing is written without `--apply`; the dry run
 *      prints every change it would make.
 *   4. IDEMPOTENT: a doc whose dollar field is set and whose naira field is
 *      gone is "already migrated" and never touched again, so a second run
 *      changes nothing.
 *   5. NEVER GUESSES: a value that is not a whole number of naira (or of
 *      kobo that makes whole naira), is negative / not a number, is non-zero
 *      but would round to $0.00, or a doc that holds BOTH a naira and a
 *      dollar price, is LISTED for manual review and left exactly as it is.
 *      An agency whose services list has any such entry keeps its whole list
 *      untouched (its fee is decided separately).
 *   6. NO STALE WRITES: each doc is written in its own transaction that
 *      re-reads it and re-decides on the fresh data.
 *   7. Finding 0 agents is an error (wrong project or emulator).
 * Zero stays zero: a 0 (or missing) agent fee becomes $0.00; an agency fee
 * of 0 becomes $0.00; a missing agency fee stays missing.
 *
 * NOT MIGRATED: historical `consultations.fee` rows (they stay naira).
 *
 * Run (dry run):  npm run migrate:prices-usd -- --project <id> --rate <naira per USD> --cutoff <ISO time>
 *      (apply):   npm run migrate:prices-usd -- --project <id> --rate <n> --cutoff <ISO> --apply
 */
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { enforceBackfillTarget } from "./backfill-news-expire-at-guard";
import type { Money, PriceMigrationRecord } from "../types/money";
import { convertLocalToUsd, fromMajor, makeMoney, toMajor } from "../money/money";
import { readStoredUsd } from "../money/usd-price";
import { DEFAULT_CURRENCIES_CONFIG } from "../money/config";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The #148 marker: the agent's fee is whole naira. */
export const NAIRA_MARKER = "naira";

// ============================================
// Pure pieces
// ============================================

/** How a stored naira-side number is read. */
export type StoredUnit = "naira" | "kobo";

/** Why a value is left alone for a human to look at. */
export type ReviewReason =
  | "invalid-value" // not a finite non-negative number
  | "not-whole-naira" // naira with a fraction (e.g. 1234.5)
  | "not-whole-kobo-naira" // kobo that is not a whole number of naira (e.g. 2550)
  | "no-created-at" // agent fee without marker and without a readable createdAt
  | "converts-to-zero" // non-zero naira that rounds to $0.00 at this rate
  | "both-prices" // the doc already has a dollar price AND still a naira one
  | "invalid-dollar-field" // the dollar field exists but is not a valid USD Money
  | "invalid-services"; // the services list is not an array / has an entry that fails

/** The decision for one price value. */
export type PricePlan =
  | { action: "convert"; usd: Money; record: Omit<PriceMigrationRecord, "migratedAt"> }
  | { action: "skip"; reason: "already-migrated" | "no-price" }
  | { action: "review"; reason: ReviewReason; value?: unknown };

/**
 * Convert one naira-side stored number to dollars, or say why not. Pure.
 *
 * @param value the stored number
 * @param unit how to read it (whole naira, or pre-#148 kobo)
 * @param rate naira per 1 USD
 */
export function convertStoredNaira(value: unknown, unit: StoredUnit, rate: number): PricePlan {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { action: "review", reason: "invalid-value", value };
  }
  let ngn: Money;
  if (unit === "naira") {
    // Whole naira only: fromMajor would accept 2 decimals, but a stored
    // naira price with kobo never came from our UI, so it is a human call.
    if (!Number.isInteger(value)) return { action: "review", reason: "not-whole-naira", value };
    ngn = fromMajor(value, "NGN");
  } else {
    // Kobo IS the NGN minor unit: no factor applied by hand.
    if (!Number.isSafeInteger(value)) return { action: "review", reason: "not-whole-kobo-naira", value };
    ngn = makeMoney(value, "NGN");
    // A pre-#148 kobo fee was always whole naira (the UI took naira * 100).
    // Checked on the major-unit text (the currency table did the division).
    const fraction = toMajor(ngn).split(".")[1] ?? "";
    if (/[^0]/.test(fraction)) return { action: "review", reason: "not-whole-kobo-naira", value };
  }
  const usd = convertLocalToUsd(ngn, rate);
  if (ngn.amountMinor > 0 && usd.amountMinor === 0) return { action: "review", reason: "converts-to-zero", value };
  return {
    action: "convert",
    usd,
    record: {
      // Whole naira (major units), e.g. 5000 for ₦5,000, whatever the stored unit.
      amount: Number(toMajor(ngn)),
      currency: "NGN",
      rate,
      storedValue: value,
      storedUnit: unit,
    },
  };
}

/** The agent fields the decision reads. `createdAtMillis` is null when unreadable. */
export interface AgentPriceInput {
  consultationFeeUsd?: unknown;
  consultationFee?: unknown;
  consultationFeeUnit?: unknown;
  createdAtMillis: number | null;
}

/**
 * Decide one agent's fee. Order: an existing dollar field first (idempotency
 * and the "both prices" guard), then "nothing to convert" (-> $0), then the
 * #148 unit rules (see the header).
 */
export function planAgentPrice(input: AgentPriceInput, cutoffMillis: number, rate: number): PricePlan {
  const hasOld =
    (input.consultationFee !== undefined && input.consultationFee !== null) || input.consultationFeeUnit !== undefined;
  if (input.consultationFeeUsd !== undefined) {
    if (!readStoredUsd(input.consultationFeeUsd)) {
      return { action: "review", reason: "invalid-dollar-field", value: input.consultationFeeUsd };
    }
    if (hasOld) return { action: "review", reason: "both-prices", value: input.consultationFee };
    return { action: "skip", reason: "already-migrated" };
  }
  const fee = input.consultationFee;
  // No fee (or 0): the agent starts at $0, like every new agent (issue #179).
  if (fee === undefined || fee === null || fee === 0) return convertStoredNaira(0, "naira", rate);
  if (input.consultationFeeUnit === NAIRA_MARKER) return convertStoredNaira(fee, "naira", rate);
  if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0) {
    return { action: "review", reason: "invalid-value", value: fee };
  }
  if (input.createdAtMillis === null) return { action: "review", reason: "no-created-at", value: fee };
  // Created after the #148 deploy: written in naira from day one.
  if (input.createdAtMillis >= cutoffMillis) return convertStoredNaira(fee, "naira", rate);
  return convertStoredNaira(fee, "kobo", rate);
}

/**
 * Decide one single-price field that was always naira (agency fee, visa
 * price). `oldValue` absent/null = no price (left as it is).
 */
export function planNairaField(dollarValue: unknown, oldValue: unknown, rate: number): PricePlan {
  const hasOld = oldValue !== undefined && oldValue !== null;
  if (dollarValue !== undefined) {
    if (!readStoredUsd(dollarValue)) return { action: "review", reason: "invalid-dollar-field", value: dollarValue };
    if (hasOld) return { action: "review", reason: "both-prices", value: oldValue };
    return { action: "skip", reason: "already-migrated" };
  }
  if (!hasOld) return { action: "skip", reason: "no-price" };
  return convertStoredNaira(oldValue, "naira", rate);
}

/** The decision for an agency's services list. */
export type ServicesPlan =
  | { action: "convert"; services: Array<Record<string, unknown>>; records: Record<string, Omit<PriceMigrationRecord, "migratedAt">> }
  | { action: "skip"; reason: "already-migrated" | "no-price" }
  | { action: "review"; reason: ReviewReason; value?: unknown };

/**
 * Decide an agency's services list as ONE unit: every entry converts, or the
 * whole list is left alone and listed (never half-migrated).
 */
export function planServices(services: unknown, rate: number): ServicesPlan {
  if (services === undefined || services === null) return { action: "skip", reason: "no-price" };
  if (!Array.isArray(services)) return { action: "review", reason: "invalid-services", value: services };
  const out: Array<Record<string, unknown>> = [];
  const records: Record<string, Omit<PriceMigrationRecord, "migratedAt">> = {};
  let converted = 0;
  for (const entry of services as unknown[]) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id) {
      return { action: "review", reason: "invalid-services", value: entry };
    }
    const plan = planNairaField(e.priceUsd, e.price, rate);
    if (plan.action === "review") return { action: "review", reason: plan.reason, value: { serviceId: e.id, value: plan.value } };
    if (plan.action === "skip" && plan.reason === "no-price") {
      // An entry without any price is not something the API ever wrote.
      return { action: "review", reason: "invalid-services", value: { serviceId: e.id } };
    }
    if (plan.action === "convert") {
      if (records[e.id]) return { action: "review", reason: "invalid-services", value: { duplicateServiceId: e.id } };
      // Keep id + name, swap price for priceUsd; drop nothing else silently
      // except the naira `price` itself.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { price: _naira, ...rest } = e;
      out.push({ ...rest, priceUsd: plan.usd });
      records[e.id] = plan.record;
      converted++;
    } else {
      out.push(e); // already a dollar entry
    }
  }
  if (converted === 0) return { action: "skip", reason: "already-migrated" };
  return { action: "convert", services: out, records };
}

/** Parse `--name <v>` / `--name=<v>`; undefined when absent. */
function argValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

/** Parse `--cutoff <ISO>`; millis, or undefined if absent/invalid. */
export function parseCutoffArg(argv: string[]): number | undefined {
  const raw = argValue(argv, "cutoff");
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Parse `--rate <naira per USD>`. Returns the rate, or an error message: it
 * must be a plain positive number inside the #178 plausible naira range, so
 * a slipped decimal (135.39) or an extra digit (13539) is refused.
 */
export function parseRateArg(argv: string[]): { ok: true; rate: number } | { ok: false; message: string } {
  const raw = argValue(argv, "rate");
  if (raw === undefined) return { ok: false, message: "Missing --rate <naira per USD>. There is no built-in rate." };
  if (!/^\d+(\.\d{1,6})?$/.test(raw.trim())) return { ok: false, message: `--rate "${raw}" is not a plain positive number.` };
  const rate = Number(raw);
  const ngn = DEFAULT_CURRENCIES_CONFIG.currencies.NGN;
  const min = ngn.minRate ?? 0;
  const max = ngn.maxRate ?? Number.MAX_SAFE_INTEGER;
  if (!(rate >= min && rate <= max)) {
    return { ok: false, message: `--rate ${rate} is outside the plausible naira range ${min}..${max}. Refusing.` };
  }
  return { ok: true, rate };
}

// ============================================
// The run
// ============================================

/** One line of the manual-review list. */
export interface ReviewItem {
  path: string;
  field: string;
  reason: ReviewReason;
  value?: unknown;
}

/** Totals printed at the end. */
export interface PriceMigrationCounts {
  agents: number;
  agencies: number;
  visaPrices: number;
  /** Prices converted (or, in a dry run, that would be). */
  converted: number;
  /** Skip reasons -> count (already migrated, no price, changed during the run). */
  skipped: Record<string, number>;
  review: ReviewItem[];
}

/** A doc listing as the migration needs it (Admin SDK or the test fake). */
interface DocList {
  get(): Promise<{ docs: Array<{ id: string; ref: any; data(): any }> }>;
}

/** The Firestore pieces the migration needs; injectable so tests use the in-memory fake. */
export interface PriceMigrationDeps {
  agents: DocList;
  agencies: DocList;
  visaPrices: (agencyId: string) => DocList;
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/** Read a Firestore Timestamp as millis, or null. */
function millisOf(v: unknown): number | null {
  return v && typeof (v as Timestamp).toMillis === "function" ? (v as Timestamp).toMillis() : null;
}

/** A field-level change for one doc, computed from its (fresh) data. */
interface DocChange {
  /** Firestore update payload (dotted paths allowed). */
  update: Record<string, unknown>;
  /** Human-readable lines for the log. */
  lines: string[];
  /** Number of prices this change converts. */
  converted: number;
  /** What was left alone and why. */
  review: Array<Omit<ReviewItem, "path">>;
  skipped: string[];
}

/** An empty change. */
const noChange = (): DocChange => ({ update: {}, lines: [], converted: 0, review: [], skipped: [] });

/** Format cents for the log ("$12.34"). */
const usdText = (m: Money) => `$${toMajor(m)}`;

/** Agent doc -> change. */
function agentChange(d: Record<string, any> | undefined, cutoff: number, rate: number, at: Timestamp): DocChange {
  const c = noChange();
  const plan = planAgentPrice(
    {
      consultationFeeUsd: d?.consultationFeeUsd,
      consultationFee: d?.consultationFee,
      consultationFeeUnit: d?.consultationFeeUnit,
      createdAtMillis: millisOf(d?.createdAt),
    },
    cutoff,
    rate
  );
  if (plan.action === "skip") c.skipped.push(`agent:${plan.reason}`);
  else if (plan.action === "review") c.review.push({ field: "consultationFee", reason: plan.reason, value: plan.value });
  else {
    c.update = {
      consultationFeeUsd: plan.usd,
      "migratedFrom.consultationFee": { ...plan.record, migratedAt: at },
      consultationFee: FieldValue.delete(),
      consultationFeeUnit: FieldValue.delete(),
    };
    c.converted = 1;
    c.lines.push(`consultationFee ${plan.record.storedValue} (${plan.record.storedUnit}) -> ${usdText(plan.usd)}`);
  }
  return c;
}

/** Agency doc -> change (fee and services decided separately). */
function agencyChange(d: Record<string, any> | undefined, rate: number, at: Timestamp): DocChange {
  const c = noChange();
  const fee = planNairaField(d?.consultationFeeUsd, d?.consultationFee, rate);
  if (fee.action === "skip") c.skipped.push(`agency-fee:${fee.reason}`);
  else if (fee.action === "review") c.review.push({ field: "consultationFee", reason: fee.reason, value: fee.value });
  else {
    c.update.consultationFeeUsd = fee.usd;
    c.update["migratedFrom.consultationFee"] = { ...fee.record, migratedAt: at };
    c.update.consultationFee = FieldValue.delete();
    c.converted++;
    c.lines.push(`consultationFee ${fee.record.storedValue} naira -> ${usdText(fee.usd)}`);
  }
  const services = planServices(d?.services, rate);
  if (services.action === "skip") c.skipped.push(`agency-services:${services.reason}`);
  else if (services.action === "review") c.review.push({ field: "services", reason: services.reason, value: services.value });
  else {
    c.update.services = services.services;
    // One map write (service ids are not safe as dotted path segments).
    c.update["migratedFrom.services"] = Object.fromEntries(
      Object.entries(services.records).map(([id, r]) => [id, { ...r, migratedAt: at }])
    );
    const n = Object.keys(services.records).length;
    c.converted += n;
    for (const [id, r] of Object.entries(services.records)) {
      const s = services.services.find((x) => x.id === id);
      c.lines.push(`services[${id}].price ${r.storedValue} naira -> ${usdText(s?.priceUsd as Money)}`);
    }
  }
  return c;
}

/** Visa price doc -> change. */
function visaPriceChange(d: Record<string, any> | undefined, rate: number, at: Timestamp): DocChange {
  const c = noChange();
  const plan = planNairaField(d?.priceUsd, d?.price, rate);
  if (plan.action === "skip") c.skipped.push(`visa-price:${plan.reason}`);
  else if (plan.action === "review") c.review.push({ field: "price", reason: plan.reason, value: plan.value });
  else {
    c.update = { priceUsd: plan.usd, "migratedFrom.price": { ...plan.record, migratedAt: at }, price: FieldValue.delete() };
    c.converted = 1;
    c.lines.push(`price ${plan.record.storedValue} naira -> ${usdText(plan.usd)}`);
  }
  return c;
}

/**
 * Walk every agent, agency and agency visa price, print the plan, and (only
 * with `apply`) write each doc's change in its own transaction that re-reads
 * and re-decides on fresh data.
 *
 * @param opts.cutoffMillis the #148 deploy time (agent fee units)
 * @param opts.rate naira per 1 USD (validated by parseRateArg)
 * @param opts.apply write (true) or only report (false)
 */
export async function migratePricesToUsd(
  opts: { cutoffMillis: number; rate: number; apply: boolean; now?: () => Timestamp },
  injected?: PriceMigrationDeps
): Promise<PriceMigrationCounts> {
  let deps = injected;
  if (!deps) {
    // Lazy import: initialises the Admin SDK, which must happen AFTER the target guard.
    const { db, collections, subcollections } = await import("../utils/firebase");
    deps = {
      agents: collections.agents as unknown as DocList,
      agencies: collections.agencies as unknown as DocList,
      visaPrices: (id) => subcollections.agencyVisaPrices(id) as unknown as DocList,
      runTransaction: (fn) => db.runTransaction(fn),
    };
  }
  const at = (opts.now ?? (() => Timestamp.now()))();
  const counts: PriceMigrationCounts = { agents: 0, agencies: 0, visaPrices: 0, converted: 0, skipped: {}, review: [] };

  /** Plan, report and (apply) write one doc. */
  const handle = async (
    doc: { id: string; ref: any; data(): any },
    path: string,
    decide: (d: Record<string, any> | undefined) => DocChange
  ) => {
    const first = decide(doc.data());
    for (const s of first.skipped) counts.skipped[s] = (counts.skipped[s] ?? 0) + 1;
    for (const r of first.review) counts.review.push({ path, ...r });
    if (first.converted === 0) return;

    if (!opts.apply) {
      counts.converted += first.converted;
      for (const l of first.lines) console.log(`  would convert ${path}: ${l}`);
      return;
    }

    // Apply: re-read and decide again on the FRESH data, so a price edited
    // since the listing (now a dollar price) is never overwritten.
    const fresh = await deps!.runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      const change = decide(snap.exists ? snap.data() : undefined);
      if (change.converted > 0) tx.update(doc.ref, change.update);
      return change;
    });
    counts.converted += fresh.converted;
    for (const l of fresh.lines) console.log(`  converted ${path}: ${l}`);
    if (fresh.converted < first.converted) {
      const key = "changed-during-run";
      counts.skipped[key] = (counts.skipped[key] ?? 0) + 1;
      console.log(`  ${path} changed during the run; left as the fresh data says`);
    }
  };

  // ---- Agents ----
  const agents = await deps.agents.get();
  for (const doc of agents.docs) {
    counts.agents++;
    await handle(doc, `agents/${doc.id}`, (d) => agentChange(d, opts.cutoffMillis, opts.rate, at));
  }

  // ---- Agencies, then each agency's visa prices ----
  const agencies = await deps.agencies.get();
  for (const doc of agencies.docs) {
    counts.agencies++;
    await handle(doc, `agencies/${doc.id}`, (d) => agencyChange(d, opts.rate, at));
    const prices = await deps.visaPrices(doc.id).get();
    for (const p of prices.docs) {
      counts.visaPrices++;
      await handle(p, `agencies/${doc.id}/visaPrices/${p.id}`, (d) => visaPriceChange(d, opts.rate, at));
    }
  }
  return counts;
}

/** Print the rate stored in exchangeRates/NGN, for reference only (never used). */
async function printStoredRate(): Promise<void> {
  try {
    const { collections } = await import("../utils/firebase");
    const snap = await collections.exchangeRates.doc("NGN").get();
    if (!snap.exists) {
      console.log("Reference: exchangeRates/NGN does not exist (no stored rate).");
      return;
    }
    const d = snap.data() as Record<string, any>;
    const iso = (t: unknown) => (t && typeof (t as Timestamp).toDate === "function" ? (t as Timestamp).toDate().toISOString() : "n/a");
    console.log(
      `Reference: exchangeRates/NGN provider rate ${d.provider?.rate ?? "n/a"} (source ${d.provider?.source ?? "n/a"}, ` +
        `asOf ${iso(d.provider?.asOf)}, fetchedAt ${iso(d.provider?.fetchedAt)})` +
        (d.override ? `; override ${d.override.rate} until ${iso(d.override.expiresAt)}` : "; no override")
    );
  } catch (e) {
    console.log(`Reference: could not read exchangeRates/NGN (${(e as Error).message}).`);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cutoff = parseCutoffArg(argv);
  if (cutoff === undefined) {
    console.error("Missing/invalid --cutoff <ISO time> (the #148 backend deploy time). Refusing to guess.");
    process.exit(1);
  }
  const rate = parseRateArg(argv);
  if (!rate.ok) {
    console.error(rate.message);
    process.exit(1);
  }
  const apply = argv.includes("--apply");
  // A stale FIRESTORE_EMULATOR_HOST would make a "real project" run hit the emulator and report success.
  if (process.env.FIRESTORE_EMULATOR_HOST && !argv.includes("--emulator")) {
    console.error(
      `price migration ABORTED. FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST} is set, so this run would ` +
        "use the emulator, not the project you name. Unset it, or pass --emulator to confirm that is what you want."
    );
    process.exit(1);
  }
  // Guard first: prints the resolved project and exits 1 on mismatch.
  enforceBackfillTarget(argv, process.env, {
    label: "price migration",
    example: "`npm run migrate:prices-usd -- --project <id> --rate <naira per USD> --cutoff <ISO time>`",
  });
  console.log(apply ? "APPLY mode: writing changes." : "DRY RUN: nothing is written (pass --apply to write).");
  console.log(`Using rate ${rate.rate} naira per USD (from --rate).`);
  printStoredRate()
    .then(() => migratePricesToUsd({ cutoffMillis: cutoff, rate: rate.rate, apply }))
    .then((c) => {
      console.log(
        `\nscanned: ${c.agents} agents, ${c.agencies} agencies, ${c.visaPrices} visa prices; ` +
          `${c.converted} price(s) ${apply ? "converted" : "to convert"}`
      );
      console.log(`skipped: ${JSON.stringify(c.skipped)}`);
      if (c.review.length) console.log(`NEEDS MANUAL REVIEW (not touched): ${JSON.stringify(c.review)}`);
      if (c.agents === 0) {
        console.error("Found 0 agents: wrong project or emulator? Treating as an error.");
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
