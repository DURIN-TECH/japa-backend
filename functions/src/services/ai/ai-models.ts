// ============================================
// AI MODEL IDS — the one place they are written (issue DURIN-TECH/japa#31)
// ============================================
//
// Every Claude model id the backend requests lives in this file, keyed by the
// ROLE the model plays rather than by its name. Callers import a role:
//
//   import { AI_MODELS } from "../services/ai/ai-models";
//   client.messages.create({ model: AI_MODELS.judgement, ... });
//
// so swapping a model (a new generation, a cheaper tier after an eval) is a
// one-line change here instead of a hunt for string literals. Do NOT write a
// `claude-…` literal anywhere else in `functions/src`.
//
// Pure module: no SDK import, no env read, no Firebase. Safe to import from
// anywhere (including tests) at zero cost.
//
// The ids are Anthropic's current-generation aliases, written exactly as
// published (no date suffix). The role -> model mapping below is the starting
// default only: issue #42 (assessment engine) owns the real model choice and
// should confirm or change it against an eval before relying on it.

/**
 * The roles an AI task can ask for. Add a role here (never a bare model id at
 * the call site) when a new kind of task lands.
 *  - `extraction`: high-volume, well-specified structured reads (pull fields
 *    out of an uploaded document, classify a page). Cheapest/fastest tier.
 *  - `drafting`:   writing for a human to review (template drafts, summaries
 *    of a case for an agent). Mid tier.
 *  - `judgement`:  decisions that weigh evidence against rules (eligibility
 *    assessment, agent pre-review). Most capable tier of the three.
 *  - `verification`: the INDEPENDENT second reader of the automatic rulebook
 *    publisher (issue #202): it re-reads each rule an extraction produced
 *    against its own quoted sentence and answers closed verdicts only. It is
 *    its own role, on the mid tier, so it is never the extractor's model
 *    (`judgement` drafts the rulebook) and its tier can be changed on its own.
 */
export type AiModelRole = "extraction" | "drafting" | "judgement" | "verification";

/** Role -> Claude model id. The single source of truth for model ids. */
export const AI_MODELS: Readonly<Record<AiModelRole, string>> = Object.freeze({
  extraction: "claude-haiku-5-5",
  drafting: "claude-sonnet-5-5",
  judgement: "claude-opus-5-5",
  verification: "claude-sonnet-5-5",
});
