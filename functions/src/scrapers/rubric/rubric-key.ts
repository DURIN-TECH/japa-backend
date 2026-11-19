import type { RulebookKeyFields } from "../../types/rubric";
import { buildRulebookKey, splitRulebookKey } from "../../authorities/authority-ids";

// ============================================
// RULEBOOK KEYS — PURE (issue #233, P4a of #228)
// ============================================
//
// A rulebook is owned by an issuing authority (types/authority.ts) and keyed
// `{authorityId}_{routeSlug}`:
//
//   country authority  `{countryCode}_{visaTypeId}`     (every key that exists today)
//   bloc / treaty      `{issuingAuthorityId}_{sharedRouteId}`
//
// The two shapes can never collide: a country id is two UPPER-case letters, a
// bloc/treaty id is at least three lower-case characters, and neither contains
// an underscore (authorities/authority-ids.ts). So the key alone says which
// kind of rulebook it is.
//
// This module is the ONE place that turns "what the caller asked for" (either
// the historic `countryCode` + `visaTypeId`, or `authorityId` + `routeSlug`)
// into a checked target, and that reads the parts back off a stored document,
// whichever shape it was written in. Pure: no Firebase, no clock.
//
// Nothing here names a country, bloc or route: ids are data.

/** Which kind of authority owns a rulebook, read from the shape of its id. */
export type RulebookAuthorityShape = "country" | "group";

/**
 * A checked rulebook target: the key and its parts. For a country authority
 * `countryCode` / `visaTypeId` are set (equal to `authorityId` / `routeSlug`);
 * for a bloc or treaty they are absent.
 */
export interface RulebookTarget {
  routeKey: string;
  authorityId: string;
  routeSlug: string;
  shape: RulebookAuthorityShape;
  countryCode?: string;
  visaTypeId?: string;
}

/** What a caller may name a rulebook by: either pair (not a mix of both). */
export interface RulebookTargetInput {
  countryCode?: string;
  visaTypeId?: string;
  authorityId?: string;
  routeSlug?: string;
}

/** Thrown for a target that cannot be a rulebook key. The message is plain words, never data beyond the ids. */
export class RulebookKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulebookKeyError";
  }
}

/** A non-empty string. */
const given = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Build the checked target from a caller's input.
 *
 *  - `authorityId` + `routeSlug`: the general form (any authority).
 *  - `countryCode` + `visaTypeId`: the historic form; the country code must be
 *    a country authority id (two upper-case letters), exactly as
 *    `rubricRouteKey` has always required.
 *  - both pairs given: they must name the SAME key (a caller that passes both
 *    for a country is fine; a mismatch is refused, never resolved by guessing).
 *
 * @throws RulebookKeyError when nothing usable is given or the parts are invalid.
 */
export function rulebookTargetOf(input: RulebookTargetInput): RulebookTarget {
  const hasGeneral = given(input.authorityId) || given(input.routeSlug);
  const hasCountry = given(input.countryCode) || given(input.visaTypeId);
  if (!hasGeneral && !hasCountry) throw new RulebookKeyError("name the rulebook by authorityId and routeSlug (or countryCode and visaTypeId)");

  let authorityId: string;
  let routeSlug: string;
  if (hasGeneral) {
    if (!given(input.authorityId) || !given(input.routeSlug)) throw new RulebookKeyError("authorityId and routeSlug must both be given");
    authorityId = input.authorityId;
    routeSlug = input.routeSlug;
    if (hasCountry && (input.countryCode !== authorityId || input.visaTypeId !== routeSlug)) {
      throw new RulebookKeyError("countryCode / visaTypeId disagree with authorityId / routeSlug");
    }
  } else {
    if (!given(input.countryCode) || !given(input.visaTypeId)) throw new RulebookKeyError("countryCode and visaTypeId must both be given");
    authorityId = input.countryCode;
    routeSlug = input.visaTypeId;
  }

  let routeKey: string;
  try {
    routeKey = buildRulebookKey(authorityId, routeSlug);
  } catch {
    throw new RulebookKeyError(`not a valid rulebook key: ${JSON.stringify({ authorityId, routeSlug })}`);
  }
  const split = splitRulebookKey(routeKey);
  // buildRulebookKey already proved the split round-trips; this narrows the type.
  if (!split.ok) throw new RulebookKeyError(split.message);
  // The historic pair may only ever name a COUNTRY (it always meant one).
  if (!hasGeneral && split.authorityIdKind !== "country") {
    throw new RulebookKeyError(`Invalid country code (two upper-case letters expected): ${JSON.stringify(authorityId)}`);
  }
  return targetFromParts(routeKey, split.authorityId, split.routeSlug, split.authorityIdKind);
}

/** The target for a stored key (`{authorityId}_{routeSlug}`). @throws RulebookKeyError for a malformed key. */
export function rulebookTargetOfKey(routeKey: string): RulebookTarget {
  const split = splitRulebookKey(routeKey);
  if (!split.ok) throw new RulebookKeyError(split.message);
  return targetFromParts(routeKey, split.authorityId, split.routeSlug, split.authorityIdKind);
}

/** Assemble a target; the country fields exist only for a country authority. */
function targetFromParts(routeKey: string, authorityId: string, routeSlug: string, shape: RulebookAuthorityShape): RulebookTarget {
  return {
    routeKey,
    authorityId,
    routeSlug,
    shape,
    ...(shape === "country" ? { countryCode: authorityId, visaTypeId: routeSlug } : {}),
  };
}

/**
 * The key fields to WRITE on a new document (head, version, run record): the
 * key, the two general parts, and the historic pair for a country only.
 * Spread into the document so the field set is the same everywhere.
 */
export function keyFieldsOf(target: RulebookTarget): Required<Pick<RulebookKeyFields, "routeKey" | "authorityId" | "routeSlug">> & Pick<RulebookKeyFields, "countryCode" | "visaTypeId"> {
  return {
    routeKey: target.routeKey,
    authorityId: target.authorityId,
    routeSlug: target.routeSlug,
    ...(target.shape === "country" ? { countryCode: target.authorityId, visaTypeId: target.routeSlug } : {}),
  };
}

/**
 * The parts of a STORED document's key, whichever shape it was written in:
 *
 *  1. `authorityId` + `routeSlug` (written since #233), else
 *  2. `countryCode` + `visaTypeId` (every document written before #233: the
 *     approved rulebook stored in dev reads through this branch), else
 *  3. the `routeKey` itself, split at its first underscore.
 *
 * Returns null when none of these gives a valid key (a damaged document); the
 * caller decides what that means (the validator reports it).
 */
export function rulebookPartsOf(doc: Partial<RulebookKeyFields> | null | undefined): RulebookTarget | null {
  if (!doc) return null;
  try {
    if (given(doc.authorityId) && given(doc.routeSlug)) return rulebookTargetOf({ authorityId: doc.authorityId, routeSlug: doc.routeSlug });
    if (given(doc.countryCode) && given(doc.visaTypeId)) return rulebookTargetOf({ countryCode: doc.countryCode, visaTypeId: doc.visaTypeId });
    if (given(doc.routeKey)) return rulebookTargetOfKey(doc.routeKey);
  } catch {
    return null;
  }
  return null;
}

/**
 * A stored document with its key parts FILLED IN (the read-side half of "no
 * data move"): a document written before #233 gains `authorityId` +
 * `routeSlug` equal to its `countryCode` + `visaTypeId`; anything else is
 * returned as it is. Never overwrites a field the document has, never adds a
 * country field to a bloc/treaty document. Returns a new object only when it
 * adds something.
 */
export function withKeyParts<T extends Partial<RulebookKeyFields>>(doc: T): T {
  if (given(doc.authorityId) && given(doc.routeSlug)) return doc;
  const parts = rulebookPartsOf(doc);
  if (!parts) return doc;
  return { ...doc, authorityId: parts.authorityId, routeSlug: parts.routeSlug };
}

/**
 * The NAMING pair of a target, in the form callers have always used for its
 * kind: `countryCode` + `visaTypeId` for a country (exactly what every caller
 * passed before #233, so country records, job inputs and events are unchanged),
 * `authorityId` + `routeSlug` for a bloc or treaty. Feed it to
 * `rulebookTargetOf` (or anything that takes RulebookTargetInput) to get the
 * same target back.
 */
export function targetInputOf(target: RulebookTarget): { countryCode: string; visaTypeId: string } | { authorityId: string; routeSlug: string } {
  return target.shape === "country" ? { countryCode: target.authorityId, visaTypeId: target.routeSlug } : { authorityId: target.authorityId, routeSlug: target.routeSlug };
}

/** True when the key is a COUNTRY authority's rulebook (the shape every rulebook had before #233). */
export function isCountryRulebookKey(routeKey: string): boolean {
  const split = splitRulebookKey(routeKey);
  return split.ok && split.authorityIdKind === "country";
}
