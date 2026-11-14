// ============================================
// Issuing authorities (issue #230, P1 of #228) — public surface
// ============================================
//
// What other code should import. Later parts (P2 shared routes, P3 official
// websites, P4 stacked rulebooks, P5/P7 member groups) use the read helpers
// and the pure key / date rules; only the admin router writes.

export { adminAuthorityRoutes } from "./authority.routes";
export { authorityService, expandDestinations, type MembersOnResult } from "./authority.service";
export {
  buildRulebookKey,
  checkAuthorityId,
  checkAuthorityIdForKind,
  isCountryCode,
  isMemberOn,
  membersOn,
  parseCalendarDate,
  splitRulebookKey,
  todayUtc,
  type AuthorityIdCheck,
  type RulebookKeySplit,
} from "./authority-ids";
export * from "../types/authority";
