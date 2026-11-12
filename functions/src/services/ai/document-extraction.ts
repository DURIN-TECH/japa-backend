import type { DocumentExtraction } from "./assessment-engine";
import { buildExtractionRequest, extractionIsSuspicious, parseExtraction } from "./assessment-engine";
import type { LlmProvider, LlmRequest, LlmUsage } from "./llm-provider";

// ============================================
// SINGLE-DOCUMENT EXTRACTION (issues #42 stage 2, reused by #115)
// ============================================
//
// This is stage 2 of the assessment, factored out of the job loop so that the
// per-upload document check (#115) and the full assessment (#42) run the SAME
// code on a document: one media-type sniff, one request builder
// (`buildExtractionRequest`), one VALUES-ONLY response schema, one parser
// (`parseExtraction`), one injection check (`extractionIsSuspicious`). There is
// no second copy of the prompt or the schema.
//
// What stays the caller's job: loading the bytes, the size cap (it needs the
// settings), the per-job request/size caps (passed in as `beforeCall`, which may
// throw), and everything that DECIDES anything from the values. The model only
// reads; it never says whether a document is acceptable.
//
// Document bytes are untrusted. The media type is sniffed from the bytes, never
// taken from the stored name; the file reaches the model as an attached block
// and its label is a code-written string wrapped by `wrapUntrusted`.

/** Media type from the bytes, never from the stored name. Null when unsupported. */
export function sniffMediaType(bytes: Buffer): "application/pdf" | "image/jpeg" | "image/png" | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

/**
 * A cheap look at a PDF's bytes, without a PDF library: is it encrypted, and
 * about how many pages does it have. The page count is a heuristic (it counts
 * page objects it can see in the file body; a PDF that packs its page tree into
 * compressed object streams reports 0, which means "unknown", never "too many").
 */
export function inspectPdf(bytes: Buffer): { encrypted: boolean; pages: number } {
  // latin1 keeps every byte as one character, so a binary PDF is searchable.
  const text = bytes.toString("latin1");
  const encrypted = /\/Encrypt\b/.test(text);
  const pages = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return { encrypted, pages };
}

/** Why a document produced no values, as a stable code the caller can map to words. */
export type ExtractionFailureCode =
  | "unsupported_type" //  not a PDF, JPEG or PNG
  | "password_protected" // an encrypted PDF
  | "too_many_pages" //    over the caller's page cap
  | "model_refused" //     the provider declined to read it
  | "bad_answer" //        the answer broke the output contract
  | "call_failed"; //      the provider call failed (or the model is not configured)

export interface ExtractOneInput {
  provider: LlmProvider;
  documentId: string;
  /** A code label (never the stored file name, which the applicant typed). */
  label: string;
  bytes: Buffer;
  /** The fields to read (the extraction schema's `field` enum). */
  fields: readonly string[];
  /** Page cap for a PDF. Absent means no cap (the assessment's behaviour). */
  maxPages?: number;
  /** Per-request wall-clock budget. Absent keeps the request builder's default. */
  timeoutMs?: number;
  /**
   * Called with the built request just BEFORE the provider is called. May throw
   * to stop (the assessment's cost caps do). Not called when nothing is sent.
   */
  beforeCall?: (request: LlmRequest) => void;
}

export interface ExtractOneResult {
  extraction: DocumentExtraction;
  /** Why there are no values, when there are none because of a failure. */
  failureCode: ExtractionFailureCode | null;
  /** Token usage when the provider answered; null when no answer came back. */
  usage: LlmUsage | null;
  /** True when a request was sent to the provider. */
  called: boolean;
  /** Model id that answered, when it did. */
  model: string | null;
}

/** An extraction that produced nothing because the file itself was not usable. */
function unreadable(base: { documentId: string; label: string }, reason: string, mediaType = ""): DocumentExtraction {
  return { ...base, mediaType, readable: false, values: [], failed: false, failure: reason, suspicious: false };
}

/** An extraction whose answer failed: counted as unread, never as a pass. */
function failedExtraction(base: { documentId: string; label: string }, reason: string, mediaType = ""): DocumentExtraction {
  return { ...base, mediaType, readable: false, values: [], failed: true, failure: reason, suspicious: false };
}

/**
 * Run stage 2 on ONE document's bytes.
 *
 * Never throws for a provider or answer problem (those become a failed
 * extraction with a code). Only `beforeCall` may throw, and that error is
 * rethrown untouched so the caller's own stop rule applies.
 */
export async function extractOneDocument(input: ExtractOneInput): Promise<ExtractOneResult> {
  const base = { documentId: input.documentId, label: input.label };
  const done = (extraction: DocumentExtraction, failureCode: ExtractionFailureCode | null, usage: LlmUsage | null, called: boolean, model: string | null = null): ExtractOneResult => ({
    extraction,
    failureCode,
    usage,
    called,
    model,
  });

  // ---- 1. media type from the bytes ----
  const mediaType = sniffMediaType(input.bytes);
  if (!mediaType) return done(unreadable(base, "file type is not supported"), "unsupported_type", null, false);

  // ---- 2. cheap PDF guards, before any bytes leave the backend ----
  if (mediaType === "application/pdf") {
    const pdf = inspectPdf(input.bytes);
    if (pdf.encrypted) return done(unreadable(base, "the file is password protected", mediaType), "password_protected", null, false);
    if (input.maxPages !== undefined && pdf.pages > input.maxPages) {
      return done(unreadable(base, `the file has more than ${input.maxPages} pages`, mediaType), "too_many_pages", null, false);
    }
  }

  // ---- 3. the request: the SAME builder the assessment uses ----
  const request = buildExtractionRequest({ label: input.label, mediaType, data: input.bytes.toString("base64") }, input.fields);
  if (input.timeoutMs !== undefined) request.timeoutMs = input.timeoutMs;
  // May throw (assessment cost caps). Deliberately outside the try below.
  input.beforeCall?.(request);

  // ---- 4. the call, and the answer checked in code ----
  try {
    const res = await input.provider.complete(request);
    if (res.stopReason === "refusal") {
      return done(failedExtraction(base, "the model declined to read the file", mediaType), "model_refused", res.usage, true, res.model);
    }
    const parsed = parseExtraction(res.text, input.fields);
    if (!parsed.ok) {
      return done(failedExtraction(base, `the answer broke the contract: ${parsed.reason}`, mediaType), "bad_answer", res.usage, true, res.model);
    }
    // A document that addresses the model is flagged; its values are then never used.
    const suspicious = extractionIsSuspicious(parsed.values);
    return done(
      { ...base, mediaType, readable: parsed.readable, values: parsed.values, failed: false, failure: null, suspicious },
      null,
      res.usage,
      true,
      res.model
    );
  } catch {
    // One document failing never fails the caller: counted as unread.
    return done(failedExtraction(base, "the model call failed", mediaType), "call_failed", null, true);
  }
}
