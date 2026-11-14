import { randomUUID } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import { checkAuthorityId, isCountryCode, parseCalendarDate, todayUtc } from "../authorities/authority-ids";
import {
  HELD_DOCUMENT_KINDS,
  HOLDINGS_LIMITS,
  type ApplicantFacts,
  type HeldDocument,
  type HeldDocumentKind,
} from "../types/applicant-facts";
import type { User } from "../types";

// ============================================
// WHAT THE APPLICANT HOLDS — PROFILE SERVICE (issue #234, P5 of #228)
// ============================================
//
// Reads and writes the holdings on the signed-in user's OWN profile
// (`users/{uid}`: `nationalities`, `residentialCountry`, `heldDocuments`,
// `holdingsUpdatedAt`), and builds the copy an application takes when it
// starts (`applicantFactsFromUser`).
//
// Who can call this: only the routes under /users/me/holdings, which always
// act on `req.userId` (the caller's own uid). There is no route that names
// another user, so nobody can read or change someone else's holdings. The
// agent side sees an application's COPY only (GET /applications/:id, behind
// `checkApplicationAccess`). No new permission in `@durin-tech/authz` is
// needed: this is the caller's own profile, like PUT /users/me.
//
// PRIVACY: values are never logged (errors name the FIELD, never the value),
// never sent to a third party, and never inferred from anything else.
//
// Validation is pure (exported for tests) and refuses, never repairs: a bad
// value is a 400 with a plain-words message naming the field.

/** A refusal of a holdings write: HTTP 400 (or 404 for an unknown document id). */
export class HoldingsValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
    public readonly status: 400 | 404 = 400
  ) {
    super(message);
    this.name = "HoldingsValidationError";
  }
}

// ============================================
// Response shape (what the mobile screen reads)
// ============================================

/** One held document as the API returns it: the stored fields plus `expired` (today, UTC). */
export interface HeldDocumentView extends HeldDocument {
  expired: boolean;
}

/** GET /users/me/holdings (and the answer of every write). */
export interface HoldingsView {
  // Two-letter codes; [] = not stated yet.
  nationalities: string[];
  // Two-letter code, or null when not stated. A legacy profile value that is
  // not a two-letter code is returned as null (it is never guessed from).
  residentialCountry: string | null;
  // null = the applicant has never said what they hold; [] = they hold none.
  heldDocuments: HeldDocumentView[] | null;
  // ISO-8601 time of the last holdings save, or null.
  updatedAt: string | null;
}

/** Is a "YYYY-MM-DD" date before `today` ("YYYY-MM-DD")? A document valid until today is still valid. */
export function isExpiredOn(validUntil: string, today: string): boolean {
  return validUntil < today;
}

/**
 * The profile fields the holdings view reads. `residentialCountry` may be
 * null in storage (a PUT that cleared it).
 */
export type ProfileHoldings = Partial<Pick<User, "nationalities" | "heldDocuments" | "holdingsUpdatedAt">> & { residentialCountry?: string | null };

/** The holdings of a profile as the API returns them. */
export function holdingsViewOf(user: ProfileHoldings | null, today: string): HoldingsView {
  const residence = user?.residentialCountry;
  const updated = user?.holdingsUpdatedAt as { toDate?: () => Date } | undefined;
  return {
    nationalities: Array.isArray(user?.nationalities) ? user.nationalities.filter((n) => isCountryCode(n)) : [],
    residentialCountry: isCountryCode(residence) ? residence : null,
    heldDocuments: Array.isArray(user?.heldDocuments)
      ? user.heldDocuments.map((d) => ({ ...d, expired: isExpiredOn(d.validUntil, today) }))
      : null,
    updatedAt: updated && typeof updated.toDate === "function" ? updated.toDate().toISOString() : null,
  };
}

// ============================================
// Validation (pure)
// ============================================

/** A two-letter code, trimmed and upper-cased (the only normalisation: case). */
function readCode(raw: unknown, field: string): string {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!isCountryCode(code)) throw new HoldingsValidationError(field, `${field} must be a two-letter country code`);
  return code;
}

/** `nationalities`: a list of distinct two-letter codes, at most HOLDINGS_LIMITS.maxNationalities. */
export function readNationalities(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new HoldingsValidationError("nationalities", "nationalities must be a list of two-letter country codes");
  if (raw.length > HOLDINGS_LIMITS.maxNationalities) {
    throw new HoldingsValidationError("nationalities", `Give at most ${HOLDINGS_LIMITS.maxNationalities} nationalities`);
  }
  const out: string[] = [];
  for (const v of raw) {
    const code = readCode(v, "nationalities");
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** `residentialCountry`: a two-letter code, or null to clear it. */
export function readResidence(raw: unknown): string | null {
  if (raw === null) return null;
  return readCode(raw, "residentialCountry");
}

/**
 * One held document from a request. Exactly one issuer: `issuerCountryCode`
 * (two-letter code) or `issuerAuthorityId` (a bloc / treaty authority id; it
 * must exist, checked by the caller with `authorityExists`). `validUntil` must
 * be a real calendar date inside HOLDINGS_LIMITS; a date in the PAST is
 * accepted and stored (the document is then reported `expired` and never
 * matches a rule). `id` is kept when it is one of the profile's existing ids
 * (an edit), otherwise a new one is made.
 */
export function readHeldDocument(raw: unknown, existingIds: ReadonlySet<string>, makeId: () => string = () => randomUUID()): HeldDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HoldingsValidationError("heldDocuments", "Each held document must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !(HELD_DOCUMENT_KINDS as readonly string[]).includes(r.kind)) {
    throw new HoldingsValidationError("kind", `kind must be one of: ${HELD_DOCUMENT_KINDS.join(", ")}`);
  }
  const hasCountry = r.issuerCountryCode !== undefined && r.issuerCountryCode !== null && r.issuerCountryCode !== "";
  const hasAuthority = r.issuerAuthorityId !== undefined && r.issuerAuthorityId !== null && r.issuerAuthorityId !== "";
  if (hasCountry === hasAuthority) {
    throw new HoldingsValidationError("issuer", "Give exactly one of issuerCountryCode (the country that issued it) or issuerAuthorityId");
  }
  let issuer: Pick<HeldDocument, "issuerCountryCode" | "issuerAuthorityId">;
  if (hasCountry) issuer = { issuerCountryCode: readCode(r.issuerCountryCode, "issuerCountryCode") };
  else {
    const check = checkAuthorityId(r.issuerAuthorityId);
    if (!check.ok) throw new HoldingsValidationError("issuerAuthorityId", check.message);
    issuer = { issuerAuthorityId: check.id };
  }
  const validUntil = parseCalendarDate(r.validUntil);
  if (!validUntil) throw new HoldingsValidationError("validUntil", "validUntil must be a date written YYYY-MM-DD");
  if (validUntil < HOLDINGS_LIMITS.earliestValidUntil || validUntil > HOLDINGS_LIMITS.latestValidUntil) {
    throw new HoldingsValidationError("validUntil", `validUntil must be between ${HOLDINGS_LIMITS.earliestValidUntil} and ${HOLDINGS_LIMITS.latestValidUntil}`);
  }
  let note: string | undefined;
  if (r.note !== undefined && r.note !== null) {
    if (typeof r.note !== "string") throw new HoldingsValidationError("note", "note must be text");
    const trimmed = r.note.trim();
    if (trimmed.length > HOLDINGS_LIMITS.maxNoteChars) throw new HoldingsValidationError("note", `note must be at most ${HOLDINGS_LIMITS.maxNoteChars} characters`);
    if (trimmed) note = trimmed;
  }
  const id = typeof r.id === "string" && existingIds.has(r.id) ? r.id : makeId();
  return { id, kind: r.kind as HeldDocumentKind, ...issuer, validUntil, ...(note ? { note } : {}) };
}

/** A whole `heldDocuments` list ([] = "I hold none"), at most HOLDINGS_LIMITS.maxHeldDocuments. */
export function readHeldDocuments(raw: unknown, existingIds: ReadonlySet<string>, makeId?: () => string): HeldDocument[] {
  if (!Array.isArray(raw)) throw new HoldingsValidationError("heldDocuments", "heldDocuments must be a list");
  if (raw.length > HOLDINGS_LIMITS.maxHeldDocuments) {
    throw new HoldingsValidationError("heldDocuments", `Give at most ${HOLDINGS_LIMITS.maxHeldDocuments} held documents`);
  }
  const docs = raw.map((d) => readHeldDocument(d, existingIds, makeId));
  // Two entries keeping the same existing id would make "remove" ambiguous.
  if (new Set(docs.map((d) => d.id)).size !== docs.length) throw new HoldingsValidationError("heldDocuments", "Two held documents have the same id");
  return docs;
}

/** The fields a PUT changes (absent = unchanged). */
export interface HoldingsPatch {
  nationalities?: string[];
  residentialCountry?: string | null;
  heldDocuments?: HeldDocument[];
}

/**
 * Read a PUT /users/me/holdings body: any of `nationalities`,
 * `residentialCountry`, `heldDocuments`; each one present REPLACES the stored
 * value. Unknown keys are refused (never silently dropped), so a typo cannot
 * look like a successful save. At least one field is required.
 */
export function readHoldingsPatch(body: unknown, existingIds: ReadonlySet<string>, makeId?: () => string): HoldingsPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HoldingsValidationError("", "The body must be an object");
  const b = body as Record<string, unknown>;
  const allowed = new Set(["nationalities", "residentialCountry", "heldDocuments"]);
  for (const key of Object.keys(b)) if (!allowed.has(key)) throw new HoldingsValidationError(key, `${key} is not a holdings field`);
  const patch: HoldingsPatch = {};
  if (b.nationalities !== undefined) patch.nationalities = readNationalities(b.nationalities);
  if (b.residentialCountry !== undefined) patch.residentialCountry = readResidence(b.residentialCountry);
  if (b.heldDocuments !== undefined) patch.heldDocuments = readHeldDocuments(b.heldDocuments, existingIds, makeId);
  if (Object.keys(patch).length === 0) throw new HoldingsValidationError("", "Give at least one of nationalities, residentialCountry or heldDocuments");
  return patch;
}

// ============================================
// The copy an application takes when it starts (pure)
// ============================================

/**
 * The applicant's holdings as an application's copy (`applicantFacts`),
 * taken at `takenAt` (the moment the application starts). Same "not stated"
 * conventions as the profile: no nationalities = [], residence not a
 * two-letter code = null, held documents never stated = null. Each held
 * document records whether it had already expired at that moment.
 */
export function applicantFactsFromUser(
  user: ProfileHoldings | null | undefined,
  takenAt: Timestamp
): ApplicantFacts {
  const today = todayUtc(takenAt.toMillis());
  const view = holdingsViewOf(user ?? null, today);
  return {
    nationalities: view.nationalities,
    residentialCountry: view.residentialCountry,
    heldDocuments: view.heldDocuments === null
      ? null
      : view.heldDocuments.map(({ expired, ...d }) => ({ ...d, expiredWhenTaken: expired })),
    takenAt,
  };
}

// ============================================
// Storage (Firestore by default; injected in tests)
// ============================================

/** What the service reads and writes. */
export interface HoldingsStore {
  readUser(uid: string): Promise<User | null>;
  writeHoldings(uid: string, fields: Record<string, unknown>): Promise<void>;
  authorityExists(id: string): Promise<boolean>;
}

/** Firestore: the caller's own `users/{uid}` and `authorities/{id}`. */
const firestoreStore: HoldingsStore = {
  async readUser(uid) {
    const snap = await collections.users.doc(uid).get();
    return snap.exists ? (snap.data() as User) : null;
  },
  async writeHoldings(uid, fields) {
    await collections.users.doc(uid).update(fields);
  },
  async authorityExists(id) {
    return (await collections.authorities.doc(id).get()).exists;
  },
};

export class ApplicantHoldingsService {
  constructor(
    private readonly store: HoldingsStore = firestoreStore,
    private readonly clock: () => number = () => Date.now()
  ) {}

  /** Today (UTC) for the `expired` flag. */
  private today(): string {
    return todayUtc(this.clock());
  }

  /** The caller's profile, or a 404 refusal when it does not exist yet. */
  private async requireUser(uid: string): Promise<User> {
    const user = await this.store.readUser(uid);
    if (!user) throw new HoldingsValidationError("", "Your profile is not set up yet", 404);
    return user;
  }

  /** Every `issuerAuthorityId` named must be an existing authority (never stored blind). */
  private async assertIssuersExist(docs: readonly HeldDocument[]): Promise<void> {
    for (const id of new Set(docs.map((d) => d.issuerAuthorityId).filter((x): x is string => typeof x === "string"))) {
      if (!(await this.store.authorityExists(id))) throw new HoldingsValidationError("issuerAuthorityId", "There is no authority with that id");
    }
  }

  /** Save the changed fields with the time, then answer the fresh view. */
  private async save(uid: string, user: User, patch: HoldingsPatch): Promise<HoldingsView> {
    const now = Timestamp.fromMillis(this.clock());
    const fields: Record<string, unknown> = { ...patch, holdingsUpdatedAt: now, updatedAt: now };
    await this.store.writeHoldings(uid, fields);
    return holdingsViewOf({ ...user, ...patch, holdingsUpdatedAt: now }, this.today());
  }

  /** GET /users/me/holdings. A user with no profile yet has nothing stated. */
  async get(uid: string): Promise<HoldingsView> {
    return holdingsViewOf(await this.store.readUser(uid), this.today());
  }

  /** PUT /users/me/holdings: replace the fields given. */
  async update(uid: string, body: unknown): Promise<HoldingsView> {
    const user = await this.requireUser(uid);
    const existing = new Set((user.heldDocuments ?? []).map((d) => d.id));
    const patch = readHoldingsPatch(body, existing);
    if (patch.heldDocuments) await this.assertIssuersExist(patch.heldDocuments);
    return this.save(uid, user, patch);
  }

  /** POST /users/me/holdings/documents: add one held document (a new id is made). */
  async addDocument(uid: string, body: unknown): Promise<HoldingsView> {
    const user = await this.requireUser(uid);
    const current = user.heldDocuments ?? [];
    if (current.length >= HOLDINGS_LIMITS.maxHeldDocuments) {
      throw new HoldingsValidationError("heldDocuments", `Give at most ${HOLDINGS_LIMITS.maxHeldDocuments} held documents`);
    }
    // An `id` in the body is ignored on add (a new document always gets a new id).
    const doc = readHeldDocument(body, new Set());
    await this.assertIssuersExist([doc]);
    return this.save(uid, user, { heldDocuments: [...current, doc] });
  }

  /** DELETE /users/me/holdings/documents/:documentId: remove one held document (404 when it is not there). */
  async removeDocument(uid: string, documentId: string): Promise<HoldingsView> {
    const user = await this.requireUser(uid);
    const current = user.heldDocuments ?? [];
    if (!current.some((d) => d.id === documentId)) throw new HoldingsValidationError("documentId", "That held document is not on your profile", 404);
    // Removing the last one leaves [] ("holds none"), which is a statement, not "not stated".
    return this.save(uid, user, { heldDocuments: current.filter((d) => d.id !== documentId) });
  }
}

export const applicantHoldingsService = new ApplicantHoldingsService();
