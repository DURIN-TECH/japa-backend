import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { bankAccountService } from "../services/bank-account.service";
import { transactionService } from "../services/transaction.service";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  ErrorMessages,
} from "../utils/response";

class BankAccountController {
  /**
   * GET /bank-accounts
   * Get all bank accounts for the authenticated user
   */
  async listAccounts(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const accounts = await bankAccountService.getAccounts(userId);
      sendSuccess(res, accounts);
    } catch (error) {
      console.error("Error listing bank accounts:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /bank-accounts
   * Create a new bank account
   */
  async createAccount(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { accountName, bankName, accountNumber, isMain } = req.body;

      if (!accountName || !bankName || !accountNumber) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "accountName, bankName, and accountNumber are required",
          400
        );
        return;
      }

      const account = await bankAccountService.createAccount(userId, {
        accountName,
        bankName,
        accountNumber,
        isMain,
      });

      sendCreated(res, account, "Bank account created");
    } catch (error) {
      console.error("Error creating bank account:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /bank-accounts/:id
   * Delete a bank account
   */
  async deleteAccount(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      await bankAccountService.deleteAccount(id, userId);
      sendSuccess(res, null, "Bank account deleted");
    } catch (error) {
      const message = (error as Error).message;
      if (message === "Bank account not found") {
        sendNotFound(res, message);
        return;
      }
      if (message === "Not authorized") {
        sendError(res, "FORBIDDEN", message, 403);
        return;
      }
      console.error("Error deleting bank account:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /bank-accounts/:id/main
   * Set a bank account as the main account
   */
  async setMain(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const account = await bankAccountService.setMain(id, userId);
      sendSuccess(res, account, "Main account updated");
    } catch (error) {
      const message = (error as Error).message;
      if (message === "Bank account not found") {
        sendNotFound(res, message);
        return;
      }
      if (message === "Not authorized") {
        sendError(res, "FORBIDDEN", message, 403);
        return;
      }
      console.error("Error setting main account:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /bank-accounts/withdraw
   * Create a withdrawal transaction
   */
  async withdraw(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { bankAccountId, amount } = req.body;

      if (!bankAccountId || !amount || amount <= 0) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "bankAccountId and a positive amount are required",
          400
        );
        return;
      }

      // Verify the bank account belongs to the user
      const accounts = await bankAccountService.getAccounts(userId);
      const account = accounts.find((a) => a.id === bankAccountId);
      if (!account) {
        sendNotFound(res, "Bank account not found");
        return;
      }

      // Check available balance
      const stats = await transactionService.getStatsForAgent(userId);
      if (amount > stats.availableBalance) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "Insufficient balance",
          400
        );
        return;
      }

      // Create withdrawal transaction
      const transaction = await transactionService.createWithdrawal(
        userId,
        amount,
        account
      );

      sendCreated(res, transaction, "Withdrawal initiated");
    } catch (error) {
      console.error("Error processing withdrawal:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const bankAccountController = new BankAccountController();
