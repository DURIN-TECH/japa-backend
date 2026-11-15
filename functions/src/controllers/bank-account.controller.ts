import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { bankAccountService } from "../services/bank-account.service";
import { ROLES } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";
import {
  transactionService,
  InsufficientBalanceError,
} from "../services/transaction.service";
import {
  sendSuccess,
  sendError,
  sendCreated,
  sendNotFound,
  ErrorMessages,
} from "../utils/response";

/**
 * Roles that may ask for a payout (issue #287): the ones that earn money on
 * the platform. Admins are deliberately NOT in the list: an admin has no
 * payout balance of their own. Clients never earn here.
 */
const WITHDRAWAL_ROLES: readonly Role[] = [ROLES.AGENT, ROLES.OWNER];

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
   * Ask for a payout of `amount` (kobo, NGN) into one of the caller's own
   * bank accounts. Writes a pending, manual withdrawal transaction.
   *
   * Body: `{ bankAccountId: string, amount: number }`.
   *
   * Checks, in this order (issue #287). Every refusal writes NOTHING:
   *  1. role: only an agent or an agency owner has a payout balance. A
   *     client, an admin, or a request with no resolved role gets 403
   *     FORBIDDEN. (`verifyAgent` is not used: it lets admins through.)
   *  2. `amount` must be a safe positive INTEGER number of kobo, else 400
   *     VALIDATION_ERROR. A string is refused even when it looks numeric
   *     ("5000"): before #287 `{ amount: "abc" }` was stored and turned the
   *     agent's balance into NaN, after which every withdrawal passed.
   *  3. `bankAccountId` must be a non-empty string, else 400
   *     VALIDATION_ERROR.
   *  4. the bank account must be one of the caller's own, else 404.
   *  5. the amount must not exceed the caller's NGN available balance, else
   *     400 VALIDATION_ERROR "Insufficient balance". This check and the write
   *     run in ONE Firestore transaction
   *     (`transactionService.withdrawWithBalanceCheck`), so two requests sent
   *     at the same time can never both be paid from the same balance.
   *
   * Success: 201 with the transaction (`type: "withdrawal"`,
   * `status: "pending"`, `currency: "NGN"`, `paymentProvider: "manual"`).
   */
  async withdraw(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      // ---- 1. Role: agents and agency owners only (admins refused) ----
      // Fail closed: a missing role is treated as not allowed.
      const role = req.authz?.role;
      if (!role || !WITHDRAWAL_ROLES.includes(role)) {
        sendError(
          res,
          "FORBIDDEN",
          "Only agents and agency owners can withdraw",
          403
        );
        return;
      }

      const userId = req.userId!;
      // `?? {}`: a request with no JSON body is a validation error, not a 500.
      const { bankAccountId, amount } = (req.body ?? {}) as {
        bankAccountId?: unknown;
        amount?: unknown;
      };

      // ---- 2. Amount: a safe positive integer in kobo ----
      // `typeof` first: Number.isSafeInteger is already false for strings,
      // but the explicit check also narrows the type for the calls below.
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "amount must be a positive whole number of kobo",
          400
        );
        return;
      }

      // ---- 3. Bank account id: a non-empty string ----
      if (typeof bankAccountId !== "string" || bankAccountId.trim() === "") {
        sendError(
          res,
          "VALIDATION_ERROR",
          "bankAccountId is required",
          400
        );
        return;
      }

      // ---- 4. The bank account must belong to the caller ----
      const accounts = await bankAccountService.getAccounts(userId);
      const account = accounts.find((a) => a.id === bankAccountId);
      if (!account) {
        sendNotFound(res, "Bank account not found");
        return;
      }

      // ---- 5. Balance check + write, in one Firestore transaction ----
      // The balance compared is the one in WITHDRAWAL_CURRENCY only (#282):
      // revenue in another currency never makes a naira withdrawal possible.
      const transaction = await transactionService.withdrawWithBalanceCheck(
        userId,
        amount,
        account
      );

      sendCreated(res, transaction, "Withdrawal initiated");
    } catch (error) {
      // Thrown inside the transaction, so nothing was written.
      if (error instanceof InsufficientBalanceError) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "Insufficient balance",
          400
        );
        return;
      }
      console.error("Error processing withdrawal:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const bankAccountController = new BankAccountController();
