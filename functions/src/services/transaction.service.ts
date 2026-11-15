import { collections, db } from "../utils/firebase";
import { Transaction, TransactionStatus, BankAccount, PaymentRequest } from "../types";
import { Timestamp } from "firebase-admin/firestore";
import type { Transaction as FirestoreTransaction } from "firebase-admin/firestore";
import type { ChargeSnapshot, CurrencyCode } from "../types/money";
import {
  CurrencyBuckets,
  isPendingIncoming,
  revenueEffect,
  transactionCurrency,
} from "../money/totals";

export interface TransactionFilters {
  status?: TransactionStatus;
  applicationId?: string;
  startDate?: string;
  endDate?: string;
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
   * `totalRevenue` minus the withdrawals (pending, processing or completed)
   * in this currency, never below 0. Withdrawals only ever reduce the
   * balance of their own currency.
   */
  availableBalance: number;
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
    return snapshot.docs.map((doc) => doc.data() as Transaction);
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
        ...snapshot.docs.map((doc) => doc.data() as Transaction)
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
    let query = collections.transactions
      .orderBy("createdAt", "desc") as FirebaseFirestore.Query;

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
  computeStats(transactions: Transaction[]): TransactionStats {
    // Separate running sums per currency for each figure.
    const revenue = new CurrencyBuckets();
    const pending = new CurrencyBuckets();
    const withdrawn = new CurrencyBuckets();
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
    }

    // One row per currency seen, sorted by code (CurrencyBuckets sorts).
    const byCurrency: CurrencyTransactionStats[] = revenue.currencies().map((currency) => ({
      currency,
      totalRevenue: revenue.get(currency),
      pendingPayments: pending.get(currency),
      // Refunds already lowered revenue; withdrawals come off here. The
      // balance is the only figure clamped at 0.
      availableBalance: Math.max(0, revenue.get(currency) - withdrawn.get(currency)),
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
   * The lock only orders one agent's WITHDRAWALS against each other. Incoming
   * payments do not take it: they only ever raise the balance, so a
   * withdrawal that passed the check stays valid.
   *
   * The caller validates `amount` (safe positive integer, kobo) and that
   * `bankAccount` is the agent's own BEFORE calling this.
   *
   * @param agentUserId the agent's (or agency owner's) user uid
   * @param amount safe positive integer in kobo
   * @param bankAccount the caller's own bank account
   * @returns the pending withdrawal that was written
   * @throws InsufficientBalanceError when `amount` exceeds the NGN balance
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
      const stats = this.computeStats(snapshot.docs.map((doc) => doc.data() as Transaction));
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
    }
  ): Transaction {
    return {
      // Snapshot first, so the explicit fields below always win.
      ...(input.snapshot ?? {}),
      id,
      userId: input.clientUserId,
      // Undefined is not a valid Firestore value: only set the agent when known.
      ...(input.agentUserId ? { agentId: input.agentUserId } : {}),
      consultationId: input.consultationId,
      type: "consultation_fee",
      amount: input.amount,
      currency: input.currency,
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

export const transactionService = new TransactionService();
