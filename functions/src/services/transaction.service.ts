import { collections } from "../utils/firebase";
import { Transaction, TransactionStatus, BankAccount, PaymentRequest } from "../types";
import { Timestamp } from "firebase-admin/firestore";

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
   * Create an escrow release transaction when a payment request is approved.
   * Records the release of held funds to the agent.
   */
  async createEscrowRelease(paymentRequest: PaymentRequest): Promise<Transaction> {
    const ref = collections.transactions.doc();
    const now = Timestamp.now();

    const transaction: Transaction = {
      id: ref.id,
      userId: paymentRequest.clientId,
      agentId: paymentRequest.agentId,
      applicationId: paymentRequest.applicationId,
      type: "escrow_release",
      amount: paymentRequest.amount,
      currency: paymentRequest.currency,
      status: "released",
      isEscrow: false,
      paymentProvider: "manual",
      description: `Escrow release for: ${paymentRequest.description}`,
      metadata: {
        paymentRequestId: paymentRequest.id,
        category: paymentRequest.category,
      },
      createdAt: now,
      updatedAt: now,
    };

    await ref.set(transaction);
    return transaction;
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
