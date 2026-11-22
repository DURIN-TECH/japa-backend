import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  transactionService,
  TransactionFilters,
  // Issue #413 (E): admin filter combinations Firestore has an index for.
  unsupportedAdminFilterCombination,
} from "../services/transaction.service";
import { toClientTransaction } from "../transactions/client-transaction";
import { collections } from "../utils/firebase";
import { Agent, PaystackFeeStatus, Transaction } from "../types";
// Issue #395: looking an unknown Paystack fee up again (admin only).
import { paystackFeeService } from "../services/paystack-fee.service";
import { ROLES } from "@durin-tech/authz";
import {
  sendSuccess,
  sendError,
  ErrorMessages,
} from "../utils/response";

/** Every Transaction type, for the `type` list filter (issue #317). */
const TRANSACTION_TYPES: Transaction["type"][] = [
  "consultation_fee", "service_fee", "government_fee", "refund", "escrow_release", "withdrawal",
  // Issue #354: Paystack's fee on a refunded payment, taken from the agent.
  "paystack_fee_debit",
  // Issue #413: an agent's adjustment when a refund mismatch is resolved.
  "refund_adjustment",
];

/** Issue #395: every Paystack-fee status, for the admin `paystackFeeStatus` list filter. */
// Issue #413 (D): "set_aside" lists the rows the lookup job gave up on.
const PAYSTACK_FEE_STATUSES: PaystackFeeStatus[] = ["known", "unknown", "fee_not_less_than_amount", "set_aside"];

export class TransactionController {
  /**
   * GET /transactions?role=client|agent|owner|admin&type=...&status=...&applicationId=...&startDate=...&endDate=...
   *
   * Issue #317: `type` narrows the list to one Transaction type. The admin
   * refund screen (#357) uses `role=admin&type=refund&status=failed` to list
   * refunds that need a human.
   *
   * Issue #395: `paystackFeeStatus` (`known` | `unknown` |
   * `fee_not_less_than_amount`) narrows the list to consultation fees whose
   * Paystack fee stands so. ADMIN ONLY: the admin list of fees still waiting
   * for Paystack is
   * `GET /transactions?role=admin&type=consultation_fee&paystackFeeStatus=unknown`.
   * Issue #393: paid payment requests whose fee is still unknown are
   * `type=escrow_release&paystackFeeStatus=unknown` (same index
   * transactions(type, paystackFeeStatus, createdAt desc)).
   * Any other caller passing it (client, agent, owner; whatever `role` says)
   * gets 403 before anything is read; an unknown value is 400. Agent-side
   * rows carry `paystackFeeMinor`, `agentCreditMinor` and `paystackFeeStatus`
   * themselves (the fee, the net, and "waiting for the payment provider's
   * fee"); the client allow-list never does.
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
      // (#395) The admin-only Paystack-fee filter: checked against the
      // caller's REAL role before any scope is chosen or anything is read.
      const feeStatusParam = req.query.paystackFeeStatus as string | undefined;
      if (feeStatusParam !== undefined) {
        if (callerRole !== ROLES.ADMIN) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        if (!(PAYSTACK_FEE_STATUSES as string[]).includes(feeStatusParam)) {
          sendError(res, "VALIDATION_ERROR", `paystackFeeStatus must be one of: ${PAYSTACK_FEE_STATUSES.join(", ")}`);
          return;
        }
      }
      const filters: TransactionFilters = {
        type,
        paystackFeeStatus: feeStatusParam as PaystackFeeStatus | undefined,
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

      // Review round 1 of #413 (E: "never a 500"): on the agent, owner and
      // admin lists a date filter that does not parse is a 400 naming it,
      // before anything is read (their Firestore query would otherwise throw
      // on an Invalid Date). The client view keeps ignoring it (in memory).
      for (const name of ["startDate", "endDate"] as const) {
        const raw = req.query[name];
        if (raw === undefined) continue;
        if (typeof raw !== "string" || raw.trim() === "" || Number.isNaN(new Date(raw).getTime())) {
          sendError(res, "VALIDATION_ERROR", `${name} must be a date (ISO 8601, e.g. 2026-11-21)`);
          return;
        }
      }
      let transactions;

      switch (role) {
      case ROLES.ADMIN: {
        if (req.authz?.role !== ROLES.ADMIN) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        // Issue #413 (E): a filter combination with no Firestore index is a
        // 400 naming it, never a 500 from the query.
        {
          const unsupported = unsupportedAdminFilterCombination(filters);
          if (unsupported) {
            sendError(res, "VALIDATION_ERROR", unsupported);
            return;
          }
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
   * Issue #395: `totalRevenue`, `heldBalance` and `availableBalance` count a
   * consultation fee NET of Paystack's fee (A - F), and a fee whose Paystack
   * fee is unknown not at all. `role=admin` rows also carry `paystackFees`
   * and `grossRevenue` (gross = net + Paystack's fees).
   */
  async getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const role = (req.query.role as string) || "agent";

      let transactions;
      // Issue #395: admin stats show gross, Paystack's fee and net side by side.
      let feeBreakdown = false;

      switch (role) {
      case ROLES.ADMIN: {
        if (req.authz?.role !== ROLES.ADMIN) {
          sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
          return;
        }
        transactions = await transactionService.getAllTransactions();
        feeBreakdown = true;
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
      const stats = transactionService.computeStats(transactions, transactionService.now(), { feeBreakdown });
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

  /**
   * POST /transactions/:id/paystack-fee/refresh (issue #395, admins only).
   *
   * Looks the consultation fee's Paystack reference up again and stores
   * Paystack's fee when it is now known (well-formed, in the charge
   * currency). Admins never type a fee in. Answers:
   *  - not an admin: 403 before anything is read (no token: 401, verifyAuth);
   *  - no such Transaction, or not a consultation fee / payment-request
   *    `escrow_release` (the fee-tracked types, #393): 404;
   *  - written before #395 (no fee status, credited A): 409 FEE_NOT_TRACKED;
   *  - the fee was already stored: 200 `{ refreshed: false, transaction }`,
   *    nothing written (a known fee is never overwritten);
   *  - Paystack still has no well-formed fee: 409 PAYSTACK_FEE_UNKNOWN,
   *    nothing written;
   *  - Paystack could not be reached: 502 PAYSTACK_ERROR, nothing written;
   *  - stored now: 200 `{ refreshed: true, transaction }` (status "known", or
   *    "fee_not_less_than_amount", which still credits nothing).
   * Two refreshes at once store the fee once (paystack-fee.service.ts).
   */
  async refreshPaystackFee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (req.authz?.role !== ROLES.ADMIN) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }
      const outcome = await paystackFeeService.resolveOne(req.params.id, "admin_refresh");
      switch (outcome.kind) {
      case "not_found":
        sendError(res, "NOT_FOUND", ErrorMessages.NOT_FOUND, 404);
        return;
      case "not_tracked":
        sendError(
          res,
          "FEE_NOT_TRACKED",
          "This payment was recorded before Paystack's fee was tracked, so there is no fee to look up.",
          409
        );
        return;
      case "still_unknown":
        sendError(
          res,
          "PAYSTACK_FEE_UNKNOWN",
          "Paystack still reports no processing fee for this payment. Try again later.",
          409
        );
        return;
      case "paystack_unavailable":
        sendError(res, "PAYSTACK_ERROR", "Paystack could not be reached. Try again in a moment.", 502);
        return;
      case "already_resolved":
        sendSuccess(res, { refreshed: false, transaction: outcome.transaction });
        return;
      case "resolved":
        sendSuccess(res, { refreshed: true, transaction: outcome.transaction });
        return;
      }
    } catch (error) {
      console.error("Error refreshing Paystack fee:", error);
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
