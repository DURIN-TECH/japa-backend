// ============================================
// Unit tests — shared Anthropic client factory (issue DURIN-TECH/japa#31)
// ============================================
//
// Run with `npm test`. Covers src/services/ai/anthropic-client.ts,
// src/services/ai/ai-models.ts and the secret binding in src/index.ts:
//  - missing / blank ANTHROPIC_API_KEY throws the clear, actionable
//    AnthropicNotConfiguredError (the acceptance criterion's missing-key path);
//  - with a key, the client is built once and memoised (the key is read once);
//  - describeAnthropicError() never lets the key (or a bearer token) through;
//  - model ids live in the one config module, one per role;
//  - `api` (and only `api`, for now) binds ANTHROPIC_API_KEY, and nothing in
//    functions/src uses the Gen-2 `defineSecret`.
//
// Hermetic: no test here makes a network call. Building the SDK client does
// not contact the API, and the key used is an obviously fake placeholder.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AI_SECRETS,
  ANTHROPIC_API_KEY_ENV,
  AnthropicNotConfiguredError,
  describeAnthropicError,
  getAnthropicClient,
  resetAnthropicClientForTests,
} from "../../src/services/ai/anthropic-client";
import { AI_MODELS } from "../../src/services/ai/ai-models";

/** A fake key: right shape for redaction tests, valid nowhere. */
const FAKE_KEY = "test-not-a-real-key-0123456789";

/** Whatever the developer's shell had, restored after the file. */
const originalKey = process.env[ANTHROPIC_API_KEY_ENV];

beforeEach(() => {
  // Each test starts with no key and no memoised client.
  delete process.env[ANTHROPIC_API_KEY_ENV];
  resetAnthropicClientForTests();
});

after(() => {
  if (originalKey === undefined) delete process.env[ANTHROPIC_API_KEY_ENV];
  else process.env[ANTHROPIC_API_KEY_ENV] = originalKey;
  resetAnthropicClientForTests();
});

describe("getAnthropicClient — missing key", () => {
  test("throws a clear, actionable error when ANTHROPIC_API_KEY is unset", () => {
    assert.throws(
      () => getAnthropicClient(),
      (err: unknown) => {
        assert.ok(err instanceof AnthropicNotConfiguredError);
        // The exact phrase the issue asks for, plus the project and the fix.
        assert.match(err.message, /ANTHROPIC_API_KEY is not set for this project/);
        assert.match(err.message, /demo-unit-test/);
        assert.match(err.message, /firebase functions:secrets:set ANTHROPIC_API_KEY/);
        assert.match(err.message, /\.env\.local/);
        return true;
      }
    );
  });

  test("treats an empty or whitespace-only value as unset", () => {
    for (const blank of ["", "   ", "\n"]) {
      process.env[ANTHROPIC_API_KEY_ENV] = blank;
      assert.throws(() => getAnthropicClient(), AnthropicNotConfiguredError);
    }
  });

  test("a missing key is not cached: setting it afterwards works", () => {
    assert.throws(() => getAnthropicClient(), AnthropicNotConfiguredError);
    process.env[ANTHROPIC_API_KEY_ENV] = FAKE_KEY;
    assert.ok(getAnthropicClient());
  });
});

describe("getAnthropicClient — configured", () => {
  test("builds the client with the key (trimmed) and memoises it", () => {
    // Trailing newline: what a secret piped from a file often carries.
    process.env[ANTHROPIC_API_KEY_ENV] = `${FAKE_KEY}\n`;
    const first = getAnthropicClient();
    assert.equal(first.apiKey, FAKE_KEY);
    assert.equal(typeof first.messages.create, "function");

    // Read once: a later env change does not produce a different client.
    process.env[ANTHROPIC_API_KEY_ENV] = "another-fake-key-zzzzzzzz";
    assert.equal(getAnthropicClient(), first);
    assert.equal(getAnthropicClient().apiKey, FAKE_KEY);
  });

  test("ignores ANTHROPIC_AUTH_TOKEN: only the bound secret is a credential", () => {
    const originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "fake-auth-token-should-be-ignored";
    try {
      // No API key => still "not configured", whatever else is in the env.
      assert.throws(() => getAnthropicClient(), AnthropicNotConfiguredError);
    } finally {
      if (originalToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
    }
  });
});

describe("describeAnthropicError — the key never reaches logs", () => {
  test("redacts the configured key and bearer tokens from the message", () => {
    process.env[ANTHROPIC_API_KEY_ENV] = FAKE_KEY;
    const err = new Error(`upstream echoed ${FAKE_KEY}, Authorization: Bearer abcdef123456 and x-api-key: zyxwvu987654`);
    const line = describeAnthropicError(err);
    assert.ok(!line.includes(FAKE_KEY));
    assert.ok(!line.includes("abcdef123456"));
    assert.ok(!line.includes("zyxwvu987654"));
    assert.match(line, /\[REDACTED\]/);
  });

  test("keeps status, type and request id; drops everything else on the error", () => {
    process.env[ANTHROPIC_API_KEY_ENV] = FAKE_KEY;
    // Shaped like the SDK's APIError, with a headers bag that must NOT be printed.
    const err = Object.assign(new Error("401 invalid x-api-key"), {
      status: 401,
      type: "authentication_error",
      requestID: "req_123",
      headers: { authorization: `Bearer ${FAKE_KEY}` },
    });
    const line = describeAnthropicError(err);
    assert.match(line, /status=401/);
    assert.match(line, /type=authentication_error/);
    assert.match(line, /request_id=req_123/);
    assert.ok(!line.includes(FAKE_KEY));
  });

  test("handles non-Error values", () => {
    assert.equal(describeAnthropicError("boom"), "boom");
  });
});

describe("AI_MODELS — one config module for model ids", () => {
  test("maps each role to a current Claude model id", () => {
    assert.deepEqual(
      { ...AI_MODELS },
      {
        extraction: "claude-haiku-5-5",
        drafting: "claude-sonnet-5-5",
        judgement: "claude-opus-5-5",
        verification: "claude-sonnet-5-5",
      }
    );
  });

  test("no other file in functions/src writes a claude-* model id", () => {
    const offenders = sourceFiles().filter(
      (f) => !f.endsWith(path.join("services", "ai", "ai-models.ts")) && /["'`]claude-[a-z0-9-]+["'`]/.test(fs.readFileSync(f, "utf8"))
    );
    assert.deepEqual(offenders, []);
  });
});

describe("secret binding in src/index.ts (Gen 1 runWith)", () => {
  /** src/index.ts as text: importing it would initialise every trigger. */
  const indexSource = fs.readFileSync(path.join(srcDir(), "index.ts"), "utf8");

  /** The `.runWith({...})` options of the exported function `name`. */
  function runWithOf(name: string): string {
    const start = indexSource.indexOf(`export const ${name} = functions`);
    assert.notEqual(start, -1, `export ${name} not found`);
    const from = indexSource.indexOf(".runWith(", start);
    // The options end where the trigger type starts (`.https` / `.firestore`).
    const to = indexSource.slice(from).search(/\)\s*\.(https|firestore|pubsub|auth)\b/);
    return indexSource.slice(from, from + to);
  }

  test("AI_SECRETS is exactly [\"ANTHROPIC_API_KEY\"], exported from one place", () => {
    assert.deepEqual(AI_SECRETS, ["ANTHROPIC_API_KEY"]);
    // index.ts imports the list; it does not declare a second copy.
    assert.match(indexSource, /import \{ AI_SECRETS \} from "\.\/services\/ai\/anthropic-client";/);
    assert.doesNotMatch(indexSource, /const AI_SECRETS\b/);
  });

  test("`api` spreads AI_SECRETS and keeps what it bound before", () => {
    assert.match(runWithOf("api"), /\.\.\.AI_SECRETS/);
    assert.match(runWithOf("api"), /\.\.\.EMAIL_SECRETS/);
    assert.match(runWithOf("api"), /\.\.\.VERIFICATION_SECRETS/);
  });

  test("`onApplicationUpdated` does NOT bind the key (it only enqueues; #42's worker binds it)", () => {
    assert.doesNotMatch(runWithOf("onApplicationUpdated"), /AI_SECRETS/);
    assert.match(runWithOf("onApplicationUpdated"), /EMAIL_SECRETS/);
  });

  test("only the named AI functions are bound (issues #42, #37, #115, #117, #118, #201, #202)", () => {
    // TODO(test-pass): was "api + the assessment worker" (count 2). The later AI
    // tasks each bind the key on their OWN worker, as the AI_SECRETS comment in
    // index.ts says they would. The list is explicit so a new binding must be a
    // conscious edit here: the count pins "no other function gets the key".
    const BOUND = [
      "api",
      "processAssessmentJob",
      "onGuidanceSourceChanged",
      // #201: the automatic rubric publisher binds the key for the independent
      // check (part B, #202); part A makes no model call itself. A conscious,
      // EXPLICIT extension of this list.
      "onRubricVersionCreated",
      // #202: the hourly sweep re-runs held drafts, so it runs the check too.
      "sweepHeldRubricDrafts",
      // #216: the worker of the resumable rulebook drafting job makes the
      // model calls of a draft. The sweep that wakes it binds NO key.
      "processRubricExtractionJob",
      "processBulkReassessments",
      "processDocumentCheck",
      "processRefusalAnalysisJob",
    ];
    // Spreads of the list inside a runWith (comments mention it without `...`).
    assert.equal(indexSource.match(/\.\.\.AI_SECRETS/g)?.length, BOUND.length);
    for (const name of BOUND) assert.match(runWithOf(name), /\.\.\.AI_SECRETS/, `${name} binds the key`);
  });

  test("nothing in functions/src uses the Gen-2 defineSecret", () => {
    const offenders = sourceFiles().filter((f) => fs.readFileSync(f, "utf8").includes("defineSecret"));
    assert.deepEqual(offenders, []);
  });
});

// ============================================
// Helpers
// ============================================

/** Absolute path of functions/src (a function, so it is hoisted above the suites that use it). */
function srcDir(): string {
  return path.resolve(__dirname, "..", "..", "src");
}

/** Every .ts file under functions/src. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(srcDir());
  return out;
}
