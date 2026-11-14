import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collectionGroups, collections, db, subcollections } from "../utils/firebase";
// The source registry's error type and audit write, through the scrapers
// module's public API (its internals are off limits, see #91).
import { appendRegistryAudit, RegistryError, stripUndefined } from "../scrapers";
import { authorityService, expandDestinations } from "../authorities/authority.service";
import { checkAuthorityId, isCountryCode, todayUtc } from "../authorities/authority-ids";
import { MEMBERSHIP_KINDS } from "../types/authority";
import type { Application, VisaCategory, VisaType } from "../types/index";
import { SHARED_ROUTE_STATUSES, type SharedRoute, type SharedRouteDestinations, type SharedRouteRef, type SharedRouteStatus } from "../types/shared-route";
import { resolveRouteStack } from "./route-stack";
import { checkSharedRouteId, inheritedIds, isApplicationOpen, sharedRulebookKey } from "./shared-route-rules";

// ============================================
// SHARED ROUTES — SERVICE (issue #231, P2 of #228)
// ============================================
//
// Reads and writes `sharedRoutes/{id}` and the `inheritsFrom` field of a
// country's visa record. The admin controller calls the writes; later parts
// use the resolver in route-stack.ts.
//
// Rules enforced here:
//   - the issuing authority must exist, be ACTIVE, and be a bloc or treaty (a
//     country authority would make `{cc}_{id}` collide with that country's own
//     visa record keys);
//   - destinations are either listed country codes (each a registered
//     country) or the members of an existing bloc/treaty;
//   - a visa record may inherit a shared route only if its country is in the
//     route's destinations ON THE DAY it is set (membership has dates), and
//     only while the route is active;
//   - dropping an inheritance, or retiring a route, is refused (409, with the
//     count) while open applications use it;
//   - every write is audited in the same transaction as the change.
//
// Open applications are counted BEFORE the write transaction (queries on
// other collections); an application started in the gap could be missed. The
// window is milliseconds and the effect is bounded: that application keeps its
// stored `routeStack`, so it still runs on the layers it started with.

/** Longest shared route name accepted. */
export const SHARED_ROUTE_NAME_MAX = 200;
/** Most shared routes one visa record may inherit (a sanity cap, not a legal rule). */
export const INHERITS_FROM_MAX = 10;
/** Most countries an admin may list in `listed` destinations. */
export const LISTED_DESTINATIONS_MAX = 100;

const CATEGORIES: readonly VisaCategory[] = ["work", "student", "tourist", "business", "family", "investor", "transit", "other"];
/** A visa type id (Firestore doc id): letters, digits, hyphen, underscore. */
const VISA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export interface CreateSharedRouteResult {
  sharedRoute: SharedRoute;
  created: boolean;
}
export interface UpdateSharedRouteResult {
  sharedRoute: SharedRoute;
  changed: boolean;
}
export interface SetInheritanceResult {
  countryCode: string;
  visaTypeId: string;
  inheritsFrom: SharedRouteRef[];
  changed: boolean;
}

// ---------- Validators (throwing RegistryError 400s) ----------

/** Any valid shared route id (path parameters), or a 400. */
export function requireSharedRouteId(raw: unknown): string {
  const check = checkSharedRouteId(raw);
  if (!check.ok) throw new RegistryError(check.code, 400, check.message);
  return check.id;
}

function readName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new RegistryError("NAME_REQUIRED", 400, "Give the shared route's name");
  if (name.length > SHARED_ROUTE_NAME_MAX) throw new RegistryError("NAME_TOO_LONG", 400, `The name is longer than ${SHARED_ROUTE_NAME_MAX} characters`);
  return name;
}

function readCategory(raw: unknown): VisaCategory {
  if (typeof raw !== "string" || !(CATEGORIES as readonly string[]).includes(raw)) {
    throw new RegistryError("INVALID_CATEGORY", 400, `The category must be one of: ${CATEGORIES.join(", ")}`, { field: "category" });
  }
  return raw as VisaCategory;
}

function readStatus(raw: unknown): SharedRouteStatus {
  if (typeof raw !== "string" || !(SHARED_ROUTE_STATUSES as readonly string[]).includes(raw)) {
    throw new RegistryError("INVALID_STATUS", 400, `The status must be one of: ${SHARED_ROUTE_STATUSES.join(", ")}`, { field: "status" });
  }
  return raw as SharedRouteStatus;
}

/**
 * Validate a destinations body (no reads): `{ mode:"listed", countryCodes }`
 * or `{ mode:"members_of", authorityId }`, strict keys, codes unique and sorted.
 * Pure (exported for unit tests).
 */
export function readDestinations(raw: unknown): SharedRouteDestinations {
  const bad = (message: string) => new RegistryError("INVALID_DESTINATIONS", 400, message, { field: "destinations" });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("destinations must be an object with a \"mode\"");
  const d = raw as Record<string, unknown>;
  if (d.mode === "listed") {
    for (const k of Object.keys(d)) if (k !== "mode" && k !== "countryCodes") throw bad(`"${k}" is not a known destinations field`);
    const codes = d.countryCodes;
    if (!Array.isArray(codes) || codes.length === 0) throw bad("listed destinations need at least one country code");
    if (codes.length > LISTED_DESTINATIONS_MAX) throw bad(`listed destinations are limited to ${LISTED_DESTINATIONS_MAX} countries`);
    for (const c of codes) if (!isCountryCode(c)) throw bad("every country code is two upper-case letters");
    if (new Set(codes).size !== codes.length) throw bad("a country code is listed twice");
    return { mode: "listed", countryCodes: [...(codes as string[])].sort() };
  }
  if (d.mode === "members_of") {
    for (const k of Object.keys(d)) if (k !== "mode" && k !== "authorityId") throw bad(`"${k}" is not a known destinations field`);
    const id = checkAuthorityId(d.authorityId);
    if (!id.ok) throw bad(id.message);
    return { mode: "members_of", authorityId: id.id };
  }
  throw bad("the destinations mode must be \"listed\" or \"members_of\"");
}

/** A plain `{ sharedRouteId }[]` list: strict entries, no duplicates, bounded. Pure (exported for unit tests). */
export function readInheritsFrom(raw: unknown): SharedRouteRef[] {
  const bad = (message: string) => new RegistryError("INVALID_INHERITS_FROM", 400, message, { field: "inheritsFrom" });
  if (!Array.isArray(raw)) throw bad("inheritsFrom must be a list (an empty list removes the inheritance)");
  if (raw.length > INHERITS_FROM_MAX) throw bad(`a visa can inherit at most ${INHERITS_FROM_MAX} shared routes`);
  const out: SharedRouteRef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw bad("each entry must be an object { sharedRouteId }");
    for (const k of Object.keys(entry)) if (k !== "sharedRouteId") throw bad(`"${k}" is not a known field of an inheritsFrom entry`);
    const id = checkSharedRouteId((entry as Record<string, unknown>).sharedRouteId);
    if (!id.ok) throw bad(id.message);
    if (out.some((e) => e.sharedRouteId === id.id)) throw bad("a shared route is listed twice");
    out.push({ sharedRouteId: id.id });
  }
  return out;
}

const asRecord = (v: unknown): Record<string, unknown> => ({ ...(v as Record<string, unknown>) });
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class SharedRouteService {
  /** Transaction runner (tests swap in the in-memory one). */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);
  /** Clock in epoch ms (tests fix it). */
  clock: () => number = Date.now;

  // ============================================
  // Reads
  // ============================================

  /** One shared route, or undefined (an invalid id is simply not found). */
  async get(id: string): Promise<SharedRoute | undefined> {
    if (!checkSharedRouteId(id).ok) return undefined;
    const snap = await collections.sharedRoutes.doc(id).get();
    return snap.exists ? (snap.data() as SharedRoute) : undefined;
  }

  /** Every shared route, sorted by id. */
  async list(): Promise<SharedRoute[]> {
    const snap = await collections.sharedRoutes.get();
    return snap.docs.map((d) => d.data() as SharedRoute).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The country codes a route covers on `date` ("YYYY-MM-DD", default today UTC), sorted. */
  async destinationsOn(route: SharedRoute, date?: string): Promise<string[]> {
    if (route.destinations.mode === "listed") return [...route.destinations.countryCodes].sort();
    return expandDestinations(route.destinations.authorityId, date);
  }

  /**
   * Open applications on `countryCode`/`visaTypeId` that run on `sharedRouteId`'s
   * layer: those whose stored `routeStack` holds the shared key, plus those
   * with no stored stack (they resolve live, so they use whatever the record
   * inherits now). `sharedKey` is the route's rulebook key.
   */
  private async openOnRecord(countryCode: string, visaTypeId: string, sharedKey: string): Promise<Application[]> {
    const snap = await collections.applications.where("countryCode", "==", countryCode).where("visaTypeId", "==", visaTypeId).get();
    return snap.docs
      .map((d) => d.data() as Application)
      .filter((a) => isApplicationOpen(a.status) && (a.routeStack === undefined || a.routeStack.includes(sharedKey)));
  }

  /** How many open applications use a shared route, across every member record. */
  async countOpenUsing(route: SharedRoute): Promise<number> {
    return (await this.openApplicationsUsing(route)).length;
  }

  /**
   * (#233 P4b) The OPEN applications that run on a shared route's layer, across
   * every member record, sorted by id: those whose stored `routeStack` names
   * the layer (the `routeStack` array-contains query, indexed in
   * firestore.indexes.json), plus older ones with no stored stack on a record
   * that inherits the route today (they resolve their stack live). Every
   * agency's applications are returned: callers are backend jobs only and must
   * never hand this list to a person (they report counts per member route).
   */
  async openApplicationsUsing(route: Pick<SharedRoute, "id" | "issuingAuthorityId">): Promise<Application[]> {
    const key = sharedRulebookKey(route.issuingAuthorityId, route.id);
    const byId = new Map<string, Application>();
    // New applications: their stored stack names the shared layer.
    const stacked = await collections.applications.where("routeStack", "array-contains", key).get();
    for (const d of stacked.docs) {
      const a = { ...(d.data() as Application), id: d.id };
      if (isApplicationOpen(a.status)) byId.set(a.id, a);
    }
    // Older applications (no stored stack) on a record that inherits the route today.
    for (const v of await this.memberRecordsOf(route)) {
      for (const a of await this.openOnRecord(v.countryCode, v.visaTypeId, key)) if (a.routeStack === undefined) byId.set(a.id, a);
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** (#233 P4b) The visa records that inherit a shared route today (country code + visa id), sorted. */
  async memberRecordsOf(route: Pick<SharedRoute, "id">): Promise<{ countryCode: string; visaTypeId: string }[]> {
    const records = await collectionGroups.visaTypes().where("inheritsFrom", "array-contains", { sharedRouteId: route.id }).get();
    return records.docs
      .map((r) => {
        const v = r.data() as VisaType;
        return { countryCode: v.countryCode, visaTypeId: v.id ?? r.id };
      })
      .sort((a, b) => `${a.countryCode}_${a.visaTypeId}`.localeCompare(`${b.countryCode}_${b.visaTypeId}`));
  }

  // ============================================
  // Writes (admin API only; each one audited)
  // ============================================

  /** Checks shared by create and edit that need reads: the issuing authority and the destinations. */
  private async checkAuthorityAndDestinations(issuingAuthorityId: string | undefined, destinations: SharedRouteDestinations | undefined): Promise<void> {
    if (issuingAuthorityId !== undefined) {
      const authority = await authorityService.get(issuingAuthorityId);
      if (!authority) throw new RegistryError("AUTHORITY_NOT_FOUND", 422, "There is no authority with that id: create it first", { field: "issuingAuthorityId" });
      if (!(MEMBERSHIP_KINDS as readonly string[]).includes(authority.kind)) {
        throw new RegistryError("AUTHORITY_NOT_SHARED", 422, "A shared route is issued by a bloc or a treaty, not by a single country", { field: "issuingAuthorityId" });
      }
      if (authority.status !== "active") throw new RegistryError("AUTHORITY_RETIRED", 422, "That authority is retired", { field: "issuingAuthorityId" });
    }
    if (destinations?.mode === "listed") {
      for (const cc of destinations.countryCodes) {
        const snap = await collections.countries.doc(cc).get();
        if (!snap.exists) throw new RegistryError("COUNTRY_NOT_FOUND", 422, `Country ${cc} is not registered yet`, { field: "destinations" });
      }
    } else if (destinations?.mode === "members_of") {
      const a = await authorityService.get(destinations.authorityId);
      if (!a) throw new RegistryError("AUTHORITY_NOT_FOUND", 422, "There is no authority with that id: create it first", { field: "destinations" });
      if (!(MEMBERSHIP_KINDS as readonly string[]).includes(a.kind)) {
        throw new RegistryError("AUTHORITY_HAS_NO_MEMBERS", 422, "Only a bloc or a treaty has members", { field: "destinations" });
      }
    }
  }

  /**
   * Create `{ id, name, category, issuingAuthorityId, destinations }` (status
   * `active`). Idempotent: the same body again changes nothing (200
   * created:false); a different body for an existing id is 409.
   */
  async create(body: Record<string, unknown>, actorUid: string): Promise<CreateSharedRouteResult> {
    const id = requireSharedRouteId(body.id);
    const name = readName(body.name);
    const category = readCategory(body.category);
    const aid = checkAuthorityId(body.issuingAuthorityId);
    if (!aid.ok) throw new RegistryError(aid.code, 400, aid.message, { field: "issuingAuthorityId" });
    const destinations = readDestinations(body.destinations);
    await this.checkAuthorityAndDestinations(aid.id, destinations);
    const now = this.clock();
    const ref = collections.sharedRoutes.doc(id);

    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const e = snap.data() as SharedRoute;
        if (e.name === name && e.category === category && e.issuingAuthorityId === aid.id && sameJson(e.destinations, destinations)) {
          return { sharedRoute: e, created: false };
        }
        throw new RegistryError("SHARED_ROUTE_EXISTS", 409, "A shared route with that id already exists with a different body; edit it instead");
      }
      const at = Timestamp.fromMillis(now);
      const sharedRoute: SharedRoute = { id, name, category, issuingAuthorityId: aid.id, destinations, status: "active", createdBy: actorUid, createdAt: at, updatedBy: actorUid, updatedAt: at };
      tx.create(ref, sharedRoute);
      appendRegistryAudit(tx, { action: "shared_route_created", actorUid, at, targetType: "sharedRoute", targetId: id, before: null, after: asRecord(sharedRoute) });
      return { sharedRoute, created: true };
    });
  }

  /**
   * Edit `name`, `category`, `destinations` and/or `status`. The id and the
   * issuing authority never change (they are the rulebook key). Retiring is
   * refused (409, with the count) while open applications use the route.
   * Re-activating is allowed. Changing destinations does not touch records
   * that already inherit: the check is made when an inheritance is set.
   */
  async update(rawId: unknown, body: Record<string, unknown>, actorUid: string): Promise<UpdateSharedRouteResult> {
    const id = requireSharedRouteId(rawId);
    if (["name", "category", "destinations", "status"].every((k) => body[k] === undefined)) {
      throw new RegistryError("VALIDATION_ERROR", 400, "Give a new name, category, destinations or status");
    }
    const name = body.name === undefined ? undefined : readName(body.name);
    const category = body.category === undefined ? undefined : readCategory(body.category);
    const status = body.status === undefined ? undefined : readStatus(body.status);
    const destinations = body.destinations === undefined ? undefined : readDestinations(body.destinations);
    await this.checkAuthorityAndDestinations(undefined, destinations);
    const now = this.clock();
    const ref = collections.sharedRoutes.doc(id);

    // Read first (outside the transaction) to know whether this is a retirement.
    const current = await this.get(id);
    if (!current) throw new RegistryError("NOT_FOUND", 404, "There is no shared route with that id");
    if (status === "retired" && current.status !== "retired") {
      const open = await this.countOpenUsing(current);
      if (open > 0) {
        throw new RegistryError("OPEN_APPLICATIONS", 409, `Cannot retire this shared route: ${open} open application${open === 1 ? " uses" : "s use"} it`, { openApplications: open });
      }
    }

    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegistryError("NOT_FOUND", 404, "There is no shared route with that id");
      const e = snap.data() as SharedRoute;
      const next: SharedRoute = {
        ...e,
        name: name ?? e.name,
        category: category ?? e.category,
        destinations: destinations ?? e.destinations,
        status: status ?? e.status,
      };
      if (next.name === e.name && next.category === e.category && next.status === e.status && sameJson(next.destinations, e.destinations)) {
        return { sharedRoute: e, changed: false };
      }
      next.updatedBy = actorUid;
      next.updatedAt = Timestamp.fromMillis(now);
      tx.set(ref, next);
      appendRegistryAudit(tx, { action: "shared_route_changed", actorUid, at: next.updatedAt, targetType: "sharedRoute", targetId: id, before: asRecord(e), after: asRecord(next) });
      return { sharedRoute: next, changed: true };
    });
  }

  /**
   * Set the shared routes a country's visa record inherits (`[]` removes them).
   *
   * Refused: a malformed code or id (400); an unknown visa record (404); a
   * route that is unknown (422) or retired (422); a country that is NOT in the
   * route's destinations today (422 "that country is not covered by this
   * shared route"); dropping a route that open applications on this record use
   * (409 with the count). Only routes ADDED by this call are checked against
   * destinations (a country that later left a bloc must not block an unrelated
   * edit). The same list again writes nothing. `date` is for tests.
   */
  async setInheritance(rawCountry: unknown, rawVisaId: unknown, rawList: unknown, actorUid: string, date?: string): Promise<SetInheritanceResult> {
    if (!isCountryCode(rawCountry)) throw new RegistryError("INVALID_COUNTRY_CODE", 400, "A country is a two-letter code in capitals");
    if (typeof rawVisaId !== "string" || !VISA_ID_RE.test(rawVisaId)) throw new RegistryError("INVALID_VISA_ID", 400, "That is not a valid visa record id");
    const countryCode = rawCountry;
    const visaTypeId = rawVisaId;
    const wanted = readInheritsFrom(rawList);
    const on = date ?? todayUtc(this.clock());
    const ref = subcollections.visaTypes(countryCode).doc(visaTypeId);
    const now = this.clock();

    const snap0 = await ref.get();
    if (!snap0.exists) throw new RegistryError("NOT_FOUND", 404, "There is no visa record with that id in that country");
    const before = inheritedIds((snap0.data() as VisaType).inheritsFrom);
    const wantedIds = wanted.map((w) => w.sharedRouteId);
    const added = wantedIds.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !wantedIds.includes(id));

    // ---- Added routes: must exist, be active, and cover this country today ----
    for (const id of added) {
      const route = await this.get(id);
      if (!route) throw new RegistryError("SHARED_ROUTE_NOT_FOUND", 422, "There is no shared route with that id", { field: "inheritsFrom", sharedRouteId: id });
      if (route.status !== "active") throw new RegistryError("SHARED_ROUTE_RETIRED", 422, "That shared route is retired", { field: "inheritsFrom", sharedRouteId: id });
      const covered = await this.destinationsOn(route, on);
      if (!covered.includes(countryCode)) {
        throw new RegistryError("COUNTRY_NOT_COVERED", 422, "that country is not covered by this shared route", { field: "inheritsFrom", sharedRouteId: id });
      }
    }

    // ---- Removed routes: refused while open applications on this record use them ----
    for (const id of removed) {
      const route = await this.get(id);
      if (!route) continue; // dangling reference: nothing can be keyed on it
      const open = await this.openOnRecord(countryCode, visaTypeId, sharedRulebookKey(route.issuingAuthorityId, route.id));
      if (open.length > 0) {
        throw new RegistryError(
          "OPEN_APPLICATIONS",
          409,
          `Cannot remove this shared route from the visa: ${open.length} open application${open.length === 1 ? " uses" : "s use"} it`,
          { openApplications: open.length, sharedRouteId: id }
        );
      }
    }

    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegistryError("NOT_FOUND", 404, "There is no visa record with that id in that country");
      const existing = snap.data() as VisaType;
      if (sameJson(inheritedIds(existing.inheritsFrom), wantedIds)) {
        return { countryCode, visaTypeId, inheritsFrom: wanted, changed: false };
      }
      // A full set: removing the field must really remove it. The record is
      // read in this same transaction, so nothing else's change is lost.
      const at = Timestamp.fromMillis(now);
      const next = stripUndefined({ ...existing, inheritsFrom: wanted.length > 0 ? wanted : undefined, updatedAt: at }) as VisaType;
      tx.set(ref, next);
      appendRegistryAudit(tx, {
        action: "visa_inheritance_changed",
        actorUid,
        at,
        targetType: "visaInheritance",
        targetId: `${countryCode}/${visaTypeId}`,
        before: { inheritsFrom: existing.inheritsFrom ?? [] },
        after: { inheritsFrom: wanted },
      });
      return { countryCode, visaTypeId, inheritsFrom: wanted, changed: true };
    });
  }

  /** The stack of a record read live (for the admin "what applies" read). */
  resolve = resolveRouteStack;
}

export const sharedRouteService = new SharedRouteService();
