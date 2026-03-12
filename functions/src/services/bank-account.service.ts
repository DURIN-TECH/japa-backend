import { collections, serverTimestamp } from "../utils/firebase";
import { BankAccount } from "../types";
import { Timestamp } from "firebase-admin/firestore";

export interface CreateBankAccountInput {
  accountName: string;
  bankName: string;
  accountNumber: string;
  isMain?: boolean;
}

class BankAccountService {
  /**
   * Get all bank accounts for a user
   */
  async getAccounts(userId: string): Promise<BankAccount[]> {
    const snapshot = await collections.bankAccounts
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    return snapshot.docs.map((doc) => doc.data() as BankAccount);
  }

  /**
   * Create a new bank account
   */
  async createAccount(
    userId: string,
    input: CreateBankAccountInput
  ): Promise<BankAccount> {
    const ref = collections.bankAccounts.doc();

    // If this is the first account or marked as main, ensure only one main
    if (input.isMain) {
      await this.clearMainFlag(userId);
    }

    const existing = await this.getAccounts(userId);
    const isFirst = existing.length === 0;

    const account: BankAccount = {
      id: ref.id,
      userId,
      accountName: input.accountName,
      bankName: input.bankName,
      accountNumber: input.accountNumber,
      isMain: input.isMain ?? isFirst, // First account is automatically main
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };

    await ref.set(account);
    return account;
  }

  /**
   * Delete a bank account
   */
  async deleteAccount(accountId: string, userId: string): Promise<void> {
    const doc = await collections.bankAccounts.doc(accountId).get();
    if (!doc.exists) {
      throw new Error("Bank account not found");
    }

    const account = doc.data() as BankAccount;
    if (account.userId !== userId) {
      throw new Error("Not authorized");
    }

    await collections.bankAccounts.doc(accountId).delete();
  }

  /**
   * Set an account as the main account
   */
  async setMain(accountId: string, userId: string): Promise<BankAccount> {
    const doc = await collections.bankAccounts.doc(accountId).get();
    if (!doc.exists) {
      throw new Error("Bank account not found");
    }

    const account = doc.data() as BankAccount;
    if (account.userId !== userId) {
      throw new Error("Not authorized");
    }

    await this.clearMainFlag(userId);
    await collections.bankAccounts.doc(accountId).update({
      isMain: true,
      updatedAt: serverTimestamp(),
    });

    return { ...account, isMain: true };
  }

  /**
   * Clear the main flag on all accounts for a user
   */
  private async clearMainFlag(userId: string): Promise<void> {
    const snapshot = await collections.bankAccounts
      .where("userId", "==", userId)
      .where("isMain", "==", true)
      .get();

    const batch = collections.bankAccounts.firestore.batch();
    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { isMain: false, updatedAt: serverTimestamp() });
    });
    await batch.commit();
  }
}

export const bankAccountService = new BankAccountService();
