import { Timestamp } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../utils/firebase";
import { isVisaPubliclyVisible } from "./visa.service";
import type {
  Country,
  SavedDestination,
  SavedDestinationItem,
  SavedDestinationVisa,
  VisaType,
} from "../types";

// ============================================
// SAVED DESTINATIONS — SERVICE (issue #146)
// ============================================
//
// A client saves a destination (one visa in one country) with the heart on
// its screen. Storage: ONE document per save, under the user:
//
//   users/{uid}/savedDestinations/{COUNTRYCODE}_{visaId}
//     { countryCode, visaId, savedAt }
//
// Rules this file keeps:
//  - Every method takes the caller's uid (from the verified token, passed by
//    the controller) and only ever touches that user's subcollection. There
//    is no method that reads "a" user's saves by anything else.
//  - The document id is built from the key, so saving twice is one document
//    (idempotent by construction, not by a lookup that could race).
//  - Country codes are stored and compared UPPER CASE: "gb" and "GB" are the
//    same save.
//  - Only a PUBLICLY VISIBLE visa (isVisaPubliclyVisible, the #99 rule) can
//    be saved or listed. A hidden or unknown visa answers "not found" in both
//    cases, so a hidden visa's existence never leaks through this feature.
//  - The saved document holds no visa data. The list reads each visa when it
//    is served, so a tile is never stale; a visa that became hidden is left
//    out, and comes back by itself if it is made visible again (the saved
//    record stays).
//  - At most SAVED_DESTINATIONS_LIMIT saves per user, counted and written in
//    one transaction.
//
// Indexes: the list orders by `savedAt` alone inside one subcollection, which
// the automatic single-field index serves. No composite index is needed.

// ============================================
// Constants
// ============================================

/** Name of the subcollection under users/{uid}. */
export const SAVED_DESTINATIONS_SUBCOLLECTION = "savedDestinations";

/** The most destinations one user can hold. The next save is refused. */
export const SAVED_DESTINATIONS_LIMIT = 200;

/** Longest visa id accepted in the path (real ids are far shorter). */
const MAX_VISA_ID_LENGTH = 200;

// ============================================
// Errors
// ============================================

/** Stable codes the controller maps to an HTTP status (the app keys its copy on them). */
export type SavedDestinationErrorCode = "NOT_FOUND" | "SAVED_LIMIT_REACHED";

/** A refusal of a save: unknown / hidden visa, or the per-user cap. */
export class SavedDestinationError extends Error {
  constructor(
    public readonly code: SavedDestinationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SavedDestinationError";
  }
}

// ============================================
// Key handling (pure)
// ============================================

/** The normalised key of a save. */
export interface SavedDestinationKey {
  /** UPPER CASE two-letter code. */
  countryCode: string;
  visaId: string;
}

/**
 * Read the two path parameters into a key, or null when they cannot name a
 * visa at all.
 *
 * The country code is trimmed and upper-cased (the only normalisation), and
 * must be two letters. The visa id is used as a Firestore document id, so the
 * values Firestore refuses or treats specially are turned away here instead
 * of reaching the database: empty, containing "/", "." and "..", the reserved
 * `__name__` form, and anything absurdly long.
 */
export function parseSavedDestinationKey(rawCountryCode: unknown, rawVisaId: unknown): SavedDestinationKey | null {
  const countryCode = typeof rawCountryCode === "string" ? rawCountryCode.trim().toUpperCase() : "";
  const visaId = typeof rawVisaId === "string" ? rawVisaId : "";
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;
  if (visaId.length === 0 || visaId.length > MAX_VISA_ID_LENGTH) return null;
  if (visaId.includes("/") || visaId === "." || visaId === ".." || /^__.*__$/.test(visaId)) return null;
  return { countryCode, visaId };
}

/**
 * Document id of a save. The country code is always exactly two letters, so
 * the first "_" is unambiguous and two different keys can never share an id.
 */
export function savedDestinationDocId(key: SavedDestinationKey): string {
  return `${key.countryCode}_${key.visaId}`;
}

/**
 * The tile fields of a visa: an explicit allow-list, so nothing internal
 * (review state, scrape provenance, owning agency) is ever returned.
 * Optional numbers become null rather than being left out, so the response
 * shape is the same for every item.
 */
export function toSavedDestinationVisa(visa: VisaType, key: SavedDestinationKey): SavedDestinationVisa {
  return {
    id: key.visaId,
    countryCode: key.countryCode,
    name: visa.name,
    description: visa.description,
    category: visa.category,
    processingTime: visa.processingTime,
    baseCostUsd: visa.baseCostUsd,
    successRate: visa.successRate ?? null,
    totalApplications: visa.totalApplications ?? null,
    source: visa.source ?? null,
  };
}

// ============================================
// Service
// ============================================

export class SavedDestinationsService {
  /** The caller's own subcollection: the ONLY place this service reads or writes saves. */
  private savesOf(userId: string): FirebaseFirestore.CollectionReference {
    return collections.users.doc(userId).collection(SAVED_DESTINATIONS_SUBCOLLECTION);
  }

  /**
   * Read the visa behind a key for a save or a list row: null when it does
   * not exist OR is not publicly visible (one answer for both).
   */
  private async publicVisa(key: SavedDestinationKey): Promise<VisaType | null> {
    const doc = await subcollections.visaTypes(key.countryCode).doc(key.visaId).get();
    if (!doc.exists) return null;
    const visa = { id: doc.id, ...doc.data() } as VisaType;
    return isVisaPubliclyVisible(visa) ? visa : null;
  }

  /** The country's display name, or the code when the country record is missing. */
  private async countryName(countryCode: string): Promise<string> {
    const doc = await collections.countries.doc(countryCode).get();
    return (doc.exists ? (doc.data() as Country).name : undefined) || countryCode;
  }

  /**
   * GET /users/me/saved-destinations: the caller's saves, newest first, each
   * with the visa data a tile draws. Saves whose visa is gone or hidden are
   * left out (their records stay).
   */
  async list(userId: string): Promise<SavedDestinationItem[]> {
    // ---- 1. The saves, newest first (single-field index on savedAt). ----
    // The cap keeps this at SAVED_DESTINATIONS_LIMIT documents; the limit is a
    // second guard so one request can never read an unbounded list.
    const snapshot = await this.savesOf(userId)
      .orderBy("savedAt", "desc")
      .limit(SAVED_DESTINATIONS_LIMIT)
      .get();
    const saves = snapshot.docs.map((doc) => doc.data() as SavedDestination);
    if (saves.length === 0) return [];

    // ---- 2. Every visa and every distinct country, in two batched reads. ----
    // getAll returns the documents in the order of the references given.
    const visaRefs = saves.map((s) => subcollections.visaTypes(s.countryCode).doc(s.visaId));
    const countryCodes = [...new Set(saves.map((s) => s.countryCode))];
    const countryRefs = countryCodes.map((code) => collections.countries.doc(code));
    const [visaDocs, countryDocs] = await Promise.all([db.getAll(...visaRefs), db.getAll(...countryRefs)]);

    const countryNames = new Map<string, string>();
    countryDocs.forEach((doc, i) => {
      countryNames.set(countryCodes[i], (doc.exists ? (doc.data() as Country).name : undefined) || countryCodes[i]);
    });

    // ---- 3. Keep the saves whose visa is publicly visible TODAY. ----
    const items: SavedDestinationItem[] = [];
    saves.forEach((save, i) => {
      const doc = visaDocs[i];
      if (!doc.exists) return;
      const visa = { id: doc.id, ...doc.data() } as VisaType;
      if (!isVisaPubliclyVisible(visa)) return;
      const key = { countryCode: save.countryCode, visaId: save.visaId };
      items.push({
        countryCode: save.countryCode,
        visaId: save.visaId,
        savedAt: save.savedAt,
        countryName: countryNames.get(save.countryCode) ?? save.countryCode,
        visa: toSavedDestinationVisa(visa, key),
      });
    });
    return items;
  }

  /**
   * PUT /users/me/saved-destinations/:countryCode/:visaId: save it and return
   * the saved item. Saving something already saved returns the existing item
   * unchanged (same `savedAt`, no second record).
   *
   * @throws SavedDestinationError NOT_FOUND when the visa does not exist or is
   *   not publicly visible; SAVED_LIMIT_REACHED at the cap. Nothing is stored
   *   in either case.
   */
  async save(userId: string, key: SavedDestinationKey): Promise<SavedDestinationItem> {
    // ---- 1. The visa must exist and be publicly visible. ----
    const visa = await this.publicVisa(key);
    if (!visa) {
      throw new SavedDestinationError("NOT_FOUND", "This destination is not available to save");
    }

    // ---- 2. Create the save, unless it exists or the user is at the cap. ----
    // One transaction reads this save and counts the user's saves, then
    // writes: two saves sent at the same moment cannot both slip under the
    // cap, and a repeated save can never produce a second record (the
    // document id IS the key).
    const saves = this.savesOf(userId);
    const ref = saves.doc(savedDestinationDocId(key));
    const saved = await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      // Already saved: succeed, and keep the first savedAt so the item does
      // not jump to the top of the list.
      if (existing.exists) return existing.data() as SavedDestination;

      const count = (await tx.get(saves.count())).data().count;
      if (count >= SAVED_DESTINATIONS_LIMIT) {
        throw new SavedDestinationError(
          "SAVED_LIMIT_REACHED",
          `You can save up to ${SAVED_DESTINATIONS_LIMIT} destinations. Remove one to save this.`
        );
      }

      // Timestamp.now() (not a server sentinel) so the stored value can be
      // returned as it is, without a second read.
      const record: SavedDestination = {
        countryCode: key.countryCode,
        visaId: key.visaId,
        savedAt: Timestamp.now(),
      };
      tx.create(ref, record);
      return record;
    });

    return {
      countryCode: saved.countryCode,
      visaId: saved.visaId,
      savedAt: saved.savedAt,
      countryName: await this.countryName(key.countryCode),
      visa: toSavedDestinationVisa(visa, key),
    };
  }

  /**
   * DELETE /users/me/saved-destinations/:countryCode/:visaId: remove the save.
   * Idempotent: removing something that is not saved succeeds too. No visa
   * check on purpose: a save whose visa was hidden or deleted since must still
   * be removable.
   */
  async remove(userId: string, key: SavedDestinationKey): Promise<void> {
    await this.savesOf(userId).doc(savedDestinationDocId(key)).delete();
  }

  /**
   * Delete every save of a user (account deletion, DELETE /users/me). Firestore
   * does not delete subcollections with their parent document, so without this
   * the saves would outlive the account. Returns how many were deleted.
   *
   * Works in pages below the 500-write batch limit and loops until the
   * subcollection is empty, so it is correct even if a user somehow held more
   * documents than the cap.
   */
  async removeAllForUser(userId: string): Promise<number> {
    const saves = this.savesOf(userId);
    let deleted = 0;
    for (;;) {
      // select(): document references only, no field data is read.
      const page = await saves.select().limit(400).get();
      if (page.empty) return deleted;
      const batch = db.batch();
      page.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      deleted += page.size;
    }
  }
}

export const savedDestinationsService = new SavedDestinationsService();
