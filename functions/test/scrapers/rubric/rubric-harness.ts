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
import { RecordedLlmProvider, LlmProviderError, type LlmRecording, type LlmRequest, type LlmResponse } from "../../../src/services/ai/llm-provider";
import { GuidanceSnapshotStore, type SnapshotBucket } from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { PDF_PAGE_SEPARATOR } from "../../../src/scrapers/shared/fetch/pdf-text";
import { chunkSnapshot } from "../../../src/scrapers/rubric/rubric-chunk";
import { QUOTE_TRANSLATION_SYSTEM_PROMPT } from "../../../src/scrapers/rubric/rubric-translation";
import { RUBRIC_INTAKE_SYSTEM_PROMPT, delimiterTag, type RawCriterion, type RawRubricOutput } from "../../../src/scrapers/rubric/rubric-prompt";
import { RubricExtractionService, type RubricExtractionDeps } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { DEFAULT_RUBRIC_SETTINGS, type RubricExtractionSettings } from "../../../src/scrapers/rubric/rubric-settings";
import { RubricStore } from "../../../src/scrapers/rubric/rubric.store";
import { RubricExtractionJobService, type RubricExtractionJobDeps } from "../../../src/scrapers/rubric/rubric-extraction-job";
import { RubricExtractionJobStore } from "../../../src/scrapers/rubric/rubric-extraction-job.store";
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
  // (#220) The language the admin declared for the page (a code); absent = a source from before the field.
  language?: string;
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
    ...(input.language ? { language: input.language } : {}),
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
    applicability: "all_applicants",
    applicabilityCondition: null,
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
  return { criteria: [], intentPolarity: null, intake: null, intakeQuestions: [], evidenceItems: [], ruleTriggers: [], suspiciousPassages: [], ...fields };
}

/** Token usage every recorded answer reports (so totals are predictable). */
export const RECORDED_USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * A recorded provider for the TWO-CALL extraction (issue #112). Call 1 reads
 * a chunk's criteria; call 2 reads its intake questions and evidence items.
 * Which accepted criteria call 2 is sent depends on what code accepted, so
 * its request cannot be hashed in advance; recordings are therefore keyed by
 * the chunk (the delimiter tag of its snapshot and its excerpt number) and
 * the kind of call. Everything else is as the base class: a request with no
 * recording fails with `missing_recording`, and `requests` lists every
 * request received.
 */
export class ScriptedProvider extends RecordedLlmProvider {
  private readonly scripts = new Map<string, LlmRecording>();
  /**
   * (#220) What answers a translation request (the one call that is neither
   * criteria nor intake). Null = no recording: the call fails like any
   * unscripted request. `translationRequests` lists the ones received.
   */
  translate: ((req: LlmRequest) => LlmRecording) | null = null;
  readonly translationRequests: LlmRequest[] = [];

  /** Key of a request: kind of call, snapshot tag, excerpt number. */
  private static keyOf(kind: "criteria" | "intake", user: string): string {
    const tag = /<(source_text_[0-9a-f]+)> and/.exec(user)?.[1] ?? "?";
    const excerpt = /Excerpt (\d+) of/.exec(user)?.[1] ?? "?";
    return `${kind}|${tag}|${excerpt}`;
  }

  /** Script one call of one chunk. */
  script(kind: "criteria" | "intake", tag: string, excerpt: number, recording: LlmRecording): void {
    this.scripts.set(`${kind}|${tag}|${excerpt}`, recording);
  }

  override async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (request.system === QUOTE_TRANSLATION_SYSTEM_PROMPT) {
      this.translationRequests.push(request);
      if (!this.translate) throw new LlmProviderError("missing_recording", "no recording for the translation call");
      const rec = this.translate(request);
      return { text: rec.text ?? "", stopReason: rec.stopReason === undefined ? "end_turn" : rec.stopReason, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...(rec.usage ?? {}) }, model: this.modelFor("judgement") };
    }
    const kind = request.system === RUBRIC_INTAKE_SYSTEM_PROMPT ? "intake" : "criteria";
    const hit = this.scripts.get(ScriptedProvider.keyOf(kind, request.user));
    if (!hit) throw new LlmProviderError("missing_recording", `no recording for the ${kind} call`);
    return {
      text: hit.text,
      stopReason: hit.stopReason === undefined ? "end_turn" : hit.stopReason,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...(hit.usage ?? {}) },
      model: this.modelFor("judgement"),
    };
  }
}

/**
 * JSON of a hand-written answer as the provider would return it: a property
 * the schema marks optional is ABSENT rather than null (only `check.value`
 * may be an explicit null), and an evidence item without triggers gets an
 * empty `showWhenAnyOf`, which the schema requires.
 */
function wire(value: unknown): string {
  return JSON.stringify(value, (key, v) => (v === null && key !== "value" ? undefined : v));
}

/** The criteria half of an answer (call 1). */
export function criteriaWire(a: RawRubricOutput): string {
  const criteria = a.criteria.map((c) => {
    // `citations` are not part of the model's output any more.
    const { citations: _citations, ...rest } = c;
    return rest;
  });
  return wire({ criteria, ...(a.intentPolarity ? { intentPolarity: a.intentPolarity } : {}), suspiciousPassages: a.suspiciousPassages });
}

/** The intake half of an answer (call 2). */
export function intakeWire(a: RawRubricOutput): string {
  return wire({
    ...(a.intake ? { intake: a.intake } : {}),
    intakeQuestions: a.intakeQuestions,
    evidenceItems: a.evidenceItems.map((e) => ({ ...e, showWhenAnyOf: e.showWhenAnyOf ?? [] })),
    // (#207) The schema requires the list; an empty one is a valid answer.
    ruleTriggers: a.ruleTriggers ?? [],
    suspiciousPassages: [],
  });
}

/**
 * Record the answers for one source's chunks. `answers[i]` answers chunk i.
 * An answer written as one object is split into the two calls' halves; a
 * string (or a raw recording) is the answer of call 1 only, for malformed or
 * refused answers.
 */
export async function recordAnswers(
  provider: RecordedLlmProvider,
  sourceId: string,
  answers: (RawRubricOutput | string | (LlmRecording & { raw: true }))[],
  settings: RubricExtractionSettings = DEFAULT_RUBRIC_SETTINGS
): Promise<void> {
  if (!(provider instanceof ScriptedProvider)) throw new Error("recordAnswers needs a ScriptedProvider");
  const hash = (store.get(`guidanceSources/${sourceId}`) as any).latestSnapshotId as string;
  const content = await snapshotStore.read(sourceId, hash);
  const chunks = chunkSnapshot(content, settings.maxChunkChars);
  if (chunks.length !== answers.length) throw new Error(`${sourceId} has ${chunks.length} chunk(s) but ${answers.length} answer(s) were given`);
  chunks.forEach((chunk, i) => {
    const tag = delimiterTag(chunk.contentHash);
    const a = answers[i];
    if (typeof a === "string") provider.script("criteria", tag, chunk.chunkIndex + 1, { text: a, usage: RECORDED_USAGE });
    else if ("raw" in a) provider.script("criteria", tag, chunk.chunkIndex + 1, { usage: RECORDED_USAGE, ...a });
    else {
      provider.script("criteria", tag, chunk.chunkIndex + 1, { text: criteriaWire(a), usage: RECORDED_USAGE });
      provider.script("intake", tag, chunk.chunkIndex + 1, { text: intakeWire(a), usage: RECORDED_USAGE });
    }
  });
}

// ----- Service wiring -----

/** A service plus the fakes it runs on. */
export interface Harness {
  service: RubricExtractionService;
  provider: ScriptedProvider;
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
  const provider = new ScriptedProvider();
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
  // (#216) The drafting job and the stored results of its steps.
  firebase.collections.rubricExtractionJobs = fakeCollection("rubricExtractionJobs");
  firebase.subcollections.rubricExtractionSteps = (id: string) => fakeCollection(`rubricExtractionJobs/${id}/steps`);
  firebase.subcollections.rubricExtractionStepParts = (id: string) => fakeCollection(`rubricExtractionJobs/${id}/stepParts`);
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

// ----- (#216) The drafting job -----

/**
 * One in-memory transaction runner for EVERYTHING in a job test. Real Firestore
 * transactions are serialisable; the plain fake runs callbacks as they come, so
 * two racing workers could both read before either writes. Chaining them makes
 * the fake behave like the real thing for the lease tests.
 */
let txChain: Promise<unknown> = Promise.resolve();
export function serialTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const run = txChain.then(() => fakeRunTransaction(fn));
  txChain = run.catch(() => undefined);
  return run;
}

/** The error a simulated process death throws out of every database call. */
export class Killed extends Error {
  constructor() {
    super("the worker process was killed");
  }
}

/** A job service plus the knobs a test turns. */
export interface JobHarness {
  h: Harness;
  jobs: RubricExtractionJobService;
  jobStore: RubricExtractionJobStore;
  // Transactions started so far (every store: jobs and versions).
  txCount: number;
  // When set, every transaction from this number on throws `Killed` before touching anything (a dead process).
  killAtTx: number | null;
  // Model calls made, in order, as `<kind>|<snapshot tag>|<excerpt>`.
  calls: string[];
  // Milliseconds of the fake clock one model call takes.
  callMs: number;
  // Runs before each model call (may throw to script a failure); 1-based call number.
  beforeCall: ((n: number, req: LlmRequest) => void) | null;
  // Worker ids handed out, in order.
  owners: string[];
}

/**
 * Wire a job service over the harness: the same provider, snapshots, store,
 * settings and clock, serialised transactions, an instant sleep, and a fake
 * clock that moves `callMs` per model call.
 */
export function makeJobHarness(h: Harness, deps: Partial<RubricExtractionJobDeps> = {}): JobHarness {
  const jobStore = new RubricExtractionJobStore();
  const jh: JobHarness = { h, jobs: undefined as unknown as RubricExtractionJobService, jobStore, txCount: 0, killAtTx: null, calls: [], callMs: 0, beforeCall: null, owners: [] };
  /** Count the transaction, die if it is time, else run it serialised. */
  const run = <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    jh.txCount += 1;
    if (jh.killAtTx !== null && jh.txCount >= jh.killAtTx) return Promise.reject(new Killed());
    return serialTransaction(fn);
  };
  jobStore.runTransaction = run as any;
  h.rubrics.runTransaction = run as any;
  // The provider: count calls, move the clock, allow scripted failures.
  const base = h.provider.complete.bind(h.provider);
  h.provider.complete = async (req: LlmRequest) => {
    const kind = req.system === QUOTE_TRANSLATION_SYSTEM_PROMPT ? "translate" : req.system === RUBRIC_INTAKE_SYSTEM_PROMPT ? "intake" : "criteria";
    const tag = /<(source_text_[0-9a-f]+)> and/.exec(req.user)?.[1] ?? "?";
    const excerpt = /Excerpt (\d+) of/.exec(req.user)?.[1] ?? "?";
    jh.calls.push(`${kind}|${tag}|${excerpt}`);
    jh.beforeCall?.(jh.calls.length, req);
    h.state.nowMs += jh.callMs;
    return base(req);
  };
  let n = 0;
  jh.jobs = new RubricExtractionJobService({
    service: h.service,
    jobs: jobStore,
    store: h.rubrics,
    loadSettings: async () => ({ settings: h.settings, ...(h.state.readError ? { readError: h.state.readError } : {}) }),
    clock: () => h.state.nowMs,
    newOwnerId: () => {
      const id = `worker-${++n}`;
      jh.owners.push(id);
      return id;
    },
    sleep: async () => undefined,
    ...deps,
  });
  return jh;
}
