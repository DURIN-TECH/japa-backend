import { FEATURES, hasFeature, ROLES, type Entitlements } from "@durin-tech/authz";
import { AnthropicLlmProvider, LlmProviderError, type LlmProvider } from "./llm-provider";
import { AnthropicNotConfiguredError } from "./anthropic-client";
import { readAiSettings } from "./ai-settings";
import { DATA_ONLY_RULE, findBannedWording, findInjectionSignals, wrapUntrusted } from "./prompt-safety";
import { rubricStore } from "../../scrapers";
import { defaultRulebookStack, rulebookFor } from "./application-rulebook";
import { collections } from "../../utils/firebase";
import type { Application, ProseMirrorDoc, TemplateCategory } from "../../types";

// ============================================
// AI-DRAFTED DOCUMENT TEMPLATES (issue #118)
// ============================================
//
// `POST /document-templates/draft` turns an agent's short description ("invitation
// letter from a sponsor for a visiting parent") into an editable ProseMirror
// draft. THIS SERVICE ONLY READS. It never writes a template, a document
// instance, a notification, a message or an email; the one write it makes is the
// usage counter (aiCosts/{day}), which is cost accounting, not content.
//
// Trust model (the backend is the boundary, the prompt is the first line only):
//   1. FACTS. The model is told to use only the facts in the data blocks and to
//      write a bracketed placeholder for everything else. The server then checks
//      the result: any digit run (an amount, date, reference number) in the
//      non-placeholder text must already appear in what we sent, else the draft
//      is refused (DRAFT_INVALID). Only three case fields are ever sent: the
//      applicant's name, the visa type name and the destination country name.
//      No passport number, date of birth, address, phone, email or document.
//   2. WHAT TO COVER comes from the approved rubric's evidence items (their
//      titles and parties), read through rubricStore.getApprovedRubric. There is
//      no country, route or nationality text in this file.
//   3. STRUCTURE. The model returns a small JSON shape (blocks of text runs), not
//      ProseMirror. THIS CODE builds the ProseMirror doc, so only the node and
//      mark types in ALLOWED_* below can ever appear; an unknown block type, an
//      attribute, or a non-http(s) link cannot be expressed or is stripped.
//   4. WORDING. The draft is refused if it promises or predicts an outcome
//      (findBannedWording) or addresses a model (findInjectionSignals).
//   5. UNTRUSTED TEXT. The agent's description and the case fields are wrapped
//      with wrapUntrusted() and the standing DATA_ONLY_RULE is in the system prompt.

// ----- named limits (the issue asks for named constants) -----

/** Longest description accepted, in characters. */
export const MAX_DESCRIPTION_CHARS = 1_000;
/** Drafts one agent may request per UTC day (rate limit). */
export const MAX_DRAFTS_PER_AGENT_PER_DAY = 30;
/** Drafts the whole platform may produce per UTC day (spend ceiling). */
export const MAX_DRAFTS_PER_DAY_TOTAL = 500;
/** Token ceiling of one call: the per-call cost cap (no price table yet, so tokens). */
export const DRAFT_MAX_OUTPUT_TOKENS = 4_096;
/** Wall-clock budget of one call. */
export const DRAFT_TIMEOUT_MS = 60_000;
/** Evidence items passed to the model at most. */
export const MAX_EVIDENCE_ITEMS = 40;
/** Output caps: a draft over any of these is refused, never truncated. */
export const MAX_BLOCKS = 60;
export const MAX_RUNS_PER_BLOCK = 40;
export const MAX_LIST_ITEMS = 30;
export const MAX_DRAFT_CHARS = 12_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 300;
export const MAX_PLACEHOLDER_CHARS = 80;

/** Human label of each category, written into the prompt (code-controlled, not user text). */
const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  cover_letter: "cover letter",
  sop: "statement of purpose",
  affidavit: "affidavit or declaration",
  other: "other letter or document",
};

/** The valid categories (mirrors TemplateCategory). */
export const DRAFT_CATEGORIES = Object.keys(CATEGORY_LABELS) as TemplateCategory[];

/** Prompt version, recorded nowhere yet but bumped when the prompt changes. */
export const TEMPLATE_DRAFT_PROMPT_VERSION = "template-draft-2026-11-11.1";

// ----- errors -----

/** A failure with a stable code and the HTTP status the controller should send. */
export class TemplateDraftError extends Error {
  constructor(
    readonly code:
      | "VALIDATION_ERROR"
      | "AI_DISABLED"
      | "AI_NOT_CONFIGURED"
      | "RATE_LIMITED"
      | "PROVIDER_ERROR"
      | "DRAFT_REFUSED"
      | "DRAFT_INVALID",
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "TemplateDraftError";
  }
}

// ----- the model's answer shape -----

/** One run of text. `link` is "" when the run is not a link. */
export interface DraftRun {
  text: string;
  bold: boolean;
  italic: boolean;
  link: string;
}

/**
 * One block. Fields that do not apply to the type are sent empty (0 / []), so the
 * schema needs no nullable or union types.
 *   paragraph, blockquote: `runs`
 *   heading:               `runs` and `level` (1-3)
 *   bullet_list, ordered_list: `items`, one run array per list item
 */
export interface DraftBlock {
  type: "heading" | "paragraph" | "blockquote" | "bullet_list" | "ordered_list";
  level: number;
  runs: DraftRun[];
  items: DraftRun[][];
}

/** The whole answer. */
export interface DraftModelOutput {
  title: string;
  summary: string;
  blocks: DraftBlock[];
}

const RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "bold", "italic", "link"],
  properties: {
    text: { type: "string" },
    bold: { type: "boolean" },
    italic: { type: "boolean" },
    link: { type: "string" },
  },
};

/** JSON Schema sent as output_config.format. There is no `strict`, so the code re-validates. */
export const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "blocks"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "level", "runs", "items"],
        properties: {
          type: { type: "string", enum: ["heading", "paragraph", "blockquote", "bullet_list", "ordered_list"] },
          level: { type: "integer" },
          runs: { type: "array", items: RUN_SCHEMA },
          items: { type: "array", items: { type: "array", items: RUN_SCHEMA } },
        },
      },
    },
  },
};

// ----- prompts -----

/** Standing instructions. Holds no per-request data. */
export const DRAFT_SYSTEM_PROMPT = [
  "You draft a document template for an immigration adviser to edit. Your output is a DRAFT for a human to review and sign. It is never sent or saved by you.",
  DATA_ONLY_RULE,
  "Rules, all mandatory:",
  "1. Use ONLY facts stated in the data blocks. Never invent or assume a name, address, date, amount, reference number, relationship, occupation, employer, income or any other fact.",
  "2. Every fact you do not have must be a placeholder: a short label in square brackets such as [Sponsor full name] or [Date of arrival], written as its own run with bold true. Placeholders hold no other text and are at most 80 characters.",
  "3. The block named guidance_evidence lists what the official guidance says supporting material should show. Where a title there suits this document, add a paragraph or list item that states, with placeholders, what the author confirms about it. Do not claim any document is attached or exists.",
  "4. Never promise, predict or hint at an outcome. Do not write that a visa, application or request will be, is likely to be, or should be granted, approved or refused. Do not guarantee anything.",
  "5. Write in the voice of the person who will sign the document. Do not add a draft notice: the server adds it.",
  "6. Use plain, formal, neutral English. Do not mention any country's rules, law or fees unless the description states them.",
  "7. Use only these block types: heading (level 1 to 3), paragraph, blockquote, bullet_list, ordered_list. Use bold only for placeholders and short headings. Use link only for an http or https address that the description itself contains, else an empty string.",
  "8. For a field that does not apply to a block, send level 0, runs [] or items [] as the schema allows.",
  "9. title is at most 120 characters, summary at most 300, the whole document at most 12000 characters.",
].join("\n");

/** The case facts that may be sent. Exactly these three, nothing else. */
export interface DraftCaseFacts {
  applicantName: string;
  visaTypeName: string;
  destinationCountryName: string;
}

/** What the model is told to cover, from the approved rubric. */
export interface DraftEvidenceItem {
  title: string;
  party: string;
}

/**
 * Build the user turn. Pure, so a test can assert the exact payload. Every
 * piece of text that is not a fixed code label goes through wrapUntrusted().
 */
export function buildDraftUserMessage(input: {
  description: string;
  category: TemplateCategory;
  facts: DraftCaseFacts | null;
  evidence: DraftEvidenceItem[];
}): string {
  const parts: string[] = [];
  parts.push(`Document type: ${CATEGORY_LABELS[input.category]}`);
  parts.push("What the adviser wants:");
  parts.push(wrapUntrusted(input.description, "description"));
  if (input.facts) {
    parts.push("Case facts (the only facts about the applicant you may use):");
    parts.push(
      wrapUntrusted(
        [
          `applicant name: ${input.facts.applicantName}`,
          `visa type: ${input.facts.visaTypeName}`,
          `destination: ${input.facts.destinationCountryName}`,
        ].join("\n"),
        "case_facts"
      )
    );
  } else {
    parts.push("No case is attached. You have no facts about any applicant: every such fact is a placeholder.");
  }
  if (input.evidence.length > 0) {
    parts.push("Supporting material the official guidance names for this route:");
    parts.push(wrapUntrusted(input.evidence.map((e) => `- ${e.title} (${e.party})`).join("\n"), "guidance_evidence"));
  }
  return parts.join("\n\n");
}

// ----- turning the model's answer into a safe ProseMirror doc -----

/** Node and mark types that may appear in a result (the TipTap StarterKit subset used). */
export const ALLOWED_NODE_TYPES = ["doc", "heading", "paragraph", "text", "blockquote", "bulletList", "orderedList", "listItem"] as const;
export const ALLOWED_MARK_TYPES = ["bold", "italic", "link"] as const;

/** A bracketed placeholder run: `[` + 1..80 characters without brackets + `]`. */
const PLACEHOLDER_RE = new RegExp(`^\\[[^\\[\\]]{1,${MAX_PLACEHOLDER_CHARS}}\\]$`);

/** Only an http(s) URL survives; anything else becomes plain text. */
function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Strip control characters from model text. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Build the ProseMirror text nodes of one run array. Empty text is dropped. */
function textNodes(runs: DraftRun[]): unknown[] {
  const nodes: unknown[] = [];
  for (const r of runs) {
    const text = clean(r.text);
    if (!text) continue;
    const marks: Array<Record<string, unknown>> = [];
    // A bracketed placeholder is ALWAYS bold (the seed-template convention),
    // whether or not the model remembered to mark it.
    if (r.bold || PLACEHOLDER_RE.test(text.trim())) marks.push({ type: "bold" });
    if (r.italic) marks.push({ type: "italic" });
    const href = r.link ? safeHref(r.link) : null;
    if (href) marks.push({ type: "link", attrs: { href } });
    nodes.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
  }
  return nodes;
}

/** All the non-placeholder text of a run array (what the fact check reads). */
function proseOf(runs: DraftRun[]): string {
  return runs.map((r) => (PLACEHOLDER_RE.test(clean(r.text).trim()) ? " " : clean(r.text))).join("");
}

/** Digit runs of a text: amounts, dates, reference numbers, phone numbers. */
function digitRuns(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

/** Shape check of the parsed JSON. Returns the typed value or a reason. */
export function parseDraftOutput(text: string): { ok: true; value: DraftModelOutput } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the model answer was not valid JSON" };
  }
  const isRun = (v: unknown): v is DraftRun =>
    !!v && typeof v === "object" &&
    typeof (v as DraftRun).text === "string" && typeof (v as DraftRun).bold === "boolean" &&
    typeof (v as DraftRun).italic === "boolean" && typeof (v as DraftRun).link === "string";
  const o = raw as Partial<DraftModelOutput> | null;
  if (!o || typeof o.title !== "string" || typeof o.summary !== "string" || !Array.isArray(o.blocks)) {
    return { ok: false, reason: "the model answer did not match the draft shape" };
  }
  const types = ["heading", "paragraph", "blockquote", "bullet_list", "ordered_list"];
  for (const b of o.blocks as unknown[]) {
    const blk = b as Partial<DraftBlock> | null;
    if (!blk || typeof blk.type !== "string" || !types.includes(blk.type)) return { ok: false, reason: "a block had an unsupported type" };
    if (typeof blk.level !== "number" || !Array.isArray(blk.runs) || !blk.runs.every(isRun)) return { ok: false, reason: "a block was malformed" };
    if (!Array.isArray(blk.items) || !blk.items.every((it) => Array.isArray(it) && it.every(isRun))) return { ok: false, reason: "a list was malformed" };
  }
  return { ok: true, value: o as DraftModelOutput };
}

/** The deterministic notice added to the top of every draft. */
function draftNotice(): unknown {
  return {
    type: "blockquote",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "DRAFT prepared with AI assistance. Check every statement against the facts, fill in each bracketed item, and have the named signatory review and sign it: ",
            marks: [{ type: "italic" }],
          },
          { type: "text", text: "[Signatory full name]", marks: [{ type: "bold" }] },
          { type: "text", text: ". Delete this notice before use.", marks: [{ type: "italic" }] },
        ],
      },
    ],
  };
}

/**
 * Validate the model output and build the ProseMirror doc.
 *
 * @param allowedDigits digit runs that may appear outside placeholders: those in
 *   the description and the three case fields (never anything else).
 * @throws TemplateDraftError DRAFT_INVALID when the output is over a cap, breaks
 *   the wording rule, addresses a model, or states a number that was not supplied.
 */
export function buildDraftDocument(
  out: DraftModelOutput,
  allowedDigits: Set<string>
): { title: string; description: string; content: ProseMirrorDoc } {
  const invalid = (why: string): never => {
    throw new TemplateDraftError("DRAFT_INVALID", 502, `The draft could not be used (${why}). Nothing was saved. Try again or rephrase the description.`);
  };
  const title = clean(out.title).trim();
  const summary = clean(out.summary).trim();
  if (!title || title.length > MAX_TITLE_CHARS) invalid("the title was missing or too long");
  if (summary.length > MAX_SUMMARY_CHARS) invalid("the summary was too long");
  if (out.blocks.length === 0 || out.blocks.length > MAX_BLOCKS) invalid("the length was outside the allowed range");

  let totalChars = 0;
  let prose = `${title}\n${summary}`;
  const content: unknown[] = [draftNotice()];

  for (const b of out.blocks) {
    if (b.runs.length > MAX_RUNS_PER_BLOCK || b.items.length > MAX_LIST_ITEMS) invalid("a block was too long");
    const allRuns = [...b.runs, ...b.items.flat()];
    for (const r of allRuns) totalChars += r.text.length;
    prose += `\n${proseOf(allRuns)}`;

    if (b.type === "bullet_list" || b.type === "ordered_list") {
      const items = b.items
        .map((it) => textNodes(it))
        .filter((n) => n.length > 0)
        .map((n) => ({ type: "listItem", content: [{ type: "paragraph", content: n }] }));
      if (items.length === 0) continue;
      content.push({ type: b.type === "bullet_list" ? "bulletList" : "orderedList", content: items });
      continue;
    }
    const nodes = textNodes(b.runs);
    if (nodes.length === 0) continue;
    if (b.type === "heading") {
      // Level clamped to 1-3; anything else becomes 2.
      content.push({ type: "heading", attrs: { level: b.level >= 1 && b.level <= 3 ? Math.floor(b.level) : 2 }, content: nodes });
    } else if (b.type === "blockquote") {
      content.push({ type: "blockquote", content: [{ type: "paragraph", content: nodes }] });
    } else {
      content.push({ type: "paragraph", content: nodes });
    }
  }
  if (content.length < 2) invalid("the draft was empty");
  if (totalChars > MAX_DRAFT_CHARS) invalid("the draft was too long");

  // Wording and injection checks on everything the user will read.
  if (findBannedWording(prose)) invalid("it contained wording that predicts or promises an outcome");
  if (findInjectionSignals(prose)) invalid("it contained text addressed to a model");

  // Fact check: a number that was not supplied was invented.
  for (const d of digitRuns(prose)) {
    if (!allowedDigits.has(d)) invalid("it stated a number or date that was not supplied");
  }

  return { title, description: summary, content: { type: "doc", content } as ProseMirrorDoc };
}

// ----- the service -----

/** Everything the service needs from outside, so a test can replace it. */
export interface TemplateDraftDeps {
  provider: LlmProvider;
  /**
   * Approved rubric lookup: the evidence items of the application's rulebook.
   * (#233 P4b) `routeStack` is the application's stored stack, so a route with
   * a shared layer also covers the shared layer's document items.
   */
  evidenceFor(countryCode: string, visaTypeId: string, routeStack?: string[]): Promise<DraftEvidenceItem[]>;
  /** Count one draft against the agent's and the platform's daily caps; throws RATE_LIMITED. */
  claimQuota(uid: string, now: Date): Promise<void>;
}

/** The request after the controller has validated its shape. */
export interface DraftRequest {
  description: string;
  category: TemplateCategory;
  /** The application, already loaded AND access-checked by the caller. Null when none was given. */
  application: Application | null;
  requestedBy: string;
}

/** Real evidence lookup: the approved rubric's evidence items, capped. A route with none gets []. */
async function realEvidenceFor(countryCode: string, visaTypeId: string, routeStack?: string[]): Promise<DraftEvidenceItem[]> {
  try {
    // (#233 P4b) The merged STACK; exactly `getApprovedRubric` for a route with no inheritance.
    const rubric = await rulebookFor(
      { countryCode, visaTypeId, ...(routeStack ? { routeStack } : {}) },
      { getApprovedRubric: (cc, vt) => rubricStore.getApprovedRubric(cc, vt), getRulebookStack: (a) => defaultRulebookStack(a) }
    );
    if (!rubric) return [];
    return rubric.evidenceItems.slice(0, MAX_EVIDENCE_ITEMS).map((e) => ({ title: e.title, party: String(e.party) }));
  } catch {
    // A malformed route key or a failed read only means "no guidance to add".
    return [];
  }
}

/** Real quota: one Firestore transaction on aiCosts/{UTC day}. */
async function realClaimQuota(uid: string, now: Date): Promise<void> {
  const ref = collections.aiCosts.doc(now.toISOString().slice(0, 10));
  await collections.aiCosts.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.exists ? snap.data() : {}) as { templateDrafts?: number; templateDraftsByUser?: Record<string, number> };
    const total = Number(data.templateDrafts ?? 0);
    const mine = Number(data.templateDraftsByUser?.[uid] ?? 0);
    if (mine >= MAX_DRAFTS_PER_AGENT_PER_DAY) {
      throw new TemplateDraftError("RATE_LIMITED", 429, `You have used today's ${MAX_DRAFTS_PER_AGENT_PER_DAY} AI drafts. Try again tomorrow.`);
    }
    if (total >= MAX_DRAFTS_PER_DAY_TOTAL) {
      throw new TemplateDraftError("RATE_LIMITED", 429, "AI drafting is at its daily limit. Try again tomorrow.");
    }
    // Merge: nested map keys merge, so other agents' counters are untouched.
    tx.set(ref, { templateDrafts: total + 1, templateDraftsByUser: { [uid]: mine + 1 } }, { merge: true });
  });
}

export class TemplateDraftService {
  constructor(
    private readonly deps: TemplateDraftDeps = {
      provider: new AnthropicLlmProvider(),
      evidenceFor: realEvidenceFor,
      claimQuota: realClaimQuota,
    },
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Produce a draft. READ-ONLY apart from the usage counter.
   * @throws TemplateDraftError for every failure the controller should report.
   */
  async draft(req: DraftRequest): Promise<{ draft: true; title: string; description: string; content: ProseMirrorDoc }> {
    // Kill switch and settings: a failed read fails CLOSED.
    const settings = await readAiSettings();
    if (!settings.ok) throw new TemplateDraftError("AI_DISABLED", 503, "AI drafting is unavailable right now.");
    if (!settings.settings.enabled) throw new TemplateDraftError("AI_DISABLED", 503, "AI drafting is switched off.");

    // Only these three case fields ever leave the backend.
    const app = req.application;
    const facts: DraftCaseFacts | null = app
      ? {
        applicantName: (app.clientName ?? "").trim() || "[Applicant full name]",
        visaTypeName: (app.visaTypeName ?? "").trim() || "[Visa type]",
        destinationCountryName: (app.countryName ?? "").trim() || "[Destination country]",
      }
      : null;
    // What to cover: the approved rubric's evidence items for THIS application's route.
    const evidence = app ? await this.deps.evidenceFor(app.countryCode, app.visaTypeId, app.routeStack) : [];

    const user = buildDraftUserMessage({ description: req.description, category: req.category, facts, evidence });

    // Count against the caps before the paid call.
    await this.deps.claimQuota(req.requestedBy, this.now());

    let text: string;
    try {
      const res = await this.deps.provider.complete({
        role: "drafting",
        system: DRAFT_SYSTEM_PROMPT,
        user,
        schema: DRAFT_SCHEMA,
        maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
        timeoutMs: DRAFT_TIMEOUT_MS,
      });
      // A refusal, or output cut at the token ceiling, is never turned into a partial doc.
      if (res.stopReason === "refusal") {
        throw new TemplateDraftError("DRAFT_REFUSED", 422, "The model declined to write this draft. Rephrase the description and try again.");
      }
      if (res.stopReason === "max_tokens") {
        throw new TemplateDraftError("DRAFT_INVALID", 502, "The draft was too long and was cut off. Nothing was saved. Ask for something shorter.");
      }
      text = res.text;
    } catch (err) {
      if (err instanceof TemplateDraftError) throw err;
      if (err instanceof AnthropicNotConfiguredError) {
        throw new TemplateDraftError("AI_NOT_CONFIGURED", 503, "AI drafting is not configured on this server.");
      }
      // LlmProviderError carries a secret-free message; log only that.
      console.error("Template draft model call failed:", err instanceof LlmProviderError ? err.message : "unexpected error");
      throw new TemplateDraftError("PROVIDER_ERROR", 502, "The AI service could not write the draft. Nothing was saved. Try again in a moment.");
    }

    const parsed = parseDraftOutput(text);
    if (!parsed.ok) throw new TemplateDraftError("DRAFT_INVALID", 502, `The draft could not be used (${parsed.reason}). Nothing was saved.`);

    // Numbers allowed outside placeholders: only those the caller supplied.
    const allowed = new Set<string>([
      ...digitRuns(req.description),
      ...(facts ? digitRuns(`${facts.applicantName} ${facts.visaTypeName} ${facts.destinationCountryName}`) : []),
    ]);
    const doc = buildDraftDocument(parsed.value, allowed);
    return { draft: true, ...doc };
  }
}

/** Singleton over the real provider, rubric store and Firestore. */
export const templateDraftService = new TemplateDraftService();

/**
 * Fail-closed feature gate. Unlike middleware `requireFeature`, which is OFF when
 * no entitlements are resolved, this denies: admin passes; resolved entitlements
 * must include ai.case_officer; unresolved ones are refused.
 */
export function draftAccessFor(role: string | undefined, entitlements: Entitlements | null | undefined): "allowed" | "upgrade" | "unresolved" {
  if (role === ROLES.ADMIN) return "allowed";
  if (!entitlements) return "unresolved";
  return hasFeature(entitlements, FEATURES.AI_CASE_OFFICER) ? "allowed" : "upgrade";
}
