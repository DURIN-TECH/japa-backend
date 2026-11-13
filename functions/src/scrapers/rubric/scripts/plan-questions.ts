/**
 * Print what the question plan does to a rulebook draft (issue #203): rules,
 * questions before and after merging exact duplicates, how many questions an
 * applicant sees in the best, a typical and the worst case, and which rules
 * have a question. No model is called (the wording check cannot run offline),
 * so the figures are an upper bound on what applicants see; nothing is written.
 *
 * Run (from functions/):
 *   npm run plan:questions -- --export <file.json>
 *   npm run plan:questions -- --project <id> --route <routeKey> --version <n>
 * The second form reads the version from that project's Firestore (read only).
 * The project must be named; production (`japa-platform`) needs --allow-production.
 * Never prints source text or question wording: counts only.
 */
import { readFileSync } from "fs";
import type { VisaRubric } from "../../../types/rubric";
import { questionPlanReport } from "../rubric-question-planner";

const TAG = "[plan-questions]";

/** Value of `--name value` or `--name=value`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3).trim();
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1].trim() : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = flag(args, "export");
  let rubric: VisaRubric | null = null;
  if (file) {
    // An export from the review tooling: { head, versions: [...] }; the newest version is used.
    const doc = JSON.parse(readFileSync(file, "utf8")) as { versions?: VisaRubric[] } & Partial<VisaRubric>;
    rubric = Array.isArray(doc.versions) ? doc.versions[doc.versions.length - 1] : (doc as VisaRubric);
  } else {
    const project = flag(args, "project");
    const route = flag(args, "route");
    const version = Number(flag(args, "version"));
    if (!project || !route || !Number.isInteger(version) || version < 1) {
      console.error(`${TAG} use --export <file>, or --project <id> --route <routeKey> --version <n>.`);
      process.exitCode = 2;
      return;
    }
    if (project === "japa-platform" && !args.includes("--allow-production")) {
      console.error(`${TAG} refusing to read production without --allow-production.`);
      process.exitCode = 2;
      return;
    }
    process.env.GCLOUD_PROJECT = project;
    process.env.GOOGLE_CLOUD_PROJECT = project;
    const { rubricStore } = await import("../rubric.store");
    rubric = await rubricStore.getVersionForReview(route, version);
  }
  if (!rubric) {
    console.error(`${TAG} no such version.`);
    process.exitCode = 1;
    return;
  }
  const r = questionPlanReport(rubric);
  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(52)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  console.log(`${TAG} ${rubric.routeKey} v${rubric.version}`);
  line("rules", r.rules);
  line("rules by kind", r.ruleKinds);
  line("questions in the draft", r.questionsBefore);
  line("questions with no condition (asked of everyone)", r.questionsWithoutCondition);
  line("exact-duplicate groups / questions folded", `${r.exactDuplicateGroups} / ${r.exactDuplicateQuestions}`);
  line("merges in the plan", r.merges);
  line("conditions the plan derives from rule triggers", r.proposedConditions);
  line("questions after merging", r.questionsAfterMerge);
  line("questions asked of everyone after the plan", r.unconditionalAfterPlan);
  line("deciding questions (placed first)", r.decidingQuestions);
  line("applicant sees: best case", r.sizing.best);
  line("applicant sees: typical case (median)", r.sizing.typical);
  line("applicant sees: worst case", r.sizing.worst);
  line("best / worst exact", r.sizing.exact);
  line("rules with at least one question, by kind", r.rulesWithQuestion);
  line("rules assessed without a question, by kind", r.rulesWithoutQuestion);
  line("document items / gated by a question", `${r.evidenceItems} / ${r.evidenceItemsGatedByQuestion}`);
  console.log(`${TAG} no model was called: the wording check can only remove questions, so these are upper bounds.`);
}

main().catch((err) => {
  console.error(`${TAG} failed: ${(err as Error)?.message ?? String(err)}`);
  process.exitCode = 1;
});
