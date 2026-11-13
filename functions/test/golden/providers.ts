// ============================================
// Golden set — the replay provider and the recording provider (issue #35)
// ============================================
//
// Both implement the engine's own `LlmProvider` interface, so the REAL engine
// code runs unchanged over either:
//
//   GoldenReplayProvider     CI. Answers from recordings/<fixture>.json, keyed
//                            by the engine's own `llmRequestHash` (role, both
//                            prompts, schema, attached-file digests). It can
//                            never reach the network. A request with no
//                            recording is NOT answered; it is remembered in
//                            `misses`, and the runner turns that into a gate
//                            failure naming the fixture and the refresh command.
//   GoldenRecordingProvider  the refresh command (`npm run golden:record`).
//                            Wraps the live provider, stores each answer, and
//                            enforces a spend cap and stop-at-first-error.
//
// Why `misses` and not just a throw: the engine deliberately swallows a provider
// failure (one document failing must not fail the job; a failed judgement call
// becomes "insufficient"). A plain throw would therefore not fail the test, it
// would silently change the assessment. The miss list is how a missing recording
// stays loud.
//
// A recording holds ONLY what replay needs: the answer text, the stop reason,
// the usage numbers and the model id. Never the request (prompt, document
// bytes), never a header, never an environment value.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AiModelRole } from "../../src/services/ai/ai-models";
import { AI_MODELS } from "../../src/services/ai/ai-models";
import {
  LlmProviderError,
  llmRequestHash,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from "../../src/services/ai/llm-provider";

/** Directory of the recordings, relative to functions/. */
export const RECORDINGS_DIR = "test/golden/recordings";

/** One stored model answer. */
export interface StoredRecording {
  // llmRequestHash of the request it answers.
  hash: string;
  // The role of the request (for a human reading the file; not used to match).
  role: AiModelRole;
  // The model id that answered.
  model: string;
  stopReason: string | null;
  usage: LlmUsage;
  // The answer text, exactly as the model returned it.
  text: string;
}

/** The file stored per fixture. */
export interface RecordingFile {
  fixtureId: string;
  // When it was recorded (ISO date). Informational.
  recordedOn: string;
  // The outcome of the run that produced it: what `golden:record` compares the
  // NEXT refresh against to print the band delta.
  recordedOutcome: { readiness: string | null; refusalGroundIds: string[] };
  recordings: StoredRecording[];
}

/** Where a fixture's recording file lives. */
export function recordingPath(fixtureId: string): string {
  return resolve(process.cwd(), RECORDINGS_DIR, `${fixtureId}.json`);
}

/** Read a fixture's recording file, or null when it does not exist. */
export function readRecordingFile(fixtureId: string): RecordingFile | null {
  const p = recordingPath(fixtureId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as RecordingFile;
}

/** The command that refreshes one fixture's recording (named in every failure message). */
export function refreshCommand(fixtureId: string): string {
  return `npm run golden:record -- --fixture ${fixtureId}`;
}

// ============================================
// Replay
// ============================================

/** One request that had no recording. */
export interface RecordingMiss {
  role: AiModelRole;
  hash: string;
}

/** Replays a fixture's recorded answers. Never reaches the network. */
export class GoldenReplayProvider implements LlmProvider {
  private readonly byHash = new Map<string, StoredRecording>();
  /** Requests that had no recording, in order. Non-empty means the fixture FAILS. */
  readonly misses: RecordingMiss[] = [];
  /** Every request received, in order (the gate counts calls and reads prompts). */
  readonly requests: LlmRequest[] = [];
  /**
   * What was answered to each EXTRACTION request, in call order (the job reads
   * documents in id order). The gate re-derives the objective outcomes from
   * these, independently of the engine's own run (assertions.ts, check c).
   */
  readonly extractionAnswers: Array<{ text: string; stopReason: string | null }> = [];

  constructor(
    private readonly fixtureId: string,
    file: RecordingFile | null
  ) {
    for (const r of file?.recordings ?? []) this.byHash.set(r.hash, r);
  }

  /** The real role -> model mapping, so a stored assessment records the roles the engine really uses. */
  modelFor(role: AiModelRole): string {
    return AI_MODELS[role];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const hash = llmRequestHash(request);
    const hit = this.byHash.get(hash);
    if (!hit) {
      this.misses.push({ role: request.role, hash });
      // The engine catches this and carries on; the runner reads `misses`.
      throw new LlmProviderError(
        "missing_recording",
        `fixture ${this.fixtureId}: no recording for ${request.role} request ${hash.slice(0, 12)}; refresh with: ${refreshCommand(this.fixtureId)}`
      );
    }
    if (request.role === "extraction") this.extractionAnswers.push({ text: hit.text, stopReason: hit.stopReason });
    return { text: hit.text, stopReason: hit.stopReason, usage: { ...hit.usage }, model: hit.model };
  }
}

// ============================================
// Recording (live)
// ============================================

/** Why a recording run stopped early. */
export class RecordingAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingAborted";
  }
}

/**
 * Wraps the live provider. Stores every answer; counts calls against a cap;
 * after the first error (or the cap) it refuses every further call WITHOUT
 * reaching the network, so a failing run spends at most one more call than the
 * one that failed.
 */
export class GoldenRecordingProvider implements LlmProvider {
  /** Answers of the fixture currently running, by hash. */
  private current = new Map<string, StoredRecording>();
  /** Calls made to the live provider in this whole run. */
  calls = 0;
  /** Token totals of the whole run, as the API reported them. */
  readonly totals: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /** Set at the first failure; every later call is refused. */
  fatal: string | null = null;

  constructor(
    private readonly live: LlmProvider,
    private readonly maxCalls: number
  ) {}

  modelFor(role: AiModelRole): string {
    return this.live.modelFor(role);
  }

  /** Start collecting for a fixture. */
  begin(): void {
    this.current = new Map();
  }

  /** The answers collected since `begin()`, in call order. */
  collected(): StoredRecording[] {
    return [...this.current.values()];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (this.fatal) throw new RecordingAborted(this.fatal);
    if (this.calls >= this.maxCalls) {
      this.fatal = `spend cap reached: ${this.maxCalls} model calls`;
      throw new RecordingAborted(this.fatal);
    }
    this.calls++;
    try {
      const res = await this.live.complete(request);
      this.totals.inputTokens += res.usage.inputTokens;
      this.totals.outputTokens += res.usage.outputTokens;
      this.totals.cacheReadTokens += res.usage.cacheReadTokens;
      this.totals.cacheWriteTokens += res.usage.cacheWriteTokens;
      const hash = llmRequestHash(request);
      this.current.set(hash, { hash, role: request.role, model: res.model, stopReason: res.stopReason, usage: { ...res.usage }, text: res.text });
      return res;
    } catch (err) {
      // LlmProviderError carries a redacted one-line message (no key, no headers).
      this.fatal = `${request.role} call ${this.calls} failed: ${err instanceof Error ? err.message : "error"}`;
      throw err;
    }
  }
}
