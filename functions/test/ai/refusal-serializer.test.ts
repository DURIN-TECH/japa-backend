// ============================================
// Unit tests — refusal-letter response whitelist (issue #122)
// ============================================
//
// The serializer is the only path from a stored analysis to a client body.
// Pins: operator-only fields never leak, a deception ground gets the adviser
// note and no fix list, and a non-analysed state carries no reasons.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { refusalEnvelope, serializeRefusalData } from "../../src/services/ai/refusal-letter-serializer";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A stored analysis carrying every operator-only field the serializer must drop. */
function stored(over: Record<string, unknown> = {}): any {
  return {
    id: "an1",
    applicationId: "app1",
    status: "succeeded",
    outcome: "analysed",
    decisionDate: "2026-01-02",
    visaTypeNamed: "Visit",
    rubricVersion: 2,
    reasons: [
      { reasonId: "r1", letterQuote: "The applicant did not show funds.", citedRefs: ["R 1"], page: 1, deception: false, matches: [{ criterionId: "c1", title: "Funds", ruleRef: "R 1", sourceQuote: "Show funds.", sourceUrl: "https://example.org/g", framing: "strengthen" }] },
      { reasonId: "r2", letterQuote: "False information was given.", citedRefs: [], page: 1, deception: true, matches: [] },
    ],
    checklist: { state: "ready", items: [] },
    warnings: [{ code: "name_mismatch" }],
    disclosureNotice: null,
    confirmedItems: [],
    // operator-only
    suspiciousContent: true,
    usage: { inputTokens: 1, outputTokens: 2 },
    model: "some-model",
    requestedBy: "uid-secret",
    inputHash: "abc",
    ...over,
  };
}

describe("refusal serializer", () => {
  test("operator-only fields appear nowhere in the serialized envelope, at any depth", () => {
    const text = JSON.stringify(refusalEnvelope({ ...stored(), startedAt: undefined, finishedAt: undefined }));
    for (const leak of ["suspiciousContent", "usage", "some-model", "uid-secret", "requestedBy", "inputHash", "inputTokens"]) {
      assert.ok(!text.includes(leak), `${leak} leaked`);
    }
  });

  test("a deception ground carries the adviser note and no rules (no fix list)", () => {
    const d: any = serializeRefusalData(stored());
    const deception = d.reasons.find((r: any) => r.reasonId === "r2");
    assert.ok(deception.adviserNote);
    assert.deepEqual(deception.rules, []);
    assert.equal(deception.status, "not_matched");
    assert.equal(d.reasons.find((r: any) => r.reasonId === "r1").adviserNote, null);
  });

  test("unreadable / not-a-letter states return fixed copy and no reasons or extracted data", () => {
    for (const outcome of ["unreadable", "not_a_refusal_letter"]) {
      const d = serializeRefusalData(stored({ outcome }));
      assert.deepEqual(d.reasons, []);
      assert.equal(d.extracted, null);
      assert.ok(d.stateMessage);
      assert.equal(d.checklist.state, "not_built");
    }
  });

  test("data is null until the job has succeeded", () => {
    assert.equal(refusalEnvelope({ ...stored(), status: "running" }).data, null);
  });

  test("warning text is fixed copy, not the stored message", () => {
    const d = serializeRefusalData(stored({ warnings: [{ code: "name_mismatch", message: "INJECTED" }, { code: "unknown_code" }] }));
    assert.ok(!d.warnings[0].message.includes("INJECTED"));
    assert.equal(d.warnings[1].message, "");
  });
});
