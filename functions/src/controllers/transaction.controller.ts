import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { transactionService, TransactionFilters } from "../services/transaction.service";
import { toClientTransaction } from "../transactions/client-transaction";
import { collections } from "../utils/firebase";
import { Agent, Transaction } from "../types";
import { ROLES } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  ErrorMessages,
} from "../utils/response";

/** Every Transaction type, for the `type` list filter (issue #317). */
const TRANSACTION_TYPES: Transaction["type"][] = [
  "consultation_fee", "service_fee", "government_fee", "refund", "escrow_release", "withdrawal",
];

export class TransactionController {
  /**
   * GET /transactions?role=client|agent|owner|admin&type=...&status=...&applicationId=...&startDate=...&endDate=...
   *
   * Issue #317: `type` narrows the list to one Transaction type. The admin
   * refund screen (#357) uses `role=admin&type=refund&status=failed` to list
   * refunds that need a human.
   *
   * Scoping (issue #292). The scope is decided from the caller's OWN role
   * (`req.authz.role`, resolved by verifyAuth from the token's custom claims),
   * never from the `role` query parameter alone:
   *
   *  - caller is a CLIENT: always their own payment history (the rows whose
   *    payer `userId` is the caller: consultation booking fees and
   *    payment-request charges they paid). `role` is IGNORED, so the result
   *    is the same with no `role`, `role=client`, or `role=agent|owner|admin`:
   *    a client cannot widen their scope by asking for another role. Before
   *    #292 a role-less client fell into the agent branch, which looks for
   *    rows where the caller is the AGENT, and so always got `[]`;
   *  - caller is agent-side or an admin: unchanged. `role=admin` needs the
   *    admin role (else 403), `role=owner` needs the owner role and an agency
   *    (else 403), and `role=agent` or no `role` returns the rows where the
   *    caller is the agent;
   *  - any caller may pass `role=client` to get their own payer rows (an
   *    agent who also booked a consultation as a customer). It is scoped to
   *    the caller's own uid, so it grants nothing extra.
   *
   * Money is returned as stored: `amount` in minor units of each row's own
   * `currency` (see money/totals.ts). Nothing is converted or summed.
   *
   * Response shape (issue #329). It depends on the SCOPE, not on the row:
   *  - client scope: each row is a `ClientTransaction`, an explicit
   *    allow-list (transactions/client-transaction.ts): id, type, status,
   *    description / service name, the amount charged, the dollar price, the
   *    related case / booking id and the dates. Seli's exchange-rate markup
   *    (`fxMarginBps`), the raw rate, agent ids and Paystack references are
   *    NOT returned. This also holds for an agent-side caller who asks for
   *    `role=client`: they are then a paying customer like any other;
   *  - agent, owner and admin scopes: the full stored `Transaction`, as
   *    before.
   */
  async getTransactions(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      // The caller's real role. verifyAuth always sets req.authz (falling
      // back to least-privilege "client" on any resolution error).
      const callerRole = req.authz?.role;
      const requestedRole = req.query.role as string | undefined;

      // The client view: forced for a client (whatever `role` says), and
      // also when there is no resolved principal at all (fail to the
      // own-rows-only scope rather than to an agent-side one); available to
      // anyone who asks for it explicitly.
      const clientScope =
        !callerRole ||
        callerRole === ROLES.CLIENT ||
        requestedRole === ROLES.CLIENT;

      // Agent-side callers keep the old default: no `role` means "agent".
      const role = requestedRole || ROLES.AGENT;

      // (#317) `type` (e.g. `type=refund` for the admin refund list): only a
      // known transaction type is used; anything else is ignored.
      const typeParam = req.query.type as string | undefined;
      const type = typeParam && (TRANSACTION_TYPES as string[]).includes(typeParam)
        ? (typeParam as TransactionFilters["type"])
        : undefined;
      const filters: TransactionFilters = {
        type,
        status: req.query.status as TransactionFilters["status"],
        applicationId: req.query.applicationId as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
      };

      // Client scope: the caller's own payer rows only. Returns before the
      // role switch, so no `role` value can reach an agent/owner/admin query.
      if (clientScope) {
        const own = await transactionService.getTransactionsForClient(
          userId,
          filters
        );
        // (#329) Never the stored documents: project every row onto the
        // client allow-list, so the markup, the raw rate and internal ids
        // stay on the server.
        sendSuccess(res, own.map(toClientTransaction));
        return;
      }

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
   * Issue #317: each row also has `heldBalance` (consultation fees still held
   * until the meeting has happened; never withdrawable), and
   * `availableBalance` excludes them and MAY BE NEGATIVE (a refund of an
   * already-released fee, #351; withdrawals are blocked until positive).
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
