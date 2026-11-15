// ============================================
// Unit tests — the e2e fixture's pure builders (issue #361)
// ============================================
// The fixture rulebook must be a rulebook the backend SERVES: it passes the
// structural validator the review API runs before an approval, the read-side
// filter keeps every question and document item, and the intake's served
// question list (`effectiveIntakeQuestions`) is all three questions with no
// condition. The builders are deterministic (same output twice).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  E2E_FIXTURE,
  buildE2eClientUserDoc,
  buildE2eRubricHead,
  buildE2eRubricVersion,
} from "../../src/scripts/e2e/e2e-fixture-data";
import { validateVisaRubric } from "../../src/scrapers/rubric/rubric-validate";
import { applyExclusions } from "../../src/scrapers/rubric/rubric-exclusions";
import { effectiveIntakeQuestions } from "../../src/services/ai/rule-applicability";
import { buildChecklist } from "../../src/services/ai/checklist-builder";

describe("e2e fixture rulebook", () => {
  test("passes the structural validator with no errors and no flags", () => {
    const v = validateVisaRubric(buildE2eRubricVersion());
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.flags, []);
  });

  test("is approved, version 1, on IE_short-stay-c, and the head points at it", () => {
    const r = buildE2eRubricVersion();
    const head = buildE2eRubricHead();
    assert.equal(r.reviewStatus, "approved");
    assert.equal(r.routeKey, "IE_short-stay-c");
    assert.equal(`${r.countryCode}_${r.visaTypeId}`, r.routeKey);
    assert.equal(head.approvedVersion, r.version);
    assert.equal(head.latestVersion, r.version);
    assert.equal(head.latestSourceSetHash, r.sourceSetHash);
  });

  test("serves 3 unconditional intake questions after the read-side filter", () => {
    const served = applyExclusions(buildE2eRubricVersion());
    const questions = effectiveIntakeQuestions(served);
    assert.deepEqual(
      questions.map((q) => [q.id, q.answerType, q.required, q.showWhen]),
      [
        [E2E_FIXTURE.questionIds.purpose, "single_choice", true, undefined],
        [E2E_FIXTURE.questionIds.visitedBefore, "yes_no", true, undefined],
        [E2E_FIXTURE.questionIds.accommodation, "text", true, undefined],
      ]
    );
  });

  test("checklist: held back until an answer exists, then both document items", () => {
    const rubric = applyExclusions(buildE2eRubricVersion());
    assert.equal(buildChecklist({ rubric, visaRecord: null, intakeAnswers: {} }).state, "intake_needed");
    const answered = buildChecklist({
      rubric,
      visaRecord: null,
      intakeAnswers: { [E2E_FIXTURE.questionIds.purpose]: "tourism", [E2E_FIXTURE.questionIds.visitedBefore]: false, [E2E_FIXTURE.questionIds.accommodation]: "Hotel" },
    });
    assert.equal(answered.state, "ready");
    assert.deepEqual(answered.items.map((i) => i.checklistItemId), ["ev-e2e-passport", "ev-e2e-accommodation-proof"]);
  });

  test("every citation is marked as fixture text on a .invalid domain", () => {
    const r = buildE2eRubricVersion();
    for (const s of [...r.criteria.map((c) => c.source), ...r.evidenceItems.map((e) => e.source)]) {
      assert.match(s.quote, /^Seli end-to-end test fixture, not real guidance:/);
      assert.match(s.url, /^https:\/\/[^/]+\.invalid\//);
    }
  });

  test("deterministic: two builds are identical", () => {
    assert.deepEqual(buildE2eRubricVersion(), buildE2eRubricVersion());
    assert.deepEqual(buildE2eRubricHead(), buildE2eRubricHead());
  });
});

describe("e2e fixture client", () => {
  test("seed-style id, onboarding complete, the given Resend email", () => {
    const doc = buildE2eClientUserDoc("delivered+e2e.amaka.obi@resend.dev");
    assert.equal(doc.id, "seed-user-e2e-client-001");
    assert.equal(doc.email, "delivered+e2e.amaka.obi@resend.dev");
    assert.equal(doc.onboardingCompleted, true);
    assert.deepEqual(buildE2eClientUserDoc("x"), buildE2eClientUserDoc("x"));
  });
});
