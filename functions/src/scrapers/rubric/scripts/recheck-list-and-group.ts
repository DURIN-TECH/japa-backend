/**
 * Re-apply the #222 fixes to two SAVED rules, from a SAVED snapshot, and
 * (only with `--live`) run the independent check on just those two rules.
 *
 * WHY: #222's verification must not need a paid re-extraction. A rule's quote
 * stays the same; code re-attaches its list lines (`source.listItems`) and the
 * group fix (`appliesTo.uncoded`) is applied to the stored group, then the
 * check reads only those rules.
 *
 * OFFLINE BY DEFAULT: no model, no network, no Firestore. It reads a stored
 * snapshot JSON file (the guidance snapshot blob: `{ text, pages, sourceId,
 * contentHash, url, fetchedAt, ... }`) and a rules JSON file, and prints what
 * code attached and whether it verifies. `--live` then sends the check request
 * to BOTH check models (2 requests per model call batch: 1 each) using the key
 * in `.env.local` (`ANTHROPIC_API_KEY`); it is the ONLY model use.
 *
 * Rules file: a JSON array, each `{ "criterionId", "title", "kind", "stage",
 * "severity", "quote", "applicability"?, "applicabilityCondition"?,
 * "appliesTo"?: { "nationalities", "asWritten", "uncoded"? } }`. For a
 * mixed group give the coded members in `nationalities` / `asWritten` and the
 * rest in `uncoded`; for a lead-in rule the quote is the lead-in sentence (the
 * list is attached here by code, never typed).
 *
 * Run (from functions/):
 *   npm run build && node lib/scrapers/rubric/scripts/recheck-list-and-group.js --page <stored-page.json> --rules <rules.json>
 *   add `--live` (with `node --env-file-if-exists=.env.local`) for the two-model check.
 * Never prints source text beyond the stored lines of the two rules, and never prints keys.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import type { AssessmentCriterion } from "../../../types/rubric";
import { SnapshotQuoteIndex, uncodedNameSupported } from "../rubric-quote";
import { readLeadInList, verifyListItems } from "../rubric-list-items";
import { buildBatchRequest, parseVerdicts, handleFor, type CheckerRuleView } from "../rubric-checker-prompt";

/** Value of `--name value`, or undefined. */
const arg = (name: string): string | undefined => {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : undefined;
};

async function main(): Promise<void> {
  const snapshotPath = arg("page");
  const rulesPath = arg("rules");
  if (!snapshotPath || !rulesPath) {
    console.error("usage: --page <stored-page.json> --rules <rules.json> [--live]");
    process.exit(2);
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const index = new SnapshotQuoteIndex(snapshot);
  const raw = JSON.parse(readFileSync(rulesPath, "utf8")) as Array<Record<string, any>>;

  const views: CheckerRuleView[] = [];
  for (const r of raw) {
    const found = index.locate(r.quote);
    if (!found.ok) {
      console.log(`${r.criterionId}: quote NOT found (${found.reason})`);
      continue;
    }
    const read = readLeadInList(index, found);
    const listItems = read.kind === "items" && verifyListItems(index, found, read.items).ok ? read.items : undefined;
    console.log(`${r.criterionId}: lead-in list ${read.kind}${read.kind === "unreadable" ? ` (${read.reason})` : ""}${listItems ? `, ${listItems.length} lines attached and verified` : ""}`);
    for (const line of listItems ?? []) console.log(`    ${line}`);
    for (const u of r.appliesTo?.uncoded ?? []) console.log(`    uncoded "${u}" named in the quote: ${uncodedNameSupported(u, found.matched)}`);
    const rule = {
      criterionId: r.criterionId, title: r.title, kind: r.kind, stage: r.stage, severity: r.severity,
      applicability: r.applicability, applicabilityCondition: r.applicabilityCondition,
      ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
      source: { quote: found.matched, sourceId: snapshot.sourceId, url: snapshot.url, contentHash: snapshot.contentHash, retrievedAt: snapshot.fetchedAt, ...(listItems ? { listItems } : {}) },
      confidence: 1,
    } as AssessmentCriterion;
    const around = index.contextAround(found, 400);
    views.push({ rule, listLeadIn: index.listLeadIn(found, 400), textBefore: around.before, textAfter: around.after });
  }

  if (!process.argv.includes("--live")) {
    console.log("\n(offline: no model was called; add --live to run the two-model check on these rules only)");
    return;
  }
  // The ONLY place a model is called: one request per check role, these rules only.
  const { AnthropicLlmProvider } = await import("../../../services/ai/llm-provider");
  const provider = new AnthropicLlmProvider();
  for (const role of ["verification", "judgement"] as const) {
    const request = buildBatchRequest(role, views, { maxOutputTokens: 4000, timeoutMs: 120_000 });
    const response = await provider.complete(request);
    const rows = parseVerdicts(response.text, views.map((_, i) => handleFor(i)));
    views.forEach((v, i) => console.log(`${role} ${v.rule.criterionId}: ${JSON.stringify(rows.get(handleFor(i)) ?? "unparsed")}`));
  }
}

main().catch((e) => {
  console.error(`recheck failed: ${(e as Error).constructor.name}`);
  process.exit(1);
});
