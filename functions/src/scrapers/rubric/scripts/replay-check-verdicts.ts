/**
 * Replay the verdicts a publish run stored through the CURRENT verdict mapping (issue #240).
 *
 * OFFLINE: no model, no network, no Firestore, zero requests. Reads one JSON file (an array of
 * `{ id, kind, applicability, check?, appliesTo?, sourceId, verdicts: { verification, judgement? },
 * leftOut }`: ids, kinds and verdict letters only, no quote text needed) and prints which rules the
 * check leaves out now, the shares the leave-out budget sees, and how many were found wrong versus
 * not confirmed. The mapping is the production one (`judgeRule`, `leaveOutBasis`), see
 * `rubric-verdict-replay.ts`.
 *
 * Run (from functions/):
 *   npm run build && node lib/scrapers/rubric/scripts/replay-check-verdicts.js --rules <file.json> [--primary <sourceId>,<sourceId>] [--repair [--rates 0.5,0.62,0.75]]
 * With --repair (#244) it also reports how many rules the ordinary re-draft would try, the request estimate against the
 * cap and the leave-out shares if a stated share of the re-drafts were repaired and confirmed (an assumption, not a measurement).
 * Prints counts and rule ids only.
 */
import { readFileSync } from "node:fs";
import type { ReplayRule } from "../rubric-verdict-replay";

/** Value of `--name value`, or undefined. */
const arg = (name: string): string | undefined => {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : undefined;
};

async function main(): Promise<void> {
  const file = arg("rules");
  if (!file) {
    console.error("usage: --rules <file.json> [--primary <sourceId>,<sourceId>]");
    process.exit(2);
  }
  // The mapping lives in a module that imports the Firebase wrappers (they resolve a project id at load).
  // This script never talks to Firebase, so it pins a DEMO project id (never a real one) BEFORE the import.
  process.env.GCLOUD_PROJECT = "demo-offline-replay";
  const { replayVerdicts } = await import("../rubric-verdict-replay");
  const rules = JSON.parse(readFileSync(file, "utf8")) as ReplayRule[];
  const primary = new Set((arg("primary") ?? "").split(",").filter(Boolean));
  const r = replayVerdicts(rules, primary);
  const pct = (n: number, of: number) => (of > 0 ? ` (${((100 * n) / of).toFixed(1)} %)` : "");
  console.log(`rules ${r.rules}; counted against the budget ${r.counted}${pct(r.counted, r.rules)}`);
  console.log(`general ${r.general.counted} of ${r.general.of}${pct(r.general.counted, r.general.of)}; scoped ${r.scoped.counted} of ${r.scoped.of}${pct(r.scoped.counted, r.scoped.of)}; primary ${r.primary.counted} of ${r.primary.of}${pct(r.primary.counted, r.primary.of)}`);
  console.log(`check leave-outs: ${r.foundWrong} found wrong, ${r.notConfirmed} not confirmed; code leave-outs: ${JSON.stringify(r.codeLeftOut)}`);
  console.log(`by reason: ${JSON.stringify(r.byReason)}`);
  console.log(`now kept (left out in the stored run): ${r.nowKept}; protected rules that would hold: ${r.heldProtected.length}`);
  if (process.argv.includes("--repair")) {
    const { estimateOrdinaryRepair } = await import("../rubric-verdict-replay");
    const { DEFAULT_PUBLISH_SETTINGS } = await import("../rubric-publish-settings");
    const rates = (arg("rates") ?? "0.5,0.62,0.75").split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
    const e = estimateOrdinaryRepair(rules, primary, DEFAULT_PUBLISH_SETTINGS, rates);
    const f = (n: number) => `${(100 * n).toFixed(1)} %`;
    console.log(`\nordinary re-draft (#244): eligible ${e.eligible} (general ${e.eligibleBy.general}, scoped ${e.eligibleBy.scoped}, primary ${e.eligibleBy.primary}); guard: ${e.guard} (more than ${DEFAULT_PUBLISH_SETTINGS.ordinaryRepairMaxShare * 100} % of the draft or ${DEFAULT_PUBLISH_SETTINGS.ordinaryRepairMaxRules} rules skips every re-draft)`);
    console.log(`requests: check ~${e.requests.baseCheck} + re-drafts ${e.requests.redraft} + replacement checks ~${e.requests.replacementCheck} = ~${e.requests.total} against the cap ${e.requests.cap}: ${e.requests.fitsCap ? "fits" : "OVER the cap"}`);
    const line = (label: string, s: (typeof e.before)) => console.log(`${label}: overall ${s.overall.counted.toFixed(1)} of ${s.overall.of} (${f(s.overall.share)}); general ${f(s.general.share)}; scoped ${f(s.scoped.share)}; primary ${f(s.primary.share)}; budget ${s.withinBudget ? "passes" : "held"}`);
    line("no repair   ", e.before);
    for (const s of e.scenarios) line(`${Math.round(s.successRate * 100)} % repaired`.padEnd(12), s);
    console.log(`eligible ids: ${e.eligibleIds.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(`replay failed: ${(err as Error)?.message ?? err}`);
  process.exitCode = 1;
});
