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

/** A module specifier reached by static import, dynamic import() or require(). */
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

/** Every module specifier a file pulls in, by any of the three syntaxes. */
function specifiers(c: string): string[] {
  return [...c.matchAll(SPECIFIER)].map((m) => m[1]);
}

/** A model provider: the app's wrappers or the SDK itself. */
const PROVIDER = /(llm-provider|batch-provider|anthropic-client|@anthropic-ai\/sdk)/;

/** Resolve a relative specifier from `fromRel` to a path key in `files` (or undefined). */
function resolveRel(fromRel: string, spec: string, keys: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel.split(path.sep).join("/")), spec));
  return [`${base}.ts`, `${base}/index.ts`, base].find((k) => keys.has(k));
}

/** Offenders in a list of [path, text]. */
function offenders(files: [string, string][]): string[] {
  const norm = files.map(([rel, text]) => [rel.split(path.sep).join("/"), code(text)] as [string, string]);
  const keys = new Set(norm.map(([rel]) => rel));
  const helper = HELPER.split(path.sep).join("/");
  // Files that read chat messages directly (the helper excluded: it is the allowed reader).
  // `utils/firebase.ts` only DEFINES the `subcollections.messages` accessor (and every file
  // imports it); the call sites are what count, and they are caught as readers themselves.
  const readers = new Set(norm.filter(([rel, c]) => rel !== helper && rel !== "utils/firebase.ts" && READS_MESSAGES.test(c)).map(([rel]) => rel));
  const bad: string[] = [];
  for (const [rel, c] of norm) {
    if (rel === helper) continue;
    const specs = specifiers(c);
    if (!specs.some((sp) => PROVIDER.test(sp))) continue;
    if (READS_MESSAGES.test(c)) bad.push(`${rel}: reads chat messages AND uses a model provider`);
    if (specs.some((sp) => /messaging\.service$/.test(sp))) bad.push(`${rel}: imports messaging.service AND a model provider`);
    // One hop of indirection: imports a file that itself reads chat messages.
    for (const sp of specs) {
      const target = resolveRel(rel, sp, keys);
      if (target && readers.has(target)) bad.push(`${rel}: imports ${target} (reads chat messages) AND a model provider`);
    }
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
      assert.ok(!specifiers(code(f[1])).some((sp) => /messaging\.service$/.test(sp)), `${rel} must not import messaging.service`);
    }
  });

  test("the guard bites: synthetic offenders are caught, one per route", () => {
    const reader: [string, string] = ["services/reader.ts", "export const r = () => subcollections.messages(id).get();"];
    const cases: [string, [string, string][]][] = [
      ["static import + read", [["services/a.ts", "import { callModel } from \"./ai/llm-provider\";\nconst m = subcollections.messages(id).get();"]]],
      ["collection(\"messages\") + batch provider", [["services/b.ts", "import { x } from \"./ai/batch-provider\";\ndb.collection(\"messages\");"]]],
      ["dynamic import() of the provider", [["services/c.ts", "const p = await import(\"./ai/llm-provider\");\nsubcollections.messages(id);"]]],
      ["require() of the provider", [["services/d.ts", "const p = require(\"./ai/anthropic-client\");\ncollectionGroup(\"messages\");"]]],
      ["direct SDK import", [["services/e.ts", "import Anthropic from \"@anthropic-ai/sdk\";\nsubcollections.messages(id);"]]],
      ["messaging.service + provider", [["services/f.ts", "import { messagingService } from \"./messaging.service\";\nimport { x } from \"./ai/batch-provider\";"]]],
      ["one hop: imports a reader + provider", [reader, ["services/g.ts", "import { r } from \"./reader\";\nimport { x } from \"./ai/llm-provider\";"]]],
      ["one hop via dynamic import", [reader, ["services/h.ts", "const r = await import(\"./reader\");\nconst p = require(\"./ai/llm-provider\");"]]],
    ];
    for (const [name, files] of cases) assert.ok(offenders(files).length >= 1, `not caught: ${name}`);
    const ok: [string, string] = ["services/fine.ts", "// subcollections.messages( in a comment\nimport { callModel } from \"./ai/llm-provider\";"];
    assert.equal(offenders([ok]).length, 0);
    // Using the helper next to a provider is the intended path.
    const viaHelper: [string, string] = ["services/consumer.ts", "import { messageAccessService } from \"./message-access.service\";\nimport { x } from \"./ai/llm-provider\";"];
    assert.equal(offenders([viaHelper, ["services/message-access.service.ts", "subcollections.messages(id)"]]).length, 0);
  });
});
