import { AI_MODELS } from "./ai-models";
import { describeAnthropicError, getAnthropicClient } from "./anthropic-client";
import { messageParamsFor, type LlmRequest, type LlmResponse } from "./llm-provider";

// ============================================
// BATCH PROVIDER — Message Batches API (issue #37)
// ============================================
//
// Bulk re-assessment sends its requests through the provider's Message Batches
// API (discounted, asynchronous, results within 24 hours) instead of the
// interactive path. This module is the only place that touches
// `client.messages.batches`; it goes through the shared client factory
// (anthropic-client.ts) and never `fetch`.
//
// The calls match the installed SDK (1.8.0, resources/messages/batches.d.ts):
//   batches.create({ requests: [{ custom_id, params }] })  -> MessageBatch
//   batches.retrieve(id)                                   -> MessageBatch
//                                       (processing_status: in_progress | canceling | ended)
//   batches.results(id)  -> JSONLDecoder<{ custom_id, result }>  (async iterable)
//   result.type: "succeeded" (has `message`) | "errored" | "canceled" | "expired"
// The params of one request are the same object the interactive path builds
// (`messageParamsFor`): no temperature, schema through `output_config.format`
// without `strict`, no tools. Results arrive in ANY order and are matched by
// `custom_id`.
//
// Logging rule: this module logs nothing and never prints a prompt, a response,
// the client or a request. Errors become a secret-free one-liner through
// describeAnthropicError().

/** One request of a batch. `customId` is 1 to 64 characters of [A-Za-z0-9_-]. */
export interface BatchRequestItem {
  customId: string;
  request: LlmRequest;
}

/** Where a provider batch stands. */
export interface BatchProgress {
  // `in_progress` and `canceling` are both "not ended yet".
  ended: boolean;
  // Request counts as the provider reports them.
  counts: { succeeded: number; errored: number; canceled: number; expired: number; processing: number };
}

/** The outcome of one request of an ended batch. */
export type BatchItemOutcome =
  | { kind: "succeeded"; response: LlmResponse }
  // The provider could not answer it (invalid request, overloaded, ...). Worth
  // another round: the failure is not about the content.
  | { kind: "errored"; message: string }
  // Not answered because the batch was cancelled or hit its 24 hour limit.
  | { kind: "canceled" }
  | { kind: "expired" };

/** The batch contract. Another backend (or a fake in tests) implements this. */
export interface LlmBatchProvider {
  /** Submit a batch; resolves to the provider's batch id. Throws on any failure (message is secret-free). */
  submit(items: BatchRequestItem[]): Promise<string>;
  /** Where a batch stands. */
  progress(providerBatchId: string): Promise<BatchProgress>;
  /** Every result of an ENDED batch, in the provider's order. */
  results(providerBatchId: string): AsyncIterable<{ customId: string; outcome: BatchItemOutcome }>;
}

/** Per-call options: the batch endpoints are quick; a bounded timeout and one retry. */
const CALL_OPTIONS = { timeout: 120_000, maxRetries: 1 } as const;

/** The real batch provider, over the shared client. */
export class AnthropicBatchProvider implements LlmBatchProvider {
  /** @throws Error (secret-free message) when the provider refuses the batch. */
  async submit(items: BatchRequestItem[]): Promise<string> {
    // Throws AnthropicNotConfiguredError before anything is sent.
    const client = getAnthropicClient();
    try {
      const batch = await client.messages.batches.create(
        {
          requests: items.map((i) => ({
            custom_id: i.customId,
            params: messageParamsFor(i.request, AI_MODELS[i.request.role]),
          })),
        },
        CALL_OPTIONS
      );
      return batch.id;
    } catch (err) {
      throw new Error(describeAnthropicError(err));
    }
  }

  async progress(providerBatchId: string): Promise<BatchProgress> {
    const client = getAnthropicClient();
    try {
      const b = await client.messages.batches.retrieve(providerBatchId, undefined, CALL_OPTIONS);
      return {
        ended: b.processing_status === "ended",
        counts: {
          succeeded: b.request_counts.succeeded,
          errored: b.request_counts.errored,
          canceled: b.request_counts.canceled,
          expired: b.request_counts.expired,
          processing: b.request_counts.processing,
        },
      };
    } catch (err) {
      throw new Error(describeAnthropicError(err));
    }
  }

  async *results(providerBatchId: string): AsyncIterable<{ customId: string; outcome: BatchItemOutcome }> {
    const client = getAnthropicClient();
    let decoder;
    try {
      decoder = await client.messages.batches.results(providerBatchId, undefined, CALL_OPTIONS);
    } catch (err) {
      throw new Error(describeAnthropicError(err));
    }
    for await (const line of decoder) {
      const r = line.result;
      if (r.type === "succeeded") {
        const m = r.message;
        // Same mapping as the interactive provider: text blocks joined, thinking ignored.
        let text = "";
        for (const block of m.content) if (block.type === "text") text += block.text;
        yield {
          customId: line.custom_id,
          outcome: {
            kind: "succeeded",
            response: {
              text,
              stopReason: m.stop_reason,
              usage: {
                inputTokens: m.usage.input_tokens ?? 0,
                outputTokens: m.usage.output_tokens ?? 0,
                cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
              },
              model: m.model,
            },
          },
        };
      } else if (r.type === "errored") {
        // Only the error's type and message: never the whole object.
        const e = r.error as { error?: { type?: string; message?: string } };
        yield { customId: line.custom_id, outcome: { kind: "errored", message: `${e.error?.type ?? "error"}: ${e.error?.message ?? "unknown"}`.slice(0, 300) } };
      } else if (r.type === "canceled") {
        yield { customId: line.custom_id, outcome: { kind: "canceled" } };
      } else {
        yield { customId: line.custom_id, outcome: { kind: "expired" } };
      }
    }
  }
}
