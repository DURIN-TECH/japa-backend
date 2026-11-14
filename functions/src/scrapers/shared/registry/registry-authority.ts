import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import { collections } from "../../../utils/firebase";
// The PURE id rules only (no Firebase, type-only imports): importing the
// authorities service from here would close a cycle (authorities -> scrapers
// index -> registry -> authorities), so the registry reads `authorities/{id}`
// itself, inside the caller's transaction when it has one.
import { checkAuthorityId } from "../../../authorities/authority-ids";
import type { Authority, AuthorityKind } from "../../../types/authority";
import { lookupRegionName } from "./registry-address";
import { RegistryError } from "./registry-errors";

// ============================================
// SOURCE REGISTRY — WHICH AUTHORITY A SOURCE BELONGS TO (issue #232, P3 of #228)
// ============================================
//
// Official websites (`officialDomains/{host}`), visa-page sources
// (`visaSources/{authorityId}`) and guidance sources (`jurisdiction`) belong
// to an ISSUING AUTHORITY: a country, a bloc or a treaty (see
// types/authority.ts). This module turns what an admin typed into a checked
// authority, the same way for every registry endpoint:
//
//   - a two-letter code (either case, as the registry always accepted) is a
//     COUNTRY authority when it is a real region code. A country authority
//     does not need an `authorities/{cc}` document: a country simply IS its
//     authority, and requiring the document would deadlock registering a new
//     country (its host must be confirmed before the country record exists).
//     When an `authorities/{cc}` document does exist, its status is honoured.
//   - anything else must be a valid bloc/treaty id (authority-ids.ts) AND an
//     existing `authorities/{id}` document.
//   - a RETIRED authority is refused: nothing new may be confirmed or
//     registered for rules that no longer apply.
//
// Refusals: 400 INVALID_AUTHORITY (bad shape, unknown region, unknown bloc or
// treaty), 409 AUTHORITY_RETIRED.

/** A checked authority, as the registry needs it. */
export interface RegistryAuthority {
  /** The id stored on sources: the upper-case country code, or the bloc/treaty id. */
  id: string;
  kind: AuthorityKind;
  /** Display name: the authority's own name, else (a country) the English region name. */
  name: string;
  /** True for a country authority (records are filed under `countries/{id}`). */
  isCountry: boolean;
}

/** Reads one document: `tx.get` inside a transaction, `ref.get()` outside. */
export type DocReader = (ref: DocumentReference) => Promise<DocumentSnapshot>;

/** The default reader (no transaction). */
const plainRead: DocReader = (ref) => ref.get();

/** Two letters, any case: the shape the registry has always read as a country code. */
const TWO_LETTERS_RE = /^[A-Za-z]{2}$/;

/** The plain-words refusal for an id that names no authority. */
function invalidAuthority(message: string, field: string): RegistryError {
  return new RegistryError("INVALID_AUTHORITY", 400, message, { field });
}

/**
 * Shape-only check (no read): returns the normalised id and whether it is a
 * country, or throws INVALID_AUTHORITY. Pure, so body parsers can call it
 * before anything is read or fetched.
 */
export function parseAuthorityRef(raw: unknown, field = "authorityId"): { id: string; isCountry: boolean; regionName?: string } {
  if (typeof raw === "string" && TWO_LETTERS_RE.test(raw)) {
    const region = lookupRegionName(raw);
    if (!region) throw invalidAuthority("That is not a known two-letter country code, nor a bloc or treaty id", field);
    return { id: region.code, isCountry: true, regionName: region.name };
  }
  const check = checkAuthorityId(raw);
  if (!check.ok) throw invalidAuthority(`Give the authority: a two-letter country code, or the id of a bloc or treaty. ${check.message}`, field);
  // checkAuthorityId's country shape is two upper-case letters, handled above,
  // so a passing id here is always a bloc/treaty id.
  return { id: check.id, isCountry: false };
}

/**
 * Resolve an authority (shape + existence + status). `read` lets a caller
 * make the read part of its transaction, so a bloc retired a moment ago is
 * seen by the same transaction that would have used it.
 */
export async function resolveRegistryAuthority(raw: unknown, read: DocReader = plainRead, field = "authorityId"): Promise<RegistryAuthority> {
  const ref = parseAuthorityRef(raw, field);
  const snap = await read(collections.authorities.doc(ref.id));
  const doc = snap.exists ? (snap.data() as Authority) : undefined;
  if (ref.isCountry) {
    if (doc?.status === "retired") throw new RegistryError("AUTHORITY_RETIRED", 409, "That authority is retired, so nothing new can be added to it", { field });
    return { id: ref.id, kind: "country", name: doc?.name ?? ref.regionName ?? ref.id, isCountry: true };
  }
  if (!doc) throw invalidAuthority("There is no bloc or treaty with that id: create it under Authorities first", field);
  if (doc.status === "retired") throw new RegistryError("AUTHORITY_RETIRED", 409, "That authority is retired, so nothing new can be added to it", { field });
  return { id: doc.id, kind: doc.kind, name: doc.name, isCountry: doc.kind === "country" };
}
