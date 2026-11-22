// ============================================
// (#440, #461) THE PAIRS OF VERSIONS WHOSE CHECK ANSWERS MAY BE REUSED
// ============================================
//
// The independent rule check (rubric-checker.ts) can reuse the answers it gave
// on an earlier version of a rulebook for rules that did not change (`reuseFrom`
// on the check's input; the conditions are in the checker's "(#440) Reusing an
// earlier version's answers" section). The owner allowed that for ONE rulebook
// only, the shared Schengen short-stay rulebook, and for two steps:
//   - (#440, decision 2026-11-21) version 1 -> version 2, built from version 1 plus
//     the one-rule result of `redraft-competence-rule` (#335);
//   - (#461, decision 2026-11-21) version 2 -> version 3, a same-rules copy of the
//     approved version 2, made so the question wording check runs again with the
//     rules' list lines. Version 2 itself reused most of its answers from version 1,
//     so for those rules the proof follows version 2's own reuse record ONE hop back
//     to version 1 (`viaVersion`); never further.
//
// Why a module of its own, outside `scrapers/rubric/`: that module is generic and
// names no country, route or publisher (containment tests grep every file of it).
// This list is the only place the permitted pairs are written; the checker, the
// publish pipeline and the version builder import it from here. It is NOT a
// setting, has no override and no admin edit: changing it is a reviewed code change.

/** One permitted step: reuse from `fromVersion` on `toVersion` (optionally one hop back to `viaVersion`). */
export interface CheckReusePair {
  routeKey: string;
  fromVersion: number;
  toVersion: number;
  // (#461) The version the BASE version itself reused its answers from, when the proof may follow that one
  // hop. Absent: the base's record must hold every answer itself (as for version 1, which reused nothing).
  viaVersion?: number;
}

/** (#440) The first pair: version 1 -> version 2 (kept: the one-rule builder and its tests use it). */
export const CHECK_REUSE_PAIR: Readonly<CheckReusePair> = Object.freeze({
  routeKey: "schengen-area_schengen-area-short-stay",
  fromVersion: 1,
  toVersion: 2,
});

/** (#461) The second pair: version 2 -> version 3, following version 2's reuse one hop back to version 1. */
export const CHECK_REUSE_PAIR_V3: Readonly<CheckReusePair> = Object.freeze({
  routeKey: CHECK_REUSE_PAIR.routeKey,
  fromVersion: 2,
  toVersion: 3,
  viaVersion: 1,
});

/** Every permitted pair. Nothing else may reuse anything. */
export const CHECK_REUSE_PAIRS: readonly Readonly<CheckReusePair>[] = Object.freeze([CHECK_REUSE_PAIR, CHECK_REUSE_PAIR_V3]);

/** The permitted pair for exactly this rulebook and these versions, or null. Pure. */
export function checkReusePairFor(routeKey: string, fromVersion: number, toVersion: number): Readonly<CheckReusePair> | null {
  return CHECK_REUSE_PAIRS.find((p) => p.routeKey === routeKey && p.fromVersion === fromVersion && p.toVersion === toVersion) ?? null;
}
