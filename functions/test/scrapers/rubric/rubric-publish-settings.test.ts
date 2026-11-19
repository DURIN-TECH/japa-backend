// ============================================
// Automatic rubric publishing (issue #201) — settings and kill switch
// ============================================
//
// `appConfig/rubricPublishSettings` resolves like `rubric-settings.ts` and FAILS
// CLOSED: a missing doc, a failed read or a bad `mode` is `manual`, never `auto`.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fakeCollection, fakeRunTransaction, resetStore, store } from "../../helpers/fake-firestore";
import {
  DEFAULT_CHECKER_CAPS,
  DEFAULT_PUBLISH_SETTINGS,
  PUBLISH_SETTINGS_DOC_ID,
  PublishSettingsValidationError,
  loadPublishSettings,
  parsePublishSettingsPatch,
  publishSettingsTx,
  readPublishSettingsView,
  resolvePublishSettings,
  routeAllowed,
  updatePublishSettings,
} from "../../../src/scrapers/rubric/rubric-publish-settings";
import { quiet } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

let firebase: any;
before(async () => {
  firebase = await import("../../../src/utils/firebase");
  firebase.collections.appConfig = fakeCollection("appConfig");
  firebase.collections.rubricPublishSettingsHistory = fakeCollection("rubricPublishSettingsHistory");
  publishSettingsTx.run = fakeRunTransaction as any;
});
beforeEach(() => resetStore());

describe("publish settings: resolution and fallbacks", () => {
  test("no doc: manual with the issue's defaults, and no allowlist (every route)", () => {
    const { settings, problems } = resolvePublishSettings(undefined);
    assert.deepEqual(settings, { mode: "manual", pauseAfterRollback: true, maxLeftOutShare: 0.15, maxPrimaryLeftOutShare: 0.2, minKeptShareOfServing: 0.7, ordinaryRepairMaxShare: 0.2, ...DEFAULT_CHECKER_CAPS });
    assert.deepEqual(problems, []);
    assert.equal(routeAllowed(settings, "XA_any"), true);
  });

  test("a valid doc is used as it is", () => {
    const { settings, problems } = resolvePublishSettings({ mode: "auto", routeAllowlist: ["XA_xa-short-visit"], pauseAfterRollback: false, maxLeftOutShare: 0.1, maxPrimaryLeftOutShare: 0.3, minKeptShareOfServing: 0.9 });
    assert.deepEqual(settings, { mode: "auto", routeAllowlist: ["XA_xa-short-visit"], pauseAfterRollback: false, maxLeftOutShare: 0.1, maxPrimaryLeftOutShare: 0.3, minKeptShareOfServing: 0.9, ordinaryRepairMaxShare: 0.2, ...DEFAULT_CHECKER_CAPS });
    assert.deepEqual(problems, []);
    assert.equal(routeAllowed(settings, "XA_xa-short-visit"), true);
    assert.equal(routeAllowed(settings, "XZ_other"), false);
  });

  test("mode is `auto` ONLY for the exact string; anything else is manual", () => {
    for (const mode of ["AUTO", "true", true, 1, null, {}, "automatic"]) {
      const { settings } = resolvePublishSettings({ mode });
      assert.equal(settings.mode, "manual", JSON.stringify(mode));
    }
    assert.equal(resolvePublishSettings({ mode: "auto" }).settings.mode, "auto");
  });

  test("an out-of-range or mistyped value falls back to its default and is reported", () => {
    const { settings, problems } = resolvePublishSettings({ maxLeftOutShare: 1.5, maxPrimaryLeftOutShare: "x", minKeptShareOfServing: -0.1, pauseAfterRollback: "yes" });
    assert.equal(settings.maxLeftOutShare, DEFAULT_PUBLISH_SETTINGS.maxLeftOutShare);
    assert.equal(settings.maxPrimaryLeftOutShare, DEFAULT_PUBLISH_SETTINGS.maxPrimaryLeftOutShare);
    assert.equal(settings.minKeptShareOfServing, DEFAULT_PUBLISH_SETTINGS.minKeptShareOfServing);
    assert.equal(settings.pauseAfterRollback, true);
    assert.equal(problems.length, 4);
  });

  test("a malformed allowlist FAILS CLOSED: it publishes nowhere, not everywhere", () => {
    for (const bad of ["XA_x", [1], ["not a route key"], ["xa_lower"]]) {
      const { settings, problems } = resolvePublishSettings({ mode: "auto", routeAllowlist: bad });
      assert.deepEqual(settings.routeAllowlist, [], JSON.stringify(bad));
      assert.equal(problems.length, 1);
      assert.equal(routeAllowed(settings, "XA_xa-short-visit"), false);
    }
  });

  test("a non-object doc is treated as empty", () => {
    assert.equal(resolvePublishSettings("auto").settings.mode, "manual");
    assert.equal(resolvePublishSettings([]).settings.mode, "manual");
  });
});

describe("publish settings: loading", () => {
  test("a missing doc is manual and is not a read error", async () => {
    const r = await loadPublishSettings();
    assert.equal(r.settings.mode, "manual");
    assert.equal(r.exists, false);
    assert.equal(r.readError, undefined);
  });

  test("a stored doc is read", async () => {
    store.set(`appConfig/${PUBLISH_SETTINGS_DOC_ID}`, { mode: "auto" });
    const r = await loadPublishSettings();
    assert.equal(r.settings.mode, "auto");
    assert.equal(r.exists, true);
  });

  test("a failed read resolves to manual and reports readError; it never throws and never says auto", async () => {
    const real = firebase.collections.appConfig;
    firebase.collections.appConfig = { doc: () => ({ get: async () => { throw Object.assign(new Error("boom: secret path /x/y"), { code: 14 }); } }) };
    try {
      const { result } = await quiet(() => loadPublishSettings());
      assert.equal(result.settings.mode, "manual");
      assert.match(result.readError ?? "", /failed/);
      assert.doesNotMatch(result.readError ?? "", /secret path/, "the error message (which can carry a path) is not kept");
    } finally {
      firebase.collections.appConfig = real;
    }
  });
});

describe("publish settings: the admin edit", () => {
  test("a patch is strict: unknown keys, wrong types, out-of-range values and an empty body are refused", () => {
    const bad: unknown[] = [null, [], {}, { nope: 1 }, { mode: "AUTO" }, { routeAllowlist: "XA_x" }, { routeAllowlist: ["bad key"] }, { pauseAfterRollback: "true" }, { maxLeftOutShare: 2 }, { minKeptShareOfServing: "0.5" }, { maxPrimaryLeftOutShare: NaN }];
    for (const b of bad) assert.throws(() => parsePublishSettingsPatch(b), PublishSettingsValidationError, JSON.stringify(b));
  });

  test("a valid patch parses; a null allowlist means clear it", () => {
    assert.deepEqual(parsePublishSettingsPatch({ mode: "auto", routeAllowlist: ["XA_a", "XA_a"], maxLeftOutShare: 0 }), { mode: "auto", routeAllowlist: ["XA_a"], maxLeftOutShare: 0 });
    assert.deepEqual(parsePublishSettingsPatch({ routeAllowlist: null }), { routeAllowlist: null });
  });

  test("updating writes the doc and ONE audit doc (who, before, after); a null allowlist drops the key", async () => {
    store.set(`appConfig/${PUBLISH_SETTINGS_DOC_ID}`, { mode: "manual", routeAllowlist: ["XA_a"] });
    const view = await updatePublishSettings({ mode: "auto", routeAllowlist: null }, "admin-uid");
    assert.equal(view.settings.mode, "auto");
    assert.equal(view.settings.routeAllowlist, undefined);
    assert.deepEqual(store.get(`appConfig/${PUBLISH_SETTINGS_DOC_ID}`), { mode: "auto" });
    const audits = [...store.entries()].filter(([p]) => p.startsWith("rubricPublishSettingsHistory/")).map(([, d]) => d as any);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].by, "admin-uid");
    assert.deepEqual(audits[0].before, { mode: "manual", routeAllowlist: ["XA_a"] });
    assert.deepEqual(audits[0].after, { mode: "auto" });
  });

  test("the first write on a missing doc has a null `before`", async () => {
    await updatePublishSettings({ mode: "manual" }, "admin-uid");
    const audit: any = [...store.entries()].find(([p]) => p.startsWith("rubricPublishSettingsHistory/"))?.[1];
    assert.equal(audit.before, null);
    assert.deepEqual(audit.after, { mode: "manual" });
  });

  test("an edit needs an author", async () => {
    await assert.rejects(updatePublishSettings({ mode: "auto" }, ""), /uid/);
    assert.equal((await readPublishSettingsView()).exists, false);
  });
});
