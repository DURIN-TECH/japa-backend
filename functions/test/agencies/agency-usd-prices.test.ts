// ============================================
// Unit tests — agency fee and services in US dollars (issue #179), hermetic
// ============================================
//  - readAgencyProfileInput: dollar fee + services validated (whole cents,
//    capped, USD only); old naira keys refused; null clears the fee;
//  - updateAgency: writing the dollar fee removes the naira one (replace,
//    not shadow); clearing removes the field;
//  - PUT /agencies/me: only the caller's OWN agency is written; another
//    agency's owner, a member agent and a client get 403 and nothing is
//    written; a bad price is a 400 with nothing written.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "@durin-tech/authz";

import { installFakes, resetStore, fakeCollection, store, writes } from "../helpers/fake-firestore";
import { agencyService, readAgencyProfileInput } from "../../src/services/agency.service";
import { agencyController } from "../../src/controllers/agency.controller";

/* eslint-disable @typescript-eslint/no-explicit-any */

const usd = (c: number) => ({ amountMinor: c, currency: "USD" });
const doc = (p: string) => store.get(p) as Record<string, any>;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.agencies = fakeCollection("agencies");
});

beforeEach(async () => {
  resetStore();
  // Two agencies, each still holding pre-migration naira prices.
  for (const [id, owner] of [["ag-a", "uid-a"], ["ag-b", "uid-b"]]) {
    await fakeCollection("agencies").doc(id).set({
      id, name: `Agency ${id}`, ownerId: owner, ownerName: "O", status: "approved",
      consultationFee: 150000, services: [{ id: "s1", name: "Review", price: 30000 }],
    });
  }
});

/** Minimal res that records status + body. */
function captureRes() {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
  };
  return { out, res };
}

describe("readAgencyProfileInput (dollar prices)", () => {
  test("a dollar fee and dollar services are read as Money", () => {
    const r = readAgencyProfileInput({
      consultationFeeUsd: { amount: "100.00", currency: "USD" },
      services: [{ id: "s1", name: "Review", priceUsd: { amount: 20 }, extra: "dropped" }],
    });
    assert.ok(r.ok);
    assert.deepEqual(r.profile.consultationFeeUsd, usd(10000));
    assert.deepEqual(r.profile.services, [{ id: "s1", name: "Review", priceUsd: usd(2000) }]);
  });

  test("null clears the fee", () => {
    const r = readAgencyProfileInput({ consultationFeeUsd: null });
    assert.ok(r.ok);
    assert.equal(r.profile.consultationFeeUsd, null);
  });

  test("bad prices and old naira keys are refused (400 message names the field)", () => {
    for (const [body, field] of [
      [{ consultationFee: 150000 }, "consultationFee"],
      [{ consultationFeeUsd: 100 }, "consultationFeeUsd"],
      [{ consultationFeeUsd: { amount: "-1" } }, "consultationFeeUsd"],
      [{ consultationFeeUsd: { amount: "100.001" } }, "consultationFeeUsd"],
      [{ consultationFeeUsd: { amount: "100000.01" } }, "consultationFeeUsd"],
      [{ consultationFeeUsd: { amount: 10, currency: "NGN" } }, "consultationFeeUsd"],
      [{ consultationFeeUsd: { amount: Infinity } }, "consultationFeeUsd"],
      [{ services: [{ id: "s1", name: "x", price: 3000 }] }, "services[].price"],
      [{ services: [{ id: "s1", name: "x" }] }, "services[].priceUsd"],
      [{ services: [{ id: "s1", name: "x", priceUsd: { amount: "1.5", currency: "GBP" } }] }, "services[].priceUsd"],
    ] as const) {
      const r = readAgencyProfileInput(body);
      assert.equal(r.ok, false, JSON.stringify(body));
      if (!r.ok) assert.ok(r.message.startsWith(field), `${JSON.stringify(body)} -> ${r.message}`);
    }
  });
});

describe("updateAgency", () => {
  test("writing the dollar fee removes the naira fee; services replaced with dollar entries", async () => {
    const r = readAgencyProfileInput({
      consultationFeeUsd: { amount: "100" },
      services: [{ id: "s1", name: "Review", priceUsd: { amount: "20" } }],
    });
    assert.ok(r.ok);
    await agencyService.updateAgency("ag-a", r.profile);
    assert.deepEqual(doc("agencies/ag-a").consultationFeeUsd, usd(10000));
    assert.equal("consultationFee" in doc("agencies/ag-a"), false);
    assert.deepEqual(doc("agencies/ag-a").services, [{ id: "s1", name: "Review", priceUsd: usd(2000) }]);
  });

  test("clearing removes both fee fields (absent = no fee)", async () => {
    await agencyService.updateAgency("ag-a", { consultationFeeUsd: null });
    assert.equal("consultationFeeUsd" in doc("agencies/ag-a"), false);
    assert.equal("consultationFee" in doc("agencies/ag-a"), false);
  });
});

describe("PUT /agencies/me: per-agency isolation", () => {
  /** An owner principal of `agencyId` (as attachAuthz resolves it). */
  const owner = (uid: string, agencyId: string) => ({ uid, role: ROLES.OWNER, agencyId });
  const body = { consultationFeeUsd: { amount: "55.00" } };

  test("the owner writes only their own agency", async () => {
    const { out, res } = captureRes();
    await agencyController.updateMyAgency({ authz: owner("uid-a", "ag-a"), userId: "uid-a", body } as any, res);
    assert.equal(out.status, 200);
    assert.deepEqual(doc("agencies/ag-a").consultationFeeUsd, usd(5500));
    // Agency B is untouched.
    assert.equal(doc("agencies/ag-b").consultationFee, 150000);
    assert.equal("consultationFeeUsd" in doc("agencies/ag-b"), false);
  });

  test("another agency's owner, a member agent and a client get 403; nothing is written", async () => {
    for (const authz of [
      owner("uid-b", "ag-a"), // claims agency A but A's record names uid-a
      { uid: "uid-agent", role: ROLES.AGENT, agencyId: "ag-a" },
      { uid: "uid-client", role: ROLES.CLIENT, agencyId: "ag-a" },
    ]) {
      writes.length = 0;
      const { out, res } = captureRes();
      await agencyController.updateMyAgency({ authz, userId: authz.uid, body } as any, res);
      assert.equal(out.status, 403, JSON.stringify(authz));
      assert.deepEqual(writes, []);
    }
    assert.equal(doc("agencies/ag-a").consultationFee, 150000);
  });

  test("a bad price is 400 and writes nothing", async () => {
    writes.length = 0;
    const { out, res } = captureRes();
    await agencyController.updateMyAgency(
      { authz: owner("uid-a", "ag-a"), userId: "uid-a", body: { consultationFeeUsd: { amount: "1.234" } } } as any,
      res
    );
    assert.equal(out.status, 400);
    assert.deepEqual(writes, []);
  });
});
