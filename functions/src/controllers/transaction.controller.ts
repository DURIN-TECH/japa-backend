import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { transactionService, TransactionFilters } from "../services/transaction.service";
import { collections } from "../utils/firebase";
import { Agent } from "../types";
import { ROLES } from "@durin-tech/authz";
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
      case ROLES.ADMIN: {
        if (req.authz?.role !== ROLES.ADMIN) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        transactions = await transactionService.getAllTransactions(filters);
        break;
      }
      case ROLES.OWNER: {
        if (req.authz?.role !== ROLES.OWNER || !req.authz.agencyId) {
          sendError(
            res,
            "FORBIDDEN",
            "Only agency owners can view agency transactions",
            403
          );
          return;
        }
        transactions = await transactionService.getTransactionsForAgency(
          req.authz.agencyId,
          filters
        );
        break;
      }
      case ROLES.AGENT:
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
   *
   * Issue #282: money is returned PER CURRENCY, never summed across
   * currencies. Response `data`:
   *   {
   *     byCurrency: [{ currency, totalRevenue, pendingPayments, availableBalance }],
   *     pendingClientsCount
   *   }
   * Amounts are integer minor units of each row's `currency`; rows are sorted
   * by code; `byCurrency` is empty when the scope has no transactions. Role
   * scoping is unchanged (admin: all; owner: own agency's agents; agent: own).
   */
  async getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const role = (req.query.role as string) || "agent";

      let transactions;

      switch (role) {
      case ROLES.ADMIN: {
        if (req.authz?.role !== ROLES.ADMIN) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        transactions = await transactionService.getAllTransactions();
        break;
      }
      case ROLES.OWNER: {
        if (req.authz?.role !== ROLES.OWNER || !req.authz.agencyId) {
          sendError(
            res,
            "FORBIDDEN",
            "Only agency owners can view agency stats",
            403
          );
          return;
        }
        transactions = await transactionService.getTransactionsForAgency(
          req.authz.agencyId
        );
        break;
      }
      case ROLES.AGENT:
      default: {
        transactions = await transactionService.getTransactionsForAgent(
          userId
        );
        break;
      }
      }

      // Per-currency aggregation (see TransactionService.computeStats).
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

      // Access check: admin, the agent on the transaction, or same agency.
      // The caller's role and agency come from the resolved principal
      // (req.authz, built from custom claims), never from the caller's own
      // agent document (issue #135).
      const isAdmin = req.authz?.role === ROLES.ADMIN || req.user?.admin === true;
      const isAgent = transaction.agentId === userId;

      if (!isAdmin && !isAgent) {
        // Same agency: the caller must belong to an agency...
        const callerAgencyId = req.authz?.agencyId;
        if (!callerAgencyId || !transaction.agentId) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }

        // ...and the transaction's agent must be in that same agency. (This
        // reads the OTHER party's agent document, to learn which agency the
        // transaction belongs to; it grants the caller nothing by itself.)
        const txnAgent = await this.getAgentForUser(transaction.agentId);
        if (!txnAgent?.agencyId || txnAgent.agencyId !== callerAgencyId) {
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
