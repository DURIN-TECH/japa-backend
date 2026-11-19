import type { OutcomeDataSourceAdapter } from "./outcome-source-adapter";
import { UkHomeOfficeOutcomeAdapter } from "./adapters/uk-home-office/uk-home-office.adapter";

// ============================================
// OUTCOME DATA SOURCES: REGISTRY (issue #116)
// ============================================
//
// The one place destinations are wired to adapters. Adding another country's
// published statistics = write its adapter and add it to this list. Nothing
// else in the feature changes.

/** All registered adapters. */
const ADAPTERS: OutcomeDataSourceAdapter[] = [new UkHomeOfficeOutcomeAdapter()];

/** Destination codes that have an adapter. */
export function registeredDestinations(): string[] {
  return ADAPTERS.map((a) => a.destination);
}

/** The adapter for a destination, or undefined. */
export function getOutcomeAdapter(destination: string): OutcomeDataSourceAdapter | undefined {
  return ADAPTERS.find((a) => a.destination === destination);
}
