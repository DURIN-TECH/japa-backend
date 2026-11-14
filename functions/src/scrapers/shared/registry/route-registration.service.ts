import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../../utils/firebase";
import { visaService } from "../../../services/visa.service";
import { GUIDANCE_DOC_TYPES, GUIDANCE_SOURCE_ROLES, type GuidanceDocType, type GuidanceSourceRole } from "../../guidance/types";
import { GUIDANCE_MAX_HTML_TEXT_CHARS } from "../../guidance/guidance-crawl.service";
import { GUIDANCE_SOURCE_ID_RE } from "../../guidance/guidance-snapshot.store";
import { buildSeededGuidanceSource, validateGuidanceSourceSeed } from "../../guidance/data/seed-guidance-sources";
import type { CrawlWindow, VisaSourcePage } from "../../visa-catalog/types";
import { deriveVisaId, slugify } from "../../visa-catalog/visa-catalog-ids";
import { assertValidCrawlWindow, nextWindowOpening } from "../etiquette/visa-crawl-window";
import { officialDomainsService } from "./official-domains.service";
import { appendRegistryAudit, stripUndefined } from "./registry-audit";
import { REGISTRY_ID_MAX, VISA_ID_RE, lookupRegionName, parseRegistryUrl } from "./registry-address";
import { parseAuthorityRef, resolveRegistryAuthority, type RegistryAuthority } from "./registry-authority";
import { RegistryError } from "./registry-errors";
import { registryRateLimiter } from "./registry-rate-limit";
import { loadRegistrySettings } from "./registry-settings";
import { sourcePreviewService, type AddressPreview } from "./source-preview.service";

// ============================================
// ROUTE REGISTRATION (issue #215)
// ============================================
//
// `POST /admin/route-sources`: register ONE route in one request: the country
// (if it is new), the visa page in `visaSources/{cc}`, and the rule/guidance
// pages in `guidanceSources/*`. Nothing is crawled or drafted here, and
// NOTHING BECOMES VISIBLE TO APPLICANTS:
//   - a new country is created with `isSupported: false`;
//   - no `countries/{cc}/visaTypes` record is created or activated (the visa
//     crawl does that later, as a pending, inactive record).
//
// Safeguards, in order (a failure at any step stops everything, nothing is
// stored, and nothing is fetched before the host check):
//   1. SHAPE of every address (registry-address.ts): https only, no credentials,
//      port, fragment or IP literal.
//   2. ENUMS / IDS / LANGUAGE: roles and doc types from the existing enums,
//      language from `appConfig/routeOnboardingSettings.supportedLanguages`,
//      ids derived by the server (a guidance id comes from its TITLE, never
//      from the URL), at least one `primary` source.
//   3. CONFIRMED HOSTS: every host must be on the allow-list
//      (`officialDomains`, status confirmed) BEFORE any request is made.
//   4. RATE LIMIT per admin per hour.
//   5. CONFLICTS against what is stored (ids, urls, an existing visa record).
//   6. PREVIEW of every page just before saving, through the guarded fetch
//      service WITH the host policy (a redirect to a host that is not
//      confirmed is refused).
//   7. ONE TRANSACTION writes everything plus one audit entry per object.
//
// Repeating the same body changes nothing (200, created: false) and makes no
// request: the stored objects already match.
//
// ISSUE #232 (P3 of #228): a route is registered under an ISSUING AUTHORITY
// (`authorityId`: a country code, or the id of a bloc or treaty that exists
// in `authorities`). Everything is keyed by that id: `visaSources/{authorityId}`,
// guidance `jurisdiction`, the visa id prefix `{authorityId}-` and so the
// rulebook key `{authorityId}_{visaId}` (authority-ids.ts buildRulebookKey).
// For a country nothing changes (same values as before). For a bloc or treaty:
//   - NO country is created and nothing under `countries/` is read or written;
//   - the visa source is stored WITHOUT `nextCrawlAt`, so the scheduled visa
//     crawl never picks it (that crawl files visa records under a country;
//     a shared route's record is P2's job), and the crawl also skips any
//     non-country source by hand;
//   - so, as for a country, nothing becomes visible to applicants.
// The confirmed-host check (step 3) and the preview policy (step 6) use the
// hosts confirmed for THIS authority only: a host confirmed for a different
// authority is refused, before any request and on any redirect.

// ---------- Body ----------

/** One rule/guidance page of a request. */
export interface RegisterGuidanceInput {
  url: string;
  title: string;
  role: GuidanceSourceRole;
  docType: GuidanceDocType;
  language: string;
  checkIntervalHours?: number;
}

/** The validated request body. */
export interface RegisterRouteInput {
  /** The authority id, normalised (country codes upper-case). Existence is checked later (a read). */
  authorityId: string;
  /** True when `authorityId` is a country code (its shape says so; no read needed). */
  authorityIsCountry: boolean;
  routeName: string;
  visaId?: string;
  visaPage: { url: string; language: string };
  guidance: RegisterGuidanceInput[];
  crawlTimeZone: string;
}

/** What a registration reports. */
export interface RegisterRouteResult {
  created: boolean;
  /** The authority the route was registered under. */
  authorityId: string;
  /** Its display name (a country's stored or English name; a bloc's or treaty's own name). */
  authorityName: string;
  /** country, bloc or treaty. */
  authorityKind: RegistryAuthority["kind"];
  /** True only when a NEW (hidden) country record was created; always false for a bloc or treaty. */
  countryCreated: boolean;
  visaId: string;
  visaPageUrl: string;
  guidanceSourceIds: string[];
  crawlWindow: CrawlWindow | null;
  warnings: string[];
}

/** Keys allowed at each level (unknown keys are rejected). */
const BODY_KEYS = ["authorityId", "routeName", "visaId", "visaPage", "guidance", "crawlTimeZone"] as const;
const VISA_PAGE_KEYS = ["url", "language"] as const;
const GUIDANCE_KEYS = ["url", "title", "role", "docType", "language", "checkIntervalHours"] as const;

/** Bounds. */
const ROUTE_NAME_MIN = 2;
const ROUTE_NAME_MAX = 120;
const TITLE_MIN = 3;
const TITLE_MAX = 200;
const CHECK_INTERVAL_RANGE: [number, number] = [1, 24 * 365];
/** Weekly check unless the admin says otherwise (the visa page uses the same). */
export const DEFAULT_CHECK_INTERVAL_HOURS = 168;
/** The night window every portal-added source is crawled in (local hours, like the seeded ones). */
const WINDOW_START_HOUR = 2;
const WINDOW_END_HOUR = 5;

const bad = (code: string, message: string, status = 400, extra: Record<string, unknown> = {}) => new RegistryError(code, status, message, extra);

/** An object with only the allowed keys, or a 400. */
function strictObject(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("VALIDATION_ERROR", `${where} must be an object`);
  for (const k of Object.keys(value)) {
    if (!keys.includes(k)) throw bad("VALIDATION_ERROR", `${where}: "${k}" is not a known field`, 400, { field: where === "body" ? k : `${where}.${k}` });
  }
  return value as Record<string, unknown>;
}

/** A trimmed string within bounds, or a 400 naming the field. */
function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw bad("VALIDATION_ERROR", `${field} must be text`, 400, { field });
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad("VALIDATION_ERROR", `${field} must be ${min} to ${max} characters`, 400, { field });
  return t;
}

/**
 * The weekday (ISO 1 Mon .. 7 Sun) with the fewest sources already windowed on
 * it; ties go to the earliest weekday so the answer is deterministic. Pure.
 * `counts[i]` is the number of sources whose window opens on weekday i+1.
 */
export function leastLoadedWeekday(counts: readonly number[]): number {
  let best = 1;
  for (let d = 2; d <= 7; d++) if ((counts[d - 1] ?? 0) < (counts[best - 1] ?? 0)) best = d;
  return best;
}

/** Shape-validate the body (pure apart from reading Intl). Throws RegistryError 400. */
export function parseRegisterRouteBody(raw: unknown): RegisterRouteInput {
  const body = strictObject(raw, BODY_KEYS, "body");
  // Shape only here (pure); whether a bloc/treaty exists is read in register().
  const authority = parseAuthorityRef(body.authorityId);
  // Every id of the route starts with the authority id in lower case ("ab-", "my-bloc-").
  const prefix = `${authority.id.toLowerCase()}-`;
  const routeName = text(body.routeName, "routeName", ROUTE_NAME_MIN, ROUTE_NAME_MAX);

  let visaId: string | undefined;
  if (body.visaId !== undefined) {
    visaId = text(body.visaId, "visaId", 1, REGISTRY_ID_MAX);
    if (!VISA_ID_RE.test(visaId) || !visaId.startsWith(prefix) || visaId.length === prefix.length) {
      throw bad("INVALID_VISA_ID", `visaId must be lowercase letters, digits and hyphens, starting with "${prefix}"`, 400, { field: "visaId" });
    }
  }

  const vp = strictObject(body.visaPage, VISA_PAGE_KEYS, "visaPage");
  const visaUrl = parseRegistryUrl(vp.url);
  if (!visaUrl.ok) throw bad(visaUrl.code, visaUrl.message, 400, { field: "visaPage.url" });
  const visaLanguage = text(vp.language, "visaPage.language", 2, 12).toLowerCase();

  if (!Array.isArray(body.guidance) || body.guidance.length === 0) {
    throw bad("PRIMARY_REQUIRED", "Give at least one rule or guidance page, and mark the route's own rules as primary", 422, { field: "guidance" });
  }
  const guidance = body.guidance.map((g, i): RegisterGuidanceInput => {
    const where = `guidance[${i}]`;
    const o = strictObject(g, GUIDANCE_KEYS, where);
    const u = parseRegistryUrl(o.url);
    if (!u.ok) throw bad(u.code, u.message, 400, { field: `${where}.url` });
    const role = o.role as GuidanceSourceRole;
    if (!GUIDANCE_SOURCE_ROLES.includes(role)) throw bad("VALIDATION_ERROR", `${where}.role must be one of: ${GUIDANCE_SOURCE_ROLES.join(", ")}`, 400, { field: `${where}.role` });
    const docType = o.docType as GuidanceDocType;
    if (!GUIDANCE_DOC_TYPES.includes(docType)) throw bad("VALIDATION_ERROR", `${where}.docType must be one of: ${GUIDANCE_DOC_TYPES.join(", ")}`, 400, { field: `${where}.docType` });
    let checkIntervalHours: number | undefined;
    if (o.checkIntervalHours !== undefined) {
      const n = o.checkIntervalHours;
      if (typeof n !== "number" || !Number.isInteger(n) || n < CHECK_INTERVAL_RANGE[0] || n > CHECK_INTERVAL_RANGE[1]) {
        throw bad("VALIDATION_ERROR", `${where}.checkIntervalHours must be a whole number ${CHECK_INTERVAL_RANGE[0]}..${CHECK_INTERVAL_RANGE[1]}`, 400, { field: `${where}.checkIntervalHours` });
      }
      checkIntervalHours = n;
    }
    return {
      url: u.url.href,
      title: text(o.title, `${where}.title`, TITLE_MIN, TITLE_MAX),
      role,
      docType,
      language: text(o.language, `${where}.language`, 2, 12).toLowerCase(),
      ...(checkIntervalHours !== undefined ? { checkIntervalHours } : {}),
    };
  });

  const crawlTimeZone = text(body.crawlTimeZone, "crawlTimeZone", 1, 64);
  // Valid zone? Reuse the seed's own window validator on a probe window.
  try {
    assertValidCrawlWindow({ timeZone: crawlTimeZone, dayOfWeek: 1, startHour: WINDOW_START_HOUR, endHour: WINDOW_END_HOUR });
  } catch {
    throw bad("INVALID_TIME_ZONE", "crawlTimeZone must be a time zone name such as Area/City", 400, { field: "crawlTimeZone" });
  }

  return {
    authorityId: authority.id,
    authorityIsCountry: authority.isCountry,
    routeName,
    ...(visaId ? { visaId } : {}),
    visaPage: { url: visaUrl.url.href, language: visaLanguage },
    guidance,
    crawlTimeZone,
  };
}

/** Hosts of every address in the request (lowercase, unique, in order). */
export function hostsOf(input: RegisterRouteInput): string[] {
  const urls = [input.visaPage.url, ...input.guidance.map((g) => g.url)];
  return [...new Set(urls.map((u) => new URL(u).hostname.toLowerCase()))];
}

/** Plain-words note stored with a registered guidance source. */
function verificationNote(preview: AddressPreview, nowMs: number): string {
  return (
    "Registered from the admin portal. The whole document was retrieved in full by the registration check " +
    `(${preview.characterCount} characters, ${preview.docType}); no person has read it. ` +
    `Retrieved ${new Date(nowMs).toISOString()}.`
  );
}

class RouteRegistrationService {
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);
  clock: () => number = Date.now;

  /** Register a route. `raw` is the unvalidated body; `actorUid` the admin. */
  async register(raw: unknown, actorUid: string): Promise<RegisterRouteResult> {
    // 1+2. Shape, enums, ids.
    const input = parseRegisterRouteBody(raw);
    // `aid` keys every object of the route: visaSources/{aid}, jurisdiction, id prefixes.
    const aid = input.authorityId;
    const aidLower = aid.toLowerCase();
    const visaId = input.visaId ?? `${aidLower}-${slugify(input.routeName)}`;
    if (!VISA_ID_RE.test(visaId) || visaId === `${aidLower}-` || visaId.length > REGISTRY_ID_MAX) {
      throw bad("INVALID_VISA_ID", "A visa id could not be made from the route name: give one in visaId", 400, { field: "visaId" });
    }
    const routeKey = visaId.slice(aidLower.length + 1); // the id without its authority prefix

    // Guidance ids come from the TITLE, never from the address.
    const guidanceIds = input.guidance.map((g, i) => {
      const id = `${aidLower}-${slugify(g.title)}`;
      if (!GUIDANCE_SOURCE_ID_RE.test(id) || id === `${aidLower}-` || id.length > REGISTRY_ID_MAX) {
        throw bad("VALIDATION_ERROR", `guidance[${i}].title cannot be turned into an id: use letters or digits`, 400, { field: `guidance[${i}].title` });
      }
      return id;
    });
    if (new Set(guidanceIds).size !== guidanceIds.length) throw bad("DUPLICATE_GUIDANCE_ID", "Two guidance pages have titles that make the same id: make the titles different", 400);
    if (new Set(input.guidance.map((g) => g.url)).size !== input.guidance.length) throw bad("DUPLICATE_URL", "The same address is listed twice", 400);
    if (!input.guidance.some((g) => g.role === "primary")) {
      throw bad("PRIMARY_REQUIRED", "At least one page must be marked primary: the route's own rules", 422, { field: "guidance" });
    }

    const loaded = await loadRegistrySettings();
    if (loaded.readError) throw bad("SETTINGS_UNAVAILABLE", "Settings could not be read; try again shortly", 503);
    const settings = loaded.settings;
    if (input.guidance.length > settings.maxGuidancePerRoute) {
      throw bad("TOO_MANY_PAGES", `A route may carry at most ${settings.maxGuidancePerRoute} rule or guidance pages`, 400, { field: "guidance" });
    }
    // Language: every page must be in a supported language.
    for (const [field, lang] of [["visaPage.language", input.visaPage.language], ...input.guidance.map((g, i) => [`guidance[${i}].language`, g.language] as const)] as const) {
      if (!settings.supportedLanguages.includes(lang)) {
        throw bad("LANGUAGE_NOT_SUPPORTED", `The language "${lang}" is not supported yet. Supported: ${settings.supportedLanguages.join(", ")}`, 422, { field, supportedLanguages: settings.supportedLanguages });
      }
    }

    // 2b. The authority must exist (a bloc or treaty in `authorities`) and
    //     not be retired. Read again inside the write transaction below.
    const authority = await resolveRegistryAuthority(aid);

    // 3. Confirmed hosts OF THIS AUTHORITY, BEFORE anything is requested.
    //    A host confirmed for a different authority counts as unconfirmed.
    const confirmed = await officialDomainsService.confirmedHostsFor(authority.id);
    const unconfirmed = hostsOf(input).filter((h) => !confirmed.has(h));
    if (unconfirmed.length > 0) {
      throw bad(
        "HOST_NOT_CONFIRMED",
        `These websites are not confirmed as official websites of this authority yet: ${unconfirmed.join(", ")}. Confirm each one for this authority first`,
        422,
        { hosts: unconfirmed }
      );
    }

    // 4. Rate limit.
    const limit = await registryRateLimiter.consume(actorUid, "registration", settings.registrationsPerHour);
    if (!limit.allowed) {
      throw bad("RATE_LIMITED", `You have registered ${settings.registrationsPerHour} routes this hour; try again later`, 429, { retryAfterSeconds: limit.retryAfterSeconds });
    }

    // 5. Conflicts and idempotency, from what is stored.
    const state = await this.readState(authority, visaId, guidanceIds, input);
    if (state.alreadyRegistered) {
      return {
        created: false,
        authorityId: aid,
        authorityName: state.countryName || authority.name,
        authorityKind: authority.kind,
        countryCreated: false,
        visaId,
        visaPageUrl: input.visaPage.url,
        guidanceSourceIds: guidanceIds,
        crawlWindow: state.crawlWindow,
        warnings: [],
      };
    }

    // 6. Preview every page just before saving, with the host policy: every
    //    hop must be a host confirmed for this authority.
    const allowedHost = (h: string) => confirmed.has(h.toLowerCase());
    const warnings: string[] = [];
    const withUrl = async (url: string, run: () => Promise<AddressPreview>): Promise<AddressPreview> => {
      try {
        return await run();
      } catch (err) {
        if (err instanceof RegistryError) throw new RegistryError(err.code, err.status, `${url}: ${err.message}`, { ...err.extra, url });
        throw err;
      }
    };
    const visaPreview = await withUrl(input.visaPage.url, () => sourcePreviewService.preview(input.visaPage.url, { purpose: "visa_page", allowedHost }));
    this.noteLanguage(warnings, input.visaPage.url, input.visaPage.language, visaPreview);
    const previews: AddressPreview[] = [];
    for (const g of input.guidance) {
      const p = await withUrl(g.url, () =>
        sourcePreviewService.preview(g.url, {
          purpose: g.docType === "pdf" ? "guidance_pdf" : "guidance_html",
          allowedHost,
          ...(g.docType === "html" ? { maxHtmlTextChars: GUIDANCE_MAX_HTML_TEXT_CHARS } : {}),
        })
      );
      this.noteLanguage(warnings, g.url, g.language, p);
      previews.push(p);
    }

    // 7. One transaction: writes + audit.
    const now = this.clock();
    const at = Timestamp.fromMillis(now);
    const retrievedAtIso = new Date(now).toISOString();
    return this.runTransaction(async (tx) => {
      // The authority again, inside the transaction (it may have been retired since step 2b).
      const current = await resolveRegistryAuthority(aid, (ref) => tx.get(ref));
      const isCountry = current.isCountry;
      const countryRef = isCountry ? collections.countries.doc(aid) : undefined;
      const sourceRef = collections.visaSources.doc(aid);
      const guidanceRefs = guidanceIds.map((id) => collections.guidanceSources.doc(id));
      const [countrySnap, sourceSnap, ...guidanceSnaps] = await Promise.all([
        countryRef ? tx.get(countryRef) : Promise.resolve(undefined),
        tx.get(sourceRef),
        ...guidanceRefs.map((r) => tx.get(r)),
      ]);
      // Re-check inside the transaction: a concurrent registration may have won.
      if (guidanceSnaps.some((s) => s.exists)) throw bad("GUIDANCE_ID_TAKEN", "A guidance source with one of these titles was registered a moment ago", 409);
      const existingSource = sourceSnap.exists ? (sourceSnap.data() as Record<string, unknown>) : undefined;
      const existingPages = (existingSource?.pages as VisaSourcePage[] | undefined) ?? [];
      if (existingPages.some((p) => p.url === input.visaPage.url)) throw bad("PAGE_ALREADY_REGISTERED", "That visa page was registered a moment ago", 409);

      // Country (a country authority only): created hidden, only when absent.
      // A bloc or treaty creates no country and touches nothing under `countries/`.
      let countryCreated = false;
      let authorityName = current.name;
      if (isCountry && countryRef && countrySnap) {
        const regionName = lookupRegionName(aid)?.name ?? current.name;
        if (!countrySnap.exists) {
          const country = visaService.buildNewCountry({ code: aid, name: regionName, isSupported: false }, at);
          tx.create(countryRef, country as unknown as Record<string, unknown>);
          countryCreated = true;
          authorityName = regionName;
          appendRegistryAudit(tx, { action: "country_created", actorUid, at, targetType: "country", targetId: aid, before: null, after: country as unknown as Record<string, unknown> });
        } else {
          authorityName = String((countrySnap.data() as { name?: string }).name ?? regionName);
        }
      }

      // Visa page: appended to the authority's registry doc (created when absent).
      const page: VisaSourcePage = stripUndefined({
        url: input.visaPage.url,
        routeName: input.routeName,
        validation: "unverified" as const,
        visaId,
        addedVia: "portal" as const,
        addedBy: actorUid,
        addedAt: at,
        language: input.visaPage.language,
      });
      const hosts = hostsOf(input);
      let crawlWindow: CrawlWindow | null = null;
      if (existingSource) {
        const union = [...new Set([...((existingSource.officialHosts as string[] | undefined) ?? []), ...hosts])];
        tx.update(sourceRef, { pages: [...existingPages, page], officialHosts: union, updatedAt: at });
        crawlWindow = (existingSource.crawlWindow as CrawlWindow | undefined) ?? null;
        appendRegistryAudit(tx, {
          action: "visa_page_added", actorUid, at, targetType: "visaSource", targetId: `${aid}#${page.url}`,
          before: { pageCount: existingPages.length, officialHosts: existingSource.officialHosts ?? null },
          after: { page, officialHosts: union },
        });
      } else {
        crawlWindow = { timeZone: input.crawlTimeZone, dayOfWeek: state.weekday, startHour: WINDOW_START_HOUR, endHour: WINDOW_END_HOUR };
        assertValidCrawlWindow(crawlWindow);
        const doc = stripUndefined({
          id: aid,
          // The issuing authority (issue #232). `countryCode` is kept for a
          // country only: the visa crawl and its readers file records under
          // `countries/{countryCode}`, which a bloc or treaty does not have.
          authorityId: aid,
          countryCode: isCountry ? aid : undefined,
          // Display name of the source (readers show it as the source's name).
          countryName: authorityName,
          isOfficial: true, // every page is on a host an admin confirmed
          pages: [page],
          adapter: "generic-html" as const,
          crawlWindow,
          officialHosts: hosts,
          crawlIntervalHours: DEFAULT_CHECK_INTERVAL_HOURS,
          // A bloc's or treaty's page is NOT scheduled for the visa crawl (see
          // the file header): without `nextCrawlAt` the due query never picks it.
          nextCrawlAt: isCountry ? Timestamp.fromDate(nextWindowOpening(crawlWindow, now)) : undefined,
          status: "active" as const,
          reliabilityScore: 100,
          consecutiveFailures: 0,
          createdAt: at,
          updatedAt: at,
          addedVia: "portal" as const,
          addedBy: actorUid,
          addedAt: at,
        });
        tx.create(sourceRef, doc as unknown as Record<string, unknown>);
        appendRegistryAudit(tx, { action: "visa_page_added", actorUid, at, targetType: "visaSource", targetId: `${aid}#${page.url}`, before: null, after: doc as unknown as Record<string, unknown> });
      }

      // Guidance sources: one doc and one audit entry each.
      input.guidance.forEach((g, i) => {
        const seed = {
          id: guidanceIds[i],
          title: g.title,
          url: g.url,
          // The issuing authority's id (issue #232): same value as before for a country.
          jurisdiction: aid,
          route: routeKey,
          docType: g.docType,
          role: g.role,
          checkIntervalHours: g.checkIntervalHours ?? DEFAULT_CHECK_INTERVAL_HOURS,
          verificationStatus: "registered" as const,
          verificationNote: verificationNote(previews[i], now),
          retrievedAt: retrievedAtIso,
        };
        const problems = validateGuidanceSourceSeed(seed);
        if (problems.length > 0) throw bad("VALIDATION_ERROR", `guidance[${i}]: ${problems.join("; ")}`, 422);
        const doc = {
          ...buildSeededGuidanceSource(seed, undefined, at),
          addedVia: "portal",
          addedBy: actorUid,
          addedAt: at,
          language: g.language,
        };
        tx.create(guidanceRefs[i], doc);
        appendRegistryAudit(tx, { action: "source_added", actorUid, at, targetType: "guidanceSource", targetId: guidanceIds[i], before: null, after: doc });
      });

      appendRegistryAudit(tx, {
        action: "route_registered", actorUid, at, targetType: "route", targetId: `${aid}/${visaId}`, before: null,
        after: { authorityId: aid, authorityKind: current.kind, visaId, visaPageUrl: input.visaPage.url, guidanceSourceIds: guidanceIds, countryCreated },
      });

      return { created: true, authorityId: aid, authorityName, authorityKind: current.kind, countryCreated, visaId, visaPageUrl: input.visaPage.url, guidanceSourceIds: guidanceIds, crawlWindow, warnings };
    });
  }

  /** A note when the page's own `<html lang>` disagrees with the declared language (advisory). */
  private noteLanguage(warnings: string[], url: string, declared: string, preview: AddressPreview): void {
    if (!preview.language) return;
    const primary = (s: string) => s.toLowerCase().split("-")[0];
    if (primary(preview.language) !== primary(declared)) {
      warnings.push(`${url}: the page says its language is "${preview.language}" but "${declared}" was declared`);
    }
  }

  /**
   * Read what is stored and decide: conflict (409), already registered (the
   * idempotent repeat), or new. Also returns the weekday a NEW source's window
   * should use (the least loaded) and the existing source's window.
   */
  private async readState(
    authority: RegistryAuthority,
    visaId: string,
    guidanceIds: string[],
    input: RegisterRouteInput
  ): Promise<{ alreadyRegistered: boolean; countryName?: string; crawlWindow: CrawlWindow | null; weekday: number }> {
    const aid = authority.id;
    // Country records exist only for a country authority; a bloc or treaty reads nothing under `countries/`.
    const [sourceSnap, countrySnap, visaDocSnap, allSources, ...guidanceSnaps] = await Promise.all([
      collections.visaSources.doc(aid).get(),
      authority.isCountry ? collections.countries.doc(aid).get() : Promise.resolve(undefined),
      authority.isCountry ? subcollections.visaTypes(aid).doc(visaId).get() : Promise.resolve(undefined),
      collections.visaSources.get(),
      ...guidanceIds.map((id) => collections.guidanceSources.doc(id).get()),
    ]);

    // Weekday load across every registry source.
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const d of allSources.docs) {
      const w = (d.data() as { crawlWindow?: CrawlWindow }).crawlWindow?.dayOfWeek;
      if (typeof w === "number" && w >= 1 && w <= 7) counts[w - 1]++;
    }
    const weekday = leastLoadedWeekday(counts);

    // ---- Visa page ----
    const source = sourceSnap.exists ? (sourceSnap.data() as { pages?: VisaSourcePage[]; crawlWindow?: CrawlWindow }) : undefined;
    const pages = source?.pages ?? [];
    const samePage = pages.find((p) => p.url === input.visaPage.url);
    let visaIdentical = false;
    if (samePage) {
      if (samePage.addedVia === "portal" && samePage.visaId === visaId) visaIdentical = true;
      else throw bad("PAGE_ALREADY_REGISTERED", "That visa page is already in the registry under a different record id", 409);
    }
    // visaId used by a DIFFERENT page of the same source (pinned, or derived from its address).
    for (const p of pages) {
      if (p.url === input.visaPage.url || p.supplementOnly) continue;
      let theirs: string | undefined;
      try {
        // Derived ids exist only for country sources (seeded pages); a bloc's pages are portal-added and pinned.
        theirs = authority.isCountry ? deriveVisaId({ countryCode: aid, sourceUrl: p.url, visaId: p.visaId }) : p.visaId;
      } catch {
        theirs = p.visaId;
      }
      if (theirs === visaId) throw bad("VISA_ID_TAKEN", `The visa id ${visaId} already belongs to another page of this authority`, 409);
    }
    // An existing visa record (country authorities only) must have come from THIS page.
    if (visaDocSnap?.exists) {
      const meta = (visaDocSnap.data() as { scrapeMeta?: { sourceUrl?: string } }).scrapeMeta;
      if (meta?.sourceUrl !== input.visaPage.url) throw bad("VISA_ID_TAKEN", `A visa record ${visaId} already exists from another source`, 409);
    }

    // ---- Guidance ----
    let guidanceIdentical = true;
    for (let i = 0; i < guidanceIds.length; i++) {
      const snap = guidanceSnaps[i];
      const g = input.guidance[i];
      if (!snap.exists) {
        guidanceIdentical = false;
        continue;
      }
      const d = snap.data() as Record<string, unknown>;
      const same = d.addedVia === "portal" && d.url === g.url && d.jurisdiction === aid && d.role === g.role && d.docType === g.docType;
      if (!same) throw bad("GUIDANCE_ID_TAKEN", `The id ${guidanceIds[i]} (made from the title) is already used by a different source: change the title`, 409);
    }
    // The same address registered under another id is a mistake, not a repeat.
    const otherUrls = await Promise.all(
      input.guidance.map((g, i) => collections.guidanceSources.where("url", "==", g.url).get().then((s) => s.docs.find((d) => d.id !== guidanceIds[i])))
    );
    otherUrls.forEach((dup, i) => {
      if (dup) throw bad("DUPLICATE_URL", `${input.guidance[i].url} is already registered as ${dup.id}`, 409);
    });

    return {
      alreadyRegistered: visaIdentical && guidanceIdentical,
      countryName: countrySnap?.exists ? String((countrySnap.data() as { name?: string }).name ?? "") : undefined,
      crawlWindow: source?.crawlWindow ?? null,
      weekday,
    };
  }
}

export const routeRegistrationService = new RouteRegistrationService();

/** Country lookup for the admin form (pure reads). */
export async function countryLookup(rawCode: unknown): Promise<{ code: string; name: string; countryExists: boolean; visaSourceExists: boolean }> {
  const region = lookupRegionName(rawCode);
  if (!region) throw bad("INVALID_COUNTRY_CODE", "That is not a known two-letter country code", 400, { field: "code" });
  const [c, v] = await Promise.all([collections.countries.doc(region.code).get(), collections.visaSources.doc(region.code).get()]);
  return { code: region.code, name: region.name, countryExists: c.exists, visaSourceExists: v.exists };
}
