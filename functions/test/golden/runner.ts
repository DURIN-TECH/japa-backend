// ============================================
// Golden set — load fixtures and run ONE through the real engine (issue #35)
// ============================================
//
// `runFixture` seeds the in-memory Firestore (the same fake the #42 suites use)
// from a fixture's DATA, then drives the production service end to end:
//
//   requestAssessment -> runJob -> read the stored assessment
//
// That is the real job code: stage 1 mandatory bars in code, stage 2 one
// extraction call per document, objective checks decided in code, stage 3 one
// judgement call, `assembleContent`, banned wording, citations copied from the
// rubric, the tier serializer. The only things swapped are the edges the
// service already injects (`AssessmentDeps`): the provider (replay or
// recording), where document bytes come from (the fixture's own text, as a small
// PDF) and the clock. Nothing is mocked inside the engine.
//
// No network and no real Firestore: the harness installs fakes for every
// collection the job reaches, and the unit-test preload (test/helpers/setup.ts)
// fails any call that slips past them.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import type { Application } from "../../src/types";
import type { ApplicationAssessment } from "../../src/types/assessment";
import type { VisaRubric } from "../../src/types/rubric";
import { routeBRubric, installAssessmentFakes, resetAll, rubricBook, serviceWith, NOW } from "../ai-case-officer/harness";
import { store } from "../helpers/fake-firestore";
import { buildTextPdf } from "./pdf";
import type { GoldenFixture } from "./types";
import type { LlmProvider } from "../../src/services/ai/llm-provider";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Directories of the fixture data, relative to functions/. */
const FIXTURE_DIR = "test/golden/fixtures";

/**
 * The rubric fixtures, by the key a fixture names in `rubric`.
 *
 *  - `gb-standard-visitor`: the EXTRACTED DRAFT (not approved), reduced with
 *    applyExclusions. Test data only. See build-rubric-fixture.ts.
 *  - `fictional-route-b`: the FICTIONAL second-route rubric the #42 generic-engine
 *    suite already uses (a different destination code and route id, one bar, one
 *    objective check, one judgement criterion). It is what proves the same engine
 *    code runs over a second rubric.
 */
export const RUBRIC_KEYS = ["gb-standard-visitor", "fictional-route-b"] as const;

/** Load a rubric fixture by key. */
export function loadRubric(key: string): VisaRubric {
  if (key === "fictional-route-b") return routeBRubric();
  if (key === "gb-standard-visitor") {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), FIXTURE_DIR, "rubrics/gb-standard-visitor.draft-subset.json"), "utf8"));
    // The banner is for humans; the engine reads the rubric fields only.
    const { _fixture, ...rubric } = raw;
    void _fixture;
    return rubric as VisaRubric;
  }
  throw new Error(`unknown rubric fixture key: ${key}`);
}

/** Every application fixture, sorted by id. */
export function loadFixtures(): GoldenFixture[] {
  const dir = resolve(process.cwd(), FIXTURE_DIR, "applications");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as GoldenFixture);
}

/** What one run produced. */
export interface FixtureRun {
  fixture: GoldenFixture;
  rubric: VisaRubric;
  // The stored assessment document (plain data; Timestamps are fake-store Timestamps).
  assessment: ApplicationAssessment;
  // How many model requests the engine made.
  requestCount: number;
}

/**
 * Seed the fake store from a fixture and run the real job over `provider`.
 * Returns the stored assessment. The caller reads the provider's own state
 * (misses, recorded answers) afterwards.
 */
export async function runFixture(fixture: GoldenFixture, provider: LlmProvider & { requests?: unknown[] }): Promise<FixtureRun> {
  const rubric = loadRubric(fixture.rubric);
  resetAll();
  await installAssessmentFakes();
  rubricBook.set(`${rubric.countryCode}_${rubric.visaTypeId}`, rubric);

  const appId = `golden-${fixture.id}`;
  const userId = `user-${fixture.id}`;

  // ---- the application (intake is stored on it, as #113 does) ----
  store.set(`applications/${appId}`, {
    userId,
    visaTypeId: rubric.visaTypeId,
    countryCode: rubric.countryCode,
    mode: "agent",
    agentId: "agent-golden",
    agencyId: "agency-golden",
    status: "submitted",
    title: fixture.title,
    intake: fixture.intake,
    startDate: Timestamp.fromMillis(0),
    lastUpdated: Timestamp.fromMillis(0),
    createdAt: Timestamp.fromMillis(0),
    updatedAt: Timestamp.fromMillis(0),
  });
  store.set(`users/${userId}`, { firstName: fixture.applicant.firstName, lastName: fixture.applicant.lastName, email: fixture.applicant.email });
  store.set(`eligibilityChecks/check-${fixture.id}`, {
    userId,
    visaTypeId: rubric.visaTypeId,
    countryCode: rubric.countryCode,
    nationality: fixture.applicant.nationality,
    score: fixture.eligibilityScore,
    answers: [{ questionId: "q1", answer: "yes" }],
    createdAt: Timestamp.fromMillis(1_000),
  });

  // ---- documents: bytes come from the fixture's own lines, never from Storage ----
  const bytesByPath = new Map<string, Buffer>();
  for (const d of fixture.documents) {
    const path = `golden/${fixture.id}/${d.id}`;
    bytesByPath.set(path, buildTextPdf(d.lines));
    store.set(`documents/${d.id}-${fixture.id}`, {
      applicationId: appId,
      userId,
      storageUrl: path,
      fileName: `${d.id}.pdf`,
      fileType: "application/pdf",
      fileSizeMb: 0.01,
      status: "uploaded",
      documentType: d.label,
      updatedAt: Timestamp.fromMillis(2_000),
      uploadedAt: Timestamp.fromMillis(2_000),
    });
  }

  // ---- the statement: one ProseMirror paragraph per fixture paragraph ----
  if (fixture.statement) {
    store.set(`documentTemplates/tpl-sop`, { category: "sop", name: "Template" });
    store.set(`documentInstances/stmt-${fixture.id}`, {
      applicationId: appId,
      templateId: "tpl-sop",
      title: "Statement",
      createdBy: "agent-golden",
      status: "final",
      version: 1,
      content: {
        type: "doc",
        // An empty paragraph has no `content` node, like an empty editor block.
        content: fixture.statement.paragraphs.map((p) => (p ? { type: "paragraph", content: [{ type: "text", text: p }] } : { type: "paragraph" })),
      },
      updatedAt: Timestamp.fromMillis(3_000),
    });
  }

  const svc = serviceWith(provider, {}, {
    loadBytes: async (path: string) => {
      const b = bytesByPath.get(path);
      if (!b) throw new Error(`no fixture bytes for ${path}`);
      return b;
    },
  });
  const app = { id: appId, ...(store.get(`applications/${appId}`) as any) } as Application;
  const out = await svc.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: "golden" });
  if (!("assessmentId" in out)) throw new Error(`fixture ${fixture.id}: request resolved to ${out.kind}, expected an assessment`);
  const result = await svc.runJob(out.assessmentId);
  const assessment = store.get(`applicationAssessments/${out.assessmentId}`) as unknown as ApplicationAssessment;
  if (!assessment) throw new Error(`fixture ${fixture.id}: no stored assessment (job ${result})`);
  // The job's own `now` is the harness clock; kept so a reader sees it is fixed.
  void NOW;
  return { fixture, rubric, assessment, requestCount: Array.isArray(provider.requests) ? provider.requests.length : 0 };
}
