// Unit tests for the per-type answer rules (issue #187 regroom): the values
// the PUT accepts and rejects, the error messages naming the field, the empty
// rule, the legacy re-read. Pure: no Firestore.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import {
  AnswerValidationError,
  isEmptyAnswer,
  isIsoDate,
  legacyValueFor,
  renderAnswerText,
  validateAnswerValue,
} from "../../src/services/answer-values";
import { toAnswerView } from "../../src/services/answers.service";

/** The validation error message for (type, value), or null when accepted. */
function msg(type: Parameters<typeof validateAnswerValue>[0], v: unknown): string | null {
  try {
    validateAnswerValue(type, v);
    return null;
  } catch (e) {
    assert.ok(e instanceof AnswerValidationError);
    return (e as Error).message;
  }
}

describe("date", () => {
  test("a real ISO calendar date", () => {
    assert.equal(validateAnswerValue("date", " 1990-04-23 "), "1990-04-23");
    assert.equal(isIsoDate("2028-02-29"), true); // leap day
    for (const bad of ["2026-02-31", "2027-02-29", "23/04/1990", "1990-4-3", "1990-13-01", "tomorrow"]) {
      assert.match(msg("date", bad) ?? "", /"value"/, bad);
    }
    assert.match(msg("date", 19900423) ?? "", /"value"/);
  });
});

describe("date_range", () => {
  test("both dates, to >= from; same day is fine", () => {
    assert.deepEqual(validateAnswerValue("date_range", { from: "2027-01-10", to: "2027-01-10" }), { from: "2027-01-10", to: "2027-01-10" });
    assert.match(msg("date_range", { from: "2027-01-10", to: "2027-01-09" }) ?? "", /"value\.to"/);
    assert.match(msg("date_range", { from: "2027-01-10" }) ?? "", /"value\.to"/);
    assert.match(msg("date_range", { to: "2027-01-10" }) ?? "", /"value\.from"/);
    assert.match(msg("date_range", { from: "nope", to: "2027-01-10" }) ?? "", /"value\.from"/);
    assert.match(msg("date_range", "2027-01-10") ?? "", /"value"/);
  });
});

describe("money", () => {
  test("finite non-negative amount, ISO 4217 currency (upper-cased)", () => {
    assert.deepEqual(validateAnswerValue("money", { amount: 0, currency: "ngn" }), { amount: 0, currency: "NGN" });
    assert.deepEqual(validateAnswerValue("money", { amount: 12.5, currency: "GBP" }), { amount: 12.5, currency: "GBP" });
    assert.match(msg("money", { amount: -0.01, currency: "GBP" }) ?? "", /"value\.amount"/);
    assert.match(msg("money", { amount: Infinity, currency: "GBP" }) ?? "", /"value\.amount"/);
    assert.match(msg("money", { amount: "5", currency: "GBP" }) ?? "", /"value\.amount"/);
    assert.match(msg("money", { amount: 5, currency: "GB" }) ?? "", /"value\.currency"/);
    assert.match(msg("money", { amount: 5, currency: "ZZZ" }) ?? "", /"value\.currency"/);
    assert.match(msg("money", { amount: 5 }) ?? "", /"value\.currency"/);
  });
});

describe("address", () => {
  test("line1, city and country are required; the rest optional and trimmed", () => {
    assert.deepEqual(
      validateAnswerValue("address", { line1: " 1 High St ", city: "London", country: "UK", postcode: "N1 1AA", note: " 2 years ", line2: "  " }),
      { line1: "1 High St", city: "London", country: "UK", postcode: "N1 1AA", note: "2 years" }
    );
    for (const k of ["line1", "city", "country"]) {
      const a: Record<string, string> = { line1: "x", city: "y", country: "z" };
      delete a[k];
      assert.match(msg("address", a) ?? "", new RegExp(`"value\\.${k}"`));
    }
    assert.match(msg("address", { line1: "x", city: "y", country: "z", postcode: 5 }) ?? "", /"value\.postcode"/);
    assert.match(msg("address", { line1: "x".repeat(201), city: "y", country: "z" }) ?? "", /"value\.line1"/);
  });
});

describe("list", () => {
  test("up to 20 entries of up to 500 chars; blank rows dropped", () => {
    assert.deepEqual(validateAnswerValue("list", [" a ", "", "b"]), ["a", "b"]);
    assert.equal((validateAnswerValue("list", Array.from({ length: 20 }, (_, i) => `e${i}`)) as string[]).length, 20);
    assert.match(msg("list", Array.from({ length: 21 }, (_, i) => `e${i}`)) ?? "", /at most 20/);
    assert.equal(msg("list", ["x".repeat(500)]), null);
    assert.match(msg("list", ["ok", "x".repeat(501)]) ?? "", /"value\[1\]"/);
    assert.match(msg("list", ["ok", 5]) ?? "", /"value\[1\]"/);
    assert.match(msg("list", "a, b") ?? "", /"value"/);
  });
});

describe("text", () => {
  test("trimmed, at most 2000 chars", () => {
    assert.equal(validateAnswerValue("text", "  hi "), "hi");
    assert.equal((validateAnswerValue("text", "x".repeat(2000)) as string).length, 2000);
    assert.match(msg("text", "x".repeat(2001)) ?? "", /2000/);
    assert.match(msg("text", 5) ?? "", /"value"/);
    assert.match(msg("text", { a: 1 }) ?? "", /"value"/);
  });
});

describe("an empty value clears for every type", () => {
  test("isEmptyAnswer", () => {
    for (const t of ["date", "text"] as const) for (const e of ["", "  ", null, undefined]) assert.equal(isEmptyAnswer(t, e), true);
    assert.equal(isEmptyAnswer("list", []), true);
    assert.equal(isEmptyAnswer("list", ["", " "]), true);
    assert.equal(isEmptyAnswer("date_range", { from: "", to: "" }), true);
    assert.equal(isEmptyAnswer("money", {}), true);
    assert.equal(isEmptyAnswer("money", { amount: "", currency: "GBP" }), true); // blank amount clears despite the chip
    assert.equal(isEmptyAnswer("money", { amount: null, currency: "GBP" }), true);
    assert.match(msg("bogus" as never, "x") ?? "", /unsupported/);
    assert.equal(isEmptyAnswer("address", { line1: "", city: null }), true);
    assert.equal(isEmptyAnswer("date_range", { from: "2027-01-01", to: "" }), false); // partial: validated, 400
    assert.equal(isEmptyAnswer("list", ["a"]), false);
    assert.equal(isEmptyAnswer("money", { amount: 0, currency: "GBP" }), false); // zero is an answer
  });
});

describe("legacy plain-string answers are re-read with no data loss", () => {
  const at = Timestamp.fromDate(new Date("2026-11-01T10:00:00Z"));
  test("text stays text; others become a one-entry list / note, flagged legacy", () => {
    assert.deepEqual(toAnswerView({ text: "hello", updatedAt: at }, "text"), { answerType: "text", value: "hello", text: "hello", updatedAt: "2026-11-01T10:00:00.000Z" });
    assert.deepEqual(toAnswerView({ text: "Paris", updatedAt: at }, "list").value, ["Paris"]);
    assert.deepEqual(toAnswerView({ text: "Paris", updatedAt: at }, "list").legacy, true);
    assert.deepEqual(toAnswerView({ text: "12 High St", updatedAt: at }, "address").value, { note: "12 High St" });
    assert.equal(toAnswerView({ text: "1 Jan", updatedAt: at }, "date").value, "1 Jan");
    // An item no longer on the checklist is read as text rather than dropped.
    assert.equal(toAnswerView({ text: "x", updatedAt: at }, undefined).answerType, "text");
  });
  test("a typed answer is returned as stored; one saved under another type is re-read as the item's type", () => {
    const stored = { answerType: "date" as const, value: "1990-04-23", updatedAt: at };
    const same = toAnswerView(stored, "date");
    assert.deepEqual([same.value, same.legacy], ["1990-04-23", undefined]);
    const changed = toAnswerView(stored, "text");
    assert.deepEqual([changed.value, changed.legacy], ["1990-04-23", true]);
  });
  test("renderAnswerText and legacyValueFor never throw", () => {
    assert.equal(renderAnswerText({ from: "a", to: "b" }), "a to b");
    assert.equal(renderAnswerText({ amount: 5, currency: "GBP" }), "5 GBP");
    assert.equal(renderAnswerText({ line1: "1 High St", city: "London", country: "UK" }), "1 High St, London, UK");
    assert.equal(renderAnswerText(["a", "b"]), "a\nb");
    assert.equal(renderAnswerText(undefined), "");
    assert.deepEqual(legacyValueFor("list", ""), []);
  });
});
