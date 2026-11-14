// ============================================
// Unit tests: per-currency totals (issue #282)
// ============================================
//
// GET /transactions/stats, the withdrawal balance check and the analytics
// revenue figures report money PER CURRENCY and never add amounts of
// different currencies. These tests drive the pure aggregation functions
// directly (no Firestore): TransactionService.computeStats, the
// availableBalanceIn helper the withdrawal check uses, and the analytics
// revenue helpers (KPIs with previous period, monthly trends, per-agent
// revenue), plus the shared revenue rule both use (settled = completed or
// released; settled refunds subtract in their own currency).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  transactionService,
  availableBalanceIn,
  WITHDRAWAL_CURRENCY,
} from "../../src/services/transaction.service";
import {
  addApplicationPaid,
  buildRevenueKpis,
  buildRevenueTrendSeries,
  percentChange,
} from "../../src/services/analytics.service";
import {
  CurrencyBuckets,
  isPendingIncoming,
  revenueEffect,
  unionCurrencies,
} from "../../src/money/totals";
import type { Application, Transaction, TransactionStatus, TransactionType } from "../../src/types";

// ============================================
// FIXTURES
// ============================================

/** Running counter so every fixture transaction gets a unique id. */
let seq = 0;

/**
 * A minimal Transaction. Only the fields the aggregations read are
 * meaningful; the rest satisfy the type.
 */
function txn(
  amount: number,
  currency: string,
  status: TransactionStatus,
  opts: { type?: TransactionType; userId?: string; at?: string } = {}
): Transaction {
  seq += 1;
  const at = Timestamp.fromDate(new Date(opts.at ?? "2026-11-01T10:00:00Z"));
  return {
    id: `t${seq}`,
    userId: opts.userId ?? `client${seq}`,
    agentId: "agent1",
    type: opts.type ?? "escrow_release",
    amount,
    currency,
    status,
    isEscrow: false,
    paymentProvider: "paystack",
    description: "fixture",
    createdAt: at,
    updatedAt: at,
  } as Transaction;
}

/** A withdrawal fixture (always the agent's own user id, like createWithdrawal). */
function withdrawal(amount: number, status: TransactionStatus, currency = "NGN"): Transaction {
  return txn(amount, currency, status, { type: "withdrawal", userId: "agent1" });
}

// ============================================
// TRANSACTION STATS
// ============================================

describe("TransactionService.computeStats (per currency)", () => {
  test("empty set: empty byCurrency and no pending clients", () => {
    assert.deepEqual(transactionService.computeStats([]), {
      byCurrency: [],
      pendingClientsCount: 0,
    });
  });

  test("only NGN rows: one NGN bucket", () => {
    const stats = transactionService.computeStats([
      txn(500_000, "NGN", "released"),
      txn(250_000, "NGN", "completed", { type: "consultation_fee" }),
      txn(100_000, "NGN", "pending", { userId: "c1" }),
    ]);
    assert.deepEqual(stats, {
      byCurrency: [
        { currency: "NGN", totalRevenue: 750_000, pendingPayments: 100_000, availableBalance: 750_000 },
      ],
      pendingClientsCount: 1,
    });
  });

  test("only USD rows: one USD bucket", () => {
    const stats = transactionService.computeStats([
      txn(12_500, "USD", "released"),
      txn(3_000, "USD", "held_in_escrow", { userId: "c1" }),
      txn(2_000, "USD", "processing", { userId: "c1" }),
    ]);
    assert.deepEqual(stats, {
      byCurrency: [
        { currency: "USD", totalRevenue: 12_500, pendingPayments: 5_000, availableBalance: 12_500 },
      ],
      // Same client twice counts once.
      pendingClientsCount: 1,
    });
  });

  test("mixed rows: each currency summed on its own, sorted by code", () => {
    const stats = transactionService.computeStats([
      txn(12_500, "USD", "released"),
      txn(500_000, "NGN", "released"),
      txn(7_000, "USD", "pending", { userId: "c1" }),
      txn(80_000, "NGN", "pending", { userId: "c2" }),
      // Failed charge: no money, but its currency still gets a row.
      txn(1_000, "GHS", "failed"),
    ]);
    assert.deepEqual(stats.byCurrency, [
      { currency: "GHS", totalRevenue: 0, pendingPayments: 0, availableBalance: 0 },
      { currency: "NGN", totalRevenue: 500_000, pendingPayments: 80_000, availableBalance: 500_000 },
      { currency: "USD", totalRevenue: 12_500, pendingPayments: 7_000, availableBalance: 12_500 },
    ]);
    assert.equal(stats.pendingClientsCount, 2);
  });

  test("a lower-case or missing currency code is normalised (missing = legacy NGN)", () => {
    const legacy = txn(10_000, "NGN", "completed");
    delete (legacy as Partial<Transaction>).currency;
    const stats = transactionService.computeStats([legacy, txn(5_000, "ngn", "completed")]);
    assert.deepEqual(stats.byCurrency, [
      { currency: "NGN", totalRevenue: 15_000, pendingPayments: 0, availableBalance: 15_000 },
    ]);
  });

  test("withdrawals in a mixed set reduce only the NGN balance", () => {
    const stats = transactionService.computeStats([
      txn(500_000, "NGN", "released"),
      txn(20_000, "USD", "released"),
      withdrawal(100_000, "completed"),
      withdrawal(50_000, "pending"),
      withdrawal(25_000, "processing"),
      // A failed withdrawal gives the money back: not subtracted.
      withdrawal(999_999, "failed"),
    ]);
    assert.deepEqual(stats, {
      byCurrency: [
        // Withdrawals are not revenue and not pending client payments.
        { currency: "NGN", totalRevenue: 500_000, pendingPayments: 0, availableBalance: 325_000 },
        // USD untouched by the naira withdrawals.
        { currency: "USD", totalRevenue: 20_000, pendingPayments: 0, availableBalance: 20_000 },
      ],
      // A pending withdrawal is not a pending client.
      pendingClientsCount: 0,
    });
  });

  test("NGN balance never goes below 0, and USD revenue does not cover it", () => {
    const stats = transactionService.computeStats([
      txn(10_000, "NGN", "released"),
      txn(1_000_000, "USD", "released"),
      withdrawal(50_000, "completed"),
    ]);
    assert.equal(availableBalanceIn(stats, "NGN"), 0);
    assert.equal(availableBalanceIn(stats, "USD"), 1_000_000);
  });

  test("withdrawals only (no revenue): NGN row with a 0 balance", () => {
    const stats = transactionService.computeStats([withdrawal(5_000, "pending")]);
    assert.deepEqual(stats.byCurrency, [
      { currency: "NGN", totalRevenue: 0, pendingPayments: 0, availableBalance: 0 },
    ]);
  });
});

describe("TransactionService.computeStats: refunds (shared revenue rule)", () => {
  test("a settled refund lowers revenue and balance in its own currency only", () => {
    const stats = transactionService.computeStats([
      txn(500_000, "NGN", "released"),
      txn(20_000, "USD", "released"),
      txn(5_000, "USD", "completed", { type: "refund" }),
      withdrawal(100_000, "completed"),
    ]);
    assert.deepEqual(stats.byCurrency, [
      { currency: "NGN", totalRevenue: 500_000, pendingPayments: 0, availableBalance: 400_000 },
      { currency: "USD", totalRevenue: 15_000, pendingPayments: 0, availableBalance: 15_000 },
    ]);
  });

  test("refunds above revenue: revenue goes negative, balance stays at 0", () => {
    const stats = transactionService.computeStats([
      txn(10_000, "NGN", "completed"),
      txn(25_000, "NGN", "completed", { type: "refund" }),
    ]);
    assert.deepEqual(stats.byCurrency, [
      { currency: "NGN", totalRevenue: -15_000, pendingPayments: 0, availableBalance: 0 },
    ]);
  });

  test("a pending refund is neither revenue nor a pending client payment", () => {
    const stats = transactionService.computeStats([
      txn(10_000, "NGN", "completed"),
      txn(4_000, "NGN", "pending", { type: "refund", userId: "c9" }),
    ]);
    assert.deepEqual(stats, {
      byCurrency: [
        { currency: "NGN", totalRevenue: 10_000, pendingPayments: 0, availableBalance: 10_000 },
      ],
      pendingClientsCount: 0,
    });
  });

  test("a charge marked 'refunded' drops out (no refund row, nothing subtracted twice)", () => {
    const stats = transactionService.computeStats([
      txn(10_000, "NGN", "completed"),
      txn(5_000, "NGN", "refunded", { type: "consultation_fee" }),
    ]);
    assert.equal(stats.byCurrency[0].totalRevenue, 10_000);
  });

  test("stats and analytics agree on the same set", () => {
    const set = [
      txn(40_000, "USD", "released"),
      txn(10_000, "USD", "completed", { type: "refund" }),
      txn(90_000, "NGN", "completed"),
      txn(7_000, "NGN", "pending"),
      withdrawal(20_000, "completed"),
    ];
    const stats = transactionService.computeStats(set);
    const kpis = buildRevenueKpis(set, []);
    assert.deepEqual(
      stats.byCurrency.map((r) => [r.currency, r.totalRevenue]),
      kpis.map((r) => [r.currency, r.totalRevenue])
    );
  });
});

describe("shared revenue rule (money/totals.ts)", () => {
  test("revenueEffect / isPendingIncoming", () => {
    assert.equal(revenueEffect({ type: "escrow_release", status: "released", amount: 5 }), 5);
    assert.equal(revenueEffect({ type: "consultation_fee", status: "completed", amount: 5 }), 5);
    assert.equal(revenueEffect({ type: "refund", status: "completed", amount: 5 }), -5);
    assert.equal(revenueEffect({ type: "refund", status: "released", amount: 5 }), -5);
    assert.equal(revenueEffect({ type: "withdrawal", status: "completed", amount: 5 }), 0);
    assert.equal(revenueEffect({ type: "service_fee", status: "pending", amount: 5 }), 0);
    assert.equal(revenueEffect({ type: "service_fee", status: "failed", amount: 5 }), 0);
    assert.equal(isPendingIncoming({ type: "service_fee", status: "held_in_escrow" }), true);
    assert.equal(isPendingIncoming({ type: "refund", status: "pending" }), false);
    assert.equal(isPendingIncoming({ type: "withdrawal", status: "pending" }), false);
  });
});

describe("withdrawal balance check (availableBalanceIn)", () => {
  test("withdrawals are paid in NGN", () => {
    assert.equal(WITHDRAWAL_CURRENCY, "NGN");
  });

  test("compares against the NGN balance only", () => {
    // Only USD revenue: nothing can be withdrawn in naira.
    const usdOnly = transactionService.computeStats([txn(50_000, "USD", "released")]);
    assert.equal(availableBalanceIn(usdOnly, WITHDRAWAL_CURRENCY), 0);

    const mixed = transactionService.computeStats([
      txn(300_000, "NGN", "released"),
      txn(50_000, "USD", "released"),
      withdrawal(100_000, "pending"),
    ]);
    assert.equal(availableBalanceIn(mixed, WITHDRAWAL_CURRENCY), 200_000);
  });

  test("empty stats: balance 0", () => {
    assert.equal(availableBalanceIn(transactionService.computeStats([]), "NGN"), 0);
  });
});

// ============================================
// ANALYTICS REVENUE
// ============================================

describe("analytics revenue KPIs (buildRevenueKpis)", () => {
  test("empty periods: empty list", () => {
    assert.deepEqual(buildRevenueKpis([], []), []);
  });

  test("only NGN: one row with its previous-period change", () => {
    const rows = buildRevenueKpis(
      [txn(150_000, "NGN", "completed")],
      [txn(100_000, "NGN", "completed")]
    );
    assert.deepEqual(rows, [
      { currency: "NGN", totalRevenue: 150_000, previousRevenue: 100_000, totalRevenueChange: 50 },
    ]);
  });

  test("only USD: one row", () => {
    const rows = buildRevenueKpis([txn(3_000, "USD", "completed")], []);
    assert.deepEqual(rows, [
      { currency: "USD", totalRevenue: 3_000, previousRevenue: 0, totalRevenueChange: 100 },
    ]);
  });

  test("mixed: compared within each currency, union of both periods", () => {
    const rows = buildRevenueKpis(
      [
        txn(200_000, "NGN", "completed"),
        txn(1_000, "USD", "completed"),
        // Not completed: not revenue.
        txn(9_999, "USD", "pending"),
      ],
      [
        txn(100_000, "NGN", "completed"),
        txn(3_000, "USD", "completed"),
        // Only in the previous period: still gets a row.
        txn(500, "GHS", "completed"),
      ]
    );
    assert.deepEqual(rows, [
      { currency: "GHS", totalRevenue: 0, previousRevenue: 500, totalRevenueChange: -100 },
      { currency: "NGN", totalRevenue: 200_000, previousRevenue: 100_000, totalRevenueChange: 100 },
      { currency: "USD", totalRevenue: 1_000, previousRevenue: 3_000, totalRevenueChange: -66.7 },
    ]);
  });

  test("withdrawals in a mixed set are never revenue", () => {
    const rows = buildRevenueKpis(
      [txn(50_000, "NGN", "completed"), txn(2_000, "USD", "completed"), withdrawal(40_000, "completed")],
      []
    );
    assert.deepEqual(rows.map((r) => [r.currency, r.totalRevenue]), [
      ["NGN", 50_000],
      ["USD", 2_000],
    ]);
  });

  test("percentChange edge cases", () => {
    assert.equal(percentChange(0, 0), 0);
    assert.equal(percentChange(0, 5), 100);
    assert.equal(percentChange(0, -5), -100);
    assert.equal(percentChange(4, 2), -50);
    // Negative revenue (refunds): moving up from -100 to 100 is +200%.
    assert.equal(percentChange(-100, 100), 200);
    assert.equal(percentChange(-100, -200), -100);
  });

  test("released payment-request charges count, like /transactions/stats", () => {
    const rows = buildRevenueKpis(
      [txn(40_000, "USD", "released"), txn(10_000, "USD", "completed", { type: "consultation_fee" })],
      [txn(25_000, "USD", "released")]
    );
    assert.deepEqual(rows, [
      { currency: "USD", totalRevenue: 50_000, previousRevenue: 25_000, totalRevenueChange: 100 },
    ]);
  });

  test("settled refunds subtract in their own currency; revenue is not clamped", () => {
    const rows = buildRevenueKpis(
      [
        txn(100_000, "NGN", "completed"),
        txn(30_000, "NGN", "completed", { type: "refund" }),
        // Refund only, no charges in USD this period: negative revenue.
        txn(2_000, "USD", "completed", { type: "refund" }),
        // A pending refund has not moved money yet: no effect.
        txn(50_000, "NGN", "pending", { type: "refund" }),
      ],
      []
    );
    assert.deepEqual(rows, [
      { currency: "NGN", totalRevenue: 70_000, previousRevenue: 0, totalRevenueChange: 100 },
      { currency: "USD", totalRevenue: -2_000, previousRevenue: 0, totalRevenueChange: -100 },
    ]);
  });
});

describe("analytics revenue trends (buildRevenueTrendSeries)", () => {
  const months = [
    { month: "2026-10", label: "Oct" },
    { month: "2026-11", label: "Nov" },
  ];

  test("empty set: no series", () => {
    assert.deepEqual(buildRevenueTrendSeries([], months), []);
  });

  test("released charges count and refunds subtract, per currency per month", () => {
    const series = buildRevenueTrendSeries(
      [
        txn(30_000, "USD", "released", { at: "2026-11-05T12:00:00Z" }),
        txn(5_000, "USD", "completed", { type: "refund", at: "2026-11-06T12:00:00Z" }),
        txn(1_000, "USD", "completed", { type: "refund", at: "2026-10-06T12:00:00Z" }),
      ],
      months
    );
    assert.deepEqual(series, [
      {
        currency: "USD",
        points: [
          { month: "2026-10", label: "Oct", value: -1_000 },
          { month: "2026-11", label: "Nov", value: 25_000 },
        ],
      },
    ]);
  });

  test("mixed: one series per currency, every month present", () => {
    const series = buildRevenueTrendSeries(
      [
        txn(100_000, "NGN", "completed", { at: "2026-10-10T12:00:00Z" }),
        txn(50_000, "NGN", "completed", { at: "2026-11-10T12:00:00Z" }),
        txn(2_500, "USD", "completed", { at: "2026-11-11T12:00:00Z" }),
        withdrawal(10_000, "completed"),
        txn(7_000, "USD", "failed", { at: "2026-10-12T12:00:00Z" }),
      ],
      months
    );
    assert.deepEqual(series, [
      {
        currency: "NGN",
        points: [
          { month: "2026-10", label: "Oct", value: 100_000 },
          { month: "2026-11", label: "Nov", value: 50_000 },
        ],
      },
      {
        currency: "USD",
        points: [
          { month: "2026-10", label: "Oct", value: 0 },
          { month: "2026-11", label: "Nov", value: 2_500 },
        ],
      },
    ]);
  });
});

describe("agent-performance revenue (addApplicationPaid)", () => {
  /** A minimal Application with only the money fields set. */
  const app = (fields: Partial<Application>) => ({ amountPaid: 0, ...fields }) as Application;

  test("nothing paid: empty list", () => {
    const b = new CurrencyBuckets();
    addApplicationPaid(b, app({ amountPaid: 0, costCurrency: "USD" }));
    assert.deepEqual(b.toList(), []);
  });

  test("USD cases, a legacy case with no costCurrency, and other-currency payments stay apart", () => {
    const b = new CurrencyBuckets();
    addApplicationPaid(b, app({ amountPaid: 50_000, costCurrency: "USD" }));
    // Pre-#181 case: no costCurrency means US cents.
    addApplicationPaid(b, app({ amountPaid: 10_000 }));
    // A legacy naira request settled on a dollar case.
    addApplicationPaid(
      b,
      app({ amountPaid: 1_000, costCurrency: "USD", amountPaidOtherCurrencies: { NGN: 2_500_000 } })
    );
    assert.deepEqual(b.toList(), [
      { currency: "NGN", amount: 2_500_000 },
      { currency: "USD", amount: 61_000 },
    ]);
  });
});

describe("CurrencyBuckets / unionCurrencies", () => {
  test("union is sorted and de-duplicated", () => {
    const a = new CurrencyBuckets();
    a.add("USD", 1);
    a.add("NGN", 1);
    const b = new CurrencyBuckets();
    b.add("NGN", 2);
    b.touch("GHS");
    assert.deepEqual(unionCurrencies(a, b), ["GHS", "NGN", "USD"]);
  });
});
