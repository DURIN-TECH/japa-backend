// ============================================
// Tests — the #239 shared-visa model migration, over the in-memory Firestore fake
// ============================================
// Fixture: a UK-shaped rulebook (head + approved version), a visa record with a legacy
// official website, a legacy `countryCode` website, a retired exemption row plus an
// admin-added one, and (in the data file) a made-up bloc with two members. Covers: dry
// run writes nothing; apply migrates; a second apply is a no-op; the rulebooks are
// identical before and after; the Netherlands rulebook is reported both ways;
// conflicts and blocked members are reported, not guessed. No emulators, no network.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import { BLOC_HOST, FIXTURE_DATA } from "../helpers/shared-visa-fixture";
import { loadSharedVisaData } from "../../src/data/shared-visa-data-format";

/* eslint-disable @typescript-eslint/no-explicit-any */

let migrate: typeof import("../../src/scripts/shared-visa-model/migrate");
const DATA = loadSharedVisaData(FIXTURE_DATA);
const T = Timestamp.fromMillis(Date.parse("2026-01-01T00:00:00Z"));
const quiet = () => undefined;

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.visaRubrics = fakeCollection("visaRubrics");
  firebase.collections.sharedRoutes = fakeCollection("sharedRoutes");
  firebase.collections.visaExemptions = fakeCollection("visaExemptions");
  firebase.subcollections.rubricVersions = (key: string) => fakeCollection(`visaRubrics/${key}/rubricVersions`);
  firebase.subcollections.authorityMembers = (id: string) => fakeCollection(`authorities/${id}/members`);
  const authorities: any = await import("../../src/authorities/authority.service");
  authorities.authorityService.runTransaction = fakeRunTransaction;
  authorities.authorityService.clock = () => Date.parse("2026-11-14T12:00:00Z");
  const shared: any = await import("../../src/shared-routes/shared-route.service");
  shared.sharedRouteService.runTransaction = fakeRunTransaction;
  shared.sharedRouteService.clock = () => Date.parse("2026-11-14T12:00:00Z");
  migrate = await import("../../src/scripts/shared-visa-model/migrate");
});

/** The dev-shaped fixture. */
function seedDev(): void {
  resetStore();
  // Countries: XA, XB have routes; XC has none; GB has the UK rulebook; NL is absent unless a test adds it.
  for (const [cc, name] of [["XA", "Xaland"], ["XB", "Xbland"], ["XC", "Xcland"], ["GB", "Fixture GB"]]) store.set(`countries/${cc}`, { code: cc, name });
  store.set("countries/XA/visaTypes/xa-visitor", { id: "xa-visitor", countryCode: "XA", name: "XA visitor", isActive: true });
  store.set("countries/GB/visaTypes/gb-visit", { id: "gb-visit", countryCode: "GB", name: "GB visit", isActive: true });
  store.set("visaSources/XB", { id: "XB", countryCode: "XB", pages: [] });
  // Official websites: legacy, already new, and the bloc's host confirmed for country XA.
  store.set("officialDomains/old.example.org", { host: "old.example.org", countryCode: "GB", status: "confirmed", confirmedAt: T });
  store.set("officialDomains/new.example.org", { host: "new.example.org", authorityId: "XB", status: "confirmed", confirmedAt: T });
  store.set(`officialDomains/${BLOC_HOST}`, { host: BLOC_HOST, countryCode: "XA", status: "confirmed", confirmedAt: T });
  // The UK-shaped rulebook: head + approved version 2.
  store.set("visaRubrics/GB_gb-visit", { routeKey: "GB_gb-visit", countryCode: "GB", visaTypeId: "gb-visit", sourceIds: ["g1"], approvedVersion: 2, latestVersion: 2, latestSourceSetHash: "h", createdAt: T, updatedAt: T });
  store.set("visaRubrics/GB_gb-visit/rubricVersions/1", { version: 1, reviewStatus: "superseded", rules: [] });
  store.set("visaRubrics/GB_gb-visit/rubricVersions/2", { version: 2, reviewStatus: "approved", rules: [{ id: "r1", text: "x" }], createdAt: T });
  store.set("guidanceSources/g1", { id: "g1", jurisdiction: "GB", url: "https://old.example.org/g" });
  // Exemptions: the retired seed row and one an admin added.
  store.set("visaExemptions/seedrow", { nationality: "NG", destinationCountry: "IE", requirementType: "visa_required", source: "Irish Naturalisation and Immigration Service (INIS)" });
  store.set("visaExemptions/adminrow", { nationality: "XA", destinationCountry: "XB", requirementType: "visa_free", source: "an admin" });
}

const run = (opts: { dryRun?: boolean; data?: typeof DATA } = {}) => migrate.runSharedVisaMigration({ ...opts, log: quiet });
const snapshotStore = () => JSON.stringify([...store.entries()].map(([k, v]) => [k, migrate.canonical(v)]).sort());
const outcomes = (items: Array<{ id: string; outcome: string }>) => Object.fromEntries(items.map((i) => [i.id, i.outcome]));

describe("dry run", () => {
  beforeEach(seedDev);

  test("writes nothing, and says what apply would do", async () => {
    const before = snapshotStore();
    const r = await run({ dryRun: true, data: DATA });
    assert.equal(writes.length, 0);
    assert.equal(snapshotStore(), before);
    assert.equal(r.dryRun, true);
    // Country authorities: every country with a route (visa record, source entry or website), not XC.
    assert.deepEqual(outcomes(r.countryAuthorities), { GB: "would_create", XA: "would_create", XB: "would_create" });
    assert.deepEqual(outcomes(r.officialDomains), { [BLOC_HOST]: "would_update", "new.example.org": "unchanged", "old.example.org": "would_update" });
    // The retired row is listed (with what it is) and the admin's row is left alone.
    assert.deepEqual(outcomes(r.visaExemptions), { seedrow: "would_delete", adminrow: "unchanged" });
    assert.equal(r.visaExemptions.find((e) => e.id === "seedrow")?.destinationCountry, "IE");
    assert.deepEqual(outcomes(r.sharedData.authorities), { "example-area": "would_create" });
    assert.deepEqual(outcomes(r.sharedData.routes), { "example-short-stay": "would_create" });
    assert.deepEqual(outcomes(r.sharedData.members), { "example-area/XA": "would_create", "example-area/XB": "would_create" });
    assert.deepEqual(outcomes(r.sharedData.inheritance), { "XA/xa-visitor <- example-short-stay": "would_update" });
  });

  test("a member whose host is not confirmed is reported blocked, with the reason", async () => {
    store.delete(`officialDomains/${BLOC_HOST}`);
    const r = await run({ dryRun: true, data: DATA });
    assert.equal(r.sharedData.members.every((m) => m.outcome === "blocked" && /not a confirmed official website/.test(m.reason ?? "")), true);
    assert.equal(writes.length, 0);
  });
});

describe("apply", () => {
  beforeEach(seedDev);

  test("migrates the data as planned", async () => {
    const r = await run({ dryRun: false, data: DATA });
    assert.deepEqual(outcomes(r.countryAuthorities), { GB: "created", XA: "created", XB: "created" });
    assert.equal(store.has("authorities/XC"), false); // no route: no authority
    assert.deepEqual(store.get("authorities/XA") && { kind: (store.get("authorities/XA") as any).kind, name: (store.get("authorities/XA") as any).name }, { kind: "country", name: "Xaland" });

    // officialDomains: authorityId = the old countryCode; the old field is gone; a new-shape doc is untouched.
    assert.equal((store.get("officialDomains/old.example.org") as any).authorityId, "GB");
    assert.equal("countryCode" in (store.get("officialDomains/old.example.org") as any), false);
    assert.equal((store.get("officialDomains/new.example.org") as any).authorityId, "XB");

    // Exemptions: the retired row is deleted, the admin's stays.
    assert.equal(store.has("visaExemptions/seedrow"), false);
    assert.equal(store.has("visaExemptions/adminrow"), true);

    // Shared data, through the services: bloc, members, route, inheritance.
    assert.equal((store.get("authorities/example-area") as any).kind, "bloc");
    assert.equal(store.has("authorities/example-area/members/XA"), true);
    assert.equal((store.get("authorities/example-area/members/XA") as any).sourceQuote, FIXTURE_DATA.authorities[0].members[0].sourceQuote);
    assert.equal((store.get("sharedRoutes/example-short-stay") as any).issuingAuthorityId, "example-area");
    assert.deepEqual((store.get("countries/XA/visaTypes/xa-visitor") as any).inheritsFrom, [{ sharedRouteId: "example-short-stay" }]);
    // Other fields of the visa record survive.
    assert.equal((store.get("countries/XA/visaTypes/xa-visitor") as any).name, "XA visitor");
    // Already-compatible collections were not touched.
    assert.equal(writes.some((w) => w.path.startsWith("visaSources/") || w.path.startsWith("guidanceSources/")), false);
    assert.deepEqual(r.untouched, { visaSources: 1, guidanceSources: 1 });
  });

  test("a second run changes nothing", async () => {
    await run({ dryRun: false, data: DATA });
    writes.length = 0;
    const before = snapshotStore();
    const again = await run({ dryRun: false, data: DATA });
    assert.equal(writes.length, 0);
    assert.equal(snapshotStore(), before);
    const all = [...again.countryAuthorities, ...again.officialDomains, ...again.sharedData.authorities, ...again.sharedData.members, ...again.sharedData.routes, ...again.sharedData.inheritance];
    assert.equal(all.every((i) => i.outcome === "unchanged"), true, JSON.stringify(all.filter((i) => i.outcome !== "unchanged")));
    // The dry run after an apply also plans nothing.
    const dry = await run({ dryRun: true, data: DATA });
    assert.equal(dry.visaExemptions.some((e) => e.outcome === "would_delete"), false);
  });

  test("an empty data file writes no bloc, route or inheritance", async () => {
    const r = await run({ dryRun: false });
    assert.equal(r.sharedData.supplied, false);
    assert.equal([...store.keys()].some((k) => k.startsWith("sharedRoutes/") || k.startsWith("authorities/example")), false);
    assert.equal("inheritsFrom" in (store.get("countries/XA/visaTypes/xa-visitor") as any), false);
  });

  test("a member whose website is not confirmed is blocked and not written; confirming it and re-running completes it", async () => {
    store.delete(`officialDomains/${BLOC_HOST}`);
    const first = await run({ dryRun: false, data: DATA });
    assert.equal(first.sharedData.members.every((m) => m.outcome === "blocked"), true);
    assert.equal(store.has("authorities/example-area/members/XA"), false);
    assert.equal(first.sharedData.inheritance[0].outcome, "blocked"); // the country is not covered yet
    store.set(`officialDomains/${BLOC_HOST}`, { host: BLOC_HOST, authorityId: "example-area", status: "confirmed", confirmedAt: T });
    const second = await run({ dryRun: false, data: DATA });
    assert.deepEqual(outcomes(second.sharedData.members), { "example-area/XA": "created", "example-area/XB": "created" });
    assert.equal(second.sharedData.inheritance[0].outcome, "updated");
  });

  test("website docs that cannot be migrated safely are reported and left alone", async () => {
    store.set("officialDomains/odd.example.org", { host: "odd.example.org", authorityId: "XA", countryCode: "XB", status: "confirmed" });
    store.set("officialDomains/empty.example.org", { host: "empty.example.org", status: "confirmed" });
    const r = await run({ dryRun: false });
    const o = outcomes(r.officialDomains);
    assert.equal(o["odd.example.org"], "conflict");
    assert.equal(o["empty.example.org"], "blocked");
    assert.equal((store.get("officialDomains/odd.example.org") as any).countryCode, "XB");
  });

  test("a country authority that already exists with another name is a conflict, not overwritten", async () => {
    store.set("authorities/XA", { id: "XA", kind: "country", name: "Something else", status: "active" });
    const r = await run({ dryRun: false });
    assert.equal(outcomes(r.countryAuthorities).XA, "conflict");
    assert.equal((store.get("authorities/XA") as any).name, "Something else");
  });
});

describe("the UK rulebook", () => {
  beforeEach(seedDev);

  test("head and approved version are identical before and after an apply, and still serve", async () => {
    const headBefore = migrate.canonical(store.get("visaRubrics/GB_gb-visit"));
    const versionBefore = migrate.canonical(store.get("visaRubrics/GB_gb-visit/rubricVersions/2"));
    const r = await run({ dryRun: false, data: DATA });
    assert.equal(r.rulebooks.identical, true);
    assert.equal(r.rulebooks.ukHeads, 1);
    assert.equal(r.rulebooks.ukApprovedStillServe, true);
    assert.equal(r.rulebooks.before[0].approvedVersion, 2);
    assert.equal(migrate.canonical(store.get("visaRubrics/GB_gb-visit")), headBefore);
    assert.equal(migrate.canonical(store.get("visaRubrics/GB_gb-visit/rubricVersions/2")), versionBefore);
    assert.equal(writes.some((w) => w.path.startsWith("visaRubrics/")), false);
  });

  test("the comparison would notice a changed head or approved version", async () => {
    const a = await migrate.snapshotRulebooks();
    assert.equal(migrate.sameRulebooks(a, await migrate.snapshotRulebooks()), true);
    store.set("visaRubrics/GB_gb-visit/rubricVersions/2", { version: 2, reviewStatus: "approved", rules: [] });
    assert.equal(migrate.sameRulebooks(a, await migrate.snapshotRulebooks()), false);
    store.set("visaRubrics/GB_gb-visit", { ...(store.get("visaRubrics/GB_gb-visit") as any), approvedVersion: 1 });
    assert.equal(migrate.sameRulebooks(a, await migrate.snapshotRulebooks()), false);
  });
});

describe("the Netherlands rulebook report", () => {
  beforeEach(seedDev);

  test("none exists: reported as absent, and none is created", async () => {
    const r = await run({ dryRun: false, data: DATA });
    assert.equal(r.nl.exists, false);
    assert.match(r.nl.summary, /No rulebook exists/);
    assert.equal(store.has("visaRubrics/NL_nl-visitor"), false);
  });

  test("one exists: reported with versions and sources, and left exactly as it is", async () => {
    store.set("countries/NL", { code: "NL", name: "Xetherlands" });
    store.set("visaSources/NL", { id: "NL", countryCode: "NL", pages: [{ url: "https://nl.example.org/a" }, { url: "https://nl.example.org/b" }] });
    store.set("guidanceSources/ng1", { id: "ng1", jurisdiction: "NL" });
    store.set("visaRubrics/NL_nl-visitor", { routeKey: "NL_nl-visitor", sourceIds: ["ng1", "gone"], approvedVersion: 1, latestVersion: 3, updatedAt: T });
    store.set("visaRubrics/NL_nl-visitor/rubricVersions/1", { version: 1, reviewStatus: "approved" });
    store.set("visaRubrics/NL_nl-visitor/rubricVersions/3", { version: 3, reviewStatus: "pending_review" });
    const headBefore = migrate.canonical(store.get("visaRubrics/NL_nl-visitor"));
    const r = await run({ dryRun: false, data: DATA });
    assert.equal(r.nl.exists, true);
    assert.equal(r.nl.approvedVersion, 1);
    assert.equal(r.nl.latestVersion, 3);
    assert.equal(r.nl.versionCount, 2);
    assert.deepEqual(r.nl.sources, [{ id: "ng1", exists: true }, { id: "gone", exists: false }]);
    assert.equal(r.nl.visaSourcePages, 2);
    assert.match(r.nl.summary, /EXISTS/);
    assert.match(r.nl.summary, /NOT re-drafted/);
    assert.equal(migrate.canonical(store.get("visaRubrics/NL_nl-visitor")), headBefore);
    assert.equal(r.rulebooks.identical, true);
  });
});
