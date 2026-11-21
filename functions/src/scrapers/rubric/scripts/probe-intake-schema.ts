/**
 * Does the provider accept the intake answer format? ONE probe, offline by default (issue #456).
 *
 * WHY: the provider compiles the output schema of a request into a grammar and refuses a schema
 * whose grammar is too large (HTTP 400 "The compiled grammar is too large"). That limit is not
 * published, so the only proof that a schema is accepted is one request. The v13 intake schema met
 * every published limit and was still refused during the #335 run (2026-11-21). This command checks
 * the v14 schema with the smallest request that compiles it, BEFORE any paid rulebook call (#335).
 *
 * WHAT IT SENDS (with `--live` only): exactly the params production sends for call 2, built by the
 * SAME builder (`messageParamsFor`, the one the interactive and Batch API paths share) with the
 * SAME schema (`buildIntakeOutputSchema()`, byte-identical) and the SAME model (`AI_MODELS.judgement`),
 * but a fixed, document-free system and user text ("Return empty lists."), `max_tokens` 256 and
 * effort `low`. So the grammar compiled is the production one, and the answer costs almost nothing:
 * about 1,500 input tokens and at most 256 output tokens, under $0.01 on the judgement model. A
 * refused compile is a 400, which the provider does not bill.
 *
 * OFFLINE BY DEFAULT: without `--live` nothing is sent and the key is never read. It prints the
 * model, the schema's hash and its measured size (optional / union parameters, depth, paths).
 *
 * `--live`: ONE request, the SDK's retry off (`maxRetries: 0`, so one send is one request), a
 * timeout of 240 s (the provider's first compile of a schema can be slow; its compile timeout is
 * 180 s). The key is read from `.env.local` (`ANTHROPIC_API_KEY`) by node, as the other rubric
 * scripts do, and never printed. It prints ONLY the HTTP outcome, the `stop_reason` and the token
 * usage, never the answer text:
 *   - HTTP 200, whatever the `stop_reason` (`max_tokens` included): the schema is ACCEPTED;
 *   - HTTP 400 about the grammar or the schema's complexity: the schema is REFUSED;
 *   - anything else: an ERROR that says nothing about the schema (try again later).
 *
 * WHAT IT NEVER DOES: read or write Firestore, Storage or any project; touch a rulebook; send a
 * document; retry; send more than one request. It is not the #335 retry.
 *
 * Run (from functions/):
 *   npm run probe:intake-schema            # offline: 0 requests
 *   npm run probe:intake-schema -- --live  # ONE paid request (owner approval first)
 */
import { createHash } from "node:crypto";
import { AI_MODELS } from "../../../services/ai/ai-models";
import { messageParamsFor, type LlmRequest } from "../../../services/ai/llm-provider";
import { buildIntakeOutputSchema } from "../rubric-prompt";
import { describeSchemaSize, measureSchema, type SchemaSize } from "../rubric-schema-size";

/** The probe's fixed text: no document, no route, nothing per-run (system and user alike). */
export const PROBE_TEXT = "Return empty lists.";

/** Output limit of the probe: enough for the empty answer; a `max_tokens` stop still proves the compile. */
export const PROBE_MAX_TOKENS = 256;

/** Per-request timeout: above the provider's 180 s compile timeout, so a slow first compile is waited for. */
export const PROBE_TIMEOUT_MS = 240_000;

/** The probe request: the production intake schema around a fixed, document-free text. */
export function buildProbeRequest(): LlmRequest {
  return {
    role: "judgement",
    system: PROBE_TEXT,
    user: PROBE_TEXT,
    schema: buildIntakeOutputSchema(),
    maxOutputTokens: PROBE_MAX_TOKENS,
    timeoutMs: PROBE_TIMEOUT_MS,
    effort: "low",
    // One send = one request: the SDK never retries the probe.
    maxRetries: 0,
  };
}

/** What the probe would send, as data (built offline; nothing is sent). */
export interface ProbePlan {
  model: string;
  // sha256 of the schema exactly as sent (JSON, no whitespace): the id of the schema the outcome is about.
  schemaHash: string;
  size: SchemaSize;
  request: LlmRequest;
  // The Messages API params, from the production builder.
  params: ReturnType<typeof messageParamsFor>;
}

/** Build the plan: the request, its params, the schema's hash and size. Pure, offline. */
export function probePlan(): ProbePlan {
  const request = buildProbeRequest();
  const model = AI_MODELS.judgement;
  const params = messageParamsFor(request, model);
  return {
    model,
    schemaHash: createHash("sha256").update(JSON.stringify(request.schema)).digest("hex"),
    size: measureSchema(request.schema),
    request,
    params,
  };
}

/** What one live probe found. `accepted` / `refused` are about the schema; `error` is not. */
export type ProbeOutcome =
  | { verdict: "accepted"; status: number; stopReason: string | null; usage: { inputTokens: number; outputTokens: number } }
  | { verdict: "refused" | "error"; status: number | null; errorType: string | null };

/**
 * Read an SDK error as a probe outcome. A 400 whose message is about the grammar or the schema's
 * complexity is a refusal of the schema; anything else is an error that proves nothing either way.
 * The message is read for those words only and is never printed or returned.
 */
export function outcomeOfError(err: unknown): ProbeOutcome {
  const e = (err && typeof err === "object" ? err : {}) as { status?: unknown; type?: unknown; error?: { error?: { type?: unknown } } };
  const status = typeof e.status === "number" ? e.status : null;
  const errorType = typeof e.error?.error?.type === "string" ? e.error.error.type : typeof e.type === "string" ? e.type : null;
  const message = err instanceof Error ? err.message : "";
  const aboutSchema = /grammar|schema|too complex|complexity/i.test(message);
  return { verdict: status === 400 && aboutSchema ? "refused" : "error", status, errorType };
}

/** The one send the probe makes (the real one, or a fake in tests). Returns the HTTP status and the message. */
export type ProbeSend = (plan: ProbePlan) => Promise<{ status: number; stopReason: string | null; usage: { input_tokens?: number; output_tokens?: number } }>;

/**
 * Run the probe. Offline (`live` false): print the plan, send nothing, never call `send`. Live:
 * call `send` exactly once and print the outcome (HTTP status, stop reason and usage, or the error's
 * status and type). Never prints the answer text, a key or the provider's message.
 */
export async function runProbe(opts: { live: boolean; send?: ProbeSend; print: (line: string) => void }): Promise<{ plan: ProbePlan; requests: number; outcome: ProbeOutcome | null }> {
  const plan = probePlan();
  opts.print(`probe-intake-schema: model ${plan.model}, schema sha256 ${plan.schemaHash}`);
  for (const line of describeSchemaSize(plan.size).split("\n")) opts.print(`  ${line}`);
  opts.print(`  request: max_tokens ${plan.params.max_tokens}, effort ${plan.request.effort}, timeout ${plan.request.timeoutMs / 1000} s, SDK retries ${plan.request.maxRetries}`);
  if (!opts.live) {
    opts.print("(offline: 0 requests sent. Add --live to send the ONE probe request; it needs the owner's approval.)");
    return { plan, requests: 0, outcome: null };
  }
  if (!opts.send) throw new Error("a live probe needs a sender");
  let outcome: ProbeOutcome;
  try {
    const res = await opts.send(plan);
    // HTTP 200 means the grammar compiled: the schema is accepted whatever the stop reason.
    outcome = { verdict: "accepted", status: res.status, stopReason: res.stopReason, usage: { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 } };
  } catch (err) {
    outcome = outcomeOfError(err);
  }
  if (outcome.verdict === "accepted") {
    opts.print(`live: HTTP ${outcome.status}, stop_reason ${String(outcome.stopReason)}, input tokens ${outcome.usage.inputTokens}, output tokens ${outcome.usage.outputTokens}`);
    opts.print(`ACCEPTED: the provider compiled the intake schema ${plan.schemaHash}.`);
  } else {
    opts.print(`live: HTTP ${outcome.status ?? "none"}, error type ${outcome.errorType ?? "unknown"}`);
    opts.print(outcome.verdict === "refused" ? `REFUSED: the provider did not compile the intake schema ${plan.schemaHash}.` : "ERROR: the outcome says nothing about the schema; do not count this as accepted or refused.");
  }
  return { plan, requests: 1, outcome };
}

/** The real sender: the shared client, one non-streamed request, the SDK retry off. Reads the key. */
const realSend: ProbeSend = async (plan) => {
  // Loaded only here, so the offline probe never reads the key or loads the SDK.
  const { getAnthropicClient } = await import("../../../services/ai/anthropic-client");
  const client = getAnthropicClient();
  const { data, response } = await client.messages.create(plan.params, { timeout: plan.request.timeoutMs, maxRetries: 0 }).withResponse();
  // The answer text (`data.content`) is deliberately never read.
  return { status: response.status, stopReason: data.stop_reason ?? null, usage: data.usage };
};

/** The command line: offline unless `--live`; any other argument is refused. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--live");
  if (unknown.length > 0) {
    console.error("usage: probe-intake-schema [--live]   (offline by default; --live sends ONE request)");
    process.exitCode = 2;
    return;
  }
  const live = args.includes("--live");
  const { outcome } = await runProbe({ live, send: live ? realSend : undefined, print: (l) => console.log(l) });
  // Exit 0 offline or accepted; 1 refused or error (a script that chains the #335 retry stops here).
  process.exitCode = outcome === null || outcome.verdict === "accepted" ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => {
    // The class only: an unexpected failure prints no message (it could quote a request).
    console.error(`probe-intake-schema: failed (${e instanceof Error ? e.constructor.name : typeof e})`);
    process.exitCode = 1;
  });
}
