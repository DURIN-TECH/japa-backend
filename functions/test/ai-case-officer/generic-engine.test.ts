// ============================================
// Generic-engine tests — two rubrics, five nationalities, no route in the code (issue #42)
// ============================================
//
// The non-negotiable: the engine, prompt builders, serializers and service hold
// no route-, destination- or nationality-specific code. A route is data; a
// nationality is a lookup key.
//
// Two checks:
//  (1) the same engine code runs over two fictional rubrics for five applicants
//      of five nationalities. The stage 3 system prompt is the same for both
//      routes; the criteria differ; a nationality changes the outcome only where a
//      criterion's appliesTo lists it.
//  (2) a static scan of the engine and prompt source for country names, nationality
//      names and the fixture route ids. The fixtures and this test are the only
//      places they may appear.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { store } from "../helpers/fake-firestore";
import { ScriptedProvider, routeARubric, routeBRubric, rubricBook, seedApplication, seedDocument, seedEligibility, seedStatement, seedUser, serviceWith, installAssessmentFakes, resetAll } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Five applicants, five nationalities. Two of them carry a bar on one route only. */
const NATIONALITIES = ["PK", "NG", "IN", "BR", "GH"];

/** The bank answer for each route's unit. Same shape, different data. */
const BANK_ANSWER: Record<string, string> = {
  "bank-a": JSON.stringify({
    readable: true,
    values: [
      { field: "funds.balance", value: 3000, unit: "GBP", page: 1, quote: "q" },
      { field: "accountHolder", value: "Test Applicant", unit: null, page: 1, quote: "q" },
      { field: "statement.endDate", value: "2026-10-31", unit: null, page: 1, quote: "q" },
    ],
  }),
  "bank-b": JSON.stringify({
    readable: true,
    values: [{ field: "funds.balance", value: 600, unit: "USD", page: 1, quote: "q" }],
  }),
};

const JUDGE = JSON.stringify({
  findings: [{ criterionId: "a-intent", detail: "A reviewable point.", whatWouldHelp: "Add evidence.", concern: true }],
  strengths: [],
  statementNotes: [],
  suspiciousPassages: [],
});

/** Seed one applicant of one nationality on one route, with the same documents. */
function seedApplicant(route: "route-a" | "route-b", nationality: string): string {
  const id = `app-${route}-${nationality}`;
  const userId = `user-${route}-${nationality}`;
  seedApplication({ id, visaTypeId: route, agentId: "agent-1", agencyId: "agency-1" });
  store.set(`applications/${id}`, { ...(store.get(`applications/${id}`) as any), userId });
  seedUser(userId, "Test", "Applicant");
  seedEligibility({ userId, visaTypeId: route, nationality, score: 70, checkId: `check-${id}` });
  const key = route === "route-a" ? "bank-a" : "bank-b";
  seedDocument({ id: `doc-${id}`, applicationId: id, key, label: "Statement" });
  seedStatement({ id: `stmt-${id}`, applicationId: id, text: "A short statement." });
  return id;
}

describe("the same engine over two rubrics and five nationalities", () => {
  beforeEach(async () => {
    resetAll();
    await installAssessmentFakes();
    rubricBook.set("AA_route-a", routeARubric());
    rubricBook.set("AA_route-b", routeBRubric());
  });

  test("the same code path runs for every applicant; only a listed nationality changes the outcome", async () => {
    const provider = new ScriptedProvider((req, key) => {
      if (req.role === "extraction") return BANK_ANSWER[key ?? ""] ?? JSON.stringify({ readable: true, values: [] });
      return JUDGE;
    });
    const svc = serviceWith(provider);

    const outcomes: Record<string, { readiness: string; refusals: string[]; judgementCalls: number }> = {};
    for (const route of ["route-a", "route-b"] as const) {
      for (const nationality of NATIONALITIES) {
        const id = seedApplicant(route, nationality);
        const app = { id, ...(store.get(`applications/${id}`) as any) } as any;
        const out = await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "t" });
        assert.ok("assessmentId" in out, `${route}/${nationality} is requested`);
        await svc.runJob((out as any).assessmentId);
        const stored = store.get(`applicationAssessments/${(out as any).assessmentId}`) as any;
        assert.equal(stored.status, "succeeded", `${route}/${nationality} succeeds`);
        outcomes[`${route}/${nationality}`] = {
          readiness: stored.readiness,
          refusals: stored.refusalGrounds.map((g: any) => g.criterionId).sort(),
          judgementCalls: provider.requests.filter((r) => r.role === "judgement").length,
        };
      }
    }

    // Route A: only PK hits its bar. Route B: only NG hits its bar.
    assert.deepEqual(outcomes["route-a/PK"].refusals, ["a-bar"]);
    assert.equal(outcomes["route-a/PK"].readiness, "not_ready");
    assert.ok(!outcomes["route-a/NG"].refusals.includes("a-bar"));
    assert.deepEqual(outcomes["route-b/NG"].refusals, ["b-bar"]);
    for (const n of ["IN", "BR", "GH"]) {
      assert.ok(!outcomes[`route-a/${n}`].refusals.includes("a-bar"), `route A does not bar ${n}`);
      assert.ok(!outcomes[`route-b/${n}`].refusals.includes("b-bar"), `route B does not bar ${n}`);
    }

    // Applicants who are not barred get the same readiness on the same route.
    const unbarredA = ["NG", "IN", "BR", "GH"].map((n) => outcomes[`route-a/${n}`].readiness);
    assert.equal(new Set(unbarredA).size, 1, "a non-barred nationality changes nothing on route A");
    const unbarredB = ["PK", "IN", "BR", "GH"].map((n) => outcomes[`route-b/${n}`].readiness);
    assert.equal(new Set(unbarredB).size, 1, "a non-barred nationality changes nothing on route B");
  });

  test("the stage 3 system prompt is identical for both routes; only the criteria data differs", async () => {
    const provider = new ScriptedProvider((req, key) => (req.role === "extraction" ? BANK_ANSWER[key ?? ""] ?? "{}" : JUDGE));
    const svc = serviceWith(provider);
    for (const route of ["route-a", "route-b"] as const) {
      const id = seedApplicant(route, "IN");
      const app = { id, ...(store.get(`applications/${id}`) as any) } as any;
      await svc.runJob(((await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "t" })) as any).assessmentId);
    }
    const judgements = provider.requests.filter((r) => r.role === "judgement");
    assert.equal(judgements.length, 2);
    assert.equal(judgements[0].system, judgements[1].system, "the same system prompt for both routes");
    assert.ok(judgements[0].user.includes("a-genuine") && !judgements[0].user.includes("b-ties"));
    assert.ok(judgements[1].user.includes("b-ties") && !judgements[1].user.includes("a-genuine"));
  });
});

describe("static check: no route, country or nationality text in the engine", () => {
  // The engine, the prompt builders, the serializers and the job. Fixtures and
  // this test are the only places the terms below may appear.
  const SOURCES = [
    "src/services/ai/assessment-engine.ts",
    "src/services/ai/prompt-safety.ts",
    "src/services/ai/tier-serializer.ts",
    "src/services/ai/ai-settings.ts",
    "src/services/ai-case-officer.service.ts",
    "src/controllers/ai-case-officer.controller.ts",
    "src/routes/ai.routes.ts",
    "src/types/assessment.ts",
  ];

  // Country codes, country and nationality names, and the fixture route ids.
  const TERMS = [
    "PK", "NG", "IN", "BR", "GH", "GB", "UK",
    "Pakistan", "Nigeria", "India", "Brazil", "Ghana", "United Kingdom",
    "Pakistani", "Nigerian", "Indian", "Brazilian", "Ghanaian", "British",
    "route-a", "route-b", "visitor", "Visitor", "student", "Student",
    "Appendix V", "Standard Visitor", "INA 214", "R216",
  ];

  test("no listed term appears in the engine or prompt source", () => {
    const hits: string[] = [];
    for (const rel of SOURCES) {
      const text = readFileSync(resolve(process.cwd(), rel), "utf8");
      for (const term of TERMS) {
        // Whole-word match for codes and short names; substring for the rest.
        const pattern = term.length <= 3 ? new RegExp(`(^|[^A-Za-z])${term}([^A-Za-z]|$)`) : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (pattern.test(text)) hits.push(`${rel}: ${term}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
