// ============================================
// Unit tests — which date a mandatory bar is checked against (issue #42)
// ============================================
//
// Stage 1 compares a bar's validFrom / validUntil window with a date. These
// tests pin which date: the application's `submittedAt` when it has one, else
// the assessment date, and never a draft's `startDate`. A missing date must
// never mean "skip the bar" (an applicant-facing verdict must not say nothing
// blocks them because a field was empty). Fictional rubrics only.

import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, test } from "node:test";
import { store } from "../helpers/fake-firestore";
import { barDateOf } from "../../src/services/ai-case-officer.service";
import {
  installAssessmentFakes, NOW, resetAll, routeARubric, rubricBook, ScriptedProvider,
  seedApplication, seedEligibility, seedUser, serviceWith,
} from "./harness";
import type { VisaRubric } from "../../src/types/rubric";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Route A with its nationality bar limited to a window, at a given rubric version. */
function dated(window: { validFrom?: string; validUntil?: string }, version = 1): VisaRubric {
  const r = routeARubric({ version });
  const bar = r.criteria.find((c) => c.criterionId === "a-bar")!;
  Object.assign(bar, window);
  return r;
}

/** Seed a PK applicant (the fixture bar's nationality) with the given dates, no documents. */
function seedCase(dates: { submittedAt?: string; startDate?: string }) {
  seedApplication({ id: "app-1" });
  const cur = store.get("applications/app-1") as any;
  if (dates.startDate) cur.startDate = Timestamp.fromDate(new Date(dates.startDate));
  if (dates.submittedAt) cur.submittedAt = Timestamp.fromDate(new Date(dates.submittedAt));
  seedUser("client-1", "Ada", "Lovelace");
  seedEligibility({ nationality: "PK", score: 80 });
}

/** Request then run; returns the stored assessment. */
async function assess(svc: ReturnType<typeof serviceWith>): Promise<any> {
  const app = { id: "app-1", ...(store.get("applications/app-1") as any) } as any;
  const out: any = await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "tester" });
  if (out.kind === "created" || out.kind === "queued") await svc.runJob(out.assessmentId);
  return store.get(`applicationAssessments/${out.assessmentId}`) as any;
}

const none = () => new ScriptedProvider(() => JSON.stringify({ readable: true, values: [] }));
const hit = (a: any) => a.stageOutcomes.mandatoryBar === "hit";

describe("barDateOf", () => {
  test("uses submittedAt when present", () => {
    const d = barDateOf({ submittedAt: Timestamp.fromDate(new Date("2026-03-01T23:30:00Z")) }, NOW);
    assert.equal(d, "2026-03-01");
  });
  test("falls back to the assessment date, never startDate", () => {
    assert.equal(barDateOf({ submittedAt: undefined, startDate: Timestamp.fromMillis(0) } as any, NOW), "2026-11-11");
  });
  test("a malformed submittedAt falls back to the assessment date, not to skipping", () => {
    assert.equal(barDateOf({ submittedAt: { _seconds: 1 } } as any, NOW), "2026-11-11");
  });
});

describe("the bar's date in the job", () => {
  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
  });

  test("submittedAt is the date used: a bar that ended before today still hits an application made inside it", async () => {
    rubricBook.set("AA_route-a", dated({ validFrom: "2026-01-01", validUntil: "2026-06-30" }));
    seedCase({ submittedAt: "2026-03-01T10:00:00Z" });
    assert.ok(hit(await assess(serviceWith(none()))));
  });

  test("an application made after the bar ended is not hit, even though the draft started inside the window", async () => {
    rubricBook.set("AA_route-a", dated({ validFrom: "2026-01-01", validUntil: "2026-06-30" }));
    seedCase({ submittedAt: "2026-08-01T10:00:00Z", startDate: "2026-02-01T10:00:00Z" });
    assert.ok(!hit(await assess(serviceWith(none()))));
  });

  test("with no submittedAt the assessment date is used, not startDate", async () => {
    // Draft started before the bar existed; the bar is in force on the assessment date (2026-11-11).
    rubricBook.set("AA_route-a", dated({ validFrom: "2026-09-01" }));
    seedCase({ startDate: "2026-02-01T10:00:00Z" });
    assert.ok(hit(await assess(serviceWith(none()))), "a bar in force today is not skipped for an old draft");
  });

  test("neither date stored: the bar is still checked, against the assessment date", async () => {
    rubricBook.set("AA_route-a", dated({ validFrom: "2026-09-01" }));
    seedCase({});
    const cur = store.get("applications/app-1") as any;
    delete cur.startDate;
    assert.ok(hit(await assess(serviceWith(none()))), "a missing date never skips a mandatory bar");
  });

  test("a rule change after submission does not change a re-run", async () => {
    // Submitted 2026-03-01 while the bar was in force; assessed.
    rubricBook.set("AA_route-a", dated({ validFrom: "2026-01-01" }, 1));
    seedCase({ submittedAt: "2026-03-01T10:00:00Z" });
    assert.ok(hit(await assess(serviceWith(none()))));
    // The bar is then narrowed to start later (new rubric version, so the inputs hash changes
    // and a genuine re-run happens). The application was made before it began: same outcome.
    rubricBook.set("AA_route-a", dated({ validFrom: "2026-10-01" }, 2));
    const again = await assess(serviceWith(none()));
    assert.equal(again.rubricVersion, 2, "this was a re-run on the new rubric version");
    assert.ok(!hit(again), "a bar that began after the application was made does not govern it");
    // And running the same inputs later, on a different day, does not move the date.
    const later = await assess(serviceWith(none(), {}, { now: () => new Date("2027-05-05T10:00:00Z") }));
    assert.ok(!hit(later));
  });
});
