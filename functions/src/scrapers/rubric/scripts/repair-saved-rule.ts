/**
 * Check ONE saved protected rule, and, when the check does not confirm it,
 * give it its one automatic repair and check the replacement (issue #223),
 * from a SAVED snapshot and a SAVED rule: no extraction run, no Firestore, no
 * deploy, and nothing is written anywhere.
 *
 * It runs the PRODUCTION code path (`RubricCheckerService.check`, the same
 * service the publish run calls): both check models read the rule; if either does
 * not answer `yes` on every aspect, the rule is re-drafted ONCE from its own
 * source passage, validated by the drafting code, and both models read the
 * replacement. The printed report is the held record's entry for the rule.
 *
 * OFFLINE BY DEFAULT: with no `--live` it only reads the two files and prints
 * what it would send (whether the quote is found, the size of the passage window
 * a re-draft would be shown). `--live` is the ONLY model use: 2 check requests,
 * plus (only when the rule fails) 1 re-draft request and 2 more check requests.
 * It uses the key in `.env.local` (`ANTHROPIC_API_KEY`), never printed.
 *
 * Files (same shapes as `recheck-list-and-group.ts`):
 *   --page  a stored guidance snapshot JSON ({ text, pages, sourceId, contentHash, url, fetchedAt, ... })
 *   --rules a JSON array holding ONE rule: { "criterionId", "title", "kind", "stage", "severity",
 *           "quote", "applicability"?, "applicabilityCondition"?, "appliesTo"?: { "nationalities",
 *           "asWritten", "uncoded"? } }
 *
 * Run (from functions/):
 *   npm run build && node --env-file-if-exists=.env.local lib/scrapers/rubric/scripts/repair-saved-rule.js --page <stored-page.json> --rules <one-rule.json> --live
 * Prints rule titles, verdict letters and counts only (never quote text, keys or error text).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import type { AssessmentCriterion } from "../../../types/rubric";
import { SnapshotQuoteIndex } from "../rubric-quote";
import { readLeadInList, verifyListItems } from "../rubric-list-items";
import { REPAIR_WINDOW_CHARS, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_LINES_BEFORE } from "../rubric-repair";
import { DEFAULT_PUBLISH_SETTINGS } from "../rubric-publish-settings";

/** Value of `--name value`, or undefined. */
const arg = (name: string): string | undefined => {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : undefined;
};

async function main(): Promise<void> {
  const pagePath = arg("page");
  const rulesPath = arg("rules");
  if (!pagePath || !rulesPath) {
    console.error("usage: --page <stored-page.json> --rules <one-rule.json> [--live]");
    process.exit(2);
  }
  const snapshot = JSON.parse(readFileSync(pagePath, "utf8"));
  const index = new SnapshotQuoteIndex(snapshot);
  const raw = JSON.parse(readFileSync(rulesPath, "utf8")) as Array<Record<string, any>>;
  if (raw.length !== 1) {
    console.error("give exactly ONE rule in --rules");
    process.exit(2);
  }
  const r = raw[0];
  const found = index.locate(r.quote);
  if (!found.ok) {
    console.log(`${r.criterionId}: quote NOT found (${found.reason}); a real run would hold this bar before any spend.`);
    return;
  }
  // The list lines of a lead-in quote come from the stored text, like at extraction (#222).
  const read = readLeadInList(index, found);
  const listItems = read.kind === "items" && verifyListItems(index, found, read.items).ok ? read.items : undefined;
  const rule = {
    criterionId: r.criterionId, title: r.title, kind: r.kind, stage: r.stage, severity: r.severity,
    applicability: r.applicability, applicabilityCondition: r.applicabilityCondition,
    ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
    source: { quote: found.matched, sourceId: snapshot.sourceId, url: snapshot.url, contentHash: snapshot.contentHash, retrievedAt: snapshot.fetchedAt, ...(listItems ? { listItems } : {}) },
    confidence: 1,
  } as AssessmentCriterion;
  const window = index.passageWindow(found, REPAIR_WINDOW_LINES_BEFORE, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_CHARS);
  console.log(`${rule.criterionId} "${rule.title}": quote found; lead-in list ${read.kind}${listItems ? ` (${listItems.length} lines attached)` : ""}; a re-draft would be shown ${window.text.length} characters of source.`);

  if (!process.argv.includes("--live")) {
    console.log("\n(offline: no model was called; add --live to run the check, and the one repair if the rule fails)");
    return;
  }

  // The ONLY place a model is called. The production check over the real provider, the saved page and an in-memory ledger.
  const { RubricCheckerService } = await import("../rubric-checker");
  const { AnthropicLlmProvider } = await import("../../../services/ai/llm-provider");
  const records = new Map<string, any>();
  const service = new RubricCheckerService({
    provider: () => new AnthropicLlmProvider(),
    readSnapshot: async () => snapshot,
    loadSettings: async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, mode: "auto" }, exists: true, problems: [] }),
    ledger: {
      load: async (id) => records.get(id) ?? null,
      save: async (rec) => void records.set(rec.runId, rec),
      countRunsOnDay: async () => 0,
    },
  });
  const outcome = await service.check({
    routeKey: "SAVED_saved-rule",
    version: 1,
    runId: "SAVED_saved-rule__v1",
    rubric: { routeKey: "SAVED_saved-rule", version: 1, criteria: [rule], intentPolarityProposal: null } as any,
    codeLeftOutIds: [],
  });
  console.log(`\noutcome: ${outcome.ok ? "CONFIRMED (the rule passed, or its one repair passed)" : `NOT CONFIRMED (${outcome.reasonCodes.join(", ")})`}`);
  if (outcome.ok && outcome.repairs && outcome.repairs.length > 0) {
    const rep = outcome.repairs[0].replacement;
    console.log(`replacement (kept by the repair): "${rep.title}", kind ${rep.kind}, stage ${rep.stage}`);
    // (A quote is never logged, like everywhere else in the module: the saved page is the place to read it.)
    console.log("replacement quote: found verbatim in the saved page (not printed)");
  }
  for (const f of outcome.protectedFailures ?? []) {
    console.log(`failed aspects of the original: ${f.failedAspects.join(", ") || "(trigger)"}; verdicts ${JSON.stringify(f.verdicts)}`);
    console.log(`repair: ${f.repair.status}${f.repair.detail ? ` (${f.repair.detail})` : ""}${f.repair.replacementFailedAspects?.length ? `; the replacement still failed ${f.repair.replacementFailedAspects.join(", ")}` : ""}; verdicts ${JSON.stringify(f.repair.replacementVerdicts ?? {})}`);
  }
  if (outcome.requests) console.log(`requests: ${outcome.requests.total} (repair ${outcome.requests.repair})`);
}

main().catch((e) => {
  // The class only: never the message, which can carry a path.
  console.error(`repair-saved-rule failed: ${(e as Error).constructor.name}`);
  process.exit(1);
});
