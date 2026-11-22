// ============================================
// Resolving an unknown Paystack fee on a consultation fee (issue #395)
// ============================================
//
// When a paid consultation settles, `settlePayment` stores Paystack's fee
// for the reference on the fee Transaction (the agent is credited A - F).
// When Paystack's report had no well-formed fee in the charge currency the
// row is written `paystackFeeStatus: "unknown"` and is credited NOWHERE. This
// service is how such a row later learns its fee, from Paystack only:
//
//  - the scheduled job (`resolveConsultationPaystackFees` in index.ts, next
//    to `retryConsultationRefunds`, every 15 minutes) looks every unknown row
//    up at Paystack again (`resolveUnknownFees`);
//  - an admin can ask for one row to be looked up again now
//    (`POST /transactions/:id/paystack-fee/refresh`, `refreshFee`). Admins
//    never type a fee in (orchestrator decision 2026-11-17).
//
// IDEMPOTENCY (must hold)
//  - The Paystack call is made OUTSIDE any Firestore transaction. The fee is
//    then stored in ONE transaction that re-reads the row and writes only if
//    it is STILL "unknown". So a known fee is never overwritten, and two
//    refreshes (or the job and a refresh) at once store it once: the second
//    finds it known and writes nothing.
//  - Still unknown after the lookup: nothing is written at all.
//  - A fee of the whole charge or more is stored with status
//    "fee_not_less_than_amount" and still credits nothing (admin list).

import { Timestamp } from "firebase-admin/firestore";
import type { Transaction } from "../types";
import { collections } from "../utils/firebase";
import { chargeRuntime } from "./charge-checkout.service";
import { PaystackTransactionLookup, paystackProvider } from "./billing/paystack.provider";
import { awaitsPaystackFee, classifyPaystackFee, paystackFeeFields } from "../money/paystack-fee";
import type { PaystackFeeResolvedBy } from "../types";

/** The most unknown-fee rows one run of the job looks up. */
export const PAYSTACK_FEE_LOOKUP_BATCH_SIZE = 100;

/**
 * Issue #413 (D): how many scheduled-job lookups that Paystack ANSWERED
 * without a usable fee a row gets before it is set aside
 * (`paystackFeeStatus: "set_aside"`). The job runs every 15 minutes, so 12
 * lookups is about three hours of Paystack saying "no fee". A lookup that
 * failed because Paystack could not be reached does not count (an outage
 * must not set every row aside).
 */
export const PAYSTACK_FEE_MAX_JOB_LOOKUPS = 12;

/**
 * The job's tunables, read at run time (issue #413 D). A property bag so a
 * test can use a small batch without seeding hundreds of rows; production
 * never changes them.
 */
export const paystackFeeJobConfig = {
  batchSize: PAYSTACK_FEE_LOOKUP_BATCH_SIZE,
  maxJobLookups: PAYSTACK_FEE_MAX_JOB_LOOKUPS,
};

/** What storing a looked-up fee did (one row). */
export type FeeResolveOutcome =
  /** No such Transaction, or not a consultation fee. */
  | { kind: "not_found" }
  /** Written before #395 (no fee status): it keeps counting as A; never looked up. */
  | { kind: "not_tracked"; transaction: Transaction }
  /** The fee was already stored (known, or not less than the amount): nothing written. */
  | { kind: "already_resolved"; transaction: Transaction }
  /** Paystack still reports no well-formed fee in the charge currency: nothing written. */
  | { kind: "still_unknown"; transaction: Transaction }
  /** Paystack could not be reached: nothing written. */
  | { kind: "paystack_unavailable"; transaction: Transaction }
  /** The fee is stored now (status "known" or "fee_not_less_than_amount"). */
  | { kind: "resolved"; transaction: Transaction };

/** What one run of the job did. */
export interface FeeLookupRunResult {
  scanned: number;
  resolved: number;
  stillUnknown: number;
  /** Issue #413 (D): rows set aside by this run (out of lookups). */
  setAside: number;
  errors: number;
}

/**
 * The fields that store `lookup`'s fee on an UNKNOWN fee row, or null when
 * the lookup still gives no well-formed fee in the row's currency. Pure.
 * Shared by the job, the admin refresh and the refund engine (#390), which
 * resolves the row's fee in the same transaction as a refund.
 *
 * @param row the fee Transaction (must be "unknown"; the caller checks)
 * @param lookup Paystack's report of the row's reference, or null
 * @param by what is storing it
 * @param now the time it is stored
 */
export function resolvedFeeFields(
  row: Pick<Transaction, "amount" | "currency">,
  lookup: Pick<PaystackTransactionLookup, "fees" | "currency"> | null,
  by: PaystackFeeResolvedBy,
  now: Timestamp
): Partial<Transaction> | null {
  const classified = classifyPaystackFee(row.amount, row.currency, lookup);
  if (classified.status === "unknown") return null;
  return { ...paystackFeeFields(row.amount, classified), paystackFeeResolvedAt: now, paystackFeeResolvedBy: by, updatedAt: now };
}

class PaystackFeeService {
  /**
   * Look one fee row up at Paystack and store its fee if it is still
   * unknown (see the header). Never throws for a Paystack failure.
   *
   * @param transactionId the consultation fee Transaction's id
   * @param by "job" or "admin_refresh" (stored on the row)
   */
  async resolveOne(transactionId: string, by: Extract<PaystackFeeResolvedBy, "job" | "admin_refresh">): Promise<FeeResolveOutcome> {
    const ref = collections.transactions.doc(transactionId);
    // ---- Read first, outside any transaction (the Paystack call is slow) ----
    const snap = await ref.get();
    if (!snap.exists) return { kind: "not_found" };
    const row = snap.data() as Transaction;
    if (row.type !== "consultation_fee") return { kind: "not_found" };
    if (row.paystackFeeStatus === undefined) return { kind: "not_tracked", transaction: row };
    if (!awaitsPaystackFee(row)) return { kind: "already_resolved", transaction: row };
    const reference = row.providerTransactionId;
    if (!reference) {
      // Cannot be looked up: stays unknown (credited nowhere), listed for admins.
      console.error(`[paystack-fee] ${transactionId}: unknown fee but no Paystack reference to look up`);
      return { kind: "still_unknown", transaction: row };
    }

    // ---- Ask Paystack (never inside a transaction) ----
    let lookup: PaystackTransactionLookup | null;
    try {
      lookup = await paystackProvider.getTransactionMetadata(reference);
    } catch (error) {
      console.error(`[paystack-fee] ${transactionId}: Paystack lookup failed; still unknown:`, error);
      return { kind: "paystack_unavailable", transaction: row };
    }
    // Quick exit when Paystack still has no usable fee: nothing is written.
    if (resolvedFeeFields(row, lookup, by, Timestamp.now()) === null) {
      return { kind: "still_unknown", transaction: row };
    }

    // ---- Store it once: re-read, write only if STILL unknown ----
    return chargeRuntime.runTransaction<FeeResolveOutcome>(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return { kind: "not_found" };
      const current = fresh.data() as Transaction;
      // A concurrent refresh, the job or a refund stored it first: never overwritten.
      if (!awaitsPaystackFee(current)) return { kind: "already_resolved", transaction: current };
      const now = Timestamp.fromDate(chargeRuntime.now());
      const fields = resolvedFeeFields(current, lookup, by, now);
      if (!fields) return { kind: "still_unknown", transaction: current };
      tx.update(ref, fields);
      console.warn(
        `[paystack-fee] ${transactionId}: Paystack's fee on ${reference} stored by ${by} ` +
          `(${fields.paystackFeeStatus}, ${fields.paystackFeeMinor} ${current.currency} minor units)`
      );
      return { kind: "resolved", transaction: { ...current, ...fields } as Transaction };
    });
  }

  /**
   * The scheduled job (issue #395): consultation fees whose Paystack fee is
   * still unknown are looked up again.
   *
   * Issue #413 (D): OLDEST `createdAt` first, at most
   * `paystackFeeJobConfig.batchSize` per run (index
   * transactions(paystackFeeStatus, createdAt asc) in firestore.indexes.json).
   * Each lookup Paystack answers without a usable fee counts on the row
   * (`paystackFeeLookupAttempts`); at `maxJobLookups` the row is SET ASIDE
   * (`paystackFeeStatus: "set_aside"`), so the job no longer picks it and a
   * batch of permanently unknown rows can never starve a newer one. A
   * set-aside row counts exactly as an unknown one, is listed for admins
   * (`GET /transactions?role=admin&type=consultation_fee&paystackFeeStatus=set_aside`)
   * and the admin refresh still resolves it.
   * One row's failure never stops the run.
   */
  async resolveUnknownFees(): Promise<FeeLookupRunResult> {
    const result: FeeLookupRunResult = { scanned: 0, resolved: 0, stillUnknown: 0, setAside: 0, errors: 0 };
    const snap = await collections.transactions
      .where("paystackFeeStatus", "==", "unknown")
      .orderBy("createdAt", "asc")
      .limit(paystackFeeJobConfig.batchSize)
      .get();
    result.scanned = snap.size;
    for (const doc of snap.docs) {
      // Belt and braces: only consultation fees are ever looked up.
      if ((doc.data() as Transaction).type !== "consultation_fee") continue;
      try {
        const outcome = await this.resolveOne(doc.id, "job");
        if (outcome.kind === "resolved" || outcome.kind === "already_resolved") result.resolved++;
        else {
          result.stillUnknown++;
          // Only a lookup Paystack ANSWERED counts toward setting it aside.
          if (outcome.kind === "still_unknown" && (await this.countJobLookup(doc.id))) result.setAside++;
        }
      } catch (error) {
        console.error(`[paystack-fee job] ${doc.id} failed:`, error);
        result.errors++;
      }
    }
    return result;
  }

  /**
   * Count one answered job lookup that left a row unknown (issue #413 D),
   * and set the row aside once it has had `maxJobLookups` of them. One
   * transaction that re-reads the row: only a row STILL "unknown" is
   * touched (a refresh or a refund may have resolved it meanwhile).
   *
   * @returns true when this call set the row aside
   */
  private async countJobLookup(transactionId: string): Promise<boolean> {
    const ref = collections.transactions.doc(transactionId);
    return chargeRuntime.runTransaction<boolean>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const row = snap.data() as Transaction;
      if (row.paystackFeeStatus !== "unknown") return false;
      const attempts = (Number(row.paystackFeeLookupAttempts) || 0) + 1;
      const now = Timestamp.fromDate(chargeRuntime.now());
      const setAside = attempts >= paystackFeeJobConfig.maxJobLookups;
      tx.update(ref, {
        paystackFeeLookupAttempts: attempts,
        ...(setAside ? { paystackFeeStatus: "set_aside", paystackFeeSetAsideAt: now } : {}),
        updatedAt: now,
      });
      if (setAside) {
        console.error(
          `[paystack-fee job] ${transactionId}: still no usable fee after ${attempts} lookups; set aside for an admin ` +
            "(credited nowhere, the admin refresh can still resolve it)"
        );
      }
      return setAside;
    });
  }
}

export const paystackFeeService = new PaystackFeeService();
