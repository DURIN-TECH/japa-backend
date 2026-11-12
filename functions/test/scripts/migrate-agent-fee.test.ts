// Unit tests — pure decision logic of the #148 agent-fee migration (no SDK/emulator).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  planAgentFee,
  parseCutoffArg,
  FEE_UNIT_MARKER,
} from "../../src/scripts/migrate-agent-consultation-fee-to-naira";

const CUTOFF = Date.parse("2026-11-20T09:00:00Z");
const BEFORE = CUTOFF - 86_400_000;

describe("planAgentFee", () => {
  test("converts a kobo value created before the cutoff", () => {
    assert.deepEqual(planAgentFee({ consultationFee: 500000, createdAtMillis: BEFORE }, CUTOFF), {
      action: "convert", from: 500000, to: 5000,
    });
  });

  test("is idempotent: a converted doc (marker) is skipped even if its naira value looks like kobo", () => {
    const converted = planAgentFee({ consultationFee: 500000, createdAtMillis: BEFORE }, CUTOFF);
    assert.equal(converted.action, "convert");
    // Second run sees the marker the first run wrote; 5000 would otherwise be /100 again.
    assert.deepEqual(
      planAgentFee({ consultationFee: 5000, consultationFeeUnit: FEE_UNIT_MARKER, createdAtMillis: BEFORE }, CUTOFF),
      { action: "skip", reason: "already-migrated" }
    );
    // Even a naira value that is a multiple of 100 stays put once marked.
    assert.equal(
      planAgentFee({ consultationFee: 50000, consultationFeeUnit: FEE_UNIT_MARKER, createdAtMillis: BEFORE }, CUTOFF).action,
      "skip"
    );
  });

  test("skips agents created at or after the cutoff (written in naira)", () => {
    assert.deepEqual(planAgentFee({ consultationFee: 5000, createdAtMillis: CUTOFF }, CUTOFF), {
      action: "skip", reason: "created-after-cutoff",
    });
  });

  test("skips missing, null and zero fees", () => {
    for (const f of [undefined, null, 0]) {
      assert.deepEqual(planAgentFee({ consultationFee: f, createdAtMillis: BEFORE }, CUTOFF), {
        action: "skip", reason: "no-fee",
      });
    }
  });

  test("flags, never converts, values that cannot be kobo or cannot be read", () => {
    assert.equal(planAgentFee({ consultationFee: 2550, createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.equal(planAgentFee({ consultationFee: 12.5, createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.equal(planAgentFee({ consultationFee: "5000", createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.equal(planAgentFee({ consultationFee: -100, createdAtMillis: BEFORE }, CUTOFF).action, "review");
    assert.deepEqual(planAgentFee({ consultationFee: 500000, createdAtMillis: null }, CUTOFF), {
      action: "review", reason: "no-created-at", fee: 500000,
    });
  });
});

describe("parseCutoffArg", () => {
  test("parses both forms and rejects absent/invalid values", () => {
    assert.equal(parseCutoffArg(["--cutoff", "2026-11-20T09:00:00Z"]), CUTOFF);
    assert.equal(parseCutoffArg(["--cutoff=2026-11-20T09:00:00Z"]), CUTOFF);
    assert.equal(parseCutoffArg([]), undefined);
    assert.equal(parseCutoffArg(["--cutoff", "soon"]), undefined);
  });
});
