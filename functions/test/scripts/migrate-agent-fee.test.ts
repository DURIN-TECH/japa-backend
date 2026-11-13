// Unit tests — pure decision logic of the #148 agent-fee migration (no SDK/emulator).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { before, beforeEach } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { installFakes, resetStore, fakeCollection, fakeRunTransaction, writes, store } from "../helpers/fake-firestore";
import { decideBackfillTarget } from "../../src/scripts/backfill-news-expire-at-guard";
import {
  migrateAgentFees,
  type MigrationDeps,
  planAgentFee,
  parseCutoffArg,
  FEE_UNIT_MARKER,
} from "../../src/scripts/migrate-agent-consultation-fee-to-naira";

const CUTOFF = Date.parse("2026-11-20T09:00:00Z");
const BEFORE = CUTOFF - 86_400_000;

describe("planAgentFee", () => {
  test("converts a kobo value created before the cutoff", () => {
    assert.deepEqual(planAgentFee({ consultationFee: 500000, createdAtMillis: BEFORE }, CUTOFF), {
      action: "convert", from: 500000, to: 5000,
    });
  });

  test("is idempotent: a converted doc (marker) is skipped even if its naira value looks like kobo", () => {
    const converted = planAgentFee({ consultationFee: 500000, createdAtMillis: BEFORE }, CUTOFF);
    assert.equal(converted.action, "convert");
    // Second run sees the marker the first run wrote; 5000 would otherwise be /100 again.
    assert.deepEqual(
      planAgentFee({ consultationFee: 5000, consultationFeeUnit: FEE_UNIT_MARKER, createdAtMillis: BEFORE }, CUTOFF),
      { action: "skip", reason: "already-migrated" }
    );
    // Even a naira value that is a multiple of 100 stays put once marked.
    assert.equal(
      planAgentFee({ consultationFee: 50000, consultationFeeUnit: FEE_UNIT_MARKER, createdAtMillis: BEFORE }, CUTOFF).action,
      "skip"
    );
  });

  test("skips agents created at or after the cutoff (written in naira)", () => {
    assert.deepEqual(planAgentFee({ consultationFee: 5000, createdAtMillis: CUTOFF }, CUTOFF), {
      action: "skip", reason: "created-after-cutoff",
    });
  });

  test("marks (never converts) missing, null and zero fees, whatever the creation date", () => {
    for (const f of [undefined, null, 0]) {
      for (const created of [BEFORE, CUTOFF + 1, null]) {
        assert.deepEqual(planAgentFee({ consultationFee: f, createdAtMillis: created }, CUTOFF), {
          action: "mark", reason: "no-fee",
        });
      }
    }
  });

  test("flags, never converts, values that cannot be kobo or cannot be read", () => {
    assert.equal(planAgentFee({ consultationFee: 2550, createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.equal(planAgentFee({ consultationFee: 12.5, createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.equal(planAgentFee({ consultationFee: "5000", createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.equal(planAgentFee({ consultationFee: -100, createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.deepEqual(planAgentFee({ consultationFee: 500000, createdAtMillis: null }, CUTOFF), {
      action: "review", reason: "no-created-at", fee: 500000,
    });
  });
});

describe("parseCutoffArg", () => {
  test("parses both forms and rejects absent/invalid values", () => {
    assert.equal(parseCutoffArg(["--cutoff", "2026-11-20T09:00:00Z"]), CUTOFF);
    assert.equal(parseCutoffArg(["--cutoff=2026-11-20T09:00:00Z"]), CUTOFF);
    assert.equal(parseCutoffArg([]), undefined);
    assert.equal(parseCutoffArg(["--cutoff", "soon"]), undefined);
  });
});

// ---------------------------------------------------------------------------
// migrateAgentFees against the in-memory Firestore fake (writes, windows)
// ---------------------------------------------------------------------------
describe("migrateAgentFees (in-memory Firestore)", () => {
  before(async () => {
    await installFakes();
  });
  beforeEach(() => {
    resetStore();
    // Silence the per-doc progress lines.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    console.log = () => {};
  });

  const agents = () => fakeCollection("agents");
  const deps = (): MigrationDeps => ({ agents: agents() as never, runTransaction: fakeRunTransaction });
  const put = (id: string, data: Record<string, unknown>) => agents().doc(id).set(data);
  const read = (id: string) => store.get(`agents/${id}`) as Record<string, unknown>;
  const created = (ms: number) => Timestamp.fromMillis(ms);

  test("dry run reports and writes nothing", async () => {
    await put("a", { consultationFee: 500000, createdAt: created(BEFORE) });
    writes.length = 0;
    const c = await migrateAgentFees(CUTOFF, false, deps());
    assert.equal(c.converted, 1);
    assert.equal(writes.length, 0);
    assert.equal(read("a").consultationFee, 500000);
  });

  test("apply converts, marks no-fee docs, lists after-cutoff and review docs", async () => {
    await put("kobo", { consultationFee: 500000, createdAt: created(BEFORE) });
    await put("zero", { consultationFee: 0, createdAt: created(BEFORE) });
    await put("none", { createdAt: created(BEFORE) });
    await put("new", { consultationFee: 5000, createdAt: created(CUTOFF + 1000) });
    await put("odd", { consultationFee: 2550, createdAt: created(BEFORE) });
    const c = await migrateAgentFees(CUTOFF, true, deps());
    assert.equal(c.converted, 1);
    assert.equal(c.marked, 2);
    assert.deepEqual(c.afterCutoff, [{ id: "new", fee: 5000 }]);
    assert.deepEqual(c.review.map((r) => r.id), ["odd"]);
    assert.deepEqual([read("kobo").consultationFee, read("kobo").consultationFeeUnit], [5000, "naira"]);
    assert.equal(read("zero").consultationFeeUnit, "naira");
    assert.equal(read("none").consultationFeeUnit, "naira");
    assert.equal(read("new").consultationFee, 5000); // untouched
    assert.equal(read("odd").consultationFee, 2550); // untouched
  });

  test("a re-run after --apply converts nothing, even when a naira value is a multiple of 100", async () => {
    await put("kobo", { consultationFee: 5000000, createdAt: created(BEFORE) }); // 50,000 naira after the first run
    await migrateAgentFees(CUTOFF, true, deps());
    assert.equal(read("kobo").consultationFee, 50000);
    writes.length = 0;
    const again = await migrateAgentFees(CUTOFF, true, deps());
    assert.equal(again.converted, 0);
    assert.equal(writes.length, 0);
    assert.equal(read("kobo").consultationFee, 50000);
  });

  test("a fee edited between the read and the write is not overwritten with a stale value", async () => {
    await put("race", { consultationFee: 500000, createdAt: created(BEFORE) });
    // The listing sees the kobo value; before the per-doc transaction runs, the
    // agent saves 7,000 naira through updateAgent (fee + marker).
    const base = deps();
    const racing = {
      agents: {
        async get() {
          const snap = await base.agents.get();
          await put("race", { consultationFee: 7000, consultationFeeUnit: "naira", createdAt: created(BEFORE) });
          return snap;
        },
      },
      runTransaction: base.runTransaction,
    };
    const c = await migrateAgentFees(CUTOFF, true, racing as never);
    assert.equal(c.converted, 0);
    assert.equal(read("race").consultationFee, 7000);
  });
});

describe("guard wording", () => {
  test("names this script, not the expireAt backfill; the news default is unchanged", () => {
    const mine = decideBackfillTarget({}, { label: "agent fee migration", example: "`npm run migrate:agent-fee -- --project <id>`" });
    assert.equal(mine.ok, false);
    assert.match(mine.message, /migrate:agent-fee/);
    assert.doesNotMatch(mine.message, /expireat/i);
    const news = decideBackfillTarget({});
    assert.match(news.message, /backfill:expireat/);
  });
});
