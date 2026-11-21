// ============================================
// The intake schema probe (issue #456): offline by default, ONE request live
// ============================================
//
// No network: the live path is exercised with a fake sender only. Covers:
//  - offline: nothing is sent, the sender is never called, the schema hash
//    and size are printed (and the command line, run for real, reads no key);
//  - the request is the production one: `messageParamsFor`, the byte-identical
//    `buildIntakeOutputSchema()`, the judgement model, a fixed document-free
//    text, `max_tokens` 256, effort low, no tools, no strict flag, SDK retry
//    off, a timeout over the provider's 180 s compile timeout;
//  - live: exactly one send; HTTP 200 (any stop reason) is ACCEPTED, a 400
//    about the grammar is REFUSED, anything else is an ERROR; the answer text
//    and the provider's message are never printed.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PROBE_TEXT, outcomeOfError, probePlan, runProbe, type ProbeSend } from "../../../src/scrapers/rubric/scripts/probe-intake-schema";
import { buildIntakeOutputSchema } from "../../../src/scrapers/rubric/rubric-prompt";
import { AI_MODELS } from "../../../src/services/ai/ai-models";
import { messageParamsFor } from "../../../src/services/ai/llm-provider";

/** Collect printed lines. */
const collector = () => {
  const lines: string[] = [];
  return { lines, print: (l: string) => lines.push(l) };
};

describe("probe-intake-schema: the request", () => {
  test("is the production params builder around the byte-identical intake schema, on the judgement model", () => {
    const plan = probePlan();
    assert.equal(plan.model, AI_MODELS.judgement);
    assert.equal(JSON.stringify(plan.request.schema), JSON.stringify(buildIntakeOutputSchema()));
    assert.deepEqual(plan.params, messageParamsFor(plan.request, AI_MODELS.judgement));
    assert.equal(plan.schemaHash, createHash("sha256").update(JSON.stringify(buildIntakeOutputSchema())).digest("hex"));
    // Fixed, document-free text; small and cheap; no retry; a timeout above the 180 s compile timeout.
    assert.equal(plan.request.system, PROBE_TEXT);
    assert.equal(plan.request.user, PROBE_TEXT);
    assert.equal(plan.request.documents, undefined);
    assert.equal(plan.params.max_tokens, 256);
    assert.equal(plan.params.output_config?.effort, "low");
    assert.equal(plan.request.maxRetries, 0);
    assert.ok(plan.request.timeoutMs >= 200_000);
    // Still no tools and no strict flag (the format production sends).
    assert.equal("tools" in plan.params, false);
    assert.equal(JSON.stringify(plan.params).includes("strict"), false);
    assert.deepEqual(plan.params.output_config?.format, { type: "json_schema", schema: buildIntakeOutputSchema() });
  });
});

describe("probe-intake-schema: offline by default", () => {
  test("offline sends nothing and prints the hash and the measured counts", async () => {
    let sent = 0;
    const send: ProbeSend = async () => {
      sent += 1;
      throw new Error("must not be called");
    };
    const { lines, print } = collector();
    const r = await runProbe({ live: false, send, print });
    assert.equal(sent, 0);
    assert.equal(r.requests, 0);
    assert.equal(r.outcome, null);
    assert.ok(lines[0].includes(r.plan.schemaHash));
    assert.ok(lines.some((l) => /optional 11, unions 0, max depth 5/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("0 requests sent")));
  });

  test("the command line, without --live, exits 0 with no key set; an unknown argument is refused (exit 2)", () => {
    const script = join(__dirname, "../../../src/scrapers/rubric/scripts/probe-intake-schema.ts");
    const env = { ...process.env, ANTHROPIC_API_KEY: "" };
    const offline = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", env });
    assert.equal(offline.status, 0, offline.stderr);
    assert.match(offline.stdout, /0 requests sent/);
    const bad = spawnSync(process.execPath, ["--import", "tsx", script, "--liev"], { encoding: "utf8", env });
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, "");
  });
});

describe("probe-intake-schema: live (fake sender)", () => {
  test("HTTP 200 is ACCEPTED whatever the stop reason; one send; no answer text printed", async () => {
    for (const stopReason of ["end_turn", "max_tokens"]) {
      let sent = 0;
      const send: ProbeSend = async () => {
        sent += 1;
        return { status: 200, stopReason, usage: { input_tokens: 1500, output_tokens: 256 } };
      };
      const { lines, print } = collector();
      const r = await runProbe({ live: true, send, print });
      assert.equal(sent, 1);
      assert.equal(r.requests, 1);
      assert.equal(r.outcome?.verdict, "accepted");
      assert.ok(lines.includes(`live: HTTP 200, stop_reason ${stopReason}, input tokens 1500, output tokens 256`), lines.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("ACCEPTED") && l.includes(r.plan.schemaHash)));
    }
  });

  test("a 400 about the grammar is REFUSED; its message is never printed", async () => {
    const err = Object.assign(new Error("400 The compiled grammar is too large, which would cause performance issues. LEAK-8810"), { status: 400, error: { error: { type: "invalid_request_error" } } });
    const { lines, print } = collector();
    const r = await runProbe({ live: true, send: async () => Promise.reject(err), print });
    assert.equal(r.outcome?.verdict, "refused");
    assert.ok(lines.includes("live: HTTP 400, error type invalid_request_error"), lines.join("\n"));
    assert.ok(lines.some((l) => l.startsWith("REFUSED")));
    assert.doesNotMatch(lines.join("\n"), /LEAK-|grammar is too large/);
  });

  test("anything else is an ERROR that says nothing about the schema", () => {
    assert.equal(outcomeOfError(Object.assign(new Error("overloaded"), { status: 529 })).verdict, "error");
    assert.equal(outcomeOfError(Object.assign(new Error("max_tokens: too large"), { status: 400 })).verdict, "error");
    assert.equal(outcomeOfError(Object.assign(new Error("Connection error."), {})).verdict, "error");
    assert.deepEqual(outcomeOfError(Object.assign(new Error("Schema is too complex for compilation"), { status: 400, type: "invalid_request_error" })), { verdict: "refused", status: 400, errorType: "invalid_request_error" });
  });
});
