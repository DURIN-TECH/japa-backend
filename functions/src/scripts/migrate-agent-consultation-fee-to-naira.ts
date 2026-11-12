/**
 * One-off migration (issue #148): convert existing `agents.consultationFee`
 * from kobo/cents to WHOLE NAIRA (divide by 100).
 *
 * WHY: the field used to be stored (and documented) as kobo, while agency fees
 * and service prices are whole naira. It is now naira everywhere, and no
 * consumer divides by 100 any more, so un-migrated agents would show a price
 * 100 times too low.
 *
 * SAFETY (a bare "divide by 100" re-run would corrupt data, so this script
 * has three independent guards against converting twice):
 *   1. MARKER: every converted doc gets `consultationFeeUnit: "naira"`. Docs
 *      that carry it are always skipped, so a second run converts 0 docs.
 *   2. CUTOFF: `--cutoff <ISO time>` is mandatory. Pass the moment the #148
 *      backend is deployed to the target project. Agents created at/after it
 *      were written in naira from day one and are skipped. A doc with no
 *      readable `createdAt` is skipped and listed for manual review.
 *   3. MULTIPLE-OF-100: a kobo value is always a multiple of 100 (whole-naira
 *      prices were entered as 5000_00 etc.). A value that is not is either
 *      already naira with kobo-looking digits or corrupt: skipped and listed
 *      for manual review, never guessed.
 * A value of 0/missing is left alone (nothing to convert).
 * Residual risk: an agent created BEFORE the cutoff whose fee was edited to a
 * naira value after the deploy but before this script runs. Run it as part of
 * the same release (right after the backend deploy) to keep that window empty.
 *
 * NOT MIGRATED: historical `consultations.fee`. Agent-originated bookings
 * (mobile sent `fee * 100`) and guest agency bookings (naira) live in the same
 * collection with no field that tells them apart, so any rule would risk
 * dividing naira bookings by 100. Mobile ignores the stored fee for display
 * ("fees are in kobo but unused"), the portal does not render it, and no
 * payment is derived from it (Paystack amounts are computed at booking time).
 * Old agent bookings therefore keep a kobo `fee`; only new bookings are naira.
 *
 * DRY-RUN BY DEFAULT: nothing is written without `--apply`.
 * Target-project guard: shares the #19 guard (prints the resolved project,
 * aborts on mismatch, `--project` is mandatory).
 *
 * Run (dry-run):  npm run migrate:agent-fee -- --project <id> --cutoff 2026-11-20T09:00:00Z
 *      (apply):   npm run migrate:agent-fee -- --project <id> --cutoff <ISO> --apply
 * Against the emulator: set FIRESTORE_EMULATOR_HOST.
 */
import { enforceBackfillTarget } from "./backfill-news-expire-at-guard";

/** Marker written on every converted agent doc (guard 1). */
export const FEE_UNIT_MARKER = "naira";

/** Firestore allows 500 writes per batch; stay under it. */
const BATCH_SIZE = 400;

/** What to do with one agent doc, and why. */
export type FeePlan =
  | { action: "convert"; from: number; to: number }
  | { action: "skip"; reason: "already-migrated" | "no-fee" | "created-after-cutoff" }
  | { action: "review"; reason: "no-created-at" | "not-multiple-of-100" | "invalid-fee"; fee?: unknown };

/** The agent fields the decision reads. `createdAtMillis` is null when unreadable. */
export interface AgentFeeInput {
  consultationFee?: unknown;
  consultationFeeUnit?: unknown;
  createdAtMillis: number | null;
}

/**
 * Pure decision for one agent doc. Order matters: the marker and the "nothing
 * to convert" cases come first so they can never be reported as problems.
 */
export function planAgentFee(input: AgentFeeInput, cutoffMillis: number): FeePlan {
  if (input.consultationFeeUnit === FEE_UNIT_MARKER) return { action: "skip", reason: "already-migrated" };
  const fee = input.consultationFee;
  if (fee === undefined || fee === null || fee === 0) return { action: "skip", reason: "no-fee" };
  if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0) {
    return { action: "review", reason: "invalid-fee", fee };
  }
  if (input.createdAtMillis === null) return { action: "review", reason: "no-created-at", fee };
  if (input.createdAtMillis >= cutoffMillis) return { action: "skip", reason: "created-after-cutoff" };
  if (!Number.isInteger(fee) || fee % 100 !== 0) return { action: "review", reason: "not-multiple-of-100", fee };
  return { action: "convert", from: fee, to: fee / 100 };
}

/** Parse `--cutoff <ISO>` / `--cutoff=<ISO>`; returns millis or undefined if absent/invalid. */
export function parseCutoffArg(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const raw = a === "--cutoff" ? argv[i + 1] : a.startsWith("--cutoff=") ? a.slice("--cutoff=".length) : undefined;
    if (raw !== undefined) {
      const ms = Date.parse(raw);
      return Number.isNaN(ms) ? undefined : ms;
    }
  }
  return undefined;
}

/** Totals printed at the end. */
export interface MigrationCounts {
  total: number;
  converted: number;
  skipped: Record<string, number>;
  review: Array<{ id: string; reason: string; fee?: unknown }>;
}

/** Walk every agent, print the plan, and (only with `apply`) write converted fees in batches. */
export async function migrateAgentFees(cutoffMillis: number, apply: boolean): Promise<MigrationCounts> {
  // Lazy import: initialises the Admin SDK, which must happen AFTER the target guard.
  const { db, collections } = await import("../utils/firebase");
  const counts: MigrationCounts = { total: 0, converted: 0, skipped: {}, review: [] };
  const snap = await collections.agents.get();
  let batch = db.batch();
  let pending = 0;

  for (const doc of snap.docs) {
    counts.total++;
    const d = doc.data();
    const created = d.createdAt;
    const plan = planAgentFee(
      {
        consultationFee: d.consultationFee,
        consultationFeeUnit: d.consultationFeeUnit,
        createdAtMillis: created && typeof created.toMillis === "function" ? created.toMillis() : null,
      },
      cutoffMillis
    );
    if (plan.action === "skip") {
      counts.skipped[plan.reason] = (counts.skipped[plan.reason] ?? 0) + 1;
    } else if (plan.action === "review") {
      counts.review.push({ id: doc.id, reason: plan.reason, fee: plan.fee });
    } else {
      counts.converted++;
      console.log(`  ${apply ? "convert" : "would convert"} agents/${doc.id}: ${plan.from} -> ${plan.to}`);
      if (apply) {
        batch.update(doc.ref, { consultationFee: plan.to, consultationFeeUnit: FEE_UNIT_MARKER });
        if (++pending >= BATCH_SIZE) {
          await batch.commit();
          batch = db.batch();
          pending = 0;
        }
      }
    }
  }
  if (apply && pending > 0) await batch.commit();
  return counts;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const cutoff = parseCutoffArg(argv);
  if (cutoff === undefined) {
    console.error("Missing/invalid --cutoff <ISO time> (the #148 backend deploy time). Refusing to guess.");
    process.exit(1);
  }
  const apply = argv.includes("--apply");
  // Guard first: prints the resolved project and exits 1 on mismatch.
  enforceBackfillTarget(argv);
  console.log(apply ? "APPLY mode: writing changes." : "DRY RUN: nothing is written (pass --apply to write).");
  migrateAgentFees(cutoff, apply)
    .then((c) => {
      console.log(`\nagents: ${c.total} total, ${c.converted} ${apply ? "converted" : "to convert"}`);
      console.log(`skipped: ${JSON.stringify(c.skipped)}`);
      if (c.review.length) console.log(`NEEDS MANUAL REVIEW (not touched): ${JSON.stringify(c.review)}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
