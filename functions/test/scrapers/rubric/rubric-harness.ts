// ============================================
// Rubric extraction test harness (issue #40)
// ============================================
//
// Not a test file. Shared by the rubric suites: an in-memory bucket for
// snapshot text, helpers that put a guidance source and its snapshot in the
// in-memory Firestore fake exactly as the #39 crawl leaves them, builders for
// hand-written model answers, and a service wired to a RecordedLlmProvider.
//
// There is NO network and NO model here: every "model answer" is written by
// hand in the test and replayed by request hash. A request with no recording
// fails the test.

import { Timestamp } from "firebase-admin/firestore";
import { RecordedLlmProvider, type LlmRecording } from "../../../src/services/ai/llm-provider";
import { GuidanceSnapshotStore, type SnapshotBucket } from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { PDF_PAGE_SEPARATOR } from "../../../src/scrapers/shared/fetch/pdf-text";
import { chunkSnapshot } from "../../../src/scrapers/rubric/rubric-chunk";
import { buildRubricRequest, type RawCriterion, type RawRubricOutput } from "../../../src/scrapers/rubric/rubric-prompt";
import { RubricExtractionService, type RubricExtractionDeps } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { DEFAULT_RUBRIC_SETTINGS, type RubricExtractionSettings } from "../../../src/scrapers/rubric/rubric-settings";
import { RubricStore } from "../../../src/scrapers/rubric/rubric.store";
import { DEFAULT_SEVERITY_LEVELS } from "../../../src/types/rubric";
import { fakeCollection, fakeRunTransaction, store } from "../../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The run clock used by every suite. */
export const T0 = Date.parse("2026-11-11T02:00:00Z");

// ----- In-memory bucket -----

/** Object name -> stored JSON. Reset with `resetBucket`. */
export const objects = new Map<string, string>();

/** Empty the in-memory bucket. */
export function resetBucket(): void {
  objects.clear();
}

/** A bucket that keeps objects in `objects` (create-only, like the real one). */
const bucket: SnapshotBucket = {
  file(name: string) {
    return {
      async save(data) {
        if (objects.has(name)) throw Object.assign(new Error("Precondition Failed"), { code: 412 });
        objects.set(name, data);
      },
      async exists() {
        return [objects.has(name)];
      },
      async download() {
        const o = objects.get(name);
        if (o === undefined) throw Object.assign(new Error("No such object"), { code: 404 });
        return [Buffer.from(o, "utf8")];
      },
    };
  },
};

/** The real snapshot store over the in-memory bucket. */
export const snapshotStore = new GuidanceSnapshotStore(bucket);

// ----- Seeding a source the way the crawl leaves it -----

/** What `seedSource` needs. Give `text` for a web page or `pages` for a PDF. */
export interface SeedSourceInput {
  id: string;
  url: string;
  text?: string;
  pages?: string[];
  publishedDate?: string;
  fetchedAtMs?: number;
}

/**
 * Store a snapshot (text in the bucket, metadata in Firestore) and point the
 * source's `latestSnapshotId` at it. Calling it again with new text is "the
 * source changed". Returns the content hash.
 */
export async function seedSource(input: SeedSourceInput): Promise<string> {
  const docType = input.pages ? "pdf" : "html";
  const text = input.pages ? input.pages.join(PDF_PAGE_SEPARATOR) : (input.text as string);
  const fetchedAtMs = input.fetchedAtMs ?? T0 - 3_600_000;
  const written = await snapshotStore.write({ sourceId: input.id, docType, url: input.url, finalUrl: input.url, fetchedAtMs, text, pages: input.pages });
  store.set(`guidanceSources/${input.id}`, {
    title: input.id,
    url: input.url,
    finalUrl: input.url,
    docType,
    status: "active",
    latestSnapshotId: written.contentHash,
    lastContentHash: written.contentHash,
    publishedDate: input.publishedDate ?? null,
  });
  store.set(`guidanceSources/${input.id}/snapshots/${written.contentHash}`, {
    sourceId: input.id,
    contentHash: written.contentHash,
    docType,
    url: input.url,
    finalUrl: input.url,
    fetchedAt: Timestamp.fromMillis(fetchedAtMs),
    publishedDate: input.publishedDate ?? null,
    pageCount: input.pages ? input.pages.length : null,
    storagePath: written.storagePath,
  });
  return written.contentHash;
}

// ----- Hand-written model answers -----

/** A full proposed criterion from the fields a test cares about. */
export function crit(fields: Partial<RawCriterion> & Pick<RawCriterion, "ref" | "title" | "kind" | "quote">): RawCriterion {
  return {
    stage: "eligibility",
    severity: "high",
    ruleRef: null,
    concernsIntent: false,
    check: null,
    appliesTo: null,
    validFrom: null,
    validUntil: null,
    probeFactors: [],
    requiresInterviewBeforeRefusal: null,
    citations: [],
    confidence: 0.9,
    ...fields,
  };
}

/** A full answer from the parts a test cares about. */
export function answer(fields: Partial<RawRubricOutput>): RawRubricOutput {
  return { criteria: [], intentPolarity: null, intake: null, intakeQuestions: [], evidenceItems: [], suspiciousPassages: [], ...fields };
}

/** Token usage every recorded answer reports (so totals are predictable). */
export const RECORDED_USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * Record the answers for one source's chunks, keyed by the exact requests
 * the service will build for the source's CURRENT snapshot. `answers[i]`
 * answers chunk i; a string is recorded as raw text (for malformed answers).
 */
export async function recordAnswers(
  provider: RecordedLlmProvider,
  sourceId: string,
  answers: (RawRubricOutput | string | (LlmRecording & { raw: true }))[],
  settings: RubricExtractionSettings = DEFAULT_RUBRIC_SETTINGS
): Promise<void> {
  const hash = (store.get(`guidanceSources/${sourceId}`) as any).latestSnapshotId as string;
  const content = await snapshotStore.read(sourceId, hash);
  const chunks = chunkSnapshot(content, settings.maxChunkChars);
  if (chunks.length !== answers.length) throw new Error(`${sourceId} has ${chunks.length} chunk(s) but ${answers.length} answer(s) were given`);
  chunks.forEach((chunk, i) => {
    const request = buildRubricRequest(chunk, DEFAULT_SEVERITY_LEVELS, { maxOutputTokens: settings.maxOutputTokensPerRequest, timeoutMs: settings.requestTimeoutMs });
    const a = answers[i];
    if (typeof a === "string") provider.record(request, { text: a, usage: RECORDED_USAGE });
    else if ("raw" in a) provider.record(request, { usage: RECORDED_USAGE, ...a });
    else provider.record(request, { text: JSON.stringify(a), usage: RECORDED_USAGE });
  });
}

// ----- Service wiring -----

/** A service plus the fakes it runs on. */
export interface Harness {
  service: RubricExtractionService;
  provider: RecordedLlmProvider;
  rubrics: RubricStore;
  // Mutable: a test may change settings or the read error between runs.
  settings: RubricExtractionSettings;
  state: { readError?: string; nowMs: number; knownVisaTypes: Set<string> };
}

/**
 * Build a service over the recorded provider, the in-memory bucket and the
 * Firestore fake. Every visa type in `state.knownVisaTypes`
 * ("<countryCode>/<visaTypeId>") exists.
 */
export function makeHarness(deps: Partial<RubricExtractionDeps> = {}): Harness {
  const provider = new RecordedLlmProvider();
  const rubrics = new RubricStore();
  rubrics.runTransaction = fakeRunTransaction as any;
  const h: Harness = {
    provider,
    rubrics,
    settings: { ...DEFAULT_RUBRIC_SETTINGS },
    state: { nowMs: T0, knownVisaTypes: new Set() },
    service: undefined as unknown as RubricExtractionService,
  };
  h.service = new RubricExtractionService({
    provider,
    snapshots: snapshotStore,
    store: rubrics,
    loadSettings: async () => ({ settings: h.settings, ...(h.state.readError ? { readError: h.state.readError } : {}) }),
    visaTypeExists: async (cc, id) => h.state.knownVisaTypes.has(`${cc}/${id}`),
    now: () => Timestamp.fromMillis(h.state.nowMs),
    ...deps,
  });
  return h;
}

/** Swap the Firestore refs the rubric code reaches for in-memory fakes. */
export async function installRubricFakes(): Promise<void> {
  const firebase: any = await import("../../../src/utils/firebase");
  firebase.collections.guidanceSources = fakeCollection("guidanceSources");
  firebase.collections.visaRubrics = fakeCollection("visaRubrics");
  firebase.collections.rubricExtractionRuns = fakeCollection("rubricExtractionRuns");
  firebase.collections.appConfig = fakeCollection("appConfig");
  firebase.subcollections.guidanceSnapshots = (id: string) => fakeCollection(`guidanceSources/${id}/snapshots`);
  firebase.subcollections.rubricVersions = (key: string) => fakeCollection(`visaRubrics/${key}/rubricVersions`);
  firebase.subcollections.visaTypes = (cc: string) => fakeCollection(`countries/${cc}/visaTypes`);
}

/** Run with console output silenced (the service logs summaries and discards). Returns what was logged. */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const lines: string[] = [];
  console.log = console.warn = console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** The stored version doc of a route. */
export const versionDoc = (routeKey: string, version: number) => store.get(`visaRubrics/${routeKey}/rubricVersions/${version}`) as any;
/** The stored head doc of a route. */
export const headDoc = (routeKey: string) => store.get(`visaRubrics/${routeKey}`) as any;
/** Paths of every stored rubric version. */
export const versionPaths = () => [...store.keys()].filter((p) => p.includes("/rubricVersions/"));
/** Every stored run record. */
export const runDocs = () => [...store.entries()].filter(([p]) => p.startsWith("rubricExtractionRuns/")).map(([, d]) => d as any);
