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
