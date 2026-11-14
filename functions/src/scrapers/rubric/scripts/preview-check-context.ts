/**
 * Preview what the independent check is now SHOWN for each rule (issue #242).
 *
 * OFFLINE: no model, no network, no Firestore, zero requests. It reads
 *   - a rules file (JSON array of flat rules: `{ id, title, kind, stage, severity, applicability,
 *     applicabilityCondition?, trigger?, check?, appliesTo?, quote, listItems?, sourceId }`, the
 *     shape of an exported run's rules), and
 *   - one stored snapshot file per source (`--page <sourceId>=<snapshot.json>`, the JSON the
 *     snapshot store keeps), and optionally
 *   - the draft's intake questions (`--questions <file.json>`, an array of `{ id, label, options }`),
 * and builds each rule's view with the PRODUCTION function (`viewOf`), so what is printed is exactly
 * what a run sends. Then it builds the real requests (batches of CHECKER_BATCH_SIZE, rulebook order)
 * and prints their count and size.
 *
 * Prints ids, heading counts and lengths, character counts and where each condition was found.
 * Source text is printed ONLY as the section headings, and only with `--show-headings`.
 *
 * Run (from functions/):
 *   npm run build && node lib/scrapers/rubric/scripts/preview-check-context.js \
 *     --rules rules.json --page <sourceId>=snapshot.json [--questions q.json] [--sample 10 | --ids a,b,c] [--show-headings]
 * Rules whose source has no `--page` are skipped (and counted).
 */
import { readFileSync } from "node:fs";

/** Values of `--name value` (repeatable), or []. */
const args = (name: string): string[] => {
  const a = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] === `--${name}`) out.push(a[i + 1]);
  return out;
};
const flag = (name: string): boolean => process.argv.slice(2).includes(`--${name}`);

/** Median of a number list (0 for an empty list). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main(): Promise<void> {
  const rulesFile = args("rules")[0];
  const pages = args("page");
  if (!rulesFile || pages.length === 0) {
    console.error("usage: --rules <file.json> --page <sourceId>=<snapshot.json> [--questions <file.json>] [--sample N | --ids a,b] [--show-headings]");
    process.exit(2);
  }
  // The modules import the Firebase wrappers (they resolve a project id at load). This script never talks to
  // Firebase, so it pins a DEMO project id (never a real one) BEFORE the imports.
  process.env.GCLOUD_PROJECT = "demo-offline-preview";
  const { viewOf } = await import("../rubric-checker");
  const { SnapshotQuoteIndex } = await import("../rubric-quote");
  const { quoteIsLeadIn, verifyListItems } = await import("../rubric-list-items");
  const { buildBatchRequest, buildTriggerRequest, CHECKER_BATCH_SIZE, CHECKER_TRIGGER_BATCH_SIZE, CHECKER_PROMPT_VERSION } = await import("../rubric-checker-prompt");
  const { isValidTrigger } = await import("../../../utils/rubric-trigger");

  type Flat = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const flat = JSON.parse(readFileSync(rulesFile, "utf8")) as Flat[];
  const questions = args("questions")[0] ? (JSON.parse(readFileSync(args("questions")[0], "utf8")) as { id: string; label: string; options?: { value: string; label: string }[] }[]) : [];
  const indexes = new Map<string, InstanceType<typeof SnapshotQuoteIndex>>();
  for (const spec of pages) {
    const [sourceId, file] = spec.split("=");
    indexes.set(sourceId, new SnapshotQuoteIndex(JSON.parse(readFileSync(file, "utf8"))));
  }

  // ---- the views, exactly as buildViews makes them ----
  const views: ReturnType<typeof viewOf>[] = [];
  let skippedNoPage = 0;
  let skippedNoView = 0;
  for (const r of flat) {
    const index = indexes.get(r.sourceId);
    if (!index) {
      skippedNoPage += 1;
      continue;
    }
    const rule = {
      criterionId: r.id, title: r.title, kind: r.kind, stage: r.stage, severity: r.severity, applicability: r.applicability,
      ...(r.applicabilityCondition !== undefined ? { applicabilityCondition: r.applicabilityCondition } : {}),
      ...(r.trigger ? { trigger: r.trigger } : {}), ...(r.check ? { check: r.check } : {}), ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
      source: { sourceId: r.sourceId, url: r.url ?? "", contentHash: "", retrievedAt: "", quote: r.quote, ...(r.listItems ? { listItems: r.listItems } : {}) },
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const found = index.locate(r.quote);
    if (!found.ok || (rule.source.listItems !== undefined ? !verifyListItems(index, found, rule.source.listItems).ok : quoteIsLeadIn(index, found))) {
      skippedNoView += 1;
      continue;
    }
    views.push(viewOf(rule, index, found, questions as any)); // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  // ---- what each new field adds, per rule ----
  const limits = { maxOutputTokens: 1, timeoutMs: 1 };
  const added = (v: (typeof views)[number]): number => {
    const stripped = { ...v, sectionHeadings: undefined, conditionFoundAt: undefined, conditionLine: undefined, trigger: undefined };
    const full = buildBatchRequest("verification", [v], limits).user.length;
    return full - buildBatchRequest("verification", [stripped], limits).user.length;
  };
  const addedChars = views.map(added);
  const foundAt: Record<string, number> = {};
  for (const v of views) foundAt[v.conditionFoundAt ?? "(no condition)"] = (foundAt[v.conditionFoundAt ?? "(no condition)"] ?? 0) + 1;
  const withHeadings = views.filter((v) => (v.sectionHeadings ?? []).length > 0).length;

  console.log(`prompt version ${CHECKER_PROMPT_VERSION}; rules in file ${flat.length}; with a view ${views.length}; skipped: no page ${skippedNoPage}, quote not readable ${skippedNoView}`);
  console.log(`rules with at least one heading: ${withHeadings} of ${views.length}; conditionFoundAt: ${JSON.stringify(foundAt)}`);
  console.log(`rules with a usable trigger shown: ${views.filter((v) => v.trigger).length}`);
  console.log(`characters added per rule by #242: median ${median(addedChars)}, max ${Math.max(0, ...addedChars)}, total ${addedChars.reduce((a, b) => a + b, 0)}`);

  // ---- the real requests: every rule once on the verification model, in rulebook order ----
  let requests = 0;
  let chars = 0;
  for (let i = 0; i < views.length; i += CHECKER_BATCH_SIZE) {
    const req = buildBatchRequest("verification", views.slice(i, i + CHECKER_BATCH_SIZE), limits);
    requests += 1;
    chars += req.system.length + req.user.length;
  }
  const triggered = views.filter((v) => v.rule.trigger !== undefined && isValidTrigger(v.rule.trigger, questions as any)); // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < triggered.length; i += CHECKER_TRIGGER_BATCH_SIZE) {
    const batch = triggered.slice(i, i + CHECKER_TRIGGER_BATCH_SIZE).map((v) => {
      const q = questions.find((x) => x.id === v.rule.trigger?.questionId);
      return { rule: v.rule, listLeadIn: v.listLeadIn, question: { label: q?.label ?? "", options: q?.options ?? [] } };
    });
    const req = buildTriggerRequest("verification", batch, limits);
    requests += 1;
    chars += req.system.length + req.user.length;
  }
  console.log(`requests to check these ${views.length} rules once (batches of ${CHECKER_BATCH_SIZE} + trigger batches of ${CHECKER_TRIGGER_BATCH_SIZE}): ${requests}; input characters ${chars}`);

  // ---- a sample, or the ids asked for ----
  const ids = args("ids")[0]?.split(",").filter(Boolean);
  const n = Number(args("sample")[0] ?? 10);
  const picked = ids ? views.filter((v) => ids.includes(v.rule.criterionId)) : views.filter((_, i) => i % Math.max(1, Math.floor(views.length / Math.max(1, n))) === 0).slice(0, n);
  for (const v of picked) {
    const headings = v.sectionHeadings ?? [];
    console.log(
      [
        v.rule.criterionId,
        `appl=${v.rule.applicability}`,
        `headings=${headings.length}[${headings.map((h) => h.length).join(",")}]`,
        `foundAt=${v.conditionFoundAt ?? "-"}`,
        `conditionLine=${v.conditionLine?.length ?? 0}`,
        `trigger=${v.trigger ? `${v.trigger.question.length}+${v.trigger.answers.length}answers` : "-"}`,
        `added=${added(v)}`,
      ].join("  "),
    );
    if (flag("show-headings")) for (const h of headings) console.log(`    heading: ${h}`);
  }
}

main().catch((err) => {
  console.error(`preview failed: ${(err as Error)?.message ?? err}`);
  process.exitCode = 1;
});
