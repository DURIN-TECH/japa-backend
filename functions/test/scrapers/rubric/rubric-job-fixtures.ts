// ============================================
// Fixtures for the drafting-job tests (issue #216) — TEST DATA ONLY
// ============================================
//
// Not a test file. Builds routes of an arbitrary number of chunks out of
// INVENTED, repetitive guidance (no real rule, no real place), with a
// scripted model whose answers DEPEND ON THE ORDER of the calls (the second
// call of a chunk is told what the first accepted, and every call is told the
// questions asked for earlier chunks), so a job that ran steps out of order or
// without the carried-forward questions would produce a different rulebook.

import { chunkSnapshot } from "../../../src/scrapers/rubric/rubric-chunk";
import { RUBRIC_INTAKE_SYSTEM_PROMPT, delimiterTag, type RawRubricOutput } from "../../../src/scrapers/rubric/rubric-prompt";
import type { LlmRequest, LlmResponse } from "../../../src/services/ai/llm-provider";
import { store } from "../../helpers/fake-firestore";
import { ROUTE_A } from "./fixtures/synthetic-guidance";
import { ScriptedProvider, answer, crit, recordAnswers, seedSource, snapshotStore, type Harness } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The route every job test drafts (an invented one). */
export const ROUTE = ROUTE_A;
export const ROUTE_KEY = `${ROUTE.countryCode}_${ROUTE.visaTypeId}`;

/** A model whose intake answers depend on the questions it is shown. */
export class OrderSensitiveProvider extends ScriptedProvider {
  override async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await super.complete(req);
    if (req.system !== RUBRIC_INTAKE_SYSTEM_PROMPT) return res;
    // The questions already asked, as the prompt lists them.
    const known = /Questions already asked earlier in the document \(JSON\):\n(.*)\n/.exec(req.user);
    const before = known ? (JSON.parse(known[1]) as unknown[]).length : 0;
    const out = JSON.parse(res.text);
    for (const q of out.intakeQuestions) q.label = `${q.label} (after ${before} earlier)`;
    return { ...res, text: JSON.stringify(out) };
  }
}

/** One paragraph of `source`: a rule sentence, then filler to give the chunk some weight. */
function paragraph(source: number, j: number): { text: string; quote: string } {
  const quote = `The applicant must provide evidence number ${source}${j} of the stated requirement within the application`;
  const filler = " and must keep it available for inspection by the decision maker for the whole period the application is open, whatever the outcome of any earlier application, and must say so when asked by an officer at any stage of the process of the decision";
  return { text: `R${source}.${j} ${quote}.${filler}.`, quote };
}

/** The text of invented source number `n`, with `paragraphs` paragraphs. */
export function textOf(n: number, paragraphs: number): { text: string; quotes: string[] } {
  const ps = Array.from({ length: paragraphs }, (_, j) => paragraph(n, j + 1));
  return { text: ps.map((p) => p.text).join("\n"), quotes: ps.map((p) => p.quote) };
}

/** Settings small enough that a few paragraphs make a chunk (the smallest the chunker allows). */
export const SMALL_CHUNKS = 1000;

/**
 * Seed `sourceCount` invented sources (ids `src-1`..), each of `paragraphs`
 * paragraphs, and record answers for every chunk. The FIRST chunk of the LAST
 * source accepts no rule (so it has no second call). Returns the source ids and
 * the number of chunks and of model calls a full run makes.
 */
export async function setUpMulti(h: Harness, sourceCount: number, paragraphs: number): Promise<{ sourceIds: string[]; chunks: number; calls: number }> {
  h.settings.maxChunkChars = SMALL_CHUNKS;
  h.state.knownVisaTypes.add(`${ROUTE.countryCode}/${ROUTE.visaTypeId}`);
  // One provider per harness: its scripts survive a re-seed after `resetStore`.
  if (!(h.provider instanceof OrderSensitiveProvider)) {
    h.provider = new OrderSensitiveProvider();
    (h.service as any).deps.provider = h.provider;
  }
  const provider = h.provider;
  const sourceIds: string[] = [];
  let chunks = 0;
  let calls = 0;
  for (let n = 1; n <= sourceCount; n++) {
    const id = `src-${n}`;
    sourceIds.push(id);
    const { text, quotes } = textOf(n, paragraphs);
    await seedSource({ id, url: `https://docs.invalid/${id}`, text });
    const hash = (store.get(`guidanceSources/${id}`) as any).latestSnapshotId as string;
    const cut = chunkSnapshot(await snapshotStore.read(id, hash), SMALL_CHUNKS);
    const answers: RawRubricOutput[] = cut.map((chunk, i) => {
      const inChunk = quotes.map((q, j) => ({ q, j })).filter(({ q }) => chunk.text.includes(q));
      // The first chunk of the last source accepts nothing.
      const silent = n === sourceCount && i === 0 && sourceCount > 1;
      if (silent) return answer({});
      return answer({
        criteria: inChunk.map(({ q, j }) =>
          crit({ ref: `r${n}_${j}`, title: `Evidence ${n}${j + 1} provided`, kind: "judgement", stage: "credibility", quote: q, probeFactors: ["evidence kept"], requiresInterviewBeforeRefusal: false })
        ),
        intakeQuestions: [
          { id: `q_${id}_${i}`, label: `Question ${id} ${i}`, helpText: null, answerType: "yes_no", required: true, criterionRefs: inChunk.map(({ j }) => `r${n}_${j}`), group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
        ],
      });
    });
    await recordAnswers(provider, id, answers, h.settings);
    chunks += cut.length;
    calls += answers.reduce((c, a) => c + (a.criteria.length > 0 ? 2 : 1), 0);
  }
  return { sourceIds, chunks, calls };
}

/** The call keys (`kind|tag|excerpt`) of the steps stored for a job, from the Firestore fake. */
export function storedStepKeys(jobId: string): string[] {
  const job = store.get(`rubricExtractionJobs/${jobId}`) as any;
  if (!job) return [];
  const keys: string[] = [];
  for (const [path, doc] of store.entries()) {
    if (!path.startsWith(`rubricExtractionJobs/${jobId}/steps/`)) continue;
    const d = doc as any;
    const source = job.sources.find((s: any) => s.snapshot.sourceId === d.sourceId);
    keys.push(`${d.phase}|${delimiterTag(source.snapshot.contentHash)}|${d.chunkIndex + 1}`);
  }
  return keys;
}
