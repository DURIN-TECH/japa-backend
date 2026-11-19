// ============================================
// Entry requirements (issue #236, P7 of #228) — public surface
// ============================================
//
// "Do you need a visa at all": sourced entry rules, drafted from official
// pages and published by automatic safeguards, answered by a free lookup.
// See README.md in this folder.

export { entryRequirementsRoutes, adminEntryRuleRoutes } from "./entry-requirements.routes";
export { entryRequirementsService, EntryRequirementsService } from "./entry-requirements.service";
export type { LookupInput, LookupDeps } from "./entry-requirements.service";
export { answerEntryRequirements, strictnessRank } from "./entry-requirements-answer";
export { runEntryRuleDrafting } from "./entry-rule-pipeline";
export { ENTRY_RULE_PROMPT_VERSION, ENTRY_CHECK_PROMPT_VERSION } from "./entry-rule-prompt";
export * from "../types/entry-requirements";
