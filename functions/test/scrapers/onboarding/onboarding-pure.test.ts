// ============================================
// Route onboarding: pure rules, settings, alert rule, genericness (issue #217)
// ============================================

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { resetStore, store } from "../../helpers/fake-firestore";
import { resolvePublishSettings, addRouteToAllowlist } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { resolveOnboardingSettings, DEFAULT_ONBOARDING_SETTINGS, parseOnboardingSettingsPatch } from "../../../src/scrapers/onboarding/onboarding-settings";
import { OnboardingError, ACTIVE_RUN_STATUSES, RUN_STATUSES, isTerminalRun } from "../../../src/scrapers/onboarding/onboarding-types";
import {
  PIPELINE_MAX_ATTEMPTS, PIPELINE_RETRYABLE_REASONS, buildEstimate, capRefusal, mapJob, mapPublish, planHashOf, publishStateOf,
} from "../../../src/scrapers/onboarding/onboarding-words";
import { evaluateRouteOnboardingAttention, evaluateRouteOnboardingCleared, DEFAULT_CONFIG } from "../../../src/scrapers/shared/alerts/scrape-alert-rules";
import { RETRYABLE_REASONS, MAX_SWEEP_ATTEMPTS } from "../../../src/services/rubric-auto-publish.service";
import { installOnboardingFakes } from "./onboarding-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await installOnboardingFakes();
});
beforeEach(() => resetStore());

const plan = [
  { sourceId: "b", contentHashPrefix: "bbbb", docType: "html" as const, chars: 1000, chunks: 2 },
  { sourceId: "a", contentHashPrefix: "aaaa", docType: "pdf" as const, chars: 500, chunks: 1 },
];

describe("estimate", () => {
  const input = {
    runId: "XA_x__r1", routeKey: "XA_x", plan, sourceFacts: new Map([["a", { title: "A", host: "h.test", role: "primary" }]]),
    extraction: { maxRequestsPerRun: 40, maxInputCharsPerRun: 600_000 }, checkerMaxRequestsPerRun: 120,
    onboarding: { maxChunksPerRun: 20, maxRunsPerDay: 3 }, publishState: { code: "on" as const, plain: "Automatic publishing is on for this route." }, now: Timestamp.fromMillis(0),
  };

  test("calls and tokens follow the stated formulas; the id is stable for the same plan and changes with it", () => {
    const e = buildEstimate(input);
    assert.equal(e.chunks, 3);
    assert.equal(e.characters, 1500);
    assert.equal(e.extractionCallsAtMost, 6);
    assert.equal(e.checkCallsAbout, Math.ceil(3 * 3.7));
    assert.equal(e.inputTokensApprox, 60_000);
    assert.equal(e.outputTokensApprox, 54_000);
    assert.deepEqual(e.sources.map((s) => s.sourceId), ["a", "b"]);
    assert.equal(e.sources[0].host, "h.test");
    assert.equal(buildEstimate(input).estimateId, e.estimateId);
    assert.notEqual(buildEstimate({ ...input, plan: [{ ...plan[0], chars: 1001 }, plan[1]] }).estimateId, e.estimateId);
    assert.notEqual(planHashOf(plan), planHashOf([plan[0]]));
    // The check calls are never more than the checker's cap.
    assert.equal(buildEstimate({ ...input, checkerMaxRequestsPerRun: 5 }).checkCallsAbout, 5);
    assert.match(e.plain, /up to 6 model calls/);
  });

  test("a plan over a cap is refused in words that name the cap; a plan within the caps is not", () => {
    const e = buildEstimate(input);
    assert.equal(capRefusal(e, input.extraction, input.onboarding), null);
    assert.match(capRefusal(e, input.extraction, { maxChunksPerRun: 2 }) as string, /maxChunksPerRun/);
    assert.match(capRefusal(e, { ...input.extraction, maxRequestsPerRun: 5 }, input.onboarding) as string, /maxRequestsPerRun/);
    assert.match(capRefusal(e, { ...input.extraction, maxInputCharsPerRun: 10 }, input.onboarding) as string, /maxInputCharsPerRun/);
  });

  test("the publish state reads in plain words: on, manual mode, not on the allow-list, unreadable", () => {
    const ok = (raw: unknown) => ({ settings: resolvePublishSettings(raw).settings, exists: true, problems: [] });
    assert.equal(publishStateOf(ok({ mode: "auto" }), "XA_x").code, "on");
    assert.equal(publishStateOf(ok({ mode: "auto", routeAllowlist: ["XA_x"] }), "XA_x").code, "on");
    assert.equal(publishStateOf(ok({ mode: "auto", routeAllowlist: ["XA_y"] }), "XA_x").code, "not_on_allowlist");
    assert.equal(publishStateOf(ok({}), "XA_x").code, "off_manual_mode");
    assert.equal(publishStateOf({ ...ok({ mode: "auto" }), readError: "x" }, "XA_x").code, "unknown");
    assert.match(publishStateOf(ok({}), "XA_x").plain, /manual mode/);
  });
});

describe("status mapping", () => {
  test("statuses: four active, five final", () => {
    assert.deepEqual([...ACTIVE_RUN_STATUSES], ["preparing", "awaiting_confirmation", "running", "waiting_for_publish"]);
    assert.deepEqual(RUN_STATUSES.filter(isTerminalRun), ["published", "held", "too_thin", "failed", "cancelled"]);
  });

  test("the retry codes and attempt limit agree with the publishing pipeline's own", () => {
    assert.deepEqual([...PIPELINE_RETRYABLE_REASONS], [...RETRYABLE_REASONS]);
    assert.equal(PIPELINE_MAX_ATTEMPTS, MAX_SWEEP_ATTEMPTS);
  });

  const base = { versionStatus: "pending_review", settings: null, waitedMs: 0, waitLimitMs: 1000 };
  test("pipeline outcomes map exactly as the records and reason codes say", () => {
    const run = (outcome: any, reasonCodes: string[] = [], attempts = 1) => ({ ...base, run: { outcome, reasonCodes, attempts } });
    assert.equal(mapPublish(run("published")).kind === "end" && (mapPublish(run("published")) as any).status, "published");
    const held = mapPublish(run("held", ["rubric_invalid"])) as any;
    assert.equal(held.status, "held");
    assert.match(held.plain, /structural check/);
    assert.equal(held.hold.retryScheduled, false);
    assert.equal((mapPublish(run("held", ["checker_output_invalid"], 2)) as any).hold.retryScheduled, true);
    assert.equal((mapPublish(run("held", ["checker_output_invalid", "rubric_invalid"], 1)) as any).hold.retryScheduled, false);
    assert.equal((mapPublish(run("held", ["no_criteria"])) as any).status, "too_thin");
    assert.equal((mapPublish(run("held", ["primary_source_empty:abc"])) as any).status, "too_thin");
    assert.match((mapPublish(run("skipped", ["route_not_in_allowlist"])) as any).plain, /not on for this route/);
    assert.equal((mapPublish(run("skipped", ["settings_unreadable"])) as any).status, "held");
    // No record yet: wait, unless manual mode (the pipeline writes nothing then) or the wait ran out.
    assert.equal(mapPublish({ ...base, run: null }).kind, "wait");
    const manual = { settings: resolvePublishSettings({}).settings, exists: true, problems: [] };
    assert.equal((mapPublish({ ...base, run: null, settings: manual }) as any).hold.code, "manual_mode");
    const auto = { settings: resolvePublishSettings({ mode: "auto" }).settings, exists: true, problems: [] };
    assert.equal(mapPublish({ ...base, run: null, settings: auto }).kind, "wait");
    assert.equal((mapPublish({ ...base, run: null, settings: auto, waitedMs: 2000 }) as any).hold.code, "no_safeguard_report");
    // An unreadable setting never makes a manual-mode decision.
    assert.equal(mapPublish({ ...base, run: null, settings: { ...manual, readError: "x" } }).kind, "wait");
    // A person's decision wins.
    assert.equal((mapPublish({ ...base, versionStatus: "approved", run: null }) as any).status, "published");
    assert.equal((mapPublish({ ...base, versionStatus: "rejected", run: null }) as any).status, "held");
  });

  test("drafting job statuses map to the run's next move", () => {
    const job = (o: any) => ({ status: "failed", reasonCode: null, message: null, version: null, chunksDone: 1, chunks: 4, ...o });
    assert.equal(mapJob(job({ status: "running" })).kind, "active");
    assert.deepEqual(mapJob(job({ status: "succeeded", version: 2 })), { kind: "drafted", version: 2 });
    assert.deepEqual(mapJob(job({ status: "skipped", reasonCode: "source_unchanged", version: 3 })), { kind: "drafted", version: 3 });
    assert.equal(mapJob(job({ status: "cancelled" })).kind, "cancelled");
    assert.equal(mapJob(job({ reasonCode: "no_criteria_accepted" })).kind, "too_thin");
    const f = mapJob(job({ reasonCode: "mystery", message: "odd" })) as any;
    assert.equal(f.kind, "failed");
    assert.match(f.plain, /odd/);
    assert.match(f.plain, /1 of 4 parts/);
  });
});

describe("settings", () => {
  test("fail closed: off by default, only a real boolean turns it on, bad numbers take the default", () => {
    assert.equal(DEFAULT_ONBOARDING_SETTINGS.enabled, false);
    assert.equal(resolveOnboardingSettings(undefined).settings.enabled, false);
    assert.equal(resolveOnboardingSettings({ enabled: "true" }).settings.enabled, false);
    assert.equal(resolveOnboardingSettings({ enabled: true }).settings.enabled, true);
    const r = resolveOnboardingSettings({ maxRunsPerDay: -1, maxChunksPerRun: 7, supportedLanguages: ["es"] });
    assert.equal(r.settings.maxRunsPerDay, 3);
    assert.equal(r.settings.maxChunksPerRun, 7);
    assert.equal(r.problems.length, 1);
    assert.throws(() => parseOnboardingSettingsPatch({ supportedLanguages: ["es"] }), OnboardingError);
  });
});

describe("the audited allow-list addition", () => {
  const ref = "appConfig/rubricPublishSettings";
  const history = () => [...store.keys()].filter((k) => k.startsWith("rubricPublishSettingsHistory/"));

  test("appends one route, keeps the mode, writes one audit doc; a repeat changes nothing", async () => {
    store.set(ref, { mode: "manual", routeAllowlist: ["XA_a"], previewsPerHour: 1 });
    assert.equal(await addRouteToAllowlist("XA_b", "admin-uid"), "added");
    const doc: any = store.get(ref);
    assert.deepEqual(doc.routeAllowlist, ["XA_a", "XA_b"]);
    assert.equal(doc.mode, "manual");
    assert.equal(history().length, 1);
    const audit: any = store.get(history()[0]);
    assert.equal(audit.by, "admin-uid");
    assert.deepEqual(audit.before.routeAllowlist, ["XA_a"]);
    assert.equal(await addRouteToAllowlist("XA_b", "admin-uid"), "already_allowed");
    assert.equal(history().length, 1);
  });

  test("never creates an allow-list (that would switch every other route off) and never repairs a bad one", async () => {
    store.set(ref, { mode: "auto" });
    assert.equal(await addRouteToAllowlist("XA_b", "admin-uid"), "already_allowed");
    assert.equal((store.get(ref) as any).routeAllowlist, undefined);
    store.set(ref, { mode: "auto", routeAllowlist: "everything" });
    assert.equal(await addRouteToAllowlist("XA_b", "admin-uid"), "refused");
    assert.equal((store.get(ref) as any).routeAllowlist, "everything");
    store.delete(ref);
    assert.equal(await addRouteToAllowlist("XA_b", "admin-uid"), "already_allowed");
    assert.equal(history().length, 0);
    await assert.rejects(() => addRouteToAllowlist("not a key", "u"));
  });
});

describe("the alert rule", () => {
  test("one deduplicated signal per run, linking the run; cleared by scope", () => {
    const e = evaluateRouteOnboardingAttention({ runId: "XA_x__r1", routeKey: "XA_x", status: "held", summary: "Held by the safeguards.", link: "https://a.test/admin/route-onboarding/XA_x__r1" }, DEFAULT_CONFIG);
    assert.equal(e.signals.length, 1);
    assert.equal(e.signals[0].key, "route_onboarding_attention:XA_x__r1");
    assert.equal(e.signals[0].severity, "warning");
    assert.match(e.signals[0].message, /route-onboarding\/XA_x__r1/);
    const again = evaluateRouteOnboardingAttention({ runId: "XA_x__r1", routeKey: "XA_x", status: "held", summary: "again", link: "l" }, DEFAULT_CONFIG);
    assert.equal(again.signals[0].key, e.signals[0].key);
    const cleared = evaluateRouteOnboardingCleared("XA_x__r1");
    assert.equal(cleared.signals.length, 0);
    assert.deepEqual(cleared.scope, { keys: ["route_onboarding_attention:XA_x__r1"] });
  });
});

describe("genericness and boundaries", () => {
  const dir = path.resolve(__dirname, "../../../src/scrapers/onboarding");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));

  test("no country, nationality or publisher name in the code or its messages", () => {
    const banned = /\b(united kingdom|great britain|england|scotland|wales|el salvador|salvador|spain|spanish|france|french|germany|german|nigeria|nigerian|canada|canadian|ireland|irish|australia|india|china|korea|japan|usa|united states|home office|gov\.uk|ircc|schengen|hikorea|uscis|dgme|migracion)\b/i;
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      assert.doesNotMatch(text, banned, f);
    }
  });

  test("the service never starts the publishing pipeline and never edits its mode", () => {
    // Code only: the header comments explain these very rules by name.
    const text = fs.readFileSync(path.join(dir, "route-onboarding.service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(text, /runOnDraft|updatePublishSettings|\.mode\s*=|mode:\s*"auto"/);
    // The only approve/reject path is the cancel's reject.
    assert.doesNotMatch(text, /action:\s*"approve"/);
    assert.doesNotMatch(text, /(isSupported|isActive)\s*:\s*true|reviewStatus\s*:\s*"approved"|updateVisaReviewStatus|updateCountry/);
  });

  test("the new code makes no direct HTTP call and imports no model provider before confirmation", () => {
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      assert.doesNotMatch(text, /\bfetch\(|axios|https?\.request|llm-provider|anthropic/i, f);
    }
  });
});
