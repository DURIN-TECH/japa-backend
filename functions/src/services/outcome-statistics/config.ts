import { collections } from "../../utils/firebase";
import type { OutcomeStatisticsSettings } from "../../types/outcome-statistics";

// ============================================
// OUTCOME STATISTICS: PRODUCT SETTINGS (issue #116)
// ============================================
//
// Two settings, both stored in the backend-only doc `appConfig/outcomeStatistics`
// so a product owner can change them without a deploy:
//
//  - minDecisions: below this many decisions (granted + refused) a rate is
//    not shown, because a handful of decisions says little. Default 100. This
//    is a product default, not a statistic: every figure still comes from the
//    imported release.
//  - scheduledImportEnabled: kill switch for the quarterly scheduled import.
//
// A missing doc, or a missing / invalid field, falls back to the default.

/** Doc id under `appConfig`. */
export const OUTCOME_SETTINGS_DOC_ID = "outcomeStatistics";

/** Defaults used when the settings doc or a field is absent or invalid. */
export const DEFAULT_OUTCOME_SETTINGS: OutcomeStatisticsSettings = {
  minDecisions: 100,
  scheduledImportEnabled: true,
};

/** Resolve raw stored data into settings, ignoring anything invalid. Pure. */
export function resolveOutcomeSettings(raw: unknown): OutcomeStatisticsSettings {
  const data = (raw ?? {}) as Partial<Record<keyof OutcomeStatisticsSettings, unknown>>;
  const min = data.minDecisions;
  return {
    // A non-negative integer; anything else (string, negative, NaN) is ignored.
    minDecisions:
      typeof min === "number" && Number.isInteger(min) && min >= 0 ? min : DEFAULT_OUTCOME_SETTINGS.minDecisions,
    scheduledImportEnabled:
      typeof data.scheduledImportEnabled === "boolean"
        ? data.scheduledImportEnabled
        : DEFAULT_OUTCOME_SETTINGS.scheduledImportEnabled,
  };
}

/** Load the settings (one Firestore read). */
export async function loadOutcomeSettings(): Promise<OutcomeStatisticsSettings> {
  const snap = await collections.appConfig.doc(OUTCOME_SETTINGS_DOC_ID).get();
  return resolveOutcomeSettings(snap.exists ? snap.data() : undefined);
}
