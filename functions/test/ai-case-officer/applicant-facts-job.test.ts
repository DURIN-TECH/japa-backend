// ============================================
// Unit tests — the assessment job reads the application's COPY of what the
// applicant holds (issue #234, P5 of #228)
// ============================================
//
// The real AiCaseOfficerService over the in-memory Firestore and a scripted
// model (no network, no emulator, no paid call). Covers:
//   - a bar decided from the application's `applicantFacts` copy (several
//     nationalities), never from the live profile;
//   - the eligibility-check nationality used ONLY when there is no copy;
//   - a missing fact gives "could not be assessed: we need to know your
//     nationality", never a pass;
//   - members_of resolved through membership on the START date; an authority
//     with no recorded members is "could not be assessed";
//   - what the judgement model is shown: only the facts rules need, never a note;
//   - the input hash: unchanged for an application with no copy.
// Every code and id is made up.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { store } from "../helpers/fake-firestore";
import { computeInputHash } from "../../src/services/ai/assessment-engine";
import type { AuthorityMember } from "../../src/types/authority";
import { criterion, fictionalRubric, installAssessmentFakes, resetAll, rubricBook, ScriptedProvider, seedApplication, seedEligibility, seedStatement, seedUser, serviceWith } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A judgement answer with no findings. */
const NO_FINDINGS = JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] });

/** The rulebook: a nationality bar, a bloc-membership bar, and one judgement rule (so the model is asked). */
function bookRubric() {
  const rubric = fictionalRubric({
    countryCode: "AA",
    visaTypeId: "route-a",
    intentPolarity: "dual_intent_permitted",
    criteria: [
      criterion({ criterionId: "nat-bar", title: "Nationality bar", kind: "mandatory_bar", stage: "suitability", severity: "critical", appliesTo: { nationalities: ["QA"], asWritten: ["Qaland"] } }),
      criterion({
        criterionId: "bloc-bar",
        title: "Bloc bar",
        kind: "mandatory_bar",
        stage: "suitability",
        severity: "critical",
        appliesTo: { nationalities: [], asWritten: [], groups: [{ kind: "members_of", authorityId: "zq-bloc", fact: "nationality", asWritten: "nationals of a Zq member" }] },
      }),
      criterion({ criterionId: "genuine", title: "Genuine visit", kind: "judgement", stage: "credibility", severity: "medium", probeFactors: ["ties"], requiresInterviewBeforeRefusal: false }),
    ],
  });
  rubricBook.set("AA_route-a", rubric);
  return rubric;
}

/** Put a copy of the applicant's holdings on the application. */
function withCopy(appId: string, facts: Record<string, unknown>) {
  const key = `applications/${appId}`;
  store.set(key, { ...(store.get(key) as any), applicantFacts: { nationalities: [], residentialCountry: null, heldDocuments: null, takenAt: Timestamp.fromMillis(0), ...facts } });
}

/** Members recorded for the bloc: QB joined long ago, QC joined after the application started. */
const MEMBERS: Record<string, AuthorityMember[]> = {
  "zq-bloc": [
    { countryCode: "QB", joinedOn: "1960-01-01" } as AuthorityMember,
    { countryCode: "QC", joinedOn: "2030-01-01" } as AuthorityMember,
  ],
};

/** Request then run the job; returns the stored assessment and the provider. */
async function assess(members: Record<string, AuthorityMember[]> = MEMBERS) {
  const provider = new ScriptedProvider(() => NO_FINDINGS);
  const svc = serviceWith(provider, {}, { loadAuthorityMembers: async (id) => members[id] ?? [] });
  const app = { id: "app-1", ...(store.get("applications/app-1") as any) } as any;
  const out: any = await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "tester" });
  if (out.kind === "created" || out.kind === "queued") await svc.runJob(out.assessmentId);
  return { stored: store.get(`applicationAssessments/${out.assessmentId}`) as any, provider, svc, app };
}

describe("the assessment reads the application's copy of what the applicant holds", () => {
  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
    bookRubric();
    seedApplication({ id: "app-1" });
    seedUser("client-1", "Ada", "Lovelace");
    seedStatement({ id: "stmt-1", applicationId: "app-1", text: "I will return home at the end of the visit." });
  });

  test("several nationalities on the copy: the bar hits on the second one, with zero model calls", async () => {
    // The eligibility check says otherwise: the copy wins.
    seedEligibility({ nationality: "QZ", score: 80 });
    withCopy("app-1", { nationalities: ["QZ", "QA"] });
    const { stored, provider } = await assess();
    assert.equal(provider.requests.length, 0);
    assert.ok(stored.refusalGrounds.some((g: any) => g.criterionId === "nat-bar"));
  });

  test("the live profile is never read for facts: a profile nationality does not reach the bar", async () => {
    store.set("users/client-1", { firstName: "Ada", lastName: "Lovelace", nationalities: ["QA"] });
    withCopy("app-1", { nationalities: ["QZ"] });
    const { stored } = await assess();
    assert.ok(!stored.refusalGrounds.some((g: any) => g.criterionId === "nat-bar"));
  });

  test("no copy (started before #234): the eligibility check's nationality is the fallback", async () => {
    seedEligibility({ nationality: "QA", score: 80 });
    const { stored } = await assess();
    assert.ok(stored.refusalGrounds.some((g: any) => g.criterionId === "nat-bar"));
  });

  test("nationality not stated: both bars are 'could not be assessed: we need to know your nationality', never passed", async () => {
    withCopy("app-1", {});
    const { stored } = await assess();
    assert.deepEqual(stored.refusalGrounds, []);
    const items = stored.insufficientInformation.filter((i: any) => i.notAssessed === "missing_fact");
    assert.deepEqual(items.map((i: any) => [i.criterionId, i.reason]).sort(), [
      ["bloc-bar", "could not be assessed: we need to know your nationality"],
      ["nat-bar", "could not be assessed: we need to know your nationality"],
    ]);
  });

  test("members_of: a member on the start date hits; one that joined later does not", async () => {
    withCopy("app-1", { nationalities: ["QB"] });
    assert.ok((await assess()).stored.refusalGrounds.some((g: any) => g.criterionId === "bloc-bar"));
    resetAll();
    await installAssessmentFakes();
    bookRubric();
    seedApplication({ id: "app-1" });
    seedUser("client-1", "Ada", "Lovelace");
    seedStatement({ id: "stmt-1", applicationId: "app-1", text: "I will return home." });
    withCopy("app-1", { nationalities: ["QC"] });
    assert.ok(!(await assess()).stored.refusalGrounds.some((g: any) => g.criterionId === "bloc-bar"));
  });

  test("members_of on an authority with no recorded members: 'could not be assessed', not 'nobody'", async () => {
    withCopy("app-1", { nationalities: ["QB"] });
    const { stored } = await assess({});
    assert.deepEqual(stored.refusalGrounds, []);
    const item = stored.insufficientInformation.find((i: any) => i.criterionId === "bloc-bar");
    assert.equal(item?.notAssessed, "missing_fact");
    assert.match(item?.reason ?? "", /which countries belong to the group this rule names/);
  });

  test("the judgement model sees the nationality codes only (no rule reads residence or documents), never a note", async () => {
    withCopy("app-1", {
      nationalities: ["QZ"],
      residentialCountry: "QY",
      heldDocuments: [{ id: "d1", kind: "visa", issuerCountryCode: "QX", validUntil: "2030-01-01", note: "PRIVATE-NOTE", expiredWhenTaken: false }],
    });
    const { provider } = await assess();
    const judge = provider.requests.find((r) => r.role === "judgement");
    assert.ok(judge, "the model was asked");
    assert.match(judge!.user, /Nationality code\(s\): QZ\./);
    assert.doesNotMatch(judge!.user, /QY|QX|PRIVATE-NOTE/);
  });

  test("the input hash of an application with no copy is the pre-#234 hash; a copy changes it", async () => {
    seedEligibility({ nationality: "QZ", score: 80 });
    const { svc, app } = await assess();
    const loaded = await svc.loadInputs(app);
    const without = svc.inputsFor(loaded, 1);
    assert.equal("applicantFacts" in without, false);
    withCopy("app-1", { nationalities: ["QZ"] });
    const copied = await svc.loadInputs({ id: "app-1", ...(store.get("applications/app-1") as any) });
    assert.notEqual(computeInputHash(svc.inputsFor(copied, 1)), computeInputHash(without));
  });
});
