/**
 * One-off migration (issue #148): convert existing `agents.consultationFee`
 * from kobo/cents to WHOLE NAIRA (divide by 100).
 *
 * WHY: the field used to be stored (and documented) as kobo, while agency fees
 * and service prices are whole naira. It is now naira everywhere, and no
 * consumer divides by 100 any more, so un-migrated agents would show a price
 * 100 times too low.
 *
 * THE MARKER: `consultationFeeUnit: "naira"`. The backend now writes it
 * whenever it writes an agent's fee (createAgent, updateAgent, onboarding,
 * invitation acceptance, seeds), and this script writes it on every doc it
 * decides about: converted docs AND docs with no/zero fee (so a first real fee
 * entered later can never be mistaken for kobo). A doc with the marker is never
 * touched again.
 *
 * SAFETY (guards against converting a naira value by mistake):
 *   1. MARKER (above). A re-run after `--apply` converts nothing: every doc it
 *      converted or inspected-as-empty carries the marker, even when its naira
 *      value (5000, 50000...) looks like kobo.
 *   2. CUTOFF: `--cutoff <ISO time>` is mandatory. Pass the moment the #148
 *      backend is deployed to the target project. Agents created at/after it
 *      were written in naira from day one and are skipped; each one is
 *      PRINTED with its id and fee, so a cutoff set too early shows up as a
 *      list of kobo-looking values. A doc with no readable `createdAt` is
 *      skipped and listed for manual review.
 *   3. MULTIPLE-OF-100: a kobo value is always a multiple of 100. A value that
 *      is not is listed for manual review and never guessed.
 *   4. NO STALE WRITES: each doc is converted inside its own transaction that
 *      re-reads the doc and re-decides on the fresh data. A fee edited between
 *      the first read and the write is therefore never overwritten with a
 *      stale /100 value (an edit goes through updateAgent, which sets the
 *      marker, so the fresh read skips it).
 * CANNOT BE TOLD APART: an agent who typed 5000 meaning ₦5,000 BEFORE the
 * deploy (naira by intent, no marker) looks exactly like 5000 kobo = ₦50. Read
 * the dry-run list and question any result under about ₦500 before --apply.
 *
 * NOT MIGRATED: historical `consultations.fee`. Agent-originated bookings
 * (mobile sent `fee * 100`) and guest agency bookings (naira) live in the same
 * collection with no field that tells them apart, so any rule would risk
 * dividing naira bookings by 100. Mobile ignores the stored fee for display,
 * the portal does not render it, and no payment is derived from it. Old agent
 * bookings keep a kobo `fee`; only new bookings are naira.
 *
 * DRY-RUN BY DEFAULT: nothing is written without `--apply`.
 * Target-project guard: shares the #19 guard (prints the resolved project,
 * aborts on mismatch, `--project` is mandatory), worded for THIS script. On top
 * of it: a set FIRESTORE_EMULATOR_HOST aborts unless `--emulator` is passed
 * (a stale variable would otherwise send a "japa-platform" run to the emulator
 * and report success), and finding 0 agents is an error.
 *
 * Run (dry-run):  npm run migrate:agent-fee -- --project <id> --cutoff 2026-11-20T09:00:00Z
 *      (apply):   npm run migrate:agent-fee -- --project <id> --cutoff <ISO> --apply
 * After --apply, confirm one agent doc in the Firebase console (a second
 * dry-run would hit the same place the first run did).
 */
import { enforceBackfillTarget } from "./backfill-news-expire-at-guard";

/** Marker written on every agent doc this script (or the backend) has settled. */
export const FEE_UNIT_MARKER = "naira";

/** What to do with one agent doc, and why. */
export type FeePlan =
  | { action: "convert"; from: number; to: number }
  /** No fee to convert: only the marker is written. */
  | { action: "mark"; reason: "no-fee" }
  | { action: "skip"; reason: "already-migrated" | "created-after-cutoff" }
  | { action: "review"; reason: "no-created-at" | "not-multiple-of-100" | "invalid-fee"; fee?: unknown };

/** The agent fields the decision reads. `createdAtMillis` is null when unreadable. */
export interface AgentFeeInput {
  consultationFee?: unknown;
  consultationFeeUnit?: unknown;
  createdAtMillis: number | null;
}

/**
 * Pure decision for one agent doc. Order matters: the marker comes first, then
 * "nothing to convert" (marked, whatever the creation date), so neither can be
 * reported as a problem.
 */
export function planAgentFee(input: AgentFeeInput, cutoffMillis: number): FeePlan {
  if (input.consultationFeeUnit === FEE_UNIT_MARKER) return { action: "skip", reason: "already-migrated" };
  const fee = input.consultationFee;
  if (fee === undefined || fee === null || fee === 0) return { action: "mark", reason: "no-fee" };
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
  /** Docs given only the marker (no/zero fee). */
  marked: number;
  skipped: Record<string, number>;
  /** Every agent skipped for being created after the cutoff (id + fee), so a too-early cutoff is visible. */
  afterCutoff: Array<{ id: string; fee: unknown }>;
  review: Array<{ id: string; reason: string; fee?: unknown }>;
}

/** The Firestore pieces the migration needs; injectable so tests use the in-memory fake. */
export interface MigrationDeps {
  agents: { get(): Promise<{ docs: Array<{ id: string; ref: any; data(): any }> }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Plan from raw doc data (reads `createdAt` as a Firestore Timestamp when present). */
function planFromData(d: Record<string, any> | undefined, cutoffMillis: number): FeePlan { // eslint-disable-line @typescript-eslint/no-explicit-any
  const created = d?.createdAt;
  return planAgentFee(
    {
      consultationFee: d?.consultationFee,
      consultationFeeUnit: d?.consultationFeeUnit,
      createdAtMillis: created && typeof created.toMillis === "function" ? created.toMillis() : null,
    },
    cutoffMillis
  );
}

/**
 * Walk every agent, print the plan, and (only with `apply`) write each change
 * in its own transaction that re-reads and re-decides on fresh data.
 */
export async function migrateAgentFees(
  cutoffMillis: number,
  apply: boolean,
  injected?: MigrationDeps
): Promise<MigrationCounts> {
  let deps = injected;
  if (!deps) {
    // Lazy import: initialises the Admin SDK, which must happen AFTER the target guard.
    const { db, collections } = await import("../utils/firebase");
    deps = { agents: collections.agents as unknown as MigrationDeps["agents"], runTransaction: (fn) => db.runTransaction(fn) };
  }
  const counts: MigrationCounts = { total: 0, converted: 0, marked: 0, skipped: {}, afterCutoff: [], review: [] };
  const snap = await deps.agents.get();

  for (const doc of snap.docs) {
    counts.total++;
    const first = planFromData(doc.data(), cutoffMillis);

    if (first.action === "skip") {
      counts.skipped[first.reason] = (counts.skipped[first.reason] ?? 0) + 1;
      if (first.reason === "created-after-cutoff") {
        counts.afterCutoff.push({ id: doc.id, fee: doc.data().consultationFee });
      }
      continue;
    }
    if (first.action === "review") {
      counts.review.push({ id: doc.id, reason: first.reason, fee: first.fee });
      continue;
    }

    if (!apply) {
      if (first.action === "convert") {
        counts.converted++;
        console.log(`  would convert agents/${doc.id}: ${first.from} -> ${first.to}`);
      } else {
        counts.marked++;
        console.log(`  would mark agents/${doc.id} as naira (no fee)`);
      }
      continue;
    }

    // Apply: re-read inside a transaction and decide again on the FRESH data, so a
    // fee edited since the listing is never overwritten with a stale value.
    const outcome = await deps.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const plan = planFromData(fresh.exists ? fresh.data() : undefined, cutoffMillis);
      if (plan.action === "convert") {
        tx.update(doc.ref, { consultationFee: plan.to, consultationFeeUnit: FEE_UNIT_MARKER });
      } else if (plan.action === "mark") {
        tx.update(doc.ref, { consultationFeeUnit: FEE_UNIT_MARKER });
      }
      return plan;
    });
    if (outcome.action === "convert") {
      counts.converted++;
      console.log(`  converted agents/${doc.id}: ${outcome.from} -> ${outcome.to}`);
    } else if (outcome.action === "mark") {
      counts.marked++;
      console.log(`  marked agents/${doc.id} as naira (no fee)`);
    } else {
      // Changed under us (edited or already settled): left as the fresh data says.
      const key = `changed-during-run:${outcome.action === "skip" ? outcome.reason : outcome.action}`;
      counts.skipped[key] = (counts.skipped[key] ?? 0) + 1;
      console.log(`  agents/${doc.id} changed during the run, skipped (${key})`);
    }
  }
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
  // A stale FIRESTORE_EMULATOR_HOST would make a "real project" run hit the emulator and report success.
  if (process.env.FIRESTORE_EMULATOR_HOST && !argv.includes("--emulator")) {
    console.error(
      `agent fee migration ABORTED. FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST} is set, so this run would ` +
        "use the emulator, not the project you name. Unset it, or pass --emulator to confirm that is what you want."
    );
    process.exit(1);
  }
  // Guard first: prints the resolved project and exits 1 on mismatch.
  enforceBackfillTarget(argv, process.env, {
    label: "agent fee migration",
    example: "`npm run migrate:agent-fee -- --project <id> --cutoff <ISO time>`",
  });
  console.log(apply ? "APPLY mode: writing changes." : "DRY RUN: nothing is written (pass --apply to write).");
  migrateAgentFees(cutoff, apply)
    .then((c) => {
      console.log(
        `\nagents: ${c.total} total, ${c.converted} ${apply ? "converted" : "to convert"}, ` +
          `${c.marked} ${apply ? "marked" : "to mark"} (no fee)`
      );
      console.log(`skipped: ${JSON.stringify(c.skipped)}`);
      if (c.afterCutoff.length) {
        console.log(`CREATED AFTER CUTOFF (left alone; a kobo-looking value here means the cutoff is too early): ${JSON.stringify(c.afterCutoff)}`);
      }
      if (c.review.length) console.log(`NEEDS MANUAL REVIEW (not touched): ${JSON.stringify(c.review)}`);
      if (c.total === 0) {
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
