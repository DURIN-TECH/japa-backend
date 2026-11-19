import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../utils/firebase";
// The source registry's error type, audit write and address rules, through
// the scrapers module's public API (its internals are off limits, see #91).
import { appendRegistryAudit, officialDomainAuthorityId, parseRegistryUrl, RegistryError, stripUndefined } from "../scrapers";
import { AUTHORITY_KINDS, AUTHORITY_STATUSES, MEMBERSHIP_KINDS, type Authority, type AuthorityKind, type AuthorityMember, type AuthorityStatus } from "../types/authority";
import { checkAuthorityId, checkAuthorityIdForKind, isCountryCode, membersOn, parseCalendarDate, todayUtc } from "./authority-ids";

// ============================================
// AUTHORITIES — SERVICE (issue #230, P1 of #228)
// ============================================
//
// Reads and writes `authorities/{id}` and `authorities/{id}/members/{cc}`.
// The only code that writes either collection. The admin controller calls the
// write methods; later parts (P2 shared routes, P3 official websites, P4
// stacked rulebooks, P5/P7 member groups) call the read helpers:
//
//   authorityService.get(id)              -> Authority | undefined
//   authorityService.exists(id)           -> boolean
//   authorityService.membersOn(id, date)  -> { authority, members } (404 when unknown)
//   expandDestinations(id, date)          -> string[] of country codes
//
// Rules enforced here (the pure ones live in authority-ids.ts):
//   - a country authority's id must be a code that exists in `countries`;
//   - only blocs and treaties have members, and a member's code must exist in
//     `countries` too (P2 resolves a member to `countries/{cc}/visaTypes`);
//   - a member is a legal claim: it needs a non-empty verbatim quote and an
//     https address on a CONFIRMED official host, or it is refused;
//   - creating the same authority twice with the same body is a no-op, with a
//     different body a 409; a member saved again unchanged is a no-op;
//   - every write is audited inside the same transaction as the change.
//
// Refusals are RegistryErrors (same `{ success:false, error, message }`
// shape as the source registry API), with plain-words messages.

/** Longest authority name accepted. */
export const AUTHORITY_NAME_MAX = 200;
/** Longest verbatim quote accepted (a sentence or short paragraph, not a page). */
export const SOURCE_QUOTE_MAX = 2000;

/** What `create` did. */
export interface CreateAuthorityResult {
  authority: Authority;
  created: boolean;
}

/** What `update` did. */
export interface UpdateAuthorityResult {
  authority: Authority;
  changed: boolean;
}

/** What `putMember` did. */
export interface PutMemberResult {
  member: AuthorityMember;
  created: boolean;
  changed: boolean;
}

/** The members of one authority current on a date. */
export interface MembersOnResult {
  authority: Authority;
  on: string;
  members: AuthorityMember[];
}

// ---------- Small validators (throwing RegistryError 400s) ----------

/** A non-empty trimmed name of bounded length. */
function readName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new RegistryError("NAME_REQUIRED", 400, "Give the authority's name as the official source writes it");
  if (name.length > AUTHORITY_NAME_MAX) throw new RegistryError("NAME_TOO_LONG", 400, `The name is longer than ${AUTHORITY_NAME_MAX} characters`);
  return name;
}

/** One of AUTHORITY_KINDS. */
function readKind(raw: unknown): AuthorityKind {
  if (typeof raw !== "string" || !(AUTHORITY_KINDS as readonly string[]).includes(raw)) {
    throw new RegistryError("INVALID_KIND", 400, `The kind must be one of: ${AUTHORITY_KINDS.join(", ")}`);
  }
  return raw as AuthorityKind;
}

/** One of AUTHORITY_STATUSES. */
function readStatus(raw: unknown): AuthorityStatus {
  if (typeof raw !== "string" || !(AUTHORITY_STATUSES as readonly string[]).includes(raw)) {
    throw new RegistryError("INVALID_STATUS", 400, `The status must be one of: ${AUTHORITY_STATUSES.join(", ")}`);
  }
  return raw as AuthorityStatus;
}

/** Any valid authority id (path parameters), or a 400. */
export function requireAuthorityId(raw: unknown): string {
  const check = checkAuthorityId(raw);
  if (!check.ok) throw new RegistryError(check.code, 400, check.message);
  return check.id;
}

/** A "YYYY-MM-DD" date, or a 400 naming the field. */
function readDate(raw: unknown, field: string): string {
  const date = parseCalendarDate(raw);
  if (!date) throw new RegistryError("INVALID_DATE", 400, `${field} must be a real date written YYYY-MM-DD`, { field });
  return date;
}

/** The fields of a member an admin supplies, validated (no reads yet). */
interface MemberInput {
  joinedOn: string;
  leftOn?: string;
  sourceQuote: string;
  sourceUrl: string;
  sourceHost: string;
}

/**
 * Validate a member body. Pure (exported for unit tests): every refusal that
 * needs no read happens here, so a bad body costs nothing.
 */
export function readMemberInput(body: Record<string, unknown>): MemberInput {
  const joinedOn = readDate(body.joinedOn, "joinedOn");
  // leftOn: absent or null means "still a member".
  const leftOn = body.leftOn === undefined || body.leftOn === null ? undefined : readDate(body.leftOn, "leftOn");
  if (leftOn !== undefined && leftOn <= joinedOn) {
    throw new RegistryError("INVALID_DATE_RANGE", 400, "leftOn must be after joinedOn (leftOn is the first day the country is no longer a member)", { field: "leftOn" });
  }
  // The quote is stored as given except for surrounding white space: it must
  // stay the official sentence, word for word.
  const sourceQuote = typeof body.sourceQuote === "string" ? body.sourceQuote.trim() : "";
  if (!sourceQuote) {
    throw new RegistryError("SOURCE_QUOTE_REQUIRED", 400, "Paste the sentence from the official page that states this membership, word for word", { field: "sourceQuote" });
  }
  if (sourceQuote.length > SOURCE_QUOTE_MAX) {
    throw new RegistryError("SOURCE_QUOTE_TOO_LONG", 400, `The quote is longer than ${SOURCE_QUOTE_MAX} characters: paste only the sentence that states the membership`, { field: "sourceQuote" });
  }
  if (body.sourceUrl === undefined || body.sourceUrl === null || body.sourceUrl === "") {
    throw new RegistryError("SOURCE_URL_REQUIRED", 400, "Give the address of the official page the quote is from", { field: "sourceUrl" });
  }
  // Same address rules as the source registry (https only, no port, no IP...).
  const parsed = parseRegistryUrl(body.sourceUrl);
  if (!parsed.ok) throw new RegistryError(parsed.code, 400, parsed.message, { field: "sourceUrl" });
  return { joinedOn, ...(leftOn ? { leftOn } : {}), sourceQuote, sourceUrl: parsed.url.href, sourceHost: parsed.url.hostname.toLowerCase() };
}

/** Plain-object copy for an audit entry. */
const asRecord = (v: unknown): Record<string, unknown> => ({ ...(v as Record<string, unknown>) });

class AuthorityService {
  /** Transaction runner (tests swap in the in-memory one). */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);
  /** Clock in epoch ms (tests fix it). */
  clock: () => number = Date.now;

  /**
   * Is `host` an official website the system may take a membership quote
   * from, for a member `countryCode` of authority `authorityId`?
   *
   * Issue #232 (P3): official websites belong to an authority
   * (`officialDomains/{host}.authorityId`). The host must be `confirmed` AND
   * confirmed for one of:
   *   - the bloc or treaty itself (its own site lists its members);
   *   - the country being saved (its own government says it is a member);
   *   - a country that is a member of the authority today (a fellow member's
   *     government publishing the list).
   * A host confirmed for an unrelated authority does not count. All reads are
   * in the caller's transaction (reads before writes).
   */
  private async hostConfirmed(tx: Transaction, host: string, authorityId: string, countryCode: string): Promise<boolean> {
    const snap = await tx.get(collections.officialDomains.doc(host));
    if (!snap.exists || (snap.data() as { status?: string }).status !== "confirmed") return false;
    const owner = officialDomainAuthorityId(snap.data());
    if (owner === authorityId || owner === countryCode) return true;
    if (!isCountryCode(owner)) return false;
    // Only a country can be a member: check the owner is a member today.
    const memberSnap = await tx.get(subcollections.authorityMembers(authorityId).doc(owner));
    return memberSnap.exists && membersOn([memberSnap.data() as AuthorityMember], todayUtc(this.clock())).length === 1;
  }

  // ============================================
  // Reads (for the controller and for later parts)
  // ============================================

  /** One authority, or undefined (an invalid id is simply not found). */
  async get(id: string): Promise<Authority | undefined> {
    if (!checkAuthorityId(id).ok) return undefined;
    const snap = await collections.authorities.doc(id).get();
    return snap.exists ? (snap.data() as Authority) : undefined;
  }

  /** Does this authority exist (any status)? */
  async exists(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  /** Every authority, sorted by id. */
  async list(): Promise<Authority[]> {
    const snap = await collections.authorities.get();
    return snap.docs.map((d) => d.data() as Authority).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every member ever recorded for an authority (past, current and future), sorted by code. */
  async listMembers(id: string): Promise<AuthorityMember[]> {
    const snap = await subcollections.authorityMembers(id).get();
    return snap.docs.map((d) => d.data() as AuthorityMember).sort((a, b) => a.countryCode.localeCompare(b.countryCode));
  }

  /**
   * The members of `id` current on `on` ("YYYY-MM-DD", default today UTC).
   * 400 for a bad id or date, 404 for an unknown authority; an authority with
   * no members (including any country authority) answers an empty list.
   */
  async membersOn(rawId: unknown, rawOn?: unknown): Promise<MembersOnResult> {
    const id = requireAuthorityId(rawId);
    const on = rawOn === undefined || rawOn === "" ? todayUtc(this.clock()) : readDate(rawOn, "on");
    const authority = await this.get(id);
    if (!authority) throw new RegistryError("NOT_FOUND", 404, "There is no authority with that id");
    const members = membersOn(await this.listMembers(id), on);
    return { authority, on, members };
  }

  // ============================================
  // Writes (admin API only; each one audited)
  // ============================================

  /**
   * Create an authority `{ id, kind, name }` (status starts `active`).
   * Idempotent: the same kind and name again changes and audits nothing (200
   * created:false); a different body for an existing id is 409.
   */
  async create(body: Record<string, unknown>, actorUid: string): Promise<CreateAuthorityResult> {
    const kind = readKind(body.kind);
    const idCheck = checkAuthorityIdForKind(body.id, kind);
    if (!idCheck.ok) throw new RegistryError(idCheck.code, 400, idCheck.message, { field: "id" });
    const id = idCheck.id;
    const name = readName(body.name);
    const now = this.clock();
    const ref = collections.authorities.doc(id);

    return this.runTransaction(async (tx) => {
      // All reads first (Firestore transactions read before they write).
      const snap = await tx.get(ref);
      const countrySnap = kind === "country" ? await tx.get(collections.countries.doc(id)) : undefined;
      if (snap.exists) {
        const existing = snap.data() as Authority;
        if (existing.kind === kind && existing.name === name) return { authority: existing, created: false };
        throw new RegistryError("AUTHORITY_EXISTS", 409, "An authority with that id already exists with a different kind or name; edit it instead", {
          existing: { kind: existing.kind, name: existing.name },
        });
      }
      if (countrySnap && !countrySnap.exists) {
        throw new RegistryError("COUNTRY_NOT_FOUND", 400, "A country authority needs the country to exist first: register the country, then create its authority", { field: "id" });
      }
      const at = Timestamp.fromMillis(now);
      const authority: Authority = { id, kind, name, status: "active", createdBy: actorUid, createdAt: at, updatedBy: actorUid, updatedAt: at };
      tx.create(ref, authority);
      appendRegistryAudit(tx, { action: "authority_created", actorUid, at, targetType: "authority", targetId: id, before: null, after: asRecord(authority) });
      return { authority, created: true };
    });
  }

  /**
   * Edit an authority's `name` and/or `status`. The id and kind never change
   * (other records key on them). An edit that changes nothing writes nothing.
   */
  async update(rawId: unknown, body: Record<string, unknown>, actorUid: string): Promise<UpdateAuthorityResult> {
    const id = requireAuthorityId(rawId);
    if (body.name === undefined && body.status === undefined) {
      throw new RegistryError("VALIDATION_ERROR", 400, "Give a new name or status");
    }
    const name = body.name === undefined ? undefined : readName(body.name);
    const status = body.status === undefined ? undefined : readStatus(body.status);
    const now = this.clock();
    const ref = collections.authorities.doc(id);

    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegistryError("NOT_FOUND", 404, "There is no authority with that id");
      const existing = snap.data() as Authority;
      const nextName = name ?? existing.name;
      const nextStatus = status ?? existing.status;
      if (nextName === existing.name && nextStatus === existing.status) return { authority: existing, changed: false };
      const next: Authority = { ...existing, name: nextName, status: nextStatus, updatedBy: actorUid, updatedAt: Timestamp.fromMillis(now) };
      tx.set(ref, next);
      appendRegistryAudit(tx, {
        action: "authority_changed",
        actorUid,
        at: next.updatedAt,
        targetType: "authority",
        targetId: id,
        before: asRecord(existing),
        after: asRecord(next),
      });
      return { authority: next, changed: true };
    });
  }

  /**
   * Add or change one member of a bloc or treaty:
   * `{ joinedOn, leftOn?, sourceQuote, sourceUrl }` for country `rawCode`.
   *
   * Refused: an unknown authority (404); a country authority (it has no
   * members, 400); a code that is malformed or not in `countries` (400); a
   * missing or empty quote, a non-https address (400); an address whose host
   * is not a confirmed official website (422, the registry's code). Saving the
   * same values again changes and audits nothing.
   */
  async putMember(rawId: unknown, rawCode: unknown, body: Record<string, unknown>, actorUid: string): Promise<PutMemberResult> {
    const id = requireAuthorityId(rawId);
    if (!isCountryCode(rawCode)) {
      throw new RegistryError("INVALID_COUNTRY_CODE", 400, "A member is a two-letter country code in capitals", { field: "countryCode" });
    }
    const countryCode = rawCode;
    const input = readMemberInput(body);
    const now = this.clock();
    const authorityRef = collections.authorities.doc(id);
    const memberRef = subcollections.authorityMembers(id).doc(countryCode);

    return this.runTransaction(async (tx) => {
      // ---- Reads ----
      const [authoritySnap, memberSnap, countrySnap] = await Promise.all([tx.get(authorityRef), tx.get(memberRef), tx.get(collections.countries.doc(countryCode))]);
      const confirmed = await this.hostConfirmed(tx, input.sourceHost, id, countryCode);

      // ---- Checks, in the order an admin would fix them ----
      if (!authoritySnap.exists) throw new RegistryError("NOT_FOUND", 404, "There is no authority with that id");
      const authority = authoritySnap.data() as Authority;
      if (!(MEMBERSHIP_KINDS as readonly string[]).includes(authority.kind)) {
        throw new RegistryError("AUTHORITY_HAS_NO_MEMBERS", 400, "Only a bloc or a treaty has members; a country authority is just that country");
      }
      if (!countrySnap.exists) {
        throw new RegistryError("COUNTRY_NOT_FOUND", 400, "That country is not registered yet: register it first, then add it as a member", { field: "countryCode" });
      }
      if (!confirmed) {
        throw new RegistryError("HOST_NOT_CONFIRMED", 422, "The quote must come from a confirmed official website. Confirm the website first, then save the member", {
          field: "sourceUrl",
          hosts: [input.sourceHost],
        });
      }

      // ---- Idempotent: the same values again write nothing ----
      const existing = memberSnap.exists ? (memberSnap.data() as AuthorityMember) : undefined;
      if (
        existing &&
        existing.joinedOn === input.joinedOn &&
        (existing.leftOn ?? undefined) === input.leftOn &&
        existing.sourceQuote === input.sourceQuote &&
        existing.sourceUrl === input.sourceUrl
      ) {
        return { member: existing, created: false, changed: false };
      }

      // ---- Write + audit ----
      const at = Timestamp.fromMillis(now);
      const member: AuthorityMember = stripUndefined({
        countryCode,
        joinedOn: input.joinedOn,
        leftOn: input.leftOn,
        sourceQuote: input.sourceQuote,
        sourceUrl: input.sourceUrl,
        createdBy: existing?.createdBy ?? actorUid,
        createdAt: existing?.createdAt ?? at,
        updatedBy: actorUid,
        updatedAt: at,
      });
      // A full set (not merge): clearing leftOn must really remove it.
      tx.set(memberRef, member);
      appendRegistryAudit(tx, {
        action: existing ? "authority_member_changed" : "authority_member_added",
        actorUid,
        at,
        targetType: "authorityMember",
        targetId: `${id}/${countryCode}`,
        before: existing ? asRecord(existing) : null,
        after: asRecord(member),
        statement: input.sourceQuote,
      });
      return { member, created: !existing, changed: true };
    });
  }
}

export const authorityService = new AuthorityService();

// ============================================
// expandDestinations — for later parts
// ============================================

/**
 * The country codes an authority's rules cover on `date` ("YYYY-MM-DD",
 * default today UTC), sorted:
 *  - a bloc or treaty: its members current on that date (may be empty);
 *  - a country: that country alone (a country authority IS its destination).
 * 404 RegistryError for an unknown authority, 400 for a bad id or date.
 * Status is not applied here: a caller that must ignore retired authorities
 * checks `authorityService.get(id).status` itself.
 */
export async function expandDestinations(authorityId: string, date?: string): Promise<string[]> {
  const { authority, members } = await authorityService.membersOn(authorityId, date);
  if (authority.kind === "country") return [authority.id];
  return members.map((m) => m.countryCode);
}
