// ============================================
// VISA EXTRACTION EVAL — TINY UNIFIED LINE DIFF (issue #60)
// ============================================
//
// `eval:record` shows what changed on GOV.UK before a fixture is overwritten.
// No new dependency (issue constraint): a hand-rolled LCS line diff, printed in
// unified format with `context` lines around each change. Guide texts are a
// few hundred lines, so the O(n x m) LCS table is small. Pure, no I/O.

/** One diff operation on a line. */
type Op = { tag: " " | "-" | "+"; line: string };

/** Line-level edit script from `a` to `b` via a longest-common-subsequence table. */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..] (filled from the end).
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Walk the table: equal lines are context, otherwise take the longer branch.
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ tag: "-", line: a[i++] });
    } else {
      ops.push({ tag: "+", line: b[j++] });
    }
  }
  while (i < n) ops.push({ tag: "-", line: a[i++] });
  while (j < m) ops.push({ tag: "+", line: b[j++] });
  return ops;
}

/**
 * Unified diff of two texts (by line). Returns "" when they are identical.
 * @param oldLabel / newLabel  the `---` / `+++` header names
 * @param context              unchanged lines shown around each change (default 3)
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  context = 3
): string {
  if (oldText === newText) return "";
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const ops = diffOps(a, b);

  // Indices of changed ops; group changes whose context windows touch into hunks.
  const changed = ops.map((o, k) => (o.tag === " " ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return "";
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const start = Math.max(0, k - context);
    const end = Math.min(ops.length - 1, k + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = end;
    else hunks.push([start, end]);
  }

  // Old/new line numbers at the start of each op (1-based, for @@ headers).
  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let ol = 1;
  let nl = 1;
  for (const o of ops) {
    oldLineAt.push(ol);
    newLineAt.push(nl);
    if (o.tag !== "+") ol++;
    if (o.tag !== "-") nl++;
  }

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const oldCount = slice.filter((o) => o.tag !== "+").length;
    const newCount = slice.filter((o) => o.tag !== "-").length;
    out.push(`@@ -${oldLineAt[s]},${oldCount} +${newLineAt[s]},${newCount} @@`);
    for (const o of slice) out.push(`${o.tag}${o.line}`);
  }
  return out.join("\n");
}
