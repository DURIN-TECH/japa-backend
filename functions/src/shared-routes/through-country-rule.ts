import type { Application } from "../types/index";
import { INTAKE_EDITABLE_STATUSES } from "../services/intake.service";

// ============================================
// MAY THE COUNTRY APPLIED THROUGH BE CHANGED? (issue #237, P8 of #228)
// ============================================
//
// ONE rule, used by two callers so they cannot drift:
//  - `PUT /applications/:id/through-country` (competenceService.changeThroughCountry)
//    refuses with the code and message returned here;
//  - every application returned to the app or the portal carries
//    `canChangeThroughCountry: boolean`, which is just "no refusal".
//
// The state rule is: the application is on a shared route, it is still in an
// editable status (not submitted), and nothing has been paid. Who may call the
// endpoint (update access) is checked separately by the controller; the flag
// describes the application, not the caller.

export interface ThroughCountryRefusal {
  code: "NOT_SHARED_ROUTE" | "NOT_EDITABLE" | "ALREADY_PAID";
  status: 409;
  message: string;
}

/** Why the country applied through can't be changed now, or null when it can. First failing check wins (same order as the endpoint). */
export function throughCountryRefusal(application: Pick<Application, "throughCountry" | "throughCountryCode" | "status" | "amountPaid">): ThroughCountryRefusal | null {
  if (!application.throughCountry || !application.throughCountryCode) {
    return { code: "NOT_SHARED_ROUTE", status: 409, message: "This application is not on a route you apply for through a member country" };
  }
  if (!INTAKE_EDITABLE_STATUSES.includes(application.status)) {
    return { code: "NOT_EDITABLE", status: 409, message: "This application has been submitted, so the country you apply through can't be changed." };
  }
  if ((application.amountPaid ?? 0) > 0) {
    return { code: "ALREADY_PAID", status: 409, message: "You've already paid for this application, so the country you apply through can't be changed here. Contact support to change it." };
  }
  return null;
}

/** The flag served on every application. */
export function canChangeThroughCountry(application: Pick<Application, "throughCountry" | "throughCountryCode" | "status" | "amountPaid">): boolean {
  return throughCountryRefusal(application) === null;
}

/** The application with `canChangeThroughCountry` added (a new object). */
export function withThroughCountryFlag<T extends Pick<Application, "throughCountry" | "throughCountryCode" | "status" | "amountPaid">>(application: T): T & { canChangeThroughCountry: boolean } {
  return { ...application, canChangeThroughCountry: canChangeThroughCountry(application) };
}
