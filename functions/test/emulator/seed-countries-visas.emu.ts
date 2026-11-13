// ============================================
// Emulator tests — the countries/visas seeder keeps runtime fields (issue #191)
// ============================================
//
// Run with `npm run test:emulator` (Firestore emulator, Admin SDK).
//
// seedCountriesAndVisas runs on every dev deploy. It must refresh the
// seed-owned content of a visa that already exists but NOT undo what admins
// and scripts did to it: isActive (deactivate:uk-seeds, #175), agentIds and
// createdAt. A visa that does not exist yet is created as before.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { resetEmulators } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let db: any;
let seed: () => Promise<any>;

const visaRef = (id: string) => db.collection("countries").doc("GB").collection("visaTypes").doc(id);

before(async () => {
  // Lazy import: the emulator env (checked by setup.ts) must be in place first.
  ({ db } = await import("../../src/utils/firebase"));
  ({ seedCountriesAndVisas: seed } = await import("../../src/data/seed-countries-visas"));
});

beforeEach(async () => {
  await resetEmulators();
});

after(async () => {
  await resetEmulators();
});

describe("seedCountriesAndVisas on existing docs", () => {
  test("a fresh seed creates uk-visitor active, with no agents", async () => {
    await seed();
    const d = (await visaRef("uk-visitor").get()).data();
    assert.equal(d.isActive, true);
    assert.deepEqual(d.agentIds, []);
    assert.ok(d.createdAt instanceof Timestamp);
  });

  test("reseed keeps isActive, agentIds and createdAt; refreshes seed-owned fields", async () => {
    await seed();
    const oldCreated = Timestamp.fromMillis(1_000_000);
    // Admin / script changes, plus a stale seed-owned field to prove refresh.
    await visaRef("uk-visitor").update({
      isActive: false,
      agentIds: ["agent-1", "agent-2"],
      createdAt: oldCreated,
      name: "stale name",
    });

    await seed();

    const d = (await visaRef("uk-visitor").get()).data();
    assert.equal(d.isActive, false);
    assert.deepEqual(d.agentIds, ["agent-1", "agent-2"]);
    assert.ok(d.createdAt.isEqual(oldCreated));
    assert.notEqual(d.name, "stale name");
  });

  test("a doc deleted between seeds is recreated as new", async () => {
    await seed();
    await visaRef("uk-visitor").delete();
    await seed();
    const d = (await visaRef("uk-visitor").get()).data();
    assert.equal(d.isActive, true);
    assert.deepEqual(d.agentIds, []);
  });

  test("seeding twice changes nothing but updatedAt", async () => {
    await seed();
    const strip = (x: any) => {
      const { updatedAt, ...rest } = x;
      void updatedAt;
      return rest;
    };
    const a = strip((await visaRef("uk-visitor").get()).data());
    await seed();
    const b = strip((await visaRef("uk-visitor").get()).data());
    assert.deepEqual(b, a);
  });
});
