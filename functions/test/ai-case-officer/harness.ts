// ============================================
// Test harness — AI case-officer assessment (issue #42)
// ============================================
//
// Not a test file. Shared by the assessment suites.
//
//  - In-memory Firestore for every collection the job reads or writes (the
//    setup preload fails a test that reaches an unfaked ref).
//  - ScriptedProvider: a stub LlmProvider. A test answers each request by role,
//    and every request is recorded, so a suite can assert the number of model
//    calls and the exact prompt text. No network, no SDK.
//  - Two FICTIONAL rubrics (route A and route B). Nothing in the engine knows
//    either one; they are data handed to the same code path.
//  - Document bytes carry a key ("KEY:<name>") so the scripted provider can
//    answer per document without parsing a real file.

import { Timestamp } from "firebase-admin/firestore";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../src/services/ai/llm-provider";
import type { AiModelRole } from "../../src/services/ai/ai-models";
import type { AssessmentCriterion, CriterionKind, DecisionStage, IntentPolarity, VisaRubric } from "../../src/types/rubric";
import { DEFAULT_SEVERITY_LEVELS } from "../../src/types/rubric";
import { AiCaseOfficerService, type AssessmentDeps, type RubricReader } from "../../src/services/ai-case-officer.service";
import { mergeAiSettings, type AiSettings } from "../../src/services/ai/ai-settings";
import { fakeCollection, fakeRunTransaction, resetStore, store } from "../helpers/fake-firestore";
import { collections, subcollections } from "../../src/utils/firebase";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A fixed clock for every suite. */
export const NOW = new Date("2026-11-11T10:00:00Z");

// ----- Scripted provider -----

/** Answers a request. Return the answer text. */
export type Responder = (request: LlmRequest, key: string | null) => string | Promise<string>;

/**
 * A stub provider. `respond` answers by role; `key` is the KEY carried by the
 * attached document, or null for a text-only call. Every request is recorded.
 */
export class ScriptedProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly respond: Responder) {}
  modelFor(role: AiModelRole): string {
    return `scripted-${role}`;
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const key = request.documents?.[0] ? keyOfBytes(Buffer.from(request.documents[0].data, "base64")) : null;
    const text = await this.respond(request, key);
    return { text, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.modelFor(request.role) };
  }
  callsFor(role: AiModelRole): number {
    return this.requests.filter((r) => r.role === role).length;
  }
}

/** Bytes for a synthetic PDF that carries a key the scripted provider can read. */
export function docBytes(key: string): Buffer {
  return Buffer.from(`%PDF-1.4 synthetic KEY:${key}`, "latin1");
}

/** The key carried by synthetic bytes, or null. */
export function keyOfBytes(bytes: Buffer): string | null {
  const m = /KEY:([A-Za-z0-9_-]+)/.exec(bytes.toString("latin1"));
  return m ? m[1] : null;
}

// ----- Fictional rubrics -----

/** A criterion with a citation. The quote is fictional; the engine copies it, never reads it. */
export function criterion(
  partial: Partial<AssessmentCriterion> & Pick<AssessmentCriterion, "criterionId" | "kind" | "stage" | "severity" | "title">
): AssessmentCriterion {
  return {
    ruleRef: undefined,
    source: {
      quote: `Fictional source text for ${partial.criterionId}.`,
      sourceId: "fictional-source",
      url: `https://example.test/${partial.criterionId}`,
      contentHash: "hash-1",
      retrievedAt: "2026-11-01T00:00:00.000Z",
    },
    confidence: 0.9,
    ...partial,
  } as AssessmentCriterion;
}

/** Build a rubric (the fields the engine reads). Approved, version 1 unless told otherwise. */
export function fictionalRubric(opts: {
  countryCode: string;
  visaTypeId: string;
  version?: number;
  intentPolarity: IntentPolarity | null;
  criteria: AssessmentCriterion[];
  severityLevels?: string[];
}): VisaRubric {
  return {
    schemaVersion: 1,
    routeKey: `${opts.countryCode}_${opts.visaTypeId}`,
    countryCode: opts.countryCode,
    visaTypeId: opts.visaTypeId,
    version: opts.version ?? 1,
    reviewStatus: "approved",
    intentPolarity: opts.intentPolarity,
    reviewedBy: "fixture-admin",
    reviewedAt: null,
    rejectReason: null,
    revision: 1,
    supersededAt: null,
    intentPolarityProposal: null,
    severityLevels: opts.severityLevels ?? [...DEFAULT_SEVERITY_LEVELS],
    criteria: opts.criteria,
    intakeQuestions: [],
    evidenceItems: [],
    sourceSnapshots: [],
    sourceSetHash: "set-1",
    extractorModel: "fixture",
    extractorPromptVersion: "fixture",
    extractionRunId: "fixture",
    discardedCount: 0,
    discarded: [],
    suspiciousPassages: [],
    flags: [],
    createdAt: Timestamp.fromMillis(0),
  } as unknown as VisaRubric;
}

/**
 * Route A: a mandatory bar for one nationality, two objective checks (funds
 * amount and holder), a presence check on the statement period, and two judgement
 * criteria (a genuine-visit factor, and an intention criterion).
 */
export function routeARubric(opts: { intentPolarity?: IntentPolarity | null; fundsMinimum?: number; version?: number } = {}): VisaRubric {
  return fictionalRubric({
    countryCode: "AA",
    visaTypeId: "route-a",
    version: opts.version,
    intentPolarity: opts.intentPolarity === undefined ? "immigrant_intent_penalised" : opts.intentPolarity,
    criteria: [
      criterion({
        criterionId: "a-bar",
        title: "Nationality bar",
        kind: "mandatory_bar",
        stage: "suitability",
        severity: "critical",
        appliesTo: { nationalities: ["PK"], asWritten: ["Pakistani"] },
      }),
      criterion({
        criterionId: "a-funds",
        title: "Funds meet the minimum",
        kind: "objective",
        stage: "eligibility",
        severity: "high",
        check: { field: "funds.balance", op: "gte", value: opts.fundsMinimum ?? 2000, unit: "GBP" },
      }),
      criterion({
        criterionId: "a-holder",
        title: "Funds held by the applicant",
        kind: "objective",
        stage: "eligibility",
        severity: "medium",
        check: { field: "funds.holderIsApplicant", op: "eq", value: true },
      }),
      criterion({
        criterionId: "a-period",
        title: "Statement period shown",
        kind: "objective",
        stage: "validity",
        severity: "low",
        check: { field: "statement.endDate", op: "present" },
      }),
      criterion({
        criterionId: "a-genuine",
        title: "Genuine visit factors",
        kind: "judgement",
        stage: "credibility",
        severity: "high",
        probeFactors: ["plans to leave at the end of the visit", "purpose of the visit"],
      }),
      criterion({
        criterionId: "a-intent",
        title: "Intention to stay",
        kind: "judgement",
        stage: "credibility",
        severity: "medium",
        concernsIntent: true,
        probeFactors: ["ties to home"],
      }),
    ],
  });
}

/**
 * Route B: a different route. A bar for a different nationality, one objective
 * check with a different unit, and one judgement criterion. Same engine.
 */
export function routeBRubric(opts: { version?: number } = {}): VisaRubric {
  return fictionalRubric({
    countryCode: "AA",
    visaTypeId: "route-b",
    version: opts.version,
    intentPolarity: "dual_intent_permitted",
    criteria: [
      criterion({
        criterionId: "b-bar",
        title: "Other nationality bar",
        kind: "mandatory_bar",
        stage: "suitability",
        severity: "critical",
        appliesTo: { nationalities: ["NG"], asWritten: ["Nigerian"] },
      }),
      criterion({
        criterionId: "b-funds",
        title: "Balance at least 500",
        kind: "objective",
        stage: "eligibility",
        severity: "medium",
        check: { field: "funds.balance", op: "gte", value: 500, unit: "USD" },
      }),
      criterion({
        criterionId: "b-ties",
        title: "Ties to the home country",
        kind: "judgement",
        stage: "credibility",
        severity: "low",
        probeFactors: ["employment at home"],
      }),
    ],
  });
}

// ----- Store and fakes -----

/** The approved rubrics the service can see, by `CC_visaType`. */
export const rubricBook = new Map<string, VisaRubric>();

/** Empty the store, the rubric book and the stored settings. */
export function resetAll(): void {
  resetStore();
  rubricBook.clear();
}

/** Install the in-memory Firestore for every collection the assessment touches. */
export async function installAssessmentFakes(): Promise<void> {
  const firebase: any = await import("../../src/utils/firebase");
  for (const name of [
    "applications",
    "users",
    "eligibilityChecks",
    "documents",
    "documentInstances",
    "documentTemplates",
    "applicationAssessments",
    "aiCosts",
    "appConfig",
  ]) {
    firebase.collections[name] = fakeCollection(name);
  }
  void collections;
  void subcollections;
}

/** A rubric reader over the book. */
export const bookReader: RubricReader = {
  async getApprovedRubric(cc, vt) {
    return rubricBook.get(`${cc}_${vt}`) ?? null;
  },
  async approvedVersionOf(cc, vt) {
    return rubricBook.get(`${cc}_${vt}`)?.version ?? null;
  },
};

/** The service under test, over the given provider and settings. */
export function serviceWith(
  provider: LlmProvider,
  settings: Partial<AiSettings> = {},
  overrides: Partial<AssessmentDeps> = {}
): AiCaseOfficerService {
  const resolved = mergeAiSettings(settings as Record<string, unknown>);
  const deps: AssessmentDeps = {
    provider,
    rubrics: bookReader,
    loadBytes: async (path: string) => docBytes(path.replace(/^storage\//, "")),
    runTransaction: fakeRunTransaction,
    readSettings: async () => ({ ok: true, settings: resolved }),
    now: () => NOW,
    ...overrides,
  };
  return new AiCaseOfficerService(deps);
}

// ----- Seeding -----

export interface SeedApplicationOpts {
  id: string;
  userId?: string;
  visaTypeId?: string;
  agencyId?: string | null;
  agentId?: string;
  title?: string;
}

/** An application in the store, on route A unless told otherwise. */
export function seedApplication(opts: SeedApplicationOpts): void {
  store.set(`applications/${opts.id}`, {
    userId: opts.userId ?? "client-1",
    visaTypeId: opts.visaTypeId ?? "route-a",
    countryCode: "AA",
    mode: "agent",
    agentId: opts.agentId ?? "agent-1",
    agencyId: opts.agencyId === undefined ? "agency-1" : opts.agencyId ?? undefined,
    status: "submitted",
    title: opts.title ?? "Application",
    startDate: Timestamp.fromMillis(0),
    lastUpdated: Timestamp.fromMillis(0),
    createdAt: Timestamp.fromMillis(0),
    updatedAt: Timestamp.fromMillis(0),
  });
}

/** An applicant profile. */
export function seedUser(id: string, firstName: string, lastName: string): void {
  store.set(`users/${id}`, { firstName, lastName, email: `${id}@example.test` });
}

/** The latest eligibility check for the application's user and route. */
export function seedEligibility(opts: { userId?: string; visaTypeId?: string; nationality: string; score: number; checkId?: string; createdAtMs?: number }): void {
  store.set(`eligibilityChecks/${opts.checkId ?? "check-1"}`, {
    userId: opts.userId ?? "client-1",
    visaTypeId: opts.visaTypeId ?? "route-a",
    countryCode: "AA",
    nationality: opts.nationality,
    score: opts.score,
    answers: [{ questionId: "q1", answer: "yes" }],
    createdAt: Timestamp.fromMillis(opts.createdAtMs ?? 1_000),
  });
}

/** An uploaded document on an application. `key` names what the scripted provider answers. */
export function seedDocument(opts: { id: string; applicationId?: string; key: string; label?: string; updatedAtMs?: number; sizeMb?: number }): void {
  store.set(`documents/${opts.id}`, {
    applicationId: opts.applicationId ?? "app-1",
    userId: "client-1",
    storageUrl: `storage/${opts.key}`,
    fileName: `${opts.key}.pdf`,
    fileType: "application/pdf",
    fileSizeMb: opts.sizeMb ?? 0.1,
    status: "uploaded",
    documentType: opts.label ?? "Bank statement",
    updatedAt: Timestamp.fromMillis(opts.updatedAtMs ?? 2_000),
    uploadedAt: Timestamp.fromMillis(2_000),
  });
}

/** A statement instance (SOP or cover letter) with plain text. */
export function seedStatement(opts: { id: string; applicationId?: string; text: string; category?: string; version?: number }): void {
  const templateId = `tpl-${opts.category ?? "sop"}`;
  store.set(`documentTemplates/${templateId}`, { category: opts.category ?? "sop", name: "Template" });
  store.set(`documentInstances/${opts.id}`, {
    applicationId: opts.applicationId ?? "app-1",
    templateId,
    title: "Statement",
    createdBy: "agent-1",
    status: "final",
    version: opts.version ?? 1,
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: opts.text }] }] },
    updatedAt: Timestamp.fromMillis(3_000),
  });
}

/** The first assessment's stored document for an application, or null. */
export function storedAssessments(applicationId: string): any[] {
  const out: any[] = [];
  for (const [path, data] of store.entries()) {
    if (path.startsWith("applicationAssessments/") && (data as any).applicationId === applicationId) out.push({ path, ...data });
  }
  return out;
}

/** Every string value in a JSON-able tree, for deep key and wording checks. */
export function allKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

export type { CriterionKind, DecisionStage };
