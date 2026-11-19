// ============================================
// Unit tests — PublicAgent allow-list on unauthenticated agent routes (#147)
// ============================================
//
// Hermetic: no network, no emulator. Firestore `agents` is the in-memory fake
// and the controller handlers are called directly with a minimal req / res
// (no auth fields at all = an anonymous caller).
//
// Per route (GET /agents, /agents/top, /agents/:id, /agents/visa/:visaTypeId):
//  - 200 without any auth;
//  - no item carries a private key (userId, licenseNumber,
//    verificationDocuments, verifiedBy, availableSlots, ...);
//  - every item's key set is exactly the allow-list (PUBLIC_AGENT_FIELDS);
//  - an empty result is `200 []`.
// Plus: non-verified GET /agents/:id is 404, and /agents/me keeps the full doc.
//
// Issue #179: the fee is the stored dollar Money (`consultationFeeUsd`) plus
// its local figure (`consultationFeeLocal`); the old naira `consultationFee`,
// its `consultationFeeUnit` marker and the `migratedFrom` audit never appear,
// and a missing rate still serves the dollar price.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { fakeCollection, installFakes, resetStore, store } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { agentController } from "../../src/controllers/agent.controller";
import { agentService } from "../../src/services/agent.service";
import { PUBLIC_AGENT_FIELDS, toPublicAgent } from "../../src/agents/public-agent";
import type { Agent } from "../../src/types";
import { pricerFromRate } from "../../src/money/local-price";
import { useFixedRate } from "../helpers/local-pricing";

/* eslint-disable @typescript-eslint/no-explicit-any */

const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** Keys that must never reach an anonymous caller. */
const FORBIDDEN_KEYS = [
  "userId",
  "licenseNumber",
  "verificationDocuments",
  "verifiedBy",
  "verifiedAt",
  "availableSlots",
  "serviceFees",
  // Issue #179: old naira fields and the migration audit stay private.
  "consultationFee",
  "consultationFeeUnit",
  "migratedFrom",
];

/** A pricer at ₦1,500 per dollar (pure, no rate service). */
const NGN_1500 = pricerFromRate("NGN", {
  currency: "NGN", rate: 1500, asOf: "2026-11-13T00:00:00.000Z", source: "cbn", marginBps: 0,
});

/** A full stored agent doc, every private field populated. */
function agentDoc(id: string, over: Data = {}): Data {
  return {
    id,
    userId: `uid-${id}`,
    agencyId: "agency-a",
    agencyRole: "agent",
    displayName: `Agent ${id}`,
    bio: "Bio",
    profilePhotoUrl: "https://example.test/p.png",
    licenseNumber: "LIC-SECRET-1",
    yearsOfExperience: 5,
    specializations: ["Work Visa"],
    languages: ["English"],
    featuredVisas: ["visa-1"],
    verificationStatus: "verified",
    verificationDocuments: ["gs://bucket/secret.pdf"],
    verifiedAt: T0,
    verifiedBy: "admin-uid",
    rating: 4.5,
    totalReviews: 3,
    totalApplications: 7,
    successRate: 90,
    responseTime: "24 hours",
    consultationFeeUsd: { amountMinor: 1000, currency: "USD" }, // $10.00
    // Leftovers a not-yet-cleaned doc might carry: must never leak.
    consultationFee: 5000,
    consultationFeeUnit: "naira",
    migratedFrom: { consultationFee: { amount: 5000, currency: "NGN", rate: 1500 } },
    serviceFees: {},
    isAvailable: true,
    availableSlots: [{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function seed(id: string, over: Data = {}): void {
  store.set(`agents/${id}`, agentDoc(id, over));
}

interface Captured {
  status: number;
  body: any;
}

/** Call a handler with an anonymous request (no userId / ability). */
async function call(
  handler: (req: any, res: any) => Promise<void>,
  req: { params?: Data; query?: Data } = {}
): Promise<Captured> {
  const out: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  await handler({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
  return out;
}

/** Assert one item is exactly the allow-list shape with no private key. */
function assertPublicShape(item: any): void {
  for (const k of FORBIDDEN_KEYS) {
    assert.equal(k in item, false, `${k} must not be in a public agent`);
  }
  const allowed = new Set<string>(PUBLIC_AGENT_FIELDS);
  for (const k of Object.keys(item)) {
    assert.ok(allowed.has(k), `unexpected key ${k}`);
  }
  // This fixture has every optional key set, so the sets must be equal.
  assert.deepEqual(Object.keys(item).sort(), [...PUBLIC_AGENT_FIELDS].sort());
}

let restoreRate: () => void;
before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.agents = fakeCollection("agents");
  // Issue #179: price reads at a fixed ₦1,500 per dollar (no Firestore).
  restoreRate = useFixedRate(1500);
});
after(() => restoreRate());

beforeEach(() => {
  resetStore();
});

describe("toPublicAgent", () => {
  test("copies only allow-listed fields: the dollar fee plus its local figure", () => {
    const pub = toPublicAgent(agentDoc("a1") as unknown as Agent, NGN_1500);
    assertPublicShape(pub);
    assert.deepEqual(pub.consultationFeeUsd, { amountMinor: 1000, currency: "USD" });
    // $10.00 x 1500 = ₦15,000.00 = 1,500,000 kobo.
    assert.deepEqual(pub.consultationFeeLocal, {
      amountMinor: 1_500_000, currency: "NGN", rate: 1500, asOf: "2026-11-13T00:00:00.000Z", available: true,
    });
    assert.equal(pub.agencyRole, "agent");
  });

  test("no usable rate: the dollar fee is still returned, the local figure is unavailable", () => {
    const pub = toPublicAgent(agentDoc("a1") as unknown as Agent, pricerFromRate("NGN", null));
    assert.deepEqual(pub.consultationFeeUsd, { amountMinor: 1000, currency: "USD" });
    assert.deepEqual(pub.consultationFeeLocal, { amountMinor: null, currency: "NGN", rate: null, asOf: null, available: false });
  });

  test("a doc with no valid dollar fee (not migrated, or corrupt) shows no fee, never the naira number", () => {
    for (const bad of [undefined, 5000, { amountMinor: 1000, currency: "NGN" }, { amountMinor: 1.5, currency: "USD" }]) {
      const pub = toPublicAgent(agentDoc("a1", { consultationFeeUsd: bad }) as unknown as Agent, NGN_1500);
      assert.equal(pub.consultationFeeUsd, null);
      assert.equal(pub.consultationFeeLocal, null);
    }
  });

  test("a zero-dollar fee shows as zero local", () => {
    const pub = toPublicAgent(agentDoc("a1", { consultationFeeUsd: { amountMinor: 0, currency: "USD" } }) as unknown as Agent, NGN_1500);
    assert.equal(pub.consultationFeeLocal?.amountMinor, 0);
    assert.equal(pub.consultationFeeLocal?.available, true);
  });

  test("omits optional keys the doc does not have", () => {
    const doc = agentDoc("a1");
    delete doc.agencyId;
    delete doc.agencyRole;
    delete doc.profilePhotoUrl;
    const pub = toPublicAgent(doc as unknown as Agent, NGN_1500) as any;
    assert.equal("agencyId" in pub, false);
    assert.equal("agencyRole" in pub, false);
    assert.equal("profilePhotoUrl" in pub, false);
  });
});

describe("GET /agents", () => {
  test("200 for anonymous, allow-listed items only", async () => {
    seed("a1");
    seed("a2");
    seed("a3", { verificationStatus: "pending" });
    const r = await call(agentController.getAgents.bind(agentController));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 2);
    r.body.data.forEach(assertPublicShape);
  });

  test("empty -> 200 []", async () => {
    const r = await call(agentController.getAgents.bind(agentController));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, []);
  });
});

describe("GET /agents/top", () => {
  test("200 for anonymous, allow-listed items only", async () => {
    seed("a1");
    seed("a2", { isAvailable: false });
    const r = await call(agentController.getTopAgents.bind(agentController));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 1);
    r.body.data.forEach(assertPublicShape);
  });

  test("empty -> 200 []", async () => {
    const r = await call(agentController.getTopAgents.bind(agentController));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, []);
  });
});

describe("GET /agents/:id", () => {
  test("200 for anonymous, allow-listed shape only", async () => {
    seed("a1");
    const r = await call(agentController.getAgent.bind(agentController), { params: { id: "a1" } });
    assert.equal(r.status, 200);
    assertPublicShape(r.body.data);
  });

  test("rate unavailable: still 200 with the dollar fee (issue #179)", async () => {
    seed("a1");
    const restore = useFixedRate(null);
    try {
      const r = await call(agentController.getAgent.bind(agentController), { params: { id: "a1" } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.consultationFeeUsd, { amountMinor: 1000, currency: "USD" });
      assert.equal(r.body.data.consultationFeeLocal.available, false);
      assert.equal(r.body.data.consultationFeeLocal.amountMinor, null);
    } finally {
      restore(); // back to the suite's ₦1,500 wiring
    }
  });

  test("non-verified agent -> 404", async () => {
    seed("a1", { verificationStatus: "pending" });
    const r = await call(agentController.getAgent.bind(agentController), { params: { id: "a1" } });
    assert.equal(r.status, 404);
    // The error body carries no agent data either.
    const text = JSON.stringify(r.body);
    for (const k of FORBIDDEN_KEYS) assert.equal(text.includes(k), false);
    assert.equal(text.includes("LIC-SECRET-1"), false);
  });

  test("unknown id -> 404", async () => {
    const r = await call(agentController.getAgent.bind(agentController), { params: { id: "nope" } });
    assert.equal(r.status, 404);
  });
});

describe("GET /agents/visa/:visaTypeId", () => {
  // The shared Firestore fake has no `array-contains`, so the service query is
  // replaced by the same filter over the in-memory store (verified + visa in
  // featuredVisas). The controller + mapper under test are the real ones.
  before(() => {
    (agentService as any).getAgentsForVisaType = async (visaTypeId: string) =>
      [...store.entries()]
        .filter(([path]) => path.startsWith("agents/"))
        .map(([, d]) => d as unknown as Agent)
        .filter((a) => a.verificationStatus === "verified" && a.featuredVisas.includes(visaTypeId));
  });

  test("200 for anonymous, allow-listed items only", async () => {
    seed("a1");
    seed("a2", { featuredVisas: ["other"] });
    const r = await call(agentController.getAgentsForVisaType.bind(agentController), {
      params: { visaTypeId: "visa-1" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 1);
    r.body.data.forEach(assertPublicShape);
  });

  test("empty -> 200 []", async () => {
    const r = await call(agentController.getAgentsForVisaType.bind(agentController), {
      params: { visaTypeId: "visa-none" },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, []);
  });
});

describe("authenticated GET /agents/me", () => {
  test("keeps the full document", async () => {
    seed("a1");
    // userId is set by verifyAuth in production.
    const out: Captured = { status: 0, body: undefined };
    const res: any = {
      status(c: number) {
        out.status = c;
        return res;
      },
      json(b: unknown) {
        out.body = b;
        return res;
      },
    };
    await agentController.getMyAgentProfile({ userId: "uid-a1" } as any, res);
    const owner = out;
    assert.equal(owner.status, 200);
    assert.equal(owner.body.data.userId, "uid-a1");
    assert.ok(owner.body.data.licenseNumber);
  });
});
