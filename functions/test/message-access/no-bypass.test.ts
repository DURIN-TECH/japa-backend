// ============================================
// Build guard: no way around the message-access helper (issue #172)
// ============================================
//
// `services/message-access.service.ts` is the only code allowed to return chat
// message content for AI use. This test reads the source tree and fails when:
//  1. any file other than the helper both reads the chat messages collection
//     (`subcollections.messages(`, `collection("messages")`,
//     `collectionGroup("messages")`) AND imports a model provider
//     (llm-provider, batch-provider, anthropic-client); or
//  2. any file that imports a model provider also imports the messaging
//     service (the other way message text could reach a prompt); or
//  3. the files named in the issue (ai-chat, ai-case-officer, the assessment
//     engine, rubric/bulk re-assessment) read `conversations/*/messages`.
// Also proves the guard bites: a synthetic offender is caught by the same check.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const SRC = path.resolve(__dirname, "../../src");
const HELPER = path.join("services", "message-access.service.ts");

/** Every .ts file under src, as [relative path, text]. */
function sourceFiles(dir = SRC, out: [string, string][] = []): [string, string][] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith(".ts")) out.push([path.relative(SRC, p), fs.readFileSync(p, "utf8")]);
  }
  return out;
}

/** Strip comments so a mention in a comment is not a read. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const READS_MESSAGES = /subcollections\s*\.\s*messages\s*\(|collection(Group)?\(\s*["'`]messages["'`]\s*\)/;
const IMPORTS_PROVIDER = /from\s+["'][^"']*(llm-provider|batch-provider|anthropic-client)["']/;
const IMPORTS_MESSAGING = /from\s+["'][^"']*messaging\.service["']/;

/** Offenders in a list of [path, text]. */
function offenders(files: [string, string][]): string[] {
  const bad: string[] = [];
  for (const [rel, text] of files) {
    if (rel === HELPER) continue;
    const c = code(text);
    if (READS_MESSAGES.test(c) && IMPORTS_PROVIDER.test(c)) bad.push(`${rel}: reads chat messages AND imports a model provider`);
    if (IMPORTS_MESSAGING.test(c) && IMPORTS_PROVIDER.test(c)) bad.push(`${rel}: imports messaging.service AND a model provider`);
  }
  return bad;
}

describe("no bypass of the message-access helper", () => {
  const files = sourceFiles();

  test("the helper exists and is the file that reads messages for AI", () => {
    const helper = files.find(([rel]) => rel === HELPER);
    assert.ok(helper, "services/message-access.service.ts must exist");
    assert.match(code(helper[1]), READS_MESSAGES);
  });

  test("no other file reads chat messages and talks to a model provider", () => {
    assert.deepEqual(offenders(files), []);
  });

  test("the AI services named in the issue do not read conversations/*/messages today", () => {
    const named = [
      "services/ai-chat.service.ts",
      "services/ai-case-officer.service.ts",
      "services/ai/assessment-engine.ts",
      "services/ai-bulk-reassessment.service.ts",
      "services/rubric-review.service.ts",
    ];
    for (const rel of named) {
      const f = files.find(([r]) => r.split(path.sep).join("/") === rel);
      assert.ok(f, `${rel} should exist`);
      assert.ok(!READS_MESSAGES.test(code(f[1])), `${rel} must not read chat messages`);
      assert.ok(!IMPORTS_MESSAGING.test(code(f[1])), `${rel} must not import messaging.service`);
    }
  });

  test("the guard bites: synthetic offenders are caught", () => {
    const offenderA: [string, string] = [
      "services/sneaky.ts",
      `import { callModel } from "./ai/llm-provider";\nconst m = subcollections.messages(id).get();`,
    ];
    const offenderB: [string, string] = [
      "services/sneaky2.ts",
      `import { messagingService } from "./messaging.service";\nimport { x } from "./ai/batch-provider";`,
    ];
    const ok: [string, string] = ["services/fine.ts", `// subcollections.messages( in a comment\nimport { callModel } from "./ai/llm-provider";`];
    assert.equal(offenders([offenderA]).length, 1);
    assert.equal(offenders([offenderB]).length, 1);
    assert.equal(offenders([ok]).length, 0);
  });
});
