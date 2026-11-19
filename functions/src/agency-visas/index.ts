// ============================================
// Agency visas module (issue #100) — public surface
// ============================================
//
// Agency-scoped create / edit / submit / delete-draft of visas. See
// ./agency-visas.md for the API contract that #101 (admin review of
// revisions, make-global) and #104 (portal "Our visas") build on.

export { agencyVisaRoutes } from "./agency-visa.routes";
export { agencyVisaService, revisionId } from "./agency-visa.service";
export type { AgencyVisaView } from "./agency-visa.service";
export {
  AGENCY_VISA_REQUIRED_FIELDS,
  AGENCY_VISA_OPTIONAL_FIELDS,
  AGENCY_VISA_CONTENT_FIELDS,
  AgencyVisaError,
  parseAgencyVisaBody,
  assertCompleteContent,
} from "./agency-visa.validation";

// Admin side (issue #101): review of agency visas + revisions, make-global.
export {
  agencyVisaReviewService,
  ADMIN_VISA_SOURCE_FILTERS,
  VISA_COST_MISSING,
  SCREENING_OPEN,
  parseExpectedTimestamp,
} from "./agency-visa-review.service";
export type {
  AdminVisaFilters,
  AdminVisaRow,
  AdminVisaSourceFilter,
  AgencyVisaReviewOutcome,
  AgencyVisaVisibilityOutcome,
} from "./agency-visa-review.service";

// Listing screening (issue #120): admin-only results and the rerun.
export { agencyVisaScreeningService } from "./agency-visa-screening.service";
