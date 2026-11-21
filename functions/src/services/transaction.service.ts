import { collections, db } from "../utils/firebase";
import {
  Transaction,
  TransactionStatus,
  BankAccount,
  PaymentRequest,
  // Issue #317: fee holds and consultation refunds.
  FeeHold,
  // Issue #395: Paystack's fee on a consultation fee.
  PaystackFeeStatus,
  RefundFundedFrom,
  RefundReason,
  // Issue #390: who carries Paystack's fee on a consultation refund.
  PaystackFeeBorneBy,
  RefundHeldReason,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";
import type { Transaction as FirestoreTransaction } from "firebase-admin/firestore";
import type { ChargeSnapshot, CurrencyCode } from "../types/money";
import {
  // Issue #413 (K): the one copy of "what a refund takes off the agent".
  agentReversalOf,
  // Issue #413: an agent adjustment of a resolved refund mismatch.
  agentAdjustmentOf,
  CurrencyBuckets,
  // Issue #354: Paystack-fee debits from the agent.
  isAgentDebit,
  isPendingIncoming,
  isSettled,
  revenueEffect,
  transactionCurrency,
} from "../money/totals";
// Issue #317: a consultation fee is HELD until the meeting has happened.
import { feeHoldStatusAt } from "../money/fee-hold";
// Issue #395: the agent is credited A - Paystack's fee (one shared rule).
import { consultationFeeCredit, PaystackFeeClassification, paystackFeeFields } from "../money/paystack-fee";

export interface TransactionFilters {
  status?: TransactionStatus;
  /**
   * Issue #317: only rows of this type (the admin refund list,
   * `GET /transactions?role=admin&type=refund&status=failed`). Pushed into
   * the Firestore query for the admin scope (composite indexes type+createdAt
   * and type+status+createdAt); applied in memory for the other scopes.
   */
  type?: Transaction["type"];
  /**
   * Issue #395: only consultation fee rows whose Paystack fee stands so
   * (the admin list of unknown fees,
   * `GET /transactions?role=admin&type=consultation_fee&paystackFeeStatus=unknown`).
   * Admin scope only (the controller refuses it for anyone else); pushed into
   * the Firestore query (composite index type + paystackFeeStatus + createdAt).
   */
  paystackFeeStatus?: PaystackFeeStatus;
  applicationId?: string;
  startDate?: string;
  endDate?: string;
}

// ============================================
// Issue #413 (E): admin list filters that Firestore can serve
// ============================================
//
// `getAllTransactions` pushes every equality filter into ONE Firestore query
// ordered by `createdAt` desc (the date range is a range on `createdAt`
// itself, so it needs no extra index field). Firestore answers such a query
// only with a composite index on exactly those equality fields + createdAt;
// without one it throws FAILED_PRECONDITION (a 500). The emulator does not
// enforce indexes, so this list is the contract: every combination here has
// its index in firestore.indexes.json (checked by
// test/transactions/admin-filter-indexes.test.ts), and every other
// combination is refused with 400 VALIDATION_ERROR before any read.

/** The admin list's equality filters, in the order they are named in messages. */
export const ADMIN_EQUALITY_FILTERS = ["type", "paystackFeeStatus", "status", "applicationId"] as const;
/** One admin equality filter. */
export type AdminEqualityFilter = (typeof ADMIN_EQUALITY_FILTERS)[number];

/**
 * Every set of equality filters the admin list serves (each with or without
 * `startDate` / `endDate`). The empty set is the plain list (single-field
 * `createdAt` index, automatic).
 */
export const ADMIN_SUPPORTED_FILTER_SETS: ReadonlyArray<ReadonlyArray<AdminEqualityFilter>> = [
  [],
  ["type"],
  ["status"],
  ["paystackFeeStatus"],
  ["applicationId"],
  ["type", "status"],
  ["type", "paystackFeeStatus"],
  ["paystackFeeStatus", "status"],
  ["type", "paystackFeeStatus", "status"],
  ["applicationId", "status"],
];

/**
 * The equality filters an admin list request uses, in ADMIN_EQUALITY_FILTERS
 * order. Pure.
 */
export function adminEqualityFiltersOf(filters: TransactionFilters | undefined): AdminEqualityFilter[] {
  return ADMIN_EQUALITY_FILTERS.filter((key) => !!filters?.[key]);
}

/**
 * Null when the admin list can serve `filters` with an index, else the 400
 * message naming the unsupported combination (issue #413 E). Pure.
 */
export function unsupportedAdminFilterCombination(filters: TransactionFilters | undefined): string | null {
  const used = adminEqualityFiltersOf(filters);
  const supported = ADMIN_SUPPORTED_FILTER_SETS.some(
    (set) => set.length === used.length && set.every((key) => used.includes(key))
  );
  if (supported) return null;
  return `This combination of filters is not supported: ${used.join(" + ")}. ` +
    `Supported: ${ADMIN_SUPPORTED_FILTER_SETS.filter((set) => set.length > 0).map((set) => set.join(" + ")).join("; ")} ` +
    "(each with or without startDate / endDate).";
}

/**
 * Currency that agent withdrawals are paid out in. Payouts go to a Nigerian
 * bank account (Paystack NGN), so `buildWithdrawal` writes this currency and
 * the withdrawal balance check compares against this currency's balance only.
 */
export const WITHDRAWAL_CURRENCY: CurrencyCode = "NGN";

/**
 * Money stats for ONE currency (issue #282). Every amount is an integer in
 * MINOR units of `currency` (kobo for NGN, cents for USD).
 */
export interface CurrencyTransactionStats {
  /** ISO 4217 code, upper case ("NGN", "USD"). */
  currency: CurrencyCode;
  /**
   * Settled (completed / released) incoming transactions in this currency,
   * minus settled refunds in this currency. Not clamped: may be negative
   * when refunds exceed charges.
   */
  totalRevenue: number;
  /** Sum of pending / processing / held-in-escrow incoming transactions in this currency (refunds and withdrawals excluded). */
  pendingPayments: number;
  /**
   * What the agent may withdraw in this currency (issue #317 changed it):
   * settled incoming money that is NOT a held consultation fee, minus
   * refunds paid from the available balance, minus settled refunds of older
   * kinds, minus withdrawals (pending, processing or completed). MAY BE
   * NEGATIVE (#351 reversal): a refund of an already-released fee is carried
   * forward as money owed, and every withdrawal is refused until it is above
   * zero again. Withdrawals only ever reduce the balance of their own currency.
   */
  availableBalance: number;
  /**
   * Issue #317: consultation fees in this currency that are still HELD
   * (the meeting has not happened yet; see money/fee-hold.ts). Never
   * withdrawable. A fee refunded out of the hold leaves it.
   */
  heldBalance: number;
  /**
   * Issue #395 (orchestrator decision 2026-11-17: admin and platform views
   * show gross, the fee and net side by side). ADMIN stats only
   * (`computeStats(..., { feeBreakdown: true })`): Paystack's fees taken off
   * the consultation fees counted in `totalRevenue`, in this currency.
   * `totalRevenue` is the NET figure; `grossRevenue` = `totalRevenue` +
   * `paystackFees`. A fee row whose fee is unknown is in none of the three.
   */
  paystackFees?: number;
  /**
   * Issue #413 (I), admin stats only: the charged amount A of every settled
   * consultation fee whose Paystack fee is not known yet ("unknown",
   * "set_aside", or bad stored data). Such a row credits nobody (it is in no
   * balance and not in `totalRevenue`) but the client WAS charged A, so it
   * belongs in gross.
   */
  unknownFeeAmount?: number;
  /**
   * Issue #395 / #413 (I), admin stats only: revenue before Paystack's fees.
   * Every settled consultation fee counts its charged amount A here, whatever
   * its Paystack-fee status (known, older full-credit rows, unknown or set
   * aside): `grossRevenue = totalRevenue + paystackFees + unknownFeeAmount`.
   */
  grossRevenue?: number;
}

/**
 * Response of GET /transactions/stats (issue #282). Money is per currency:
 * amounts in different currencies are never summed. `byCurrency` is sorted by
 * currency code and is EMPTY when there are no transactions.
 */
export interface TransactionStats {
  byCurrency: CurrencyTransactionStats[];
  /** Distinct clients with a pending incoming payment (a count, not money). */
  pendingClientsCount: number;
}

/**
 * Statuses of a withdrawal that hold money out of the balance: a completed
 * payout has left, and a pending / processing one is reserved so it cannot
 * be withdrawn twice. A failed withdrawal gives the money back.
 */
const WITHDRAWAL_HOLD_STATUSES: TransactionStatus[] = ["pending", "processing", "completed"];

/**
 * The available balance in one currency from a stats result (0 when that
 * currency has no bucket). Used by the withdrawal check, which only ever
 * compares a withdrawal against the balance of its own currency.
 */
export function availableBalanceIn(stats: TransactionStats, currency: CurrencyCode): number {
  return stats.byCurrency.find((row) => row.currency === currency)?.availableBalance ?? 0;
}

/**
 * Thrown by `withdrawWithBalanceCheck` (issue #287) when the amount asked for
 * is more than the agent's available balance in WITHDRAWAL_CURRENCY at the
 * moment the transaction reads it. Thrown INSIDE the Firestore transaction,
 * so nothing is written. The controller answers 400 "Insufficient balance".
 */
export class InsufficientBalanceError extends Error {
  constructor() {
    super("Insufficient balance");
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Thrown by `withdrawWithBalanceCheck` (issue #354, orchestrator decision
 * 2026-11-16) when the agent's available balance is below zero in ANY
 * currency. A debit in GHS or USD (Paystack's fee on a refunded payment, or a
 * #351 refund of a released fee) must not be dodged by withdrawing naira, so
 * EVERY withdrawal is refused until each currency is back to zero or above.
 * A subclass of InsufficientBalanceError, so any caller that only knows the
 * parent still refuses the withdrawal (fails closed).
 */
export class NegativeBalanceError extends InsufficientBalanceError {
  /** The currency whose available balance is below zero (the first one, by code). */
  readonly currency: CurrencyCode;
  constructor(currency: CurrencyCode) {
    super();
    this.name = "NegativeBalanceError";
    this.currency = currency;
  }
}

/**
 * Whether a stored transaction amount can be summed (issue #287): a safe
 * integer in minor units. A string ("abc", "5000"), a fraction, NaN,
 * Infinity, null or a missing value is NOT usable: adding one to a running
 * sum gives NaN (or a string), which then poisons every figure built on it.
 */
export function isUsableAmount(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isSafeInteger(amount);
}

class TransactionService {
  /**
   * Firestore transaction runner (issue #287). A property, like
   * `visaService.runTransaction`, so unit tests can swap it for the in-memory
   * one (writes buffered until the callback resolves, a throw writes
   * nothing: the same all-or-nothing contract as Firestore).
   */
  runTransaction: <T>(fn: (tx: FirestoreTransaction) => Promise<T>) => Promise<T> = (fn) =>
    db.runTransaction(fn);

  /**
   * The server clock the balances are worked out at (issue #317: whether a
   * consultation fee is still held depends on the time). A property so tests
   * can move it; the caller's clock is never used.
   */
  now: () => Date = () => new Date();

  /**
   * Get transactions where the user is the assigned agent.
   */
  async getTransactionsForAgent(
    agentUserId: string,
    filters?: TransactionFilters
  ): Promise<Transaction[]> {
    let query = collections.transactions
      .where("agentId", "==", agentUserId)
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    // (#317) `type` is applied in memory here (no extra composite index),
    // and so is (#395) `paystackFeeStatus`.
    return snapshot.docs
      .map((doc) => doc.data() as Transaction)
      .filter((txn) => !filters?.type || txn.type === filters.type)
      .filter((txn) => !filters?.paystackFeeStatus || txn.paystackFeeStatus === filters.paystackFeeStatus);
  }

  /**
   * Get the transactions a CLIENT paid: their payment history (issue #292).
   *
   * Who the payer is: every incoming Transaction stores the paying client's
   * user uid in `userId`:
   *  - a consultation booking fee (`buildConsultationFee`: `userId` =
   *    `clientUserId`, type "consultation_fee");
   *  - a payment-request charge (`buildPaymentRequestPayment`: `userId` =
   *    the request's `clientId`, type "escrow_release");
   *  - a refund of either goes back to the same `userId`.
   * So the scope is exactly `userId == clientUserId`. This is the ONLY
   * ownership rule here: nothing is derived from a case, an agency or an
   * agent, so a client can never be handed another client's row.
   *
   * Withdrawals are left out. An agent's payout row (`buildWithdrawal`)
   * also stores the agent's own uid in `userId`, but it is money going OUT
   * to the agent's bank, not a payment the caller made, so it does not
   * belong in a payment history. (It only matters when an agent-side user
   * asks for their own client view; a real client has no withdrawals.)
   *
   * Filters (`status`, `applicationId`, `startDate`, `endDate`) are applied
   * IN MEMORY after the query, unlike the agent-side queries that push them
   * into Firestore. A client has few rows, and this way the query needs one
   * composite index only (`userId` + `createdAt` desc, in
   * firestore.indexes.json) instead of one per filter combination.
   *
   * Money is returned as stored: `amount` in minor units of the row's own
   * `currency`. Nothing is converted or summed here.
   *
   * These are the FULL stored documents (markup, raw rate, agent ids and
   * Paystack references included). They must not be sent to the client as
   * they are: the controller projects each one through
   * `toClientTransaction` (transactions/client-transaction.ts, issue #329).
   *
   * @param clientUserId the paying client's user uid (always the caller's own)
   * @param filters optional list filters, same meaning as for the agent view
   * @returns the client's own transactions, newest first
   */
  async getTransactionsForClient(
    clientUserId: string,
    filters?: TransactionFilters
  ): Promise<Transaction[]> {
    // Fail closed: with no uid there is no payer to scope to. (An empty
    // string must never reach the query as a "match anything" value.)
    if (!clientUserId) return [];

    const snapshot = await collections.transactions
      .where("userId", "==", clientUserId)
      .orderBy("createdAt", "desc")
      .get();

    return snapshot.docs
      .map((doc) => doc.data() as Transaction)
      // Belt and braces: re-check the payer on every row, so a query change
      // (or a fake that ignores a filter) can never leak a stranger's row.
      .filter((txn) => txn.userId === clientUserId)
      // Payouts are not payments the caller made (see above).
      .filter((txn) => txn.type !== "withdrawal")
      // Issue #354: an agent's Paystack-fee debit is the AGENT's money (its
      // `userId` is the agent, so the query above never returns it to a
      // client); filtered again so no future change can show it to one.
      .filter((txn) => txn.type !== "paystack_fee_debit")
      // Issue #413: an agent's adjustment is the agent's money, never the client's.
      .filter((txn) => txn.type !== "refund_adjustment")
      .filter((txn) => this.matchesFilters(txn, filters));
  }

  /**
   * Get all transactions for agents in an agency.
   * Fetches agent userIds first, then queries transactions.
   */
  async getTransactionsForAgency(
    agencyId: string,
    filters?: TransactionFilters
  ): Promise<Transaction[]> {
    // Get all agents in the agency
    const agentSnapshot = await collections.agents
      .where("agencyId", "==", agencyId)
      .get();

    if (agentSnapshot.empty) return [];

    const agentUserIds = agentSnapshot.docs.map(
      (doc) => doc.data().userId as string
    );

    // Firestore `in` supports max 30 values
    const chunks = this.chunkArray(agentUserIds, 30);
    const results: Transaction[] = [];

    for (const chunk of chunks) {
      let query = collections.transactions
        .where("agentId", "in", chunk)
        .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

      query = this.applyFilters(query, filters);
      const snapshot = await query.get();
      results.push(
        ...snapshot.docs
          .map((doc) => doc.data() as Transaction)
          // (#317) `type` is applied in memory here (no extra composite index),
          // and so is (#395) `paystackFeeStatus`.
          .filter((txn) => !filters?.type || txn.type === filters.type)
          .filter((txn) => !filters?.paystackFeeStatus || txn.paystackFeeStatus === filters.paystackFeeStatus)
      );
    }

    // Re-sort since we merged multiple chunks
    results.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
    return results;
  }

  /**
   * Get all transactions (admin only).
   */
  async getAllTransactions(
    filters?: TransactionFilters
  ): Promise<Transaction[]> {
    // Issue #413 (E): never send Firestore a query it has no index for (the
    // controller answers 400 first; this is the second line).
    const unsupported = unsupportedAdminFilterCombination(filters);
    if (unsupported) throw new Error(`getAllTransactions: ${unsupported}`);
    let query = collections.transactions
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

    // (#317) The admin refund list filters by type IN Firestore (indexes
    // transactions(type, createdAt desc) and (type, status, createdAt desc)).
    if (filters?.type) query = query.where("type", "==", filters.type);
    // (#395) The admin list of consultation fees whose Paystack fee is still
    // unknown: index transactions(type, paystackFeeStatus, createdAt desc).
    if (filters?.paystackFeeStatus) query = query.where("paystackFeeStatus", "==", filters.paystackFeeStatus);
    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Transaction);
  }

  /**
   * Get a single transaction by ID.
   */
  async getTransactionById(
    transactionId: string
  ): Promise<Transaction | null> {
    const doc = await collections.transactions.doc(transactionId).get();
    if (!doc.exists) return null;
    return doc.data() as Transaction;
  }

  /**
   * Compute aggregate stats from a list of transactions, PER CURRENCY
   * (issue #282).
   *
   * Rules:
   *  - each transaction lands in the bucket of its own `currency` (a legacy
   *    row with no code counts as NGN); amounts of different currencies are
   *    never added together;
   *  - revenue follows the SHARED rule in money/totals.ts (`revenueEffect`,
   *    also used by analytics): a settled (completed / released) incoming
   *    transaction adds its amount, a settled refund subtracts it, both in
   *    their own currency. `pendingPayments` sums pending / processing /
   *    held-in-escrow incoming transactions (`isPendingIncoming`);
   *  - withdrawals are outflows: they are NOT revenue or pending payments,
   *    and a pending / processing / completed withdrawal is subtracted from
   *    the `availableBalance` of ITS currency only (clamped at 0). Before
   *    #282 a completed withdrawal was counted as revenue and a pending one
   *    as a pending client payment;
   *  - (issue #317) HELD consultation fees: a settled `consultation_fee`
   *    still held at time `at` (`feeHoldStatusAt`) counts in revenue as
   *    before, but in `heldBalance`, NOT in `availableBalance`. A fee refunded
   *    out of the hold (`feeHold.state: "refunded"`) counts in neither
   *    balance, and neither does its refund row (`refundFundedFrom: "hold"`):
   *    the agent never had that money;
   *  - (issue #317) a refund row paid from the AVAILABLE balance
   *    (`refundFundedFrom: "available"`, an admin refund of a released fee)
   *    lowers `availableBalance` from the moment it is written, whatever its
   *    status: the client is owed it. A refund row of an older kind (no
   *    `refundFundedFrom`) lowers it once settled, as before;
   *  - (#351 reversal) `availableBalance` is no longer floored at 0: a
   *    negative figure is money the agent owes, and blocks withdrawals;
   *  - (issue #390) a refund paid from the available balance takes
   *    `agentReversalMinor` off it (what the agent gives back; the client may
   *    get less, Paystack keeping its fee), or `amount` on an older row. A
   *    refund HELD for an admin (`refundHeldReason`, amount 0, no
   *    `refundFundedFrom`, `failed`) counts nowhere;
   *  - (issue #354) a `paystack_fee_debit` lowers `totalRevenue` (shared
   *    `revenueEffect`) and `availableBalance` of its own currency from the
   *    moment it is written, never `heldBalance`, never pending payments;
   *  - (issue #395) a settled `consultation_fee` counts what it CREDITS the
   *    agent: A - Paystack's fee F (`consultationFeeCredit`), in `heldBalance`
   *    while held and in `availableBalance` once released. A fee whose
   *    Paystack fee is unknown (or not less than A) counts in NEITHER
   *    balance, nor in revenue, and releasing the meeting hold does not make
   *    it withdrawable. A legacy fee (no fee status) counts A, as before.
   *    With `opts.feeBreakdown` (admin stats) each row also carries
   *    `paystackFees` and `grossRevenue` (gross, fee and net side by side);
   *  - a currency appears in `byCurrency` as soon as any transaction in it
   *    is seen (even one that adds 0, e.g. a failed charge), so the list is
   *    empty only when there are no transactions at all.
   *
   *  - (issue #287) a stored row whose `amount` is not a safe integer (a
   *    string such as "abc", a fraction, NaN, a missing value) is SKIPPED
   *    whole and logged with its id. Before #287 one such row turned the
   *    sums into NaN (JSON `null`), and `amount > NaN` is always false, so
   *    every later withdrawal passed the balance check. A skipped row adds
   *    nothing anywhere: no revenue, no pending payment, no withdrawal hold,
   *    no pending client and no currency row of its own.
   *
   * Used by GET /transactions/stats for every role, and by the withdrawal
   * balance check (withdrawWithBalanceCheck), so both always agree.
   */
  computeStats(
    transactions: Transaction[],
    at: Date = this.now(),
    /** Issue #395: `feeBreakdown` adds `paystackFees` + `grossRevenue` per currency (admin stats). */
    opts: { feeBreakdown?: boolean } = {}
  ): TransactionStats {
    // Separate running sums per currency for each figure.
    const revenue = new CurrencyBuckets();
    const pending = new CurrencyBuckets();
    const withdrawn = new CurrencyBuckets();
    // Issue #317: the available balance is built on its own (not derived
    // from revenue), because held fees are revenue but not available.
    const available = new CurrencyBuckets();
    const held = new CurrencyBuckets();
    // Issue #395: Paystack's fees taken off the consultation fees counted in
    // revenue (for the admin's gross / fee / net breakdown).
    const paystackFees = new CurrencyBuckets();
    // Issue #413 (I): the charged amount of settled fees whose Paystack fee
    // is not known yet (credited nowhere, but charged: part of gross).
    const unknownFees = new CurrencyBuckets();
    // Distinct paying clients with a pending payment (count, not money).
    const pendingUserIds = new Set<string>();

    for (const txn of transactions) {
      // (#287) Never sum an amount that is not a safe integer: skip the row
      // and say which one, so the bad data can be found and repaired.
      if (!isUsableAmount(txn.amount)) {
        console.warn(
          `computeStats: skipping transaction ${txn.id} with a non-integer amount ` +
            `(type ${typeof txn.amount})`
        );
        continue;
      }

      const currency = transactionCurrency(txn);
      // Give the currency a row even if this transaction adds nothing.
      revenue.touch(currency);

      if (txn.type === "withdrawal") {
        // Outflow: only ever reduces the balance of its own currency.
        if (WITHDRAWAL_HOLD_STATUSES.includes(txn.status)) {
          withdrawn.add(currency, txn.amount);
        }
        continue;
      }

      // Settled charge: +amount; settled refund: -amount; otherwise 0.
      revenue.add(currency, revenueEffect(txn));
      if (isPendingIncoming(txn)) {
        pending.add(currency, txn.amount);
        pendingUserIds.add(txn.userId);
      }

      // ---- Issue #354: Paystack's fee taken from the agent ----
      // Owed from the moment it is written (it is written `completed`), in
      // its own currency, and NOT floored: it may take the available
      // balance below zero, which then blocks every withdrawal. The held
      // balance is never touched (the fee was not paid out of a hold).
      if (isAgentDebit(txn)) {
        available.add(currency, -txn.amount);
        continue;
      }
      // ---- Issue #413: an agent adjustment of a resolved refund mismatch ----
      // Settled when written: a credit raises, a debit lowers the available
      // balance of its currency (may go below zero); never `heldBalance`.
      if (txn.type === "refund_adjustment") {
        available.add(currency, agentAdjustmentOf(txn));
        continue;
      }

      // ---- Issue #317: available vs held ----
      if (txn.type === "refund") {
        if (txn.refundFundedFrom === "unapplied_payment") {
          // Issue #354: a payment that never confirmed its booking, given
          // back. It was never credited, so it is debited from nothing.
          // (Such a row has no agentId, so it is not even in an agent's
          // query; this keeps an all-rows admin total right too.)
        } else if (txn.refundFundedFrom === "mismatch_top_up") {
          // Issue #413: the top-up of a resolved mismatch. The agent already
          // gave the planned amount back on the original row: neutral.
        } else if (txn.refundFundedFrom === "hold") {
          // Paid out of a held fee: that fee is already out of both balances.
        } else if (txn.refundFundedFrom === "available") {
          // A released fee given back: owed from the moment it is written.
          // Issue #390: what comes off the AGENT (`agentReversalMinor`) may
          // differ from what the client gets back (`amount`); rows written
          // before #390 have no such field and use `amount`, as before.
          available.add(currency, -agentReversalOf(txn));
        } else if (isSettled(txn)) {
          // Older refund kinds: as before, once the money has moved.
          available.add(currency, -txn.amount);
        }
        continue;
      }
      if (!isSettled(txn)) continue;
      if (txn.type === "consultation_fee") {
        // Issue #395: the agent's credit is A - Paystack's fee. A fee that
        // cannot be worked out yet credits nothing, held or released.
        const credit = consultationFeeCredit(txn);
        if (credit === null) {
          // Issue #413 (I): credited nobody, but the client paid A. A fee
          // Paystack reported as the whole charge or more is Paystack's (it
          // kept all of A); any other row's fee is still unknown.
          if (txn.paystackFeeStatus === "fee_not_less_than_amount" && typeof txn.paystackFeeMinor === "number") {
            paystackFees.add(currency, txn.amount);
          } else {
            unknownFees.add(currency, txn.amount);
          }
          continue;
        }
        // The fee Paystack kept, for the admin breakdown (0 on a legacy row).
        paystackFees.add(currency, txn.amount - credit);
        const hold = feeHoldStatusAt(txn, at);
        if (hold === "held") held.add(currency, credit);
        else if (hold === "released") available.add(currency, credit);
        // "refunded": given back out of the hold, counted nowhere.
        continue;
      }
      // Any other settled incoming payment is available straight away.
      available.add(currency, txn.amount);
    }

    // One row per currency seen, sorted by code (CurrencyBuckets sorts).
    const byCurrency: CurrencyTransactionStats[] = revenue.currencies().map((currency) => ({
      currency,
      totalRevenue: revenue.get(currency),
      pendingPayments: pending.get(currency),
      // Withdrawals come off here. NOT floored (#351 reversal): below zero is
      // money owed, and the withdrawal check then refuses every amount.
      availableBalance: available.get(currency) - withdrawn.get(currency),
      heldBalance: held.get(currency),
      // Issue #395: admin stats show gross, Paystack's fee and net together.
      ...(opts.feeBreakdown
        ? {
          paystackFees: paystackFees.get(currency),
          unknownFeeAmount: unknownFees.get(currency),
          // Issue #413 (I): every settled consultation fee at its charge A.
          grossRevenue: revenue.get(currency) + paystackFees.get(currency) + unknownFees.get(currency),
        }
        : {}),
    }));

    return { byCurrency, pendingClientsCount: pendingUserIds.size };
  }

  /**
   * Convenience: stats for one agent (by user uid). Withdrawals are already
   * subtracted per currency inside computeStats.
   *
   * NOT what the withdrawal endpoint uses to decide (issue #287): a balance
   * read outside a transaction can be stale by the time the withdrawal is
   * written. `withdrawWithBalanceCheck` re-reads inside its transaction.
   */
  async getStatsForAgent(agentUserId: string): Promise<TransactionStats> {
    const transactions = await this.getTransactionsForAgent(agentUserId);
    return this.computeStats(transactions);
  }

  /**
   * Build (but do not write) a pending withdrawal Transaction: the agent's
   * request to be paid `amount` (kobo) into `bankAccount`. Payouts are done
   * by hand today, hence `paymentProvider: "manual"`.
   *
   * @param id the new transaction's document id
   * @param now the creation time (also `updatedAt`)
   * @param agentUserId the agent's (or owner's) user uid; stored as both the
   *   `userId` and the `agentId`, which is what the balance query filters on
   * @param amount safe positive integer in minor units of WITHDRAWAL_CURRENCY
   * @param bankAccount the caller's own account the money goes to
   */
  buildWithdrawal(
    id: string,
    now: Timestamp,
    agentUserId: string,
    amount: number,
    bankAccount: BankAccount
  ): Transaction {
    return {
      id,
      userId: agentUserId,
      agentId: agentUserId,
      type: "withdrawal",
      amount,
      // Payouts are in naira (minor units = kobo); see WITHDRAWAL_CURRENCY.
      currency: WITHDRAWAL_CURRENCY,
      status: "pending",
      isEscrow: false,
      paymentProvider: "manual",
      description: `Withdrawal to ${bankAccount.bankName} ${bankAccount.accountNumber}`,
      metadata: {
        bankAccountId: bankAccount.id,
        bankAccountName: bankAccount.accountName,
        bankName: bankAccount.bankName,
        accountNumber: bankAccount.accountNumber,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Check the agent's balance and write the withdrawal in ONE Firestore
   * transaction (issue #287). Replaces the old `createWithdrawal`, which
   * wrote without checking; there is deliberately no unchecked way to write
   * a withdrawal any more.
   *
   * Why: before #287 the controller read the balance, then wrote the
   * withdrawal in a separate step. Two requests sent at the same time both
   * read the same balance, both passed, and both were written: the agent was
   * owed twice what they had.
   *
   * How it is made atomic:
   *  1. the transaction first reads the agent's LOCK document
   *     (`withdrawalLocks/{agentUserId}`) and, on success, writes it. Two
   *     withdrawals of one agent therefore always touch the same document,
   *     so Firestore runs them one after the other: the second one is
   *     retried on fresh data and sees the first one's withdrawal. A query
   *     alone is not relied on for this, because a query inside a
   *     transaction does not have to block a concurrent INSERT of a new row;
   *  2. the agent's transactions are read THROUGH the transaction (`tx.get`)
   *     and the balance is computed with the same `computeStats` that
   *     GET /transactions/stats uses, so the check and the screen agree;
   *  3. the balance compared is the one in WITHDRAWAL_CURRENCY only (#282):
   *     revenue in another currency never makes a naira withdrawal possible;
   *  4. if the amount is more than the balance, InsufficientBalanceError is
   *     thrown and NOTHING is written (no withdrawal, no lock). An amount
   *     exactly equal to the balance is allowed.
   *
   * All reads happen before any write, as Firestore requires.
   *
   * The lock orders one agent's WITHDRAWALS against each other, and (issue
   * #317) against consultation REFUNDS: the refund engine writes its refund
   * row under the same lock, so a withdrawal can never spend money that is
   * being refunded. Incoming payments do not take it: they only ever raise
   * the balance, so a withdrawal that passed the check stays valid.
   *
   * The caller validates `amount` (safe positive integer, kobo) and that
   * `bankAccount` is the agent's own BEFORE calling this.
   *
   * @param agentUserId the agent's (or agency owner's) user uid
   * @param amount safe positive integer in kobo
   * @param bankAccount the caller's own bank account
   * @returns the pending withdrawal that was written
   * @throws InsufficientBalanceError when `amount` exceeds the NGN balance
   * @throws NegativeBalanceError (issue #354) when the available balance is
   *   below zero in any currency, whatever the amount
   */
  async withdrawWithBalanceCheck(
    agentUserId: string,
    amount: number,
    bankAccount: BankAccount
  ): Promise<Transaction> {
    // Defence in depth: the controller validates first, but a non-integer
    // amount must never be stored whoever calls this.
    if (!isUsableAmount(amount) || amount <= 0) {
      throw new Error("withdrawWithBalanceCheck: amount must be a safe positive integer");
    }

    // One lock document per agent, keyed by their user uid.
    const lockRef = collections.withdrawalLocks.doc(agentUserId);
    // Same query as getTransactionsForAgent (uses the existing
    // agentId + createdAt index), but read through the transaction below.
    const agentTransactions = collections.transactions
      .where("agentId", "==", agentUserId)
      .orderBy("createdAt", "desc");

    return this.runTransaction(async (tx) => {
      // ---- Reads (before any write) ----
      // The lock read is what makes two withdrawals of one agent conflict.
      const lockSnap = await tx.get(lockRef);
      const snapshot = await tx.get(agentTransactions);

      // ---- Decide (a throw here writes nothing) ----
      // (#317) At the server clock: a consultation fee still held is not in
      // the available balance, so it can never be withdrawn; a negative
      // balance (a refund of a released fee, #351) refuses every amount.
      const stats = this.computeStats(snapshot.docs.map((doc) => doc.data() as Transaction), this.now());
      // (#354) Money owed in ANY currency blocks every withdrawal: a GHS or
      // USD debit cannot be dodged by withdrawing NGN.
      const owing = stats.byCurrency.find((row) => row.availableBalance < 0);
      if (owing) throw new NegativeBalanceError(owing.currency);
      if (amount > availableBalanceIn(stats, WITHDRAWAL_CURRENCY)) {
        throw new InsufficientBalanceError();
      }

      // ---- Writes (both or neither) ----
      const ref = collections.transactions.doc();
      const now = Timestamp.now();
      const transaction = this.buildWithdrawal(ref.id, now, agentUserId, amount, bankAccount);
      tx.set(ref, transaction);
      // Writing the lock is what forces a concurrent withdrawal of the same
      // agent to be retried. The fields are for a human reading the console.
      const previousCount = lockSnap.exists ? Number(lockSnap.data()?.withdrawalCount) || 0 : 0;
      tx.set(lockRef, {
        agentUserId,
        lastWithdrawalId: ref.id,
        withdrawalCount: previousCount + 1,
        // Issue #383: WHEN this instance withdrew, on the balance clock. A
        // refund (on another instance, maybe a slightly different clock)
        // reads it in its own transaction and does not fund itself from a
        // hold this withdrawal may have seen as released.
        lastWithdrawalAt: Timestamp.fromDate(this.now()),
        updatedAt: now,
      });
      return transaction;
    });
  }

  /**
   * Build (but do not write) the Transaction for a PAID payment request
   * (issue #181). Used inside the settlement's Firestore transaction
   * (services/payment-request-settlement.service.ts), which writes it in the
   * SAME commit that flips the request to paid, so a request is never paid
   * without its Transaction and a second settlement never writes a second one.
   *
   * Kept as `type: "escrow_release"` / `status: "released"` (what the
   * settlement wrote before #181), so earnings and dashboards read it as
   * before. What changed:
   *  - `amount` is what Paystack actually charged, in minor units of
   *    `currency` = the request's `chargedCurrency` (a legacy naira request:
   *    its kobo amount with "NGN", as before);
   *  - `snapshot` carries `priceUsdCents` and the rate snapshot (`fxRate`,
   *    `fxRateAsOf`, `fxRateSource`, `fxMarginBps`, `chargedCurrency`,
   *    `chargedAmountMinor`); a legacy request has none;
   *  - `paymentProvider` is "paystack" with the Paystack reference, and
   *    `agentId` is the agent's USER uid (what GET /transactions filters
   *    on), not the agent profile id the old record carried.
   */
  buildPaymentRequestPayment(
    id: string,
    now: Timestamp,
    input: {
      paymentRequest: PaymentRequest;
      /** The requesting agent's user uid (falls back to the profile id when unknown). */
      agentUserId: string;
      /** Minor units of `currency`, like every Transaction.amount. */
      amount: number;
      /** ISO 4217 code of the charge. */
      currency: string;
      /** Paystack transaction reference. */
      reference: string;
      /** The request's charge snapshot (empty for a legacy naira request). */
      snapshot?: Partial<ChargeSnapshot>;
    }
  ): Transaction {
    const pr = input.paymentRequest;
    return {
      // Snapshot first, so the explicit fields below always win.
      ...(input.snapshot ?? {}),
      id,
      userId: pr.clientId,
      agentId: input.agentUserId,
      applicationId: pr.applicationId,
      paymentRequestId: pr.id,
      type: "escrow_release",
      amount: input.amount,
      currency: input.currency,
      status: "released",
      isEscrow: false,
      paymentProvider: "paystack",
      providerTransactionId: input.reference,
      description: `Escrow release for: ${pr.description}`,
      metadata: {
        paymentRequestId: pr.id,
        category: pr.category,
        reference: input.reference,
        agentProfileId: pr.agentId,
      },
      ...(pr.clientName !== undefined ? { clientName: pr.clientName } : {}),
      ...(pr.clientEmail !== undefined ? { clientEmail: pr.clientEmail } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build (but do not write) a completed consultation-fee Transaction
   * (Paystack). Used inside the verify transaction
   * (services/consultation-charge.service.ts `settlePayment`), which writes it
   * in the SAME commit that flips the booking to paid, so a booking is never
   * paid without its transaction and a second verify never writes a second
   * one.
   *
   * Issue #180: `amount` is the booking's `chargedAmountMinor` in
   * `currency` = its `chargedCurrency` (kobo for NGN, as before), and
   * `snapshot` carries `priceUsdCents` and the rate snapshot (`fxRate`,
   * `fxRateAsOf`, `fxRateSource`, `fxMarginBps`, `chargedCurrency`,
   * `chargedAmountMinor`). A LEGACY booking has no snapshot: its naira fee in
   * kobo is recorded with an empty one. The currency is always explicit:
   * there is no naira default here any more.
   *
   * Issue #395: the row also records Paystack's fee for the reference
   * (`paystackFeeMinor`, `paystackFeeStatus`, `agentCreditMinor` = A - F).
   * `amount` stays A. While the fee is unknown the status says so and no fee
   * is stored, and no `paystackFeeResolvedAt` either.
   */
  buildConsultationFee(
    id: string,
    now: Timestamp,
    input: {
      consultationId: string;
      clientUserId: string;
      agentUserId?: string;
      /** Minor units of `currency`, like every Transaction.amount. */
      amount: number;
      /** ISO 4217 code of the charge (the booking's chargedCurrency). */
      currency: string;
      /** Paystack transaction reference. */
      reference: string;
      clientName?: string;
      clientEmail?: string;
      /** The booking's charge snapshot (empty for a legacy naira booking). */
      snapshot?: Partial<ChargeSnapshot>;
      /** Issue #317: the hold on the fee until the meeting has happened (see money/fee-hold.ts). */
      feeHold?: FeeHold;
      /**
       * Issue #395: Paystack's fee for this reference, as classified from
       * Paystack's own report (`classifyPaystackFee`): known, unknown, or
       * not less than the amount. Required: a fee row is never written
       * without saying where Paystack's fee stands (no silent full credit).
       */
      paystackFee: PaystackFeeClassification;
    }
  ): Transaction {
    return {
      // Snapshot first, so the explicit fields below always win.
      ...(input.snapshot ?? {}),
      id,
      // (#317) Held until the meeting has happened; never withdrawable before.
      ...(input.feeHold ? { feeHold: input.feeHold } : {}),
      userId: input.clientUserId,
      // Undefined is not a valid Firestore value: only set the agent when known.
      ...(input.agentUserId ? { agentId: input.agentUserId } : {}),
      consultationId: input.consultationId,
      type: "consultation_fee",
      // A: what the client was charged. Never the net (the client's history,
      // the refund engine's base and Paystack all use this figure).
      amount: input.amount,
      currency: input.currency,
      // Issue #395: Paystack's fee and the agent's credit (A - F), or the
      // "unknown" / "fee_not_less_than_amount" status, stored with the row.
      ...paystackFeeFields(input.amount, input.paystackFee),
      // When and by what the fee was stored (absent while it is unknown).
      ...(input.paystackFee.status !== "unknown"
        ? { paystackFeeResolvedAt: now, paystackFeeResolvedBy: "settle" as const }
        : {}),
      status: "completed",
      isEscrow: false,
      paymentProvider: "paystack",
      providerTransactionId: input.reference,
      description: "Consultation fee",
      metadata: {
        consultationId: input.consultationId,
        reference: input.reference,
      },
      ...(input.clientName !== undefined ? { clientName: input.clientName } : {}),
      ...(input.clientEmail !== undefined ? { clientEmail: input.clientEmail } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build (but do not write) a consultation REFUND Transaction (issue #317).
   * Written by the refund engine (services/consultation-refund.service.ts)
   * inside the Firestore transaction that also updates the booking and
   * takes the agent's withdrawal lock.
   *
   * The `currency` is COPIED from the fee Transaction it refunds, never
   * re-converted. Issue #390: the `amount` sent back is decided by the
   * refund engine's fee rule (`planCancellationRefund`), from the fee's
   * `amount` A and Paystack's fee F, in the same minor units:
   *  - client-caused (`feeBorneBy: "client"`): A - F, with F recorded as
   *    `paystackFeeKeptMinor` (refund + kept = A);
   *  - agent-caused (`feeBorneBy: "agent"`): A, in full.
   * `agentReversalMinor` says what the row takes off the agent (see the
   * Transaction field), and `paystackFeeMinor` the F it was worked out with.
   *
   * `userId` is the client (it shows in their payment history as a refund),
   * `agentId` the agent (it counts in their balance). The row starts
   * `pending`, due for its first Paystack call now.
   *
   * @param id the deterministic doc id (`refundDocId(reference)`)
   * @param now the creation time
   */
  buildConsultationRefund(
    id: string,
    now: Timestamp,
    input: {
      /** The fee Transaction being refunded. */
      fee: Transaction;
      /** The booking's agent user uid (the lock and the balance are keyed by it). */
      agentUserId: string;
      /** The booking id. */
      consultationId: string;
      reason: RefundReason;
      /** Uid of who started the refund. */
      initiatedBy: string;
      fundedFrom: RefundFundedFrom;
      /** #351: how far below zero this takes the available balance (0 when it does not). */
      balanceShortfallMinor: number;
      /** Admin note, when given. */
      note?: string;
      // ---- Issue #390: Paystack's fee ----
      /** What the client gets back: a safe positive integer, at most the fee's `amount`. */
      refundAmountMinor: number;
      /** Who carries Paystack's fee on this refund. */
      feeBorneBy: PaystackFeeBorneBy;
      /** Paystack's fee on the charge (minor units), as the refund was worked out with. */
      paystackFeeMinor: number;
      /** Client-caused only: the part of the charge Paystack kept (refund + kept = the fee's amount). */
      paystackFeeKeptMinor?: number;
      /** What this row takes off the agent (see `Transaction.agentReversalMinor`). */
      agentReversalMinor: number;
      /** The agent's fee debit written with this refund, when there is one. */
      feeDebitId?: string;
    }
  ): Transaction {
    const fee = input.fee;
    // Defence in depth: never a refund of a non-positive amount, of more than
    // was charged, or whose parts do not add up to the charge.
    const refund = input.refundAmountMinor;
    const kept = input.paystackFeeKeptMinor;
    if (!isUsableAmount(refund) || refund <= 0 || refund > fee.amount) {
      throw new Error(`buildConsultationRefund: refund ${refund} is not within the charge ${fee.amount}`);
    }
    if (kept !== undefined && (!isUsableAmount(kept) || kept < 0 || refund + kept !== fee.amount)) {
      throw new Error(`buildConsultationRefund: refund ${refund} + fee kept ${kept} != charge ${fee.amount}`);
    }
    if (!isUsableAmount(input.agentReversalMinor) || input.agentReversalMinor < 0) {
      throw new Error(`buildConsultationRefund: agent reversal ${input.agentReversalMinor} is not a safe integer >= 0`);
    }
    return {
      id,
      userId: fee.userId,
      agentId: input.agentUserId,
      consultationId: input.consultationId,
      type: "refund",
      // Issue #390: what the client gets back, in the fee's currency (minor units).
      amount: refund,
      currency: fee.currency,
      feeBorneBy: input.feeBorneBy,
      paystackFeeMinor: input.paystackFeeMinor,
      ...(kept !== undefined ? { paystackFeeKeptMinor: kept } : {}),
      agentReversalMinor: input.agentReversalMinor,
      ...(input.feeDebitId ? { feeDebitId: input.feeDebitId } : {}),
      status: "pending",
      isEscrow: false,
      paymentProvider: "paystack",
      // The CHARGE's Paystack reference: what POST /refund is called with.
      providerTransactionId: fee.providerTransactionId,
      description: "Refund: consultation fee",
      refundOf: fee.id,
      reason: input.reason,
      initiatedBy: input.initiatedBy,
      ...(input.note ? { refundNote: input.note } : {}),
      refundFundedFrom: input.fundedFrom,
      balanceShortfallMinor: input.balanceShortfallMinor,
      refundAttempts: 0,
      refundProviderCalls: 0,
      refundNextAttemptAt: now,
      metadata: {
        consultationId: input.consultationId,
        reference: fee.providerTransactionId,
      },
      ...(fee.clientName !== undefined ? { clientName: fee.clientName } : {}),
      ...(fee.clientEmail !== undefined ? { clientEmail: fee.clientEmail } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build (but do not write) a consultation refund that is HELD for an admin
   * (issue #390): Paystack's fee on the charge is unknown (or, client-caused,
   * not less than the charge), so who-gets-what cannot be worked out and
   * NOTHING is guessed. Written by the refund engine at the deterministic id
   * `refundDocId(reference)`, in the same Firestore transaction as the
   * booking update, so the booking still cancels and the refund cannot be
   * started twice.
   *
   * The row is `failed` with `refundHeldReason` and `refundLastError` set to
   * the reason, so it is listed in
   * `GET /transactions?role=admin&type=refund&status=failed`. MONEY:
   * `amount` is 0 and there is no `refundFundedFrom`: the row counts in no
   * balance and no revenue (it is never settled), is never sent to Paystack
   * (only `pending` rows are), and no agent debit is written. An admin retry
   * (`POST /consultations/:id/refund`) re-reads the fee and rewrites THIS row
   * under the rule once the fee is known.
   */
  buildHeldConsultationRefund(
    id: string,
    now: Timestamp,
    input: {
      /** The fee Transaction that would be refunded. */
      fee: Transaction;
      agentUserId: string;
      consultationId: string;
      reason: RefundReason;
      initiatedBy: string;
      feeBorneBy: PaystackFeeBorneBy;
      heldReason: RefundHeldReason;
      /** Paystack's fee, when it is known (a client-caused fee >= the charge). */
      paystackFeeMinor?: number;
      note?: string;
    }
  ): Transaction {
    const fee = input.fee;
    return {
      id,
      userId: fee.userId,
      agentId: input.agentUserId,
      consultationId: input.consultationId,
      type: "refund",
      // No figure is guessed while the fee is unknown: 0, and counted nowhere.
      amount: 0,
      currency: fee.currency,
      status: "failed",
      isEscrow: false,
      paymentProvider: "paystack",
      providerTransactionId: fee.providerTransactionId,
      description: "Refund: consultation fee (held: Paystack's fee needed)",
      refundOf: fee.id,
      reason: input.reason,
      initiatedBy: input.initiatedBy,
      ...(input.note ? { refundNote: input.note } : {}),
      feeBorneBy: input.feeBorneBy,
      ...(input.paystackFeeMinor !== undefined ? { paystackFeeMinor: input.paystackFeeMinor } : {}),
      refundHeldReason: input.heldReason,
      refundLastError: input.heldReason,
      refundFailedAt: now,
      refundAttempts: 0,
      refundProviderCalls: 0,
      metadata: {
        consultationId: input.consultationId,
        reference: fee.providerTransactionId,
      },
      ...(fee.clientName !== undefined ? { clientName: fee.clientName } : {}),
      ...(fee.clientEmail !== undefined ? { clientEmail: fee.clientEmail } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build (but do not write) the REFUND Transaction of a payment that could
   * not be applied to its booking (issue #354): a `consultationPaymentExceptions`
   * record. Written by `settlePayment` in the SAME Firestore transaction that
   * records the exception, under the deterministic id `refundDocId(reference)`.
   *
   * MONEY (decision 2026-11-16, Seli never carries Paystack's fee): the
   * `currency` is the exception's, exactly what Paystack charged in, never
   * re-converted. The `amount` is decided by the caller from Paystack's own
   * fee for the reference (`refundAmountMinor`):
   *  - client-caused (`booking_not_payable`, `paid_on_superseded_...`): the
   *    amount charged minus Paystack's fee, with the fee kept recorded as
   *    `paystackFeeKeptMinor` (refunded + kept = charged);
   *  - agent-caused (`paid_for_rescheduled_slot`): the full amount charged
   *    (the agent is debited the fee in a separate row).
   * The refund engine (`processRefund`) sends exactly `amount` to Paystack
   * against the same reference.
   *
   * NOT THE AGENT'S MONEY: no fee Transaction was ever written for such a
   * payment, so nothing was credited to the agent. The row therefore has NO
   * `agentId` (it is in no agent's balance query and takes no withdrawal
   * lock), `refundFundedFrom: "unapplied_payment"` (neutral in computeStats
   * and `revenueEffect`), and no `refundOf`. It links back to the exception
   * by `paymentExceptionId`, so the engine mirrors its status onto the
   * exception, never onto the booking.
   *
   * `userId` is the client (it shows in their payment history as a refund).
   * The row starts `pending`, due for its first Paystack call now.
   */
  buildUnappliedPaymentRefund(
    id: string,
    now: Timestamp,
    input: {
      /** The exception being refunded (its money is what Paystack charged). */
      exception: {
        id: string;
        consultationId: string;
        reference: string;
        amountMinor: number;
        currency: string;
      };
      /** The client's user uid (who paid, and who gets the money back). */
      clientUserId: string;
      /**
       * Minor units of the exception's currency to give back: a safe
       * positive integer, at most `exception.amountMinor`.
       */
      refundAmountMinor: number;
      /**
       * Client-caused refunds only: Paystack's fee kept out of the charge
       * (`amountMinor - refundAmountMinor`). Omitted for agent-caused ones.
       */
      paystackFeeKeptMinor?: number;
      /** Denormalised for the client's history and admin lists, when known. */
      clientName?: string;
      clientEmail?: string;
    }
  ): Transaction {
    const ex = input.exception;
    // Defence in depth: never a refund row of a non-positive amount, of more
    // than was charged, or whose parts do not add up to the charge.
    const refund = input.refundAmountMinor;
    const kept = input.paystackFeeKeptMinor;
    if (!isUsableAmount(refund) || refund <= 0 || refund > ex.amountMinor) {
      throw new Error(`buildUnappliedPaymentRefund: refund ${refund} is not within the charge ${ex.amountMinor}`);
    }
    if (kept !== undefined && (!isUsableAmount(kept) || kept < 0 || refund + kept !== ex.amountMinor)) {
      throw new Error(`buildUnappliedPaymentRefund: refund ${refund} + fee kept ${kept} != charge ${ex.amountMinor}`);
    }
    return {
      id,
      userId: input.clientUserId,
      consultationId: ex.consultationId,
      type: "refund",
      // Minor units of the charged currency (see MONEY above).
      amount: refund,
      currency: ex.currency,
      ...(kept !== undefined ? { paystackFeeKeptMinor: kept } : {}),
      status: "pending",
      isEscrow: false,
      paymentProvider: "paystack",
      // The CHARGE's Paystack reference: what POST /refund is called with.
      providerTransactionId: ex.reference,
      description: "Refund: consultation payment that could not be applied",
      paymentExceptionId: ex.id,
      reason: "payment_not_applied",
      // Started by the system, not by a person.
      initiatedBy: "system",
      refundFundedFrom: "unapplied_payment",
      balanceShortfallMinor: 0,
      refundAttempts: 0,
      refundProviderCalls: 0,
      refundNextAttemptAt: now,
      metadata: {
        consultationId: ex.consultationId,
        reference: ex.reference,
      },
      ...(input.clientName !== undefined ? { clientName: input.clientName } : {}),
      ...(input.clientEmail !== undefined ? { clientEmail: input.clientEmail } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build (but do not write) the DEBIT of Paystack's processing fee from an
   * agent. Issue #390 also writes it for a consultation refund the agent side
   * caused (`refundId`), when the refund's funding path did not already take
   * the fee off the agent; same type, same doc id `feeDebitDocId(reference)`,
   * so one reference is debited at most once across #354 and #390.
   *
   * Issue #354 (decision 2026-11-16): the agent side rescheduled a
   * `pending_payment` booking after its quote lock, the client then paid the
   * old checkout, and that payment is refunded to the client IN FULL.
   * Paystack keeps its fee on a refunded charge; Seli never carries it, so
   * the agent who caused the refund does.
   *
   * Written by the refund-of-an-unapplied-payment path in the SAME Firestore
   * transaction as the exception and the refund row, under the deterministic
   * id `feeDebitDocId(reference)` with `tx.create` (one debit ever per
   * charge), and with the agent's `withdrawalLocks/{agentUid}` lock read and
   * written (#287), so no concurrent withdrawal spends the money.
   *
   * MONEY: `amount` = Paystack's reported fee for that reference, in minor
   * units of the CHARGE currency (never converted). `status: "completed"`:
   * owed from the moment it is written. computeStats / `revenueEffect` take
   * it off the agent's `totalRevenue` and `availableBalance` in that
   * currency (may go below zero); `heldBalance` is untouched.
   *
   * `userId` and `agentId` are the AGENT (it is their money; a client's
   * history query, `userId == client`, never returns it).
   */
  buildPaystackFeeDebit(
    id: string,
    now: Timestamp,
    input: {
      /** The booking's agent (user uid), who is debited. */
      agentUserId: string;
      /** The booking the refunded payment was for. */
      consultationId: string;
      /** The charge's Paystack reference (= the exception's doc id). */
      reference: string;
      /** Paystack's fee on that charge: a safe positive integer of minor units. */
      feeMinor: number;
      /** The charge currency. */
      currency: string;
      /** Issue #354: the unapplied-payment exception it debits for (= the reference). */
      exceptionId?: string;
      /** Issue #390: the consultation refund row it debits for. */
      refundId?: string;
    }
  ): Transaction {
    if (!isUsableAmount(input.feeMinor) || input.feeMinor <= 0) {
      throw new Error(`buildPaystackFeeDebit: fee ${input.feeMinor} must be a safe positive integer`);
    }
    return {
      id,
      userId: input.agentUserId,
      agentId: input.agentUserId,
      consultationId: input.consultationId,
      type: "paystack_fee_debit",
      amount: input.feeMinor,
      currency: input.currency,
      status: "completed",
      isEscrow: false,
      paymentProvider: "paystack",
      // The charge whose fee this is (admin traceability; agents only).
      providerTransactionId: input.reference,
      // What it debits for: an unapplied payment (#354) or a refunded
      // consultation the agent side caused (#390).
      ...(input.exceptionId ? { paymentExceptionId: input.exceptionId } : {}),
      ...(input.refundId ? { refundId: input.refundId } : {}),
      description: input.refundId
        ? "Payment processing fee on a refunded consultation"
        : "Payment processing fee on a refunded payment (consultation rescheduled)",
      initiatedBy: "system",
      metadata: {
        consultationId: input.consultationId,
        reference: input.reference,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  private applyFilters(
    query: FirebaseFirestore.Query,
    filters?: TransactionFilters
  ): FirebaseFirestore.Query {
    if (!filters) return query;

    if (filters.status) {
      query = query.where("status", "==", filters.status);
    }
    if (filters.applicationId) {
      query = query.where("applicationId", "==", filters.applicationId);
    }
    if (filters.startDate) {
      query = query.where(
        "createdAt",
        ">=",
        Timestamp.fromDate(new Date(filters.startDate))
      );
    }
    if (filters.endDate) {
      query = query.where(
        "createdAt",
        "<=",
        Timestamp.fromDate(new Date(filters.endDate))
      );
    }

    return query;
  }

  /**
   * In-memory version of `applyFilters`, for a list that is already loaded
   * (the client view, `getTransactionsForClient`). Same meaning per filter:
   * exact `status`, exact `applicationId`, `createdAt` within
   * [`startDate`, `endDate`] inclusive. A date that does not parse is
   * ignored rather than hiding every row.
   */
  private matchesFilters(txn: Transaction, filters?: TransactionFilters): boolean {
    if (!filters) return true;

    if (filters.status && txn.status !== filters.status) return false;
    // (#317) The type filter, as the other scopes apply it.
    if (filters.type && txn.type !== filters.type) return false;
    // (#395) The Paystack-fee filter, as the other scopes apply it.
    if (filters.paystackFeeStatus && txn.paystackFeeStatus !== filters.paystackFeeStatus) return false;
    if (filters.applicationId && txn.applicationId !== filters.applicationId) return false;

    // Compare by milliseconds: `createdAt` is a Firestore Timestamp.
    const createdMs = txn.createdAt.toMillis();
    if (filters.startDate) {
      const startMs = new Date(filters.startDate).getTime();
      if (!Number.isNaN(startMs) && createdMs < startMs) return false;
    }
    if (filters.endDate) {
      const endMs = new Date(filters.endDate).getTime();
      if (!Number.isNaN(endMs) && createdMs > endMs) return false;
    }

    return true;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

/**
 * Issue #390 / #413 (K): what a refund row takes off the agent. The rule
 * lives in money/totals.ts (one copy, shared with `revenueEffect`); it is
 * re-exported here so existing imports of it from this module keep working.
 */
export { agentReversalOf } from "../money/totals";

export const transactionService = new TransactionService();
