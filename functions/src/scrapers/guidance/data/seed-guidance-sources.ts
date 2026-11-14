import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { publishedDateSelectorProblem } from "../guidance-published-date";
import { linkPatternHost, resolveFromProblems } from "../guidance-resolve";
import { GUIDANCE_SOURCE_ID_RE } from "../guidance-snapshot.store";
import {
  GUIDANCE_DOC_TYPES,
  GUIDANCE_SOURCE_ROLES,
  GUIDANCE_VERIFICATION_STATUSES,
  type GuidanceSourceSeed,
} from "../types";

// ============================================
// GUIDANCE SOURCE REGISTRY — SEED (issue #39)
// ============================================
//
// Data plus a loader, the same shape as news/seed-news-sources.ts: a static
// list of entries, a pure builder that turns one entry into the doc to
// write, and `seedGuidanceSources()` which writes them under deterministic
// ids with `{ merge: true }` so re-running is idempotent. No fetching happens
// here: seeding only writes the registry; the crawl fetches.
//
// NOTE: the Firestore handle is resolved LAZILY inside seedGuidanceSources()
// (not at module load), like the other seeders: this module is reachable from
// scrapers/index.ts, which is loaded on every cold start.
//
// ---- Verification honesty ----
//
// Every entry must say how far a human got when retrieving the document by
// hand: `verificationStatus` plus a free-text `verificationNote` recording
// what was actually retrieved and when. The validator below refuses an entry
// that claims more than it records:
//  - `verified` needs a `retrievedAt` and must NOT carry a `retrievalError`;
//  - `partial` needs a `retrievedAt` (something was retrieved);
//  - `unverified` needs the `retrievalError` of the failed attempt.
// So a source that could not be fully retrieved cannot be seeded as verified
// by leaving the failure out: recording the failure forces the lower status.
// The crawl skips `unverified` sources (guidance-crawl.service.ts).

/**
 * How often the entries below are re-checked: weekly. The documents change a
 * few times a year, and the crawl is a hash gate, so a weekly look is enough
 * to notice a re-issue without asking the publisher's servers more than that.
 */
const WEEKLY_HOURS = 24 * 7;

/**
 * The registry entries to seed.
 *
 * Add an entry here as DATA only; no code in this module (or anywhere in
 * guidance/) may depend on what an entry's jurisdiction, route or publisher
 * is. Adding another route's sources means adding rows to this list (and,
 * for passages worth pinning, rows to guidance-quote-checks.ts).
 *
 * ---- The first entries (issue #111) ----
 *
 * Five documents, all sharing one `jurisdiction` + `route` key pair, which is
 * the pair the rubric built from them will be keyed by. Two of them (the
 * suitability rules and the finance appendix) are general documents that the
 * route's own rules refer to; they are registered under the same route key
 * because that is the route they are read for here.
 *
 * Every `verificationNote` below records what was ACTUALLY retrieved, by
 * whom and when: each document was requested once on 2026-11-11 through the
 * shared fetch service (bot user agent, robots.txt checked, per-host delay),
 * the same code path the crawl uses, and the numbers in the note are that
 * request's. The addresses were taken from the publisher's live pages on
 * that day, not from the issue text. Nothing here is copied from a summary.
 *
 * Publisher's date: only the two renditions of the caseworker guidance carry
 * their own "published for staff on" line in the text that is stored, so
 * only they have a `publishedDateSelector`. The three rules pages show their
 * "updated" date in page furniture OUTSIDE the main content the fetch
 * service keeps, so their snapshots report no date and `publishedDate`
 * stays null for them (recorded per entry; not guessed, not copied).
 */
export const GUIDANCE_SOURCE_SEEDS: GuidanceSourceSeed[] = [
  {
    id: "gb-appendix-v-visitor",
    // The route's own rules document.
    role: "primary",
    title: "Immigration Rules Appendix V: Visitor",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-v-visitor",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "31,960 characters of cleaned text, sha256 fc9142666910e764a61bcf377bc52e84653dbfc231d5b8b3ed9095da94fbd6aa. " +
      "The text runs from the page title to the last rule of the last section (it is not cut short). " +
      "Read closely: V 3.1, V 4.2 and V 4.3; the rest was retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-11T10:48:37Z",
  },
  {
    id: "gb-visit-guidance-html",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Visit caseworker guidance (accessible web version)",
    url: "https://www.gov.uk/government/publications/visit-guidance/visit-caseworker-guidance-accessible--2",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    // The document's own line, e.g. "published for Home Office staff on <date>".
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "147,856 characters of cleaned text, sha256 4427af933123fdb6273c4d0f27165e11bc41b03cd2ab0605041b8fda0cb27a0c. " +
      "The address is the one the publication page linked to on that day. The text states version 18.0, " +
      "published for staff on 8 October 2026, and runs through the last numbered section (19.9). " +
      "Read closely: sections 7.2, 7.3, 7.4 and 8.2; the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-11T10:48:38Z",
  },
  {
    id: "gb-visit-guidance-pdf",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Visit caseworker guidance (PDF)",
    // The file's address ON THE DAY IT WAS RETRIEVED. It carries a per-release
    // id and changes with every publication, so the crawl does not request
    // this value: it reads the current address from `resolveFrom` each time.
    url: "https://assets.publishing.service.gov.uk/media/6ab66e8ba9c3d267bcccef22/Visit__updated_.pdf",
    resolveFrom: {
      // The stable publication page that always links to the current file.
      pageUrl: "https://www.gov.uk/government/publications/visit-guidance",
      // The one PDF attachment on that page: any release id, any file name.
      linkPattern: "https://assets\\.publishing\\.service\\.gov\\.uk/media/[0-9a-f]+/[^/?#]+\\.pdf",
    },
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "pdf",
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "814,372-byte PDF, 80 pages, every page with a text layer, 169,325 characters of cleaned text, " +
      "sha256 9d4d1a72479fc64f8a5da0a92a12a8c6f129a2f6fdef62101177aeb02bb5ec6f. The file's address was read " +
      "from the publication page on that day (it was the only PDF linked there). Each page is headed " +
      "'Published for Home Office staff on 8 October 2026'; page 1 states version 18.0. " +
      "Read closely: the passages on pages 21 to 23 and 26 that correspond to sections 7.2, 7.3, 7.4 and 8.2 of the " +
      "web version (the PDF's headings are not numbered); the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-11T10:48:43Z",
  },
  {
    id: "gb-part-suitability",
    // Cross-route document: only what the route's own rules point to, and what applies to its applicants.
    role: "secondary",
    title: "Immigration Rules: Part Suitability",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-part-suitability",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "36,186 characters of cleaned text, sha256 75e7884bf7a91b9d7064c6bbe9ef884c617a30c9c48b19f9f6cf6311c25c7e35. " +
      "The address is the one the publisher's index of the rules linked to on that day; this is the document " +
      "the visitor rules name for refusal grounds (V 3.1 of the entry above). The text runs from the title to the " +
      "last numbered paragraph (it is not cut short). Read closely: the opening and the closing paragraphs only; " +
      "the rest was retrieved, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-11T10:48:40Z",
  },
  {
    id: "gb-appendix-finance",
    // Cross-route document: only what the route's own rules point to, and what applies to its applicants.
    role: "secondary",
    title: "Immigration Rules Appendix Finance",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-finance",
    jurisdiction: "GB",
    route: "standard-visitor",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-11 (10:48 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "9,076 characters of cleaned text, sha256 12d7089b98578dc7379bc40672a99364e4b0fa10a199004b1aaf0d3c20596847. " +
      "The address is the one the publisher's index of the rules linked to on that day. Registered because the " +
      "visitor rules (V 4.2(e) of the first entry) refer to FIN 2.1 of this document. The text runs from the title to " +
      "the last numbered paragraph (it is not cut short). Read closely: FIN 2.1; the rest was retrieved and skimmed, " +
      "not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-11T10:48:41Z",
  },

  // ============================================
  // UK FAMILY (route key "uk-family-visa", visa type gb-uk-family-visa; issue #260)
  // ============================================
  //
  // The route key follows the registry convention: the visa type id without
  // its country prefix (gb-uk-family-visa -> uk-family-visa), the same rule
  // route-onboarding.service.ts uses to find a route's guidance.
  //
  // Documents, each requested once on 2026-11-14 through the shared fetch
  // service (the crawl's own code path: bot user agent, robots.txt checked,
  // per-host delay), with the numbers in each note taken from that request:
  //  - Appendix FM (the route's own rules)                       -> primary
  //  - Appendix FM-SE (the evidence Appendix FM specifies)       -> secondary
  //  - the Family Policy caseworker guidance, web + PDF          -> route_guidance
  //  - the minimum income requirement caseworker guidance (PDF)  -> route_guidance
  //
  // Cross-route documents reused BY ID, not re-registered (one source per URL;
  // the validator refuses a duplicate URL):
  //  - gb-part-suitability: Appendix FM S-EC.1.1 says "The applicant must not
  //    fall for refusal under Part Suitability."
  //  - gb-appendix-finance: Appendix FM-SE paragraph 1(a)(i) says bank
  //    statements must "be from a financial institution to which Appendix
  //    Finance applies."
  // Both stay registered under the visitor route key; the rubric extraction
  // reads a source by id (`--sources`), whatever route key it carries.
  //
  // Addresses: the two rules pages were taken from the publisher's index of
  // the Immigration Rules (https://www.gov.uk/guidance/immigration-rules) on
  // 2026-11-14; the guidance addresses from their publication pages that day.
  {
    id: "gb-appendix-fm-family-members",
    // The route's own rules document.
    role: "primary",
    title: "Immigration Rules Appendix FM: family members",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-fm-family-members",
    jurisdiction: "GB",
    route: "uk-family-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (11:56 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "92,178 characters of cleaned text, sha256 4708f9d0ba479877bf397e8162eb6fd26058ee30c509aa061f222e95cd7e51c1. " +
      "The address is the one the publisher's index of the rules linked to on that day. The text runs from the page " +
      "title to the closing 'Deportation and removal' paragraph (it is not cut short). Read closely: GEN.1.1 to GEN.1.3, " +
      "S-EC.1.1 and E-ECP.1.1 to E-ECP.4.1; the rest was retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T11:56:56Z",
  },
  {
    id: "gb-appendix-fm-se-specified-evidence",
    // Cross-route document: only what the route's own rules point to, and what applies to its applicants.
    role: "secondary",
    title: "Immigration Rules Appendix FM-SE: family members specified evidence",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-fm-se-family-members-specified-evidence",
    jurisdiction: "GB",
    route: "uk-family-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (11:56 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "79,574 characters of cleaned text, sha256 9a7c644e39fc808fc4cd4426d3d233ccfd0f771eb3d06250f2976b6bd24ef801. " +
      "The address is the one the publisher's index of the rules linked to on that day. Registered because Appendix FM " +
      "(E-ECP.3.1, E-ECP.4.1 of the entry above) requires 'specified evidence', which this appendix specifies; it also " +
      "serves other appendices, hence secondary. The text runs from the title to paragraph 37 (it is not cut short). " +
      "Read closely: paragraphs A, A1 and 1(a); the rest was retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T11:56:58Z",
  },
  {
    id: "gb-family-life-guidance-html",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Family life (as a partner or parent) and exceptional circumstances caseworker guidance (accessible web version)",
    url:
      "https://www.gov.uk/government/publications/family-life-as-a-partner-or-parent-private-life-and-exceptional-circumstance/" +
      "family-life-as-a-partner-or-parent-and-exceptional-circumstances-accessible",
    jurisdiction: "GB",
    route: "uk-family-visa",
    docType: "html",
    // The document's own line, "published for Home Office staff on <date>".
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (11:58 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "198,207 characters of cleaned text, sha256 d9edda222fa8d5b54cdc67c1fe66432d502e9777ec7f0d8cc85d06382bd84edb. " +
      "The address is the one the publication page linked to on that day. The text states version 30.0, " +
      "published for staff on 8 October 2026, and runs through the last numbered section (17, Coronavirus concessions). " +
      "Read closely: sections 1, 5.1, the opening of 7.2, and 7.4 to 7.6; the rest was retrieved and skimmed, " +
      "not read line by line.",
    retrievedAt: "2026-11-14T11:58:53Z",
  },
  {
    id: "gb-family-life-guidance-pdf",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Family life (as a partner or parent) and exceptional circumstances caseworker guidance (PDF)",
    // The file's address ON THE DAY IT WAS RETRIEVED. It carries a per-release
    // id and changes with every publication, so the crawl does not request
    // this value: it reads the current address from `resolveFrom` each time.
    url: "https://assets.publishing.service.gov.uk/media/6aec80a1d77f87d8c7b52f77/Family_life__as_a_partner_or_parent__and_exceptional_circumstances.pdf",
    resolveFrom: {
      // The stable publication page that always links to the current file.
      pageUrl: "https://www.gov.uk/government/publications/family-life-as-a-partner-or-parent-private-life-and-exceptional-circumstance",
      // The one PDF attachment on that page: any release id, any file name.
      linkPattern: "https://assets\\.publishing\\.service\\.gov\\.uk/media/[0-9a-f]+/[^/?#]+\\.pdf",
    },
    jurisdiction: "GB",
    route: "uk-family-visa",
    docType: "pdf",
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (11:59 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "851,541-byte PDF, 91 pages, every page with a text layer, 216,336 characters of cleaned text, " +
      "sha256 e3506e178d3f87225cf0c3679eb5b2937b657d6a9f8376e07ebef417266b1583. The file's address was read from the " +
      "publication page on that day (it was the only PDF linked there; the resolveFrom lookup returned it). Each page " +
      "is headed 'Published for Home Office staff on 8 October 2026'; page 1 states version 30.0. " +
      "Read closely: the passages pinned in guidance-quote-checks.ts, which correspond to sections 1, 5.1 and 7.2 of the " +
      "web version (the PDF's headings are not numbered); the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-14T11:59:10Z",
  },
  {
    id: "gb-family-financial-requirement-pdf",
    // Guidance written for this route's financial requirement (Appendix FM,
    // and Appendix HM Armed Forces which shares it).
    role: "route_guidance",
    title: "Family Migration: Appendix FM and Appendix HM Armed Forces, minimum income requirement caseworker guidance (PDF)",
    // The file's address on the day it was retrieved (per-release id).
    url:
      "https://assets.publishing.service.gov.uk/media/691209e3e9348ac8fb54f4ba/" +
      "Family+Migration+Appendix+FM+Section+and+Appendix+HM+Armed+Forces+Financial+Requirement.pdf",
    resolveFrom: {
      // The stable publication page. It links to FIVE PDFs (this one, the
      // adequate maintenance guidance, two children annexes and the adult
      // dependent relatives guidance), so the pattern names this file by the
      // words its name carries ("Financial+Requirement"), not just ".pdf".
      pageUrl: "https://www.gov.uk/government/publications/chapter-8-appendix-fm-family-members",
      linkPattern: "https://assets\\.publishing\\.service\\.gov\\.uk/media/[0-9a-f]+/[^/?#]*Financial\\+Requirement[^/?#]*\\.pdf",
    },
    jurisdiction: "GB",
    route: "uk-family-visa",
    docType: "pdf",
    // Anchored on the bullet of the document's "Publication" section. The page
    // headers cannot be used: page 1 is headed "12 March 2025" while pages 2 to
    // 80 and the Publication section say "11 November 2025", and the match is
    // case-insensitive, so the plain lead-in would pick page 1's older date.
    publishedDateSelector: "• published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:00 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "759,302-byte PDF, 80 pages, every page with a text layer, 193,643 characters of cleaned text, " +
      "sha256 440d223989d76cceaa30e695bbef48ae55e9fada222b540fac3422a453084279. The file's address was read from the " +
      "publication page on that day; the resolveFrom pattern matched exactly this one of the five PDFs there. " +
      "There is no web rendition: the 'accessible version' address the search index still lists " +
      "(.../appendix-fm-17-financial-requirement-accessible-version) redirected to the publication page that day. " +
      "The Publication section states version 13.0, published for staff on 11 November 2025 (page 1's header says " +
      "12 March 2025; pages 2 to 80 say 11 November 2025). Read closely: pages 1, 5 and 11 to 13 (publication, the " +
      "summary of thresholds and the 11 April 2024 rules); the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-14T12:00:20Z",
  },

  // ============================================
  // SKILLED WORKER (route key "skilled-worker-visa", visa type gb-skilled-worker-visa; issue #260)
  // ============================================
  //
  // Documents, each requested once on 2026-11-14 through the shared fetch
  // service (numbers in each note are from that request):
  //  - Appendix Skilled Worker (the route's own rules)               -> primary
  //  - the Skilled Worker caseworker guidance, web + PDF             -> route_guidance
  //  - Appendix English Language (SW 7.2 names it)                   -> secondary
  //  - Appendix Skilled Occupations (SW 4.2, SW 8.1: eligible codes
  //    and going rates)                                              -> secondary
  //  - Appendix Immigration Salary List (SW 8.1(b))                  -> secondary
  // Reused by id: gb-part-suitability (SW 2.1) and gb-appendix-finance
  // (SW 15.3, funds "as specified in Appendix Finance").
  //
  // Not registered, though the rules name them for some applicants only:
  // Appendix ATAS (SW 6.3A, certain researchers), Appendix Tuberculosis
  // (SW 3.2, certain countries), Appendix KOL UK and Appendix Continuous
  // Residence (settlement only). They can be added the same way if the
  // rubric needs them.
  //
  // The Health and Care Worker visa (gb-health-care-worker-visa) is decided
  // under this same appendix (its "Health and Care ASHE salary job" rules,
  // SW A1.1), so its rubric can reuse these ids. The caseworker guidance above
  // (section 3.1) also points to a separate "Health and Care visa guidance";
  // that document has NOT been looked up or registered here.
  {
    id: "gb-appendix-skilled-worker",
    // The route's own rules document.
    role: "primary",
    title: "Immigration Rules Appendix Skilled Worker",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-skilled-worker",
    jurisdiction: "GB",
    route: "skilled-worker-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:07 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "75,506 characters of cleaned text, sha256 9e1a1d62cd239d066fc765cd3294d8ec6fed728904c4652622e27f2db6c7c96b. " +
      "The address is the one the publisher's index of the rules linked to on that day. The text runs from the page " +
      "title to SW 46.2 (it is not cut short). Read closely: SW 2.1, SW 3.2, SW 4.1, SW 4.2, SW 5.1, SW 7.2, SW 8.1 and " +
      "SW 15.1 to SW 15.3; the rest was retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T12:07:20Z",
  },
  {
    id: "gb-skilled-worker-guidance-html",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Skilled Worker caseworker guidance (accessible web version)",
    url: "https://www.gov.uk/government/publications/skilled-worker-visa-caseworker-guidance/skilled-worker-caseworker-guidance-accessible",
    jurisdiction: "GB",
    route: "skilled-worker-visa",
    docType: "html",
    // The document's own line, "published for Home Office staff on <date>".
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:07 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "124,377 characters of cleaned text, sha256 c2e7916e214946216c4affa1fb0077bcf0f3b0824ba29b260b565cd2a3972d5c. " +
      "The address is the one the publication page linked to on that day. The text states version 20.0, " +
      "published for staff on 3 August 2026, and runs through the last numbered section (30.8). " +
      "Read closely: section 1 and the openings of sections 8 and 9; the rest was retrieved and skimmed, " +
      "not read line by line.",
    retrievedAt: "2026-11-14T12:07:34Z",
  },
  {
    id: "gb-skilled-worker-guidance-pdf",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Skilled Worker caseworker guidance (PDF)",
    // The file's address ON THE DAY IT WAS RETRIEVED (per-release id); the
    // crawl reads the current address from `resolveFrom` each time.
    url: "https://assets.publishing.service.gov.uk/media/6a6b4a63cceb23e86789771f/Skilled_worker__1_.pdf",
    resolveFrom: {
      // The stable publication page that always links to the current file.
      pageUrl: "https://www.gov.uk/government/publications/skilled-worker-visa-caseworker-guidance",
      // The one PDF attachment on that page: any release id, any file name.
      linkPattern: "https://assets\\.publishing\\.service\\.gov\\.uk/media/[0-9a-f]+/[^/?#]+\\.pdf",
    },
    jurisdiction: "GB",
    route: "skilled-worker-visa",
    docType: "pdf",
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:07 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "763,334-byte PDF, 76 pages, every page with a text layer, 141,042 characters of cleaned text, " +
      "sha256 321757c1c0bd36a3c10de8f7f80c220ac73d08a3eb7d65d5fc5609f528a9f105. The file's address was read from the " +
      "publication page on that day (it was the only PDF linked there; the resolveFrom lookup returned it). Each page " +
      "is headed 'Published for Home Office staff on 3 August 2026'; page 1 states version 20.0. " +
      "Read closely: the passages pinned in guidance-quote-checks.ts (sections 1, 8 and 9 of the web version; the " +
      "PDF's headings are not numbered); the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-14T12:07:36Z",
  },
  {
    id: "gb-appendix-english-language",
    // Cross-route document: only what the route's own rules point to, and what applies to its applicants.
    role: "secondary",
    title: "Immigration Rules Appendix English Language",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-english-language",
    jurisdiction: "GB",
    route: "skilled-worker-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:07 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "10,732 characters of cleaned text, sha256 236d13a2055429e1ed7f46f8a8cd8f23267825c53ddedebbd200d2dc70b03ce3. " +
      "The address is the one the publisher's index of the rules linked to on that day. Registered because SW 7.2 " +
      "of Appendix Skilled Worker names it; its opening lists the appendices it applies to (Student among them). " +
      "The text runs from the title to the last paragraph (it is not cut short). Read closely: the opening paragraphs; " +
      "the rest was retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T12:07:56Z",
  },
  {
    id: "gb-appendix-skilled-occupations",
    // Cross-route document: only what the route's own rules point to, and what applies to its applicants.
    role: "secondary",
    title: "Immigration Rules Appendix Skilled Occupations",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-skilled-occupations",
    jurisdiction: "GB",
    route: "skilled-worker-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:07 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "199,859 characters of cleaned text, sha256 572db9d4776411c55da3f2100f42775fe14c4d8bd72ea3a473133ae215a73b5b. " +
      "The address is the one the publisher's index of the rules linked to on that day. Registered because SW 4.2 and " +
      "SW 8.1 of Appendix Skilled Worker take eligible occupation codes and going rates from its tables. The text runs " +
      "from the title to the last occupation listed (9269; it is not cut short); it is mostly tables. Read closely: " +
      "the title and the table headings only; the tables were retrieved, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T12:07:58Z",
  },
  {
    id: "gb-appendix-immigration-salary-list",
    // Cross-route document: only what the route's own rules point to, and what applies to its applicants.
    role: "secondary",
    title: "Immigration Rules Appendix Immigration Salary List",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-immigration-salary-list",
    jurisdiction: "GB",
    route: "skilled-worker-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:08 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "5,076 characters of cleaned text, sha256 b3f2651bf6a288e11f55c96f2130ae1f3fd9b3b260f764bec4819fd8461f55f0. " +
      "The address is the one the publisher's index of the rules linked to on that day. Registered because SW 8.1(b) " +
      "of Appendix Skilled Worker refers to it. The text runs from the title to the last table row (it is not cut " +
      "short). Read closely: the two opening paragraphs; the table was retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T12:08:16Z",
  },

  // ============================================
  // STUDENT (route key "student-visa", visa type gb-student-visa; issue #260)
  // ============================================
  //
  // Documents, each requested once on 2026-11-14 through the shared fetch
  // service (numbers in each note are from that request):
  //  - Appendix Student (the route's own rules)                       -> primary
  //  - the "Student and Child Student" caseworker guidance, web + PDF -> route_guidance
  //  - Appendix ATAS (ST 8.4)                                         -> secondary
  // Reused by id: gb-part-suitability (ST 2.1), gb-appendix-finance (ST 12.6)
  // and gb-appendix-english-language (ST 13.2; registered with Skilled Worker
  // above). The guidance itself says it "is based on Appendix Student,
  // Appendix Child Student, Appendix English Language, Appendix Finance and
  // Appendix ATAS", which is the same set.
  //
  // Not registered: Appendix Tuberculosis (ST 3.2, certain countries only).
  // The publication page's web rendition is ".../student-and-child-student"
  // (there is no "-accessible" suffix on this one; the older
  // points-based-system-student-route address redirects to this page).
  {
    id: "gb-appendix-student",
    // The route's own rules document.
    role: "primary",
    title: "Immigration Rules Appendix Student",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-student",
    jurisdiction: "GB",
    route: "student-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:10 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "50,639 characters of cleaned text, sha256 073ed78055dcc72821285477bcf05f99eaa9d3413c887277a2dd64030a9d7752. " +
      "The address is the one the publisher's index of the rules linked to on that day. The text runs from the page " +
      "title to the conditions for a partner or child (it is not cut short). Read closely: ST 2.1, ST 3.2, ST 4.1, " +
      "ST 4.2, ST 5.1, ST 7.1, ST 7.2, ST 8.4, ST 12.1, ST 12.2, ST 12.6 and ST 13.2; the rest was retrieved and " +
      "skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T12:10:46Z",
  },
  {
    id: "gb-student-guidance-html",
    // Guidance written for this same route (and Child Student): all of it is about the route.
    role: "route_guidance",
    title: "Student and Child Student caseworker guidance (web version)",
    url: "https://www.gov.uk/government/publications/student-route-caseworker-guidance/student-and-child-student",
    jurisdiction: "GB",
    route: "student-visa",
    docType: "html",
    // The document's own line, "published for Home Office staff on <date>".
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:10 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "179,193 characters of cleaned text, sha256 7700bc3208ad4ce3b23e2094e926b794e84d39d3214d91cf6efa1bc6b261a487. " +
      "The address is the one the publication page linked to on that day. The text states version 15.0, " +
      "published for staff on 9 October 2026, and runs through the closing table of rules for a dependant child " +
      "(its headings are not numbered). Read closely: 'About this guidance', 'Publication' and the opening of " +
      "'Genuine student rule'; the rest was retrieved and skimmed, not read line by line.",
    retrievedAt: "2026-11-14T12:10:48Z",
  },
  {
    id: "gb-student-guidance-pdf",
    // Guidance written for this same route (and Child Student): all of it is about the route.
    role: "route_guidance",
    title: "Student and Child Student caseworker guidance (PDF)",
    // The file's address ON THE DAY IT WAS RETRIEVED (per-release id); the
    // crawl reads the current address from `resolveFrom` each time.
    url: "https://assets.publishing.service.gov.uk/media/6ad09e010f7b53973e0266f3/Student_and_Child_Student.pdf",
    resolveFrom: {
      // The stable publication page that always links to the current file.
      pageUrl: "https://www.gov.uk/government/publications/student-route-caseworker-guidance",
      // The one PDF attachment on that page: any release id, any file name.
      linkPattern: "https://assets\\.publishing\\.service\\.gov\\.uk/media/[0-9a-f]+/[^/?#]+\\.pdf",
    },
    jurisdiction: "GB",
    route: "student-visa",
    docType: "pdf",
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:10 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "1,053,905-byte PDF, 113 pages, every page with a text layer, 210,094 characters of cleaned text, " +
      "sha256 d1c5dd4058348002d38220b4275a9b6f7a259229acda8c64dfb59384c283bb22. The file's address was read from the " +
      "publication page on that day (it was the only PDF linked there; the resolveFrom lookup returned it). Each page " +
      "is headed 'Published for Home Office staff on 9 October 2026'; page 1 states version 15.0. " +
      "Read closely: the passages pinned in guidance-quote-checks.ts; the rest was retrieved and skimmed, " +
      "not read line by line.",
    retrievedAt: "2026-11-14T12:10:50Z",
  },
  {
    id: "gb-appendix-atas",
    // Cross-route document: only what the route's own rules point to, and what applies to its applicants.
    role: "secondary",
    title: "Immigration Rules Appendix ATAS: Academic Technology Approval Scheme (ATAS)",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-atas-academic-technology-approval-scheme-atas",
    jurisdiction: "GB",
    route: "student-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:11 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "7,521 characters of cleaned text, sha256 e2baa6461d6dd9b31437723ea95ce24ca920877e17a2a27eb6438328ae82835f. " +
      "The address is the one the publisher's index of the rules linked to on that day. Registered because ST 8.4 of " +
      "Appendix Student refers to it (and the Student guidance names it). The text runs from the title to the last " +
      "subject code listed (it is not cut short). Read closely: the two opening paragraphs; the code lists were " +
      "retrieved, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T12:11:08Z",
  },

  // ============================================
  // GRADUATE (route key "graduate-visa", visa type gb-graduate-visa; issue #260)
  // ============================================
  //
  // Documents, each requested once on 2026-11-14 through the shared fetch
  // service (numbers in each note are from that request):
  //  - Appendix Graduate (the route's own rules)               -> primary
  //  - the Graduate caseworker guidance, web + PDF             -> route_guidance
  // Reused by id: gb-part-suitability (GR 2.1) and gb-appendix-atas (GR 8.2(d),
  // the study condition; registered with Student above). The guidance says it
  // "is based on Appendix Graduate and Appendix ATAS", which is the same set.
  // The route has no financial or English language requirement in its rules,
  // so neither of those appendices is listed for it.
  //
  // Not registered: Appendix Relationship with Partner (GR 11.2, dependent
  // partners only).
  {
    id: "gb-appendix-graduate",
    // The route's own rules document.
    role: "primary",
    title: "Immigration Rules Appendix Graduate",
    url: "https://www.gov.uk/guidance/immigration-rules/immigration-rules-appendix-graduate",
    jurisdiction: "GB",
    route: "graduate-visa",
    docType: "html",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:12 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "13,287 characters of cleaned text, sha256 8067a67ea995fa375e3b335941f45917b24421c84949ce127d2d602136115c56. " +
      "The address is the one the publisher's index of the rules linked to on that day. The text runs from the page " +
      "title to the conditions for a partner or child (it is not cut short). Read closely: the paragraph numbers and " +
      "opening sentences of GR 1 to GR 16, and GR 2.1, GR 3.1, GR 4.1 to GR 4.3 and GR 8.2 in full; the rest was " +
      "retrieved and skimmed, not read line by line. " +
      "The cleaned text carries no published or updated date, so publishedDate is not recorded for this entry.",
    retrievedAt: "2026-11-14T12:12:47Z",
  },
  {
    id: "gb-graduate-guidance-html",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Graduate caseworker guidance (accessible web version)",
    url: "https://www.gov.uk/government/publications/graduate-caseworker-guidance/graduate-caseworker-guidance-accessible-version",
    jurisdiction: "GB",
    route: "graduate-visa",
    docType: "html",
    // The document's own line, "published for Home Office staff on <date>".
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:12 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "44,132 characters of cleaned text, sha256 f59a04799068b3eaa56312ce9c0a9b5abcf9ee6ccf57eaeb9163750deede4dae. " +
      "The address is the one the publication page linked to on that day. The text states version 6.0, " +
      "published for staff on 3 August 2026, and runs through the closing section on translated documents (its " +
      "headings are not numbered). Read closely: 'About this guidance', 'Publication' and 'Eligibility requirements' " +
      "(successful completion, sponsor notification, qualification); the rest was retrieved and skimmed, not read " +
      "line by line.",
    retrievedAt: "2026-11-14T12:12:49Z",
  },
  {
    id: "gb-graduate-guidance-pdf",
    // Guidance written for this same route: all of it is about the route.
    role: "route_guidance",
    title: "Graduate caseworker guidance (PDF)",
    // The file's address ON THE DAY IT WAS RETRIEVED (per-release id); the
    // crawl reads the current address from `resolveFrom` each time.
    url: "https://assets.publishing.service.gov.uk/media/6a4bbe12e50f952c9b89e603/Graduate_route__1_.pdf",
    resolveFrom: {
      // The stable publication page that always links to the current file.
      pageUrl: "https://www.gov.uk/government/publications/graduate-caseworker-guidance",
      // The one PDF attachment on that page: any release id, any file name.
      linkPattern: "https://assets\\.publishing\\.service\\.gov\\.uk/media/[0-9a-f]+/[^/?#]+\\.pdf",
    },
    jurisdiction: "GB",
    route: "graduate-visa",
    docType: "pdf",
    publishedDateSelector: "published for Home Office staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
    checkIntervalHours: WEEKLY_HOURS,
    verificationStatus: "verified",
    verificationNote:
      "Retrieved in full on 2026-11-14 (12:13 UTC) through the shared fetch service: HTTP 200, no redirect, " +
      "390,717-byte PDF, 32 pages, every page with a text layer, 52,715 characters of cleaned text, " +
      "sha256 102e749800aaf6c37726a0dd45f07c5203ed10b1f24cec1ef940a37a61941994. The file's address was read from the " +
      "publication page on that day (it was the only PDF linked there; the resolveFrom lookup returned it). Each page " +
      "is headed 'Published for Home Office staff on 3 August 2026'; page 1 states version 6.0. " +
      "Read closely: the passages pinned in guidance-quote-checks.ts; the rest was retrieved and skimmed, " +
      "not read line by line.",
    retrievedAt: "2026-11-14T12:13:00Z",
  },
];

/** Statuses a seed may set (`failing` belongs to the crawler). */
const SEEDABLE_STATUSES = ["active", "paused", "retired"] as const;

/** A route / jurisdiction key: letters, digits and inner hyphens. */
const KEY_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** Bounds for `checkIntervalHours`: hourly at most, yearly at least. */
export const MIN_CHECK_INTERVAL_HOURS = 1;
export const MAX_CHECK_INTERVAL_HOURS = 24 * 366;

/** Crawl-state fields the crawler owns; a re-seed never resets them. */
export const GUIDANCE_CRAWL_STATE_DEFAULTS = {
  lastFetchedAt: null,
  lastContentHash: null,
  finalUrl: null,
  resolvedUrl: null,
  publishedDate: null,
  publishedDateText: null,
  latestSnapshotId: null,
  lastChangedAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
  lastError: null,
  lastErrorKind: null,
  lastErrorAt: null,
  backoffUntil: null,
} as const;

/** True for an absolute https URL. */
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** True for a non-empty string. */
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Everything wrong with one seed entry (empty = valid). Pure. The messages
 * name the field so a failed seed says exactly what to fix.
 */
export function validateGuidanceSourceSeed(seed: GuidanceSourceSeed): string[] {
  const problems: string[] = [];
  const s = seed as Partial<GuidanceSourceSeed>;

  // ---- Identity and location ----
  if (typeof s.id !== "string" || !GUIDANCE_SOURCE_ID_RE.test(s.id)) {
    problems.push("id must be lowercase letters, digits and hyphens");
  }
  if (!isText(s.title)) problems.push("title is required");
  if (!isHttpsUrl(s.url)) problems.push("url must be an absolute https URL");
  if (s.expectedFinalUrl !== undefined && !isHttpsUrl(s.expectedFinalUrl)) {
    problems.push("expectedFinalUrl must be an absolute https URL");
  }
  // A document whose address changes per publication (issue #111): where to
  // look the current one up. The resolved address is then the redirect
  // baseline, so a fixed `expectedFinalUrl` would contradict it.
  if (s.resolveFrom !== undefined) {
    problems.push(...resolveFromProblems(s.resolveFrom));
    if (s.expectedFinalUrl !== undefined) {
      problems.push("expectedFinalUrl cannot be combined with resolveFrom (the resolved address is the redirect baseline)");
    }
    // `url` records where the document WAS; the pattern says where it may
    // be. They must name the same host, or one of the two is a mistake.
    const patternHost =
      typeof s.resolveFrom?.linkPattern === "string" ? linkPatternHost(s.resolveFrom.linkPattern) : null;
    if (patternHost && isHttpsUrl(s.url) && new URL(s.url as string).hostname !== patternHost) {
      problems.push(`url must be on the host resolveFrom.linkPattern names (${patternHost})`);
    }
  }
  if (typeof s.jurisdiction !== "string" || !KEY_RE.test(s.jurisdiction)) {
    problems.push("jurisdiction must be a key of letters, digits and hyphens");
  }
  // The route key is generic and lowercase so two seeders cannot spell the
  // same route two ways.
  if (typeof s.route !== "string" || !KEY_RE.test(s.route) || s.route !== s.route.toLowerCase()) {
    problems.push("route must be a lowercase key of letters, digits and hyphens");
  }

  // ---- Document kind, schedule, status ----
  if (!GUIDANCE_DOC_TYPES.includes(s.docType as never)) problems.push(`docType must be one of ${GUIDANCE_DOC_TYPES.join(", ")}`);
  if (
    typeof s.checkIntervalHours !== "number" ||
    !Number.isFinite(s.checkIntervalHours) ||
    s.checkIntervalHours < MIN_CHECK_INTERVAL_HOURS ||
    s.checkIntervalHours > MAX_CHECK_INTERVAL_HOURS
  ) {
    problems.push(`checkIntervalHours must be between ${MIN_CHECK_INTERVAL_HOURS} and ${MAX_CHECK_INTERVAL_HOURS}`);
  }
  if (s.status !== undefined && !SEEDABLE_STATUSES.includes(s.status as never)) {
    problems.push(`status must be one of ${SEEDABLE_STATUSES.join(", ")} (the crawler sets "failing")`);
  }
  if (s.publishedDateSelector !== undefined) {
    const problem = typeof s.publishedDateSelector === "string"
      ? publishedDateSelectorProblem(s.publishedDateSelector)
      : "publishedDateSelector must be a string";
    if (problem) problems.push(problem);
  }

  // ---- Role (issue #112) ----
  if (s.role !== undefined && !GUIDANCE_SOURCE_ROLES.includes(s.role as never)) {
    problems.push(`role must be one of ${GUIDANCE_SOURCE_ROLES.join(", ")} when present`);
  }

  // ---- Verification honesty ----
  if (!GUIDANCE_VERIFICATION_STATUSES.includes(s.verificationStatus as never)) {
    problems.push(`verificationStatus must be one of ${GUIDANCE_VERIFICATION_STATUSES.join(", ")}`);
  }
  if (!isText(s.verificationNote)) {
    problems.push("verificationNote is required: say what was actually retrieved, and when");
  }
  if (s.retrievedAt !== undefined && (typeof s.retrievedAt !== "string" || Number.isNaN(Date.parse(s.retrievedAt)))) {
    problems.push("retrievedAt must be an ISO-8601 date or date-time");
  }
  if (s.retrievalError !== undefined && !isText(s.retrievalError)) {
    problems.push("retrievalError must be a non-empty string when present");
  }
  if (s.verificationStatus === "verified") {
    if (s.retrievedAt === undefined) problems.push("a verified source needs retrievedAt (when it was retrieved in full)");
    // The rule that stops a failed retrieval being seeded as verified.
    if (s.retrievalError !== undefined) {
      problems.push("a source with a retrievalError cannot be verified: seed it as partial or unverified");
    }
  }
  // "registered" (issue #215) claims the same thing as verified about
  // retrieval (the whole text was fetched), so it carries the same two rules.
  if (s.verificationStatus === "registered") {
    if (s.retrievedAt === undefined) problems.push("a registered source needs retrievedAt (when the preview fetch retrieved it)");
    if (s.retrievalError !== undefined) {
      problems.push("a source with a retrievalError cannot be registered: it was not retrieved in full");
    }
  }
  if (s.verificationStatus === "partial" && s.retrievedAt === undefined) {
    problems.push("a partial source needs retrievedAt (when the part that was retrieved was retrieved)");
  }
  if (s.verificationStatus === "unverified" && s.retrievalError === undefined) {
    problems.push("an unverified source needs retrievalError (what the failed retrieval returned)");
  }
  return problems;
}

/**
 * Validate a whole list: every entry's problems, plus duplicate ids and
 * duplicate URLs. Returns messages prefixed with the entry they belong to.
 */
export function validateGuidanceSourceSeeds(seeds: readonly GuidanceSourceSeed[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  seeds.forEach((seed, i) => {
    const label = typeof seed?.id === "string" && seed.id ? seed.id : `entry ${i}`;
    for (const p of validateGuidanceSourceSeed(seed)) problems.push(`${label}: ${p}`);
    if (ids.has(seed.id)) problems.push(`${label}: duplicate id`);
    ids.add(seed.id);
    if (urls.has(seed.url)) problems.push(`${label}: duplicate url ${seed.url}`);
    urls.add(seed.url);
  });
  return problems;
}

/** True for a stored guidance source an admin added through the portal API (issue #215). */
export function isPortalAdded(existing: Record<string, unknown> | undefined): boolean {
  return existing?.addedVia === "portal";
}

/**
 * The doc to write (merged) for one seed entry. Pure.
 *
 *  - Curated fields always come from the seed.
 *  - A NEW source gets the blank crawl state and status `active` (unless the
 *    seed sets one).
 *  - An EXISTING source keeps its crawl state (hash, snapshots pointer,
 *    failure streak): a re-seed must not make the crawler forget what it has
 *    fetched or un-fail a failing source. Its status changes only when the
 *    seed sets one explicitly; a `failing` source is not flipped to `active`
 *    by the seed (only a successful crawl does that).
 *  - If the seed's `url` differs from the stored one, the entry now points at
 *    a different address, so the redirect baseline and the failure streak
 *    are reset and a `failing` source is given a fresh start. The stored
 *    hash is kept: if the text behind the new URL is the same, nothing is
 *    re-snapshotted.
 */
export function buildSeededGuidanceSource(
  seed: GuidanceSourceSeed,
  existing: Record<string, unknown> | undefined,
  now: Timestamp
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    title: seed.title.trim(),
    url: seed.url,
    jurisdiction: seed.jurisdiction,
    route: seed.route,
    docType: seed.docType,
    // null (not undefined) so a selector removed from the seed is removed
    // from the doc by the merge.
    publishedDateSelector: seed.publishedDateSelector ?? null,
    expectedFinalUrl: seed.expectedFinalUrl ?? null,
    // A copy of the two strings (never the seed object itself), or null.
    resolveFrom: seed.resolveFrom
      ? { pageUrl: seed.resolveFrom.pageUrl, linkPattern: seed.resolveFrom.linkPattern }
      : null,
    checkIntervalHours: seed.checkIntervalHours,
    // null (not undefined) so a role removed from the seed is cleared.
    // Issue #215: an admin's role edit (PATCH /admin/guidance-sources/:id sets
    // `roleEditedBy`) belongs to Firestore: the seed keeps the stored role.
    role: existing?.roleEditedBy ? ((existing.role as string | null | undefined) ?? null) : (seed.role ?? null),
    verificationStatus: seed.verificationStatus,
    verificationNote: seed.verificationNote.trim(),
    retrievedAt: seed.retrievedAt ? Timestamp.fromMillis(Date.parse(seed.retrievedAt)) : null,
    retrievalError: seed.retrievalError?.trim() ?? null,
    updatedAt: now,
  };

  if (!existing) {
    // Brand-new source: blank crawl state.
    Object.assign(doc, GUIDANCE_CRAWL_STATE_DEFAULTS, { status: seed.status ?? "active", createdAt: now });
    return doc;
  }

  // Existing source: fill in only the crawl-state fields an older doc lacks.
  for (const [field, value] of Object.entries(GUIDANCE_CRAWL_STATE_DEFAULTS)) {
    if (existing[field] === undefined) doc[field] = value;
  }
  if (existing.createdAt === undefined) doc.createdAt = now;

  const urlChanged = existing.url !== seed.url;
  const wasFailing = existing.status === "failing";
  if (urlChanged) {
    // A different address: forget the old redirect baseline and streak.
    Object.assign(doc, {
      finalUrl: null,
      resolvedUrl: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorKind: null,
      lastErrorAt: null,
      backoffUntil: null,
      autoPaused: false,
      autoPausedAt: null,
      autoPausedReason: null,
      autoPauseCause: null,
    });
  }
  if (seed.status !== undefined && !(wasFailing && seed.status === "active" && !urlChanged)) {
    // An explicit seed status wins, except that "active" does not un-fail a
    // failing source whose URL is unchanged.
    doc.status = seed.status;
  } else if (existing.status === undefined || (wasFailing && urlChanged)) {
    doc.status = "active";
  }
  return doc;
}

/**
 * Seed the `guidanceSources` collection.
 *
 * Validates EVERY entry first and writes nothing if any is invalid (the
 * error lists all problems). Each source is written under its `id` with
 * `{ merge: true }`.
 *
 * @param seeds the entries to write (default: GUIDANCE_SOURCE_SEEDS)
 * @returns the number of sources seeded
 */
export async function seedGuidanceSources(
  seeds: readonly GuidanceSourceSeed[] = GUIDANCE_SOURCE_SEEDS,
  // Issue #215: the Firestore handle (tests pass an in-memory one).
  database?: FirebaseFirestore.Firestore
): Promise<number> {
  const problems = validateGuidanceSourceSeeds(seeds);
  if (problems.length > 0) {
    throw new Error(`Invalid guidance source seed(s), nothing written:\n- ${problems.join("\n- ")}`);
  }
  if (seeds.length === 0) {
    console.log("Guidance sources: no seed entries, nothing to write");
    return 0;
  }

  // Resolved here (not at module load): see the note at the top of the file.
  const db = database ?? getFirestore();
  const collection = db.collection("guidanceSources");
  const now = Timestamp.now();

  // Read the existing docs in one round trip so crawl state survives.
  const refs = seeds.map((s) => collection.doc(s.id));
  const snaps = await db.getAll(...refs);

  const batch = db.batch();
  let written = 0;
  seeds.forEach((seed, i) => {
    const existing = snaps[i]?.exists ? (snaps[i].data() as Record<string, unknown>) : undefined;
    // Issue #215: a source an admin registered from the portal belongs to
    // Firestore, not to this list. If a seed entry ever reuses its id, the
    // stored doc wins: it is never overwritten (the merge would replace the
    // admin's url, title, role and verification note). Said loudly, since a
    // seed entry that cannot land is a mistake somebody should resolve.
    if (isPortalAdded(existing)) {
      console.warn(`[seed-guidance-sources] ${seed.id} was added from the portal: the seed entry was NOT applied`);
      return;
    }
    batch.set(refs[i], buildSeededGuidanceSource(seed, existing, now), { merge: true });
    written++;
  });
  await batch.commit();
  console.log(`Seeded ${written} guidance source(s)`);
  return written;
}
