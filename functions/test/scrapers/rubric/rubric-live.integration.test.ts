// ============================================
// Rubric extraction (issue #40) — LIVE smoke test (opt-in)
// ============================================
//
// Sends ONE synthetic guidance page to the real model through the real
// provider, then runs the answer through the same code-side validation the
// service uses. It proves the request shape is accepted by the API and that
// a real answer follows the output schema. It writes nothing anywhere.
//
// SKIPPED BY DEFAULT: `npm test` never calls a model. It costs money and
// needs a key. To run it (from functions/):
//
//   RUBRIC_LIVE_TEST=1 node --env-file-if-exists=.env.local --import tsx \
//     --import ./test/helpers/setup.ts \
//     --test test/scrapers/rubric/rubric-live.integration.test.ts
//
// The document is the invented one from fixtures/synthetic-guidance.ts: no
// real rule is sent, and nothing about a real route is asserted.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AnthropicLlmProvider } from "../../../src/services/ai/llm-provider";
import { chunkSnapshot } from "../../../src/scrapers/rubric/rubric-chunk";
import { buildRubricRequest, parseRubricOutput } from "../../../src/scrapers/rubric/rubric-prompt";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { assessChunkOutput } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { DEFAULT_SEVERITY_LEVELS } from "../../../src/types/rubric";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { A_TEXT_INJECTED, SOURCE_A_ID, SOURCE_A_URL } from "./fixtures/synthetic-guidance";

// Opt-in switch. Anything but "1" skips the test.
const LIVE = process.env.RUBRIC_LIVE_TEST === "1";

describe("rubric extraction: live smoke test", { skip: !LIVE }, () => {
  test("a synthetic page is extracted, and only verbatim, number-backed criteria survive", async () => {
    const snapshot: GuidanceSnapshotContent = {
      schemaVersion: 1,
      sourceId: SOURCE_A_ID,
      contentHash: createHash("sha256").update(A_TEXT_INJECTED).digest("hex"),
      docType: "html",
      url: SOURCE_A_URL,
      finalUrl: SOURCE_A_URL,
      fetchedAt: new Date().toISOString(),
      text: A_TEXT_INJECTED,
      pages: null,
    };
    const [chunk] = chunkSnapshot(snapshot, 24_000);
    const request = buildRubricRequest(chunk, DEFAULT_SEVERITY_LEVELS, { maxOutputTokens: 16_000, timeoutMs: 240_000 });
    const response = await new AnthropicLlmProvider().complete(request);
    assert.equal(response.stopReason, "end_turn");
    assert.ok(response.usage.inputTokens > 0);

    // Throws when the answer does not follow the schema.
    const raw = parseRubricOutput(response.text, request.schema);
    const assessed = assessChunkOutput(raw, chunk, new SnapshotQuoteIndex(snapshot), { sourceId: SOURCE_A_ID, url: SOURCE_A_URL, contentHash: snapshot.contentHash, retrievedAt: snapshot.fetchedAt }, DEFAULT_SEVERITY_LEVELS);

    // Counts and reasons only: never the text.
    console.log(`live: ${raw.criteria.length} proposed, ${assessed.criteria.length} accepted, ${assessed.discards.length} discarded (${assessed.discards.map((d) => d.reason).join(", ") || "none"}), ${assessed.suspiciousPassages.length} flagged passage(s); tokens in=${response.usage.inputTokens} out=${response.usage.outputTokens}`);
    assert.ok(assessed.criteria.length > 0, "at least one criterion survives validation");
    // Whatever the model did with the injected line, no accepted criterion
    // states the figure it tried to plant.
    assert.ok(!assessed.criteria.some((c) => c.criterion.check?.value === 9999));
  });
});
