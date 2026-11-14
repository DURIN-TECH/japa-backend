// ============================================
// Seed safety (issue #215): a seed run must not undo portal work
// ============================================
//
// Before #215 `seedVisaSources` rebuilt a country's whole page list from the
// vendored markdown with a full overwrite, so a page an admin added from the
// portal to a country that is ALSO in the markdown was wiped by the next seed.
// These tests run the real seed functions over an in-memory Firestore.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, resetStore, store } from "../../../helpers/fake-firestore";
import { fetcher, wireRegistry } from "./registry-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A Firestore stand-in with just what the seeds call. */
const fakeDb: any = {
  collection: (n: string) => fakeCollection(n),
  getAll: (...refs: any[]) => Promise.all(refs.map((r) => r.get())),
  batch: () => {
    const ops: Array<() => Promise<void>> = [];
    return {
      set: (ref: any, data: any, opts?: any) => ops.push(() => ref.set(data, opts)),
      commit: async () => {
        for (const op of ops) await op();
      },
    };
  },
};

let seedVisa: any;
let seedGuidance: any;
let seedMod: any;
let registration: any;
let importer: any;
let wired: any;
after(() => wired.close());

before(async () => {
  wired = await wireRegistry();
  seedMod = await import("../../../../src/scrapers/visa-catalog/data/seed-visa-sources");
  seedVisa = seedMod.seedVisaSources;
  const g = await import("../../../../src/scrapers/guidance/data/seed-guidance-sources");
  seedGuidance = g;
  registration = (await import("../../../../src/scrapers/shared/registry/route-registration.service")).routeRegistrationService;
  importer = await import("../../../../src/scrapers/shared/registry/official-domains-seed");
});
beforeEach(() => {
  resetStore();
  fetcher.pages.clear();
});

/** A confirmed host doc. */
const confirmed = (host: string, authorityId: string) =>
  store.set(`officialDomains/${host}`, { host, authorityId, status: "confirmed", confirmedBy: "u", confirmedAt: Timestamp.now(), statement: "An agency", addedVia: "portal" });

/** Register one route on `cc` through the real service (fetch faked). */
async function registerOn(cc: string, host: string, path: string): Promise<void> {
  const visa = `https://${host}/${path}`;
  const rules = `https://${host}/${path}-rules`;
  confirmed(host, cc);
  fetcher.pages.set(visa, {});
  fetcher.pages.set(rules, {});
  await registration.register(
    {
      authorityId: cc,
      routeName: `Route ${path}`,
      visaPage: { url: visa, language: "en" },
      guidance: [{ url: rules, title: `Rules ${path}`, role: "primary", docType: "html", language: "en" }],
      crawlTimeZone: "Etc/UTC",
    },
    "admin-uid"
  );
}

/**
 * A country that is in the markdown AND has built-in official hosts (the case
 * the issue names), found from the data rather than by writing its code here.
 */
async function firstSeededCode(): Promise<string> {
  const fs = await import("node:fs");
  const md = fs.readFileSync(seedMod.findVisaSourcesMarkdown()!, "utf8");
  const inMarkdown = new Set(seedMod.parseVisaSourcesMarkdown(md).map((c: any) => c.countryCode));
  const withHosts = Object.keys(seedMod.VISA_SOURCE_OFFICIAL_HOSTS).find((c) => inMarkdown.has(c));
  assert.ok(withHosts, "a seeded country with built-in hosts exists");
  return withHosts;
}

describe("seedVisaSources keeps portal work", () => {
  test("a re-seed after a portal page was added to a country that is in the markdown keeps the page, its crawl state and the confirmed host", async () => {
    const cc = await firstSeededCode();
    await seedVisa(undefined, fakeDb);
    const seeded = store.get(`visaSources/${cc}`) as any;
    const seededPages = seeded.pages.length;
    assert.ok(seededPages > 0);

    await registerOn(cc, "www.agency.example.org", "visit");
    // The crawler has since stamped crawl state on the portal page.
    const doc = store.get(`visaSources/${cc}`) as any;
    const stamped = Timestamp.fromMillis(1_700_000_000_000);
    doc.pages = doc.pages.map((p: any) => (p.addedVia === "portal" ? { ...p, lastContentHash: "hash-1", lastCrawledAt: stamped } : p));
    store.set(`visaSources/${cc}`, doc);
    const codeHosts: string[] = [...(seedMod.VISA_SOURCE_OFFICIAL_HOSTS[cc] ?? [])];

    await seedVisa(undefined, fakeDb);

    const after = store.get(`visaSources/${cc}`) as any;
    assert.equal(after.pages.length, seededPages + 1);
    const portal = after.pages.filter((p: any) => p.addedVia === "portal");
    assert.equal(portal.length, 1);
    assert.equal(portal[0].url, "https://www.agency.example.org/visit");
    assert.equal(portal[0].visaId, `${cc.toLowerCase()}-route-visit`);
    assert.equal(portal[0].addedBy, "admin-uid");
    assert.equal(portal[0].lastContentHash, "hash-1");
    assert.equal(portal[0].lastCrawledAt.toMillis(), stamped.toMillis());
    // Seeded pages are still the markdown's.
    assert.equal(after.pages.filter((p: any) => p.addedVia !== "portal").length, seededPages);
    // Hosts: the union of code and stored.
    for (const h of codeHosts) assert.ok(after.officialHosts.includes(h), `code host ${h}`);
    assert.ok(after.officialHosts.includes("www.agency.example.org"));
    assert.equal(new Set(after.officialHosts).size, after.officialHosts.length);
  });

  test("a re-seed keeps a paused portal page paused and keeps the doc's provenance", async () => {
    const cc = await firstSeededCode();
    store.set(`visaSources/${cc}`, {
      pages: [{ url: "https://p.example.org/x", routeName: "P", validation: "unverified", visaId: `${cc.toLowerCase()}-x`, addedVia: "portal", paused: true, pausedReason: "host_revoked", language: "en" }],
      addedVia: "portal",
      addedBy: "admin-uid",
      addedAt: Timestamp.fromMillis(5),
    });
    await seedVisa(undefined, fakeDb);
    const after = store.get(`visaSources/${cc}`) as any;
    const p = after.pages.find((x: any) => x.addedVia === "portal");
    assert.equal(p.paused, true);
    assert.equal(p.pausedReason, "host_revoked");
    assert.equal(after.addedBy, "admin-uid");
    assert.equal(after.addedVia, "portal");
  });

  test("countries that are not in the markdown are not touched (document-for-document)", async () => {
    await registerOn("SV", "www.agency.example.org", "visit"); // not in the markdown
    const before = JSON.stringify(store.get("visaSources/SV"));
    const countryBefore = JSON.stringify(store.get("countries/SV"));
    await seedVisa(undefined, fakeDb);
    assert.equal(JSON.stringify(store.get("visaSources/SV")), before);
    assert.equal(JSON.stringify(store.get("countries/SV")), countryBefore);
    // …and the seed did write others.
    assert.ok([...store.keys()].filter((p) => p.startsWith("visaSources/")).length > 5);
  });

  test("a seeded host list alone is unchanged for a country with no portal work", async () => {
    const cc = await firstSeededCode();
    await seedVisa(undefined, fakeDb);
    const once = JSON.stringify(store.get(`visaSources/${cc}`), (k, v) => (k === "updatedAt" || k === "createdAt" || k === "nextCrawlAt" ? undefined : v));
    await seedVisa(undefined, fakeDb);
    const twice = JSON.stringify(store.get(`visaSources/${cc}`), (k, v) => (k === "updatedAt" || k === "createdAt" || k === "nextCrawlAt" ? undefined : v));
    assert.equal(once, twice);
  });
});

describe("seedGuidanceSources keeps portal work and never deletes", () => {
  test("a portal-added source survives; a seed entry reusing its id does not overwrite it; nothing is deleted", async () => {
    await seedGuidance.seedGuidanceSources(undefined, fakeDb);
    const seedIds = seedGuidance.GUIDANCE_SOURCE_SEEDS.map((s: any) => s.id);
    // A portal source under its own id.
    store.set("guidanceSources/zz-portal-only", { title: "Portal", url: "https://p.example.org/a", addedVia: "portal", role: "primary", status: "paused", pausedReason: "host_revoked" });
    // …and one that squats a seed id.
    const target = seedIds[0];
    const squat = { title: "Mine", url: "https://p.example.org/mine", addedVia: "portal", role: "secondary", status: "active", verificationStatus: "registered" };
    store.set(`guidanceSources/${target}`, squat);
    const count = [...store.keys()].filter((p) => /^guidanceSources\/[^/]+$/.test(p)).length;
    const written = await seedGuidance.seedGuidanceSources(undefined, fakeDb);
    assert.equal(written, seedIds.length - 1);
    assert.deepEqual(store.get(`guidanceSources/${target}`), squat);
    assert.equal((store.get("guidanceSources/zz-portal-only") as any).status, "paused");
    assert.equal([...store.keys()].filter((p) => /^guidanceSources\/[^/]+$/.test(p)).length, count);
  });

  test("an admin's role edit on a seeded source survives a re-seed; an unedited one still follows the seed", async () => {
    const seed = seedGuidance.GUIDANCE_SOURCE_SEEDS[0];
    const existing = { role: "secondary", roleEditedBy: "admin-uid" };
    const edited = seedGuidance.buildSeededGuidanceSource(seed, existing, Timestamp.now());
    assert.equal(edited.role, "secondary");
    const plain = seedGuidance.buildSeededGuidanceSource(seed, { role: "secondary" }, Timestamp.now());
    assert.equal(plain.role, seed.role ?? null);
  });

  test("the validator accepts `registered` only with a retrieval time and no retrieval error", () => {
    const seed = { ...seedGuidance.GUIDANCE_SOURCE_SEEDS[0], verificationStatus: "registered", verificationNote: "n", retrievedAt: undefined, retrievalError: undefined };
    assert.ok(seedGuidance.validateGuidanceSourceSeed(seed).some((p: string) => /retrievedAt/.test(p)));
    const ok = { ...seed, retrievedAt: "2026-11-10T12:00:00Z" };
    assert.deepEqual(seedGuidance.validateGuidanceSourceSeed(ok), []);
    assert.ok(seedGuidance.validateGuidanceSourceSeed({ ...ok, retrievalError: "boom" }).length > 0);
  });
});

describe("one-off import of the built-in hosts", () => {
  const HOSTS = { AA: ["www.one.example.org", "*.apps.example.org", "www.one.example.org"], BB: ["portal.two.example.org", "bad host"] };

  test("plans exact hosts only; patterns and invalid entries are reported, not imported", () => {
    const { planned, skipped } = importer.planOfficialDomainImport(HOSTS);
    assert.deepEqual(planned, [
      { host: "www.one.example.org", countryCode: "AA" },
      { host: "portal.two.example.org", countryCode: "BB" },
    ]);
    assert.equal(skipped.length, 2);
  });

  test("imports as confirmed by system:seed with an audit entry; a re-run changes nothing; a revoked host is not un-revoked; dry run writes nothing", async () => {
    const run = (apply: boolean) => importer.importOfficialDomains({ apply, now: 1000, hosts: HOSTS, runTransaction: fakeRunTransaction });
    assert.deepEqual((await run(false)).created.length, 2);
    assert.equal(store.size, 0);
    await run(true);
    const d = store.get("officialDomains/www.one.example.org") as any;
    assert.equal(d.status, "confirmed");
    assert.equal(d.confirmedBy, "system:seed");
    assert.equal(d.addedVia, "seed");
    // Issue #232: written as the country's authority; the old field is not written.
    assert.equal(d.authorityId, "AA");
    assert.equal(d.countryCode, undefined);
    assert.ok(!store.has("officialDomains/*.apps.example.org"));
    const audits = [...store.keys()].filter((p) => p.startsWith("sourceRegistryAudit/"));
    assert.equal(audits.length, 2);
    store.set("officialDomains/portal.two.example.org", { ...(store.get("officialDomains/portal.two.example.org") as any), status: "revoked" });
    const again = await run(true);
    assert.deepEqual(again.created, []);
    assert.equal(again.existing.length, 2);
    assert.equal((store.get("officialDomains/portal.two.example.org") as any).status, "revoked");
    assert.equal([...store.keys()].filter((p) => p.startsWith("sourceRegistryAudit/")).length, 2);
  });

  test("the real constant imports only its exact hosts (patterns stay in code)", () => {
    const { planned } = importer.planOfficialDomainImport();
    assert.ok(planned.length >= 1);
    assert.ok(planned.every((p: any) => !p.host.includes("*")));
  });

  test("the project guard refuses a stray environment", async () => {
    const { projectGuardProblems } = await import("../../../../src/scrapers/shared/registry/official-domains-seed-guard");
    assert.ok(projectGuardProblems({ writes: false }).length > 0);
    assert.ok(projectGuardProblems({ gcloudProject: "some-real-project", writes: true }).length > 0);
    assert.deepEqual(projectGuardProblems({ gcloudProject: "some-real-project", confirmProject: "some-real-project", writes: true }), []);
    assert.deepEqual(projectGuardProblems({ gcloudProject: "some-real-project", writes: false }), []);
    assert.ok(projectGuardProblems({ gcloudProject: "demo-x", writes: true }).length > 0); // no emulator
    assert.deepEqual(projectGuardProblems({ gcloudProject: "demo-x", firestoreEmulatorHost: "127.0.0.1:8782", writes: true }), []);
    assert.ok(projectGuardProblems({ gcloudProject: "some-real-project", firestoreEmulatorHost: "127.0.0.1:8782", writes: false }).length > 0);
  });
});
