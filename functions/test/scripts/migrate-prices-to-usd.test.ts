// ============================================
// Unit tests — the #179 naira -> US dollar price migration
// ============================================
// Pure decisions (units, rounding, review cases) and full runs against the
// in-memory Firestore fake: dry run writes nothing, apply converts, a second
// apply changes nothing, unrecognised values are listed and left alone, and a
// price edited between listing and write is never overwritten.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { installFakes, resetStore, fakeCollection, fakeRunTransaction, writes, store } from "../helpers/fake-firestore";
import {
  convertStoredNaira,
  migratePricesToUsd,
  parseCutoffArg,
  parseRateArg,
  planAgentPrice,
  planNairaField,
  planServices,
  type PriceMigrationDeps,
} from "../../src/scripts/migrate-prices-to-usd";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CUTOFF = Date.parse("2026-11-20T09:00:00Z");
const BEFORE = CUTOFF - 86_400_000;
const RATE = 1500;
const usd = (c: number) => ({ amountMinor: c, currency: "USD" });
const NOW = Timestamp.fromMillis(Date.parse("2026-11-14T10:00:00Z"));

describe("convertStoredNaira", () => {
  test("whole naira and pre-#148 kobo, rounded half up to a cent", () => {
    const n = convertStoredNaira(15000, "naira", RATE);
    assert.equal(n.action, "convert");
    assert.deepEqual((n as any).usd, usd(1000)); // ₦15,000 / 1500 = $10.00
    assert.deepEqual((n as any).record, { amount: 15000, currency: "NGN", rate: RATE, storedValue: 15000, storedUnit: "naira" });
    const k = convertStoredNaira(1_500_000, "kobo", RATE); // 1,500,000 kobo = ₦15,000
    assert.deepEqual((k as any).usd, usd(1000));
    assert.equal((k as any).record.amount, 15000);
    assert.equal((k as any).record.storedUnit, "kobo");
    // ₦5,000 at 1353.9741 = $3.6928 -> $3.69
    assert.deepEqual((convertStoredNaira(5000, "naira", 1353.9741) as any).usd, usd(369));
    assert.deepEqual((convertStoredNaira(0, "naira", RATE) as any).usd, usd(0));
  });

  test("lists, never guesses, values that are not whole naira / kobo of whole naira", () => {
    assert.equal((convertStoredNaira(1234.5, "naira", RATE) as any).reason, "not-whole-naira");
    assert.equal((convertStoredNaira(2550, "kobo", RATE) as any).reason, "not-whole-kobo-naira");
    assert.equal((convertStoredNaira(25.5, "kobo", RATE) as any).reason, "not-whole-kobo-naira");
    for (const bad of [-1, "5000", Number.NaN, Infinity, null, {}]) {
      assert.equal((convertStoredNaira(bad, "naira", RATE) as any).reason, "invalid-value", String(bad));
    }
    // ₦5 at 1500 = 0.33 cent -> would be $0.00: a human call.
    assert.equal((convertStoredNaira(5, "naira", RATE) as any).reason, "converts-to-zero");
  });
});

describe("planAgentPrice", () => {
  const plan = (over: Record<string, unknown>) =>
    planAgentPrice({ createdAtMillis: BEFORE, ...over } as any, CUTOFF, RATE);

  test("marker = naira; no marker before the cutoff = kobo; after = naira", () => {
    assert.equal((plan({ consultationFee: 15000, consultationFeeUnit: "naira" }) as any).record.storedUnit, "naira");
    assert.equal((plan({ consultationFee: 1_500_000 }) as any).record.storedUnit, "kobo");
    assert.deepEqual((plan({ consultationFee: 1_500_000 }) as any).usd, usd(1000));
    assert.equal((plan({ consultationFee: 15000, createdAtMillis: CUTOFF }) as any).record.storedUnit, "naira");
  });

  test("no fee or 0 becomes $0.00 (zero stays zero)", () => {
    for (const f of [undefined, null, 0]) {
      const p = plan({ consultationFee: f, createdAtMillis: null }) as any;
      assert.equal(p.action, "convert");
      assert.deepEqual(p.usd, usd(0));
    }
  });

  test("idempotency and the both-prices / corrupt guards", () => {
    assert.deepEqual(plan({ consultationFeeUsd: usd(1000) }), { action: "skip", reason: "already-migrated" });
    assert.equal((plan({ consultationFeeUsd: usd(1000), consultationFee: 5000 }) as any).reason, "both-prices");
    assert.equal((plan({ consultationFeeUsd: usd(1000), consultationFeeUnit: "naira" }) as any).reason, "both-prices");
    assert.equal((plan({ consultationFeeUsd: { amountMinor: 5, currency: "NGN" } }) as any).reason, "invalid-dollar-field");
  });

  test("no marker and no createdAt -> review", () => {
    assert.equal((plan({ consultationFee: 500000, createdAtMillis: null }) as any).reason, "no-created-at");
  });
});

describe("planNairaField and planServices", () => {
  test("agency fee / visa price: convert, skip when absent or already dollars, review otherwise", () => {
    assert.deepEqual((planNairaField(undefined, 150000, RATE) as any).usd, usd(10000));
    assert.deepEqual(planNairaField(undefined, undefined, RATE), { action: "skip", reason: "no-price" });
    assert.deepEqual(planNairaField(usd(10000), undefined, RATE), { action: "skip", reason: "already-migrated" });
    assert.equal((planNairaField(usd(10000), 150000, RATE) as any).reason, "both-prices");
    assert.equal((planNairaField(undefined, 12.5, RATE) as any).reason, "not-whole-naira");
  });

  test("services convert as one unit, keeping id, name and other keys", () => {
    const p = planServices(
      [
        { id: "s1", name: "A", price: 15000 },
        { id: "s2", name: "B", priceUsd: usd(500) },
      ],
      RATE
    ) as any;
    assert.equal(p.action, "convert");
    assert.deepEqual(p.services, [
      { id: "s1", name: "A", priceUsd: usd(1000) },
      { id: "s2", name: "B", priceUsd: usd(500) },
    ]);
    assert.deepEqual(Object.keys(p.records), ["s1"]);
  });

  test("one bad entry leaves the whole list alone", () => {
    for (const bad of [
      [{ id: "s1", name: "A", price: 15000 }, { id: "s2", name: "B", price: 12.5 }],
      [{ id: "s1", name: "A", price: 15000 }, { id: "s2", name: "B" }],
      [{ id: "s1", name: "A", price: 15000 }, { name: "no id", price: 100 }],
      [{ id: "s1", name: "A", price: 15000, priceUsd: usd(1) }],
      [{ id: "s1", name: "A", price: 15000 }, { id: "s1", name: "dup", price: 3000 }],
      "not a list",
    ]) {
      assert.equal(planServices(bad, RATE).action, "review", JSON.stringify(bad));
    }
    assert.deepEqual(planServices([], RATE), { action: "skip", reason: "already-migrated" });
    assert.deepEqual(planServices(undefined, RATE), { action: "skip", reason: "no-price" });
  });
});

describe("arguments", () => {
  test("--rate is required, a plain number in the plausible naira range", () => {
    assert.deepEqual(parseRateArg(["--rate", "1353.9741"]), { ok: true, rate: 1353.9741 });
    assert.deepEqual(parseRateArg(["--rate=1500"]), { ok: true, rate: 1500 });
    for (const argv of [[], ["--rate"], ["--rate", "abc"], ["--rate", "-1500"], ["--rate", "135.39"], ["--rate", "13539"], ["--rate", "1e3"]]) {
      assert.equal(parseRateArg(argv).ok, false, argv.join(" "));
    }
  });

  test("--cutoff parses an ISO time", () => {
    assert.equal(parseCutoffArg(["--cutoff", "2026-11-20T09:00:00Z"]), CUTOFF);
    assert.equal(parseCutoffArg(["--cutoff=soon"]), undefined);
    assert.equal(parseCutoffArg([]), undefined);
  });
});

// ---------------------------------------------------------------------------
// Full runs against the in-memory fake
// ---------------------------------------------------------------------------

describe("migratePricesToUsd", () => {
  before(async () => {
    await installFakes();
  });
  beforeEach(() => {
    resetStore();
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    console.log = () => {};
  });

  const deps = (): PriceMigrationDeps => ({
    agents: fakeCollection("agents") as never,
    agencies: fakeCollection("agencies") as never,
    visaPrices: (id: string) => fakeCollection(`agencies/${id}/visaPrices`) as never,
    runTransaction: fakeRunTransaction,
  });
  const run = (apply: boolean) => migratePricesToUsd({ cutoffMillis: CUTOFF, rate: RATE, apply, now: () => NOW }, deps());
  const doc = (p: string) => store.get(p) as Record<string, any>;

  /** A small world with every case. */
  async function seed() {
    const at = Timestamp.fromMillis(BEFORE);
    await fakeCollection("agents").doc("naira").set({ id: "naira", consultationFee: 15000, consultationFeeUnit: "naira", createdAt: at });
    await fakeCollection("agents").doc("kobo").set({ id: "kobo", consultationFee: 900_000, createdAt: at });
    await fakeCollection("agents").doc("zero").set({ id: "zero", consultationFee: 0, createdAt: at });
    await fakeCollection("agents").doc("odd").set({ id: "odd", consultationFee: 2550, createdAt: at });
    await fakeCollection("agents").doc("done").set({ id: "done", consultationFeeUsd: usd(700), createdAt: at });
    await fakeCollection("agencies").doc("ag1").set({
      id: "ag1",
      consultationFee: 150000,
      services: [{ id: "s1", name: "Review", price: 30000 }],
    });
    await fakeCollection("agencies").doc("ag2").set({
      id: "ag2",
      consultationFee: 0,
      services: [{ id: "s1", name: "Ok", price: 1500 }, { id: "s2", name: "Bad", price: 99.5 }],
    });
    await fakeCollection("agencies/ag1/visaPrices").doc("GB__uk").set({ id: "GB__uk", price: 187500 });
    await fakeCollection("agencies/ag1/visaPrices").doc("GB__odd").set({ id: "GB__odd", price: "12500" });
  }

  test("dry run reports and writes nothing", async () => {
    await seed();
    writes.length = 0;
    const c = await run(false);
    assert.deepEqual(writes, []);
    // naira, kobo, zero agents; ag1 fee + 1 service; ag2 fee; 1 visa price
    assert.equal(c.converted, 7);
    assert.equal(c.agents, 5);
    assert.equal(c.agencies, 2);
    assert.equal(c.visaPrices, 2);
    assert.deepEqual(
      c.review.map((r) => [r.path, r.field, r.reason]).sort(),
      [
        ["agencies/ag1/visaPrices/GB__odd", "price", "invalid-value"],
        ["agencies/ag2", "services", "not-whole-naira"],
        ["agents/odd", "consultationFee", "not-whole-kobo-naira"],
      ]
    );
  });

  test("apply converts, removes the naira fields, records migratedFrom; a second run changes nothing", async () => {
    await seed();
    const first = await run(true);
    assert.equal(first.converted, 7);

    // Agents
    assert.deepEqual(doc("agents/naira").consultationFeeUsd, usd(1000));
    assert.equal("consultationFee" in doc("agents/naira"), false);
    assert.equal("consultationFeeUnit" in doc("agents/naira"), false);
    assert.deepEqual(doc("agents/naira").migratedFrom.consultationFee, {
      amount: 15000, currency: "NGN", rate: RATE, storedValue: 15000, storedUnit: "naira", migratedAt: NOW,
    });
    assert.deepEqual(doc("agents/kobo").consultationFeeUsd, usd(600)); // ₦9,000 / 1500 = $6.00
    assert.equal(doc("agents/kobo").migratedFrom.consultationFee.storedUnit, "kobo");
    assert.deepEqual(doc("agents/zero").consultationFeeUsd, usd(0));
    // Left alone
    assert.equal(doc("agents/odd").consultationFee, 2550);
    assert.equal("consultationFeeUsd" in doc("agents/odd"), false);
    assert.deepEqual(doc("agents/done"), { id: "done", consultationFeeUsd: usd(700), createdAt: doc("agents/done").createdAt });

    // Agencies
    assert.deepEqual(doc("agencies/ag1").consultationFeeUsd, usd(10000));
    assert.equal("consultationFee" in doc("agencies/ag1"), false);
    assert.deepEqual(doc("agencies/ag1").services, [{ id: "s1", name: "Review", priceUsd: usd(2000) }]);
    assert.equal(doc("agencies/ag1").migratedFrom.services.s1.amount, 30000);
    assert.equal(doc("agencies/ag1").migratedFrom.consultationFee.amount, 150000);
    // ag2: fee converted (0 -> $0), services untouched as a unit
    assert.deepEqual(doc("agencies/ag2").consultationFeeUsd, usd(0));
    assert.deepEqual(doc("agencies/ag2").services, [{ id: "s1", name: "Ok", price: 1500 }, { id: "s2", name: "Bad", price: 99.5 }]);

    // Visa prices
    assert.deepEqual(doc("agencies/ag1/visaPrices/GB__uk").priceUsd, usd(12500));
    assert.equal("price" in doc("agencies/ag1/visaPrices/GB__uk"), false);
    assert.equal(doc("agencies/ag1/visaPrices/GB__odd").price, "12500");

    // Second run: nothing converted, nothing written, the same review list.
    writes.length = 0;
    const second = await run(true);
    assert.equal(second.converted, 0);
    assert.deepEqual(writes, []);
    assert.equal(second.review.length, 3);
    assert.equal(second.skipped["agent:already-migrated"], 4);
  });

  test("a price edited between the listing and the write is never overwritten", async () => {
    await fakeCollection("agents").doc("a1").set({ id: "a1", consultationFee: 15000, consultationFeeUnit: "naira" });
    const d = deps();
    const realAgents = d.agents;
    // List the old doc, then let the agent set a dollar fee through the API
    // shape (dollar field written, naira field removed) before the write.
    d.agents = {
      async get() {
        const snap = await realAgents.get();
        await fakeCollection("agents").doc("a1").update({
          consultationFeeUsd: usd(2500),
          consultationFee: FieldValue.delete(),
          consultationFeeUnit: FieldValue.delete(),
        });
        return snap;
      },
    };
    const c = await migratePricesToUsd({ cutoffMillis: CUTOFF, rate: RATE, apply: true, now: () => NOW }, d);
    assert.equal(c.converted, 0);
    assert.equal(c.skipped["changed-during-run"], 1);
    assert.deepEqual(doc("agents/a1").consultationFeeUsd, usd(2500));
    assert.equal("migratedFrom" in doc("agents/a1"), false);
  });
});
