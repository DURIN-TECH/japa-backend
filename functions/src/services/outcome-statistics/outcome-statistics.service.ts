import { collections } from "../../utils/firebase";
import type { OutcomeReleasePointer, OutcomeStatistic } from "../../types/outcome-statistics";

// ============================================
// OUTCOME STATISTICS: STORAGE KEYS + LOOKUP (issue #116)
// ============================================
//
// The read side of the store. Generic: a lookup is (destination, category key,
// nationality key). It contains nothing specific to a destination, a route or
// a nationality, so another destination's adapter needs no change here.
//
// Access: there is deliberately NO HTTP endpoint that lists or reads statistics
// by nationality. The only consumer is the assessment's country-context step
// (buildCountryContext), which runs behind checkApplicationAccess.

/** Lowercase alphanumerics with "-" between runs: safe inside a Firestore doc id. */
function idPart(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic doc id for one statistic. Re-importing the same release
 * overwrites the same docs (idempotent); a new release gets new ids, so the
 * old release stays readable until the pointer flips.
 */
export function statisticDocId(destination: string, releaseId: string, categoryKey: string, nationalityKey: string): string {
  return [destination, releaseId, idPart(categoryKey), idPart(nationalityKey)].join("__");
}

/** The current release pointer for a destination, or null when none was imported. */
export async function getReleasePointer(destination: string): Promise<OutcomeReleasePointer | null> {
  const snap = await collections.outcomeStatisticsReleases.doc(destination).get();
  return snap.exists ? (snap.data() as OutcomeReleasePointer) : null;
}

/**
 * One statistic from the CURRENT release, or null when there is none (no
 * release imported, or no row for this category / nationality).
 *
 * Uses the composite index (destination, categoryKey, nationalityKey,
 * releaseId, periodEnd desc) in firestore.indexes.json. `nationalityKey` is
 * the normalised code (e.g. a passport country) or "ALL" for the
 * all-nationality aggregate.
 */
export async function getCurrentStatistic(
  destination: string,
  categoryKey: string,
  nationalityKey: string
): Promise<OutcomeStatistic | null> {
  const pointer = await getReleasePointer(destination);
  if (!pointer) return null;
  const snap = await collections.outcomeStatistics
    .where("destination", "==", destination)
    .where("categoryKey", "==", categoryKey)
    .where("nationalityKey", "==", nationalityKey)
    .where("releaseId", "==", pointer.releaseId)
    .orderBy("periodEnd", "desc")
    .limit(1)
    .get();
  return snap.empty ? null : (snap.docs[0].data() as OutcomeStatistic);
}
