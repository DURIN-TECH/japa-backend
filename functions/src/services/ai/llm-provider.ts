import { createHash } from "crypto";
import { AI_MODELS, type AiModelRole } from "./ai-models";
import { describeAnthropicError, getAnthropicClient } from "./anthropic-client";

// ============================================
// LLM PROVIDER — the swappable model interface (issue #40)
// ============================================
//
// Every structured model call goes through `LlmProvider`, so the code that
// builds prompts and validates answers never touches an SDK and can be tested
// against stored responses:
//
//   AnthropicLlmProvider   the real one (shared client from #31)
//   RecordedLlmProvider    tests: returns a stored response keyed by a hash of
//                          the request; a request with no recording THROWS.
//                          It can never reach the network.
//
// The request shape follows what the pinned SDK accepts (confirmed in #31):
//  - no `temperature` / `top_p` / `top_k` (rejected by the API);
//  - structured output through `output_config.format`
//    `{ type: "json_schema", schema }`. There is no `strict` flag there, so
//    the CALLER must validate the returned JSON against its schema in code
//    and treat a mismatch as a failure;
//  - no tools at all, and so no forced tool choice (rejected by the larger
//    models). A document handed to the model cannot cause an action;
//  - a per-request timeout (the SDK default is 10 minutes).
//
// Logging rule: this module logs nothing. It never prints a prompt, a
// response, the client or a request options object. Errors are turned into a
// secret-free one-liner by describeAnthropicError().

/** One structured request: a system prompt, one user message, one schema. */
export interface LlmRequest {
  // The role decides the model (ai-models.ts); never a model id literal.
  role: AiModelRole;
  // Stable instructions. Must hold no per-document data.
  system: string;
  // The data for this call (already wrapped in its delimiters by the caller).
  user: string;
  // JSON Schema the answer must follow.
  schema: Record<string, unknown>;
  // Upper bound on generated tokens (thinking included).
  maxOutputTokens: number;
  // Wall-clock budget for this one HTTP request, in ms.
  timeoutMs: number;
  // Thinking depth. Optional: the provider's default applies when absent.
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Token counts of one call, as the API reported them (never estimated). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The outcome of one call. */
export interface LlmResponse {
  // The answer text (all text blocks joined). The caller parses and validates.
  text: string;
  // Why the model stopped ("end_turn", "max_tokens", "refusal", ...).
  stopReason: string | null;
  usage: LlmUsage;
  // The model id that answered.
  model: string;
}

/** The provider contract. Any model backend implements this. */
export interface LlmProvider {
  /** Model id used for a role (recorded on whatever the call produces). */
  modelFor(role: AiModelRole): string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** A provider failure with a stable code and a loggable, secret-free message. */
export class LlmProviderError extends Error {
  constructor(
    readonly code: "provider_error" | "missing_recording",
    message: string
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/** A blank usage record. */
export function emptyLlmUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

// ============================================
// Anthropic provider
// ============================================

/** Retries left to the SDK per request (connection errors, 429, 5xx). */
const MAX_RETRIES = 1;

/** The real provider, over the shared client. */
export class AnthropicLlmProvider implements LlmProvider {
  /** Model id for a role, from the one config module. */
  modelFor(role: AiModelRole): string {
    return AI_MODELS[role];
  }

  /**
   * Send one request and wait for the whole answer.
   *
   * The call is STREAMED and the final message awaited: a large `max_tokens`
   * on a non-streaming request can outlive the HTTP connection, and nothing
   * here needs the partial events. Nothing is streamed onwards.
   *
   * @throws AnthropicNotConfiguredError when the key is not set (from the
   *   client factory, unchanged, so callers can report "AI is not configured")
   * @throws LlmProviderError("provider_error") for any API failure
   */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Throws AnthropicNotConfiguredError before anything is sent.
    const client = getAnthropicClient();
    const model = this.modelFor(request.role);
    try {
      const message = await client.messages
        .stream(
          {
            model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
            // Schema-constrained JSON. No `strict` field exists here: the
            // caller re-validates the answer in code.
            output_config: {
              format: { type: "json_schema", schema: request.schema },
              ...(request.effort ? { effort: request.effort } : {}),
            },
            // Deliberately absent: temperature / top_p / top_k (rejected),
            // tools and tool_choice (the model must not be able to act).
          },
          { timeout: request.timeoutMs, maxRetries: MAX_RETRIES }
        )
        .finalMessage();

      // Join the text blocks; thinking blocks are ignored.
      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
      }
      return {
        text,
        stopReason: message.stop_reason,
        usage: {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
        model: message.model ?? model,
      };
    } catch (err) {
      // Never rethrow the raw SDK error: keep status / type / request id and
      // a redacted message only.
      throw new LlmProviderError("provider_error", describeAnthropicError(err));
    }
  }
}

// ============================================
// Recorded provider (tests, replays)
// ============================================

/**
 * Stable hash of a request: what a recording is keyed by. Covers everything
 * that changes the answer (role, both prompts, the schema); the timeout and
 * token ceiling are left out so tuning them does not orphan recordings.
 */
export function llmRequestHash(request: Pick<LlmRequest, "role" | "system" | "user" | "schema">): string {
  return createHash("sha256")
    .update(JSON.stringify([request.role, request.system, request.user, request.schema]))
    .digest("hex");
}

/** What a recording holds: the answer text, and optionally the rest. */
export interface LlmRecording {
  text: string;
  stopReason?: string | null;
  usage?: Partial<LlmUsage>;
}

/**
 * Replays stored answers. A request with no recording throws
 * LlmProviderError("missing_recording"): a test can never fall through to a
 * live call, and a prompt change that orphans a recording is loud.
 */
export class RecordedLlmProvider implements LlmProvider {
  /** request hash -> recording. */
  private readonly recordings = new Map<string, LlmRecording>();
  /** Every request received, in order (tests assert on prompts and counts). */
  readonly requests: LlmRequest[] = [];

  /** @param model the model id to report for every role. */
  constructor(private readonly model = "recorded-model") {}

  /** Model id reported for a role. */
  modelFor(_role: AiModelRole): string {
    return this.model;
  }

  /** Store the answer for a request. */
  record(request: Pick<LlmRequest, "role" | "system" | "user" | "schema">, recording: LlmRecording): void {
    this.recordings.set(llmRequestHash(request), recording);
  }

  /** Return the stored answer for this exact request, or throw. */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const hash = llmRequestHash(request);
    const hit = this.recordings.get(hash);
    if (!hit) {
      // The hash only: never the prompt text.
      throw new LlmProviderError("missing_recording", `no recording for request ${hash.slice(0, 12)}`);
    }
    return {
      text: hit.text,
      stopReason: hit.stopReason === undefined ? "end_turn" : hit.stopReason,
      usage: { ...emptyLlmUsage(), ...(hit.usage ?? {}) },
      model: this.model,
    };
  }
}
