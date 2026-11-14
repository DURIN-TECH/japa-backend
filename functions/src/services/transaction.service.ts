import { collections } from "../utils/firebase";
import { Transaction, TransactionStatus, BankAccount, PaymentRequest } from "../types";
import { Timestamp } from "firebase-admin/firestore";
import type { ChargeSnapshot } from "../types/money";

export interface TransactionFilters {
  status?: TransactionStatus;
  applicationId?: string;
  startDate?: string;
  endDate?: string;
}

export interface TransactionStats {
  totalRevenue: number;
  pendingPayments: number;
  availableBalance: number;
  pendingClientsCount: number;
}

class TransactionService {
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
   * Compute aggregate stats from a list of transactions.
   */
  computeStats(transactions: Transaction[]): TransactionStats {
    const completedStatuses: TransactionStatus[] = ["completed", "released"];
    const pendingStatuses: TransactionStatus[] = [
      "pending",
      "processing",
      "held_in_escrow",
    ];

    let totalRevenue = 0;
    let pendingPayments = 0;
    const pendingUserIds = new Set<string>();

    for (const txn of transactions) {
      if (completedStatuses.includes(txn.status)) {
        totalRevenue += txn.amount;
      }
      if (pendingStatuses.includes(txn.status)) {
        pendingPayments += txn.amount;
        pendingUserIds.add(txn.userId);
      }
    }

    return {
      totalRevenue,
      pendingPayments,
      availableBalance: totalRevenue,
      pendingClientsCount: pendingUserIds.size,
    };
  }

  /**
   * Convenience: get stats for an agent by userId
   */
  async getStatsForAgent(agentUserId: string): Promise<TransactionStats> {
    const transactions = await this.getTransactionsForAgent(agentUserId);

    // Subtract completed withdrawals from available balance
    const stats = this.computeStats(transactions);
    const withdrawals = transactions
      .filter((t) => t.type === "withdrawal" && (t.status === "completed" || t.status === "processing" || t.status === "pending"))
      .reduce((sum, t) => sum + t.amount, 0);

    stats.availableBalance = Math.max(0, stats.availableBalance - withdrawals);
    return stats;
  }

  /**
   * Create a withdrawal transaction
   */
  async createWithdrawal(
    agentUserId: string,
    amount: number,
    bankAccount: BankAccount
  ): Promise<Transaction> {
    const ref = collections.transactions.doc();
    const now = Timestamp.now();

    const transaction: Transaction = {
      id: ref.id,
      userId: agentUserId,
      agentId: agentUserId,
      type: "withdrawal",
      amount,
      currency: "NGN",
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

    await ref.set(transaction);
    return transaction;
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

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

export const transactionService = new TransactionService();
