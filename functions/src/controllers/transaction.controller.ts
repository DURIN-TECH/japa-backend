import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { transactionService, TransactionFilters } from "../services/transaction.service";
import { collections } from "../utils/firebase";
import { Agent } from "../types";
import {
  sendSuccess,
  sendError,
  ErrorMessages,
} from "../utils/response";

export class TransactionController {
  /**
   * GET /transactions?role=agent|owner|admin&status=...&applicationId=...&startDate=...&endDate=...
   */
  async getTransactions(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const role = (req.query.role as string) || "agent";

      const filters: TransactionFilters = {
        status: req.query.status as TransactionFilters["status"],
        applicationId: req.query.applicationId as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
      };

      let transactions;

      switch (role) {
      case "admin": {
        if (!req.user?.admin) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        transactions = await transactionService.getAllTransactions(filters);
        break;
      }
      case "owner": {
        const agent = await this.getAgentForUser(userId);
        if (!agent?.agencyId || agent.agencyRole !== "owner") {
          sendError(
            res,
            "FORBIDDEN",
            "Only agency owners can view agency transactions",
            403
          );
          return;
        }
        transactions = await transactionService.getTransactionsForAgency(
          agent.agencyId,
          filters
        );
        break;
      }
      case "agent":
      default: {
        transactions = await transactionService.getTransactionsForAgent(
          userId,
          filters
        );
        break;
      }
      }

      sendSuccess(res, transactions);
    } catch (error) {
      console.error("Error getting transactions:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /transactions/stats?role=agent|owner|admin
   */
  async getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const role = (req.query.role as string) || "agent";

      let transactions;

      switch (role) {
      case "admin": {
        if (!req.user?.admin) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        transactions = await transactionService.getAllTransactions();
        break;
      }
      case "owner": {
        const agent = await this.getAgentForUser(userId);
        if (!agent?.agencyId || agent.agencyRole !== "owner") {
          sendError(
            res,
            "FORBIDDEN",
            "Only agency owners can view agency stats",
            403
          );
          return;
        }
        transactions = await transactionService.getTransactionsForAgency(
          agent.agencyId
        );
        break;
      }
      case "agent":
      default: {
        transactions = await transactionService.getTransactionsForAgent(
          userId
        );
        break;
      }
      }

      const stats = transactionService.computeStats(transactions);
      sendSuccess(res, stats);
    } catch (error) {
      console.error("Error getting transaction stats:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /transactions/:id
   */
  async getTransaction(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { id } = req.params;

      const transaction = await transactionService.getTransactionById(id);
      if (!transaction) {
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      }

      // Access check: admin, the agent on the transaction, or same agency
      const isAdmin = !!req.user?.admin;
      const isAgent = transaction.agentId === userId;

      if (!isAdmin && !isAgent) {
        // Check same agency
        const agent = await this.getAgentForUser(userId);
        if (!agent?.agencyId) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }

        // Check if the transaction's agent is in the same agency
        if (transaction.agentId) {
          const txnAgentSnapshot = await collections.agents
            .where("userId", "==", transaction.agentId)
            .limit(1)
            .get();

          if (txnAgentSnapshot.empty) {
            sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
            return;
          }

          const txnAgent = txnAgentSnapshot.docs[0].data() as Agent;
          if (txnAgent.agencyId !== agent.agencyId) {
            sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
            return;
          }
        } else {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
      }

      sendSuccess(res, transaction);
    } catch (error) {
      console.error("Error getting transaction:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // Helper: get agent document for a userId
  private async getAgentForUser(userId: string): Promise<Agent | null> {
    const snapshot = await collections.agents
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Agent;
  }
}

export const transactionController = new TransactionController();
