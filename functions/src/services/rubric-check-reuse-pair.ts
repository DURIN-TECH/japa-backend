// ============================================
// (#440) THE ONE PAIR OF VERSIONS WHOSE CHECK ANSWERS MAY BE REUSED
// ============================================
//
// The independent rule check (rubric-checker.ts) can reuse the answers it gave
// on an earlier version of a rulebook for rules that did not change (`reuseFrom`
// on the check's input; the conditions are in the checker's "(#440) Reusing an
// earlier version's answers" section). The owner allowed that for ONE rulebook
// and ONE step only (decision on #440, 2026-11-21): the shared Schengen
// short-stay rulebook, from version 1 to version 2, built from version 1 plus
// the one-rule result of `redraft-competence-rule` (#335).
//
// Why a module of its own, outside `scrapers/rubric/`: that module is generic and
// names no country, route or publisher (containment tests grep every file of it).
// This constant is the only place the permitted pair is written; the checker and
// the version 2 builder import it from here. It is NOT a setting, has no override and no
// admin edit: changing it is a reviewed code change.

/** The only rulebook, and the only from/to versions, a check may reuse answers between. */
export const CHECK_REUSE_PAIR: Readonly<{ routeKey: string; fromVersion: number; toVersion: number }> = Object.freeze({
  routeKey: "schengen-area_schengen-area-short-stay",
  fromVersion: 1,
  toVersion: 2,
});
