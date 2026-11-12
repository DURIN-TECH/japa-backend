import * as cheerio from "cheerio";
import axios from "axios";
import { createHash } from "crypto";
import { createWriteStream } from "fs";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { VISA_CATALOG_USER_AGENT, visaCatalogFetchService } from "../../../shared/fetch/visa-catalog-fetch.service";
import { parseQuarterLabel, quarterIndex } from "../../../../services/outcome-statistics/period";
import {
  OutcomeDataSourceAdapter,
  OutcomeObservation,
  OutcomeSchemaError,
  ReleaseDescriptor,
  ReleaseReadResult,
} from "../../outcome-source-adapter";
import { slug } from "../../outcome-aggregate";
import { XlsxRow, XlsxWorkbook } from "../../xlsx-stream";
import { UK_NATIONALITY_CODES } from "./nationality-codes";

// ============================================
// UK HOME OFFICE: ENTRY CLEARANCE OUTCOMES ADAPTER (issue #116)
// ============================================
//
// The ONLY destination-specific code of the outcome-statistics feature.
//
// Source (verified 2026-11-10 and 2026-11-11 against the live page and file):
//   page:  https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables
//   entry: "Entry clearance visa applications and outcomes detailed datasets,
//          year ending June 2026" (MS Excel, ~31.5 MB), listed on that page as
//          Vis_D01 (applications, by nationality and visa type) and Vis_D02
//          (outcomes, by nationality, visa type and outcome).
//   file:  entry-clearance-visa-outcomes-datasets-jun-2026.xlsx, served from
//          assets.publishing.service.gov.uk under a media id that CHANGES with
//          every release, so the link is read from the page each time and never
//          stored as configuration.
//
// Workbook layout this adapter relies on (checked against the real file):
//   - flat data sheets `Data_Vis_D01` and `Data_Vis_D02` (the `Vis_*` sheets are
//     pivot views and are not read);
//   - header row = row 4; data from row 5;
//   - Data_Vis_D01 columns: Year, Quarter, Nationality, Region, Visa type group,
//     Visa type, Visa type subgroup, Applicant type, Applications;
//   - Data_Vis_D02 columns: the same eight, then Case outcome, Decisions;
//   - the Notes sheet states which quarters are provisional (read as a caveat);
//   - `Case outcome` values seen: Issued, Refused, Withdrawn, Lapsed;
//   - `Quarter` reads like "2026 Q2"; `Year` is stored as text.
//
// The note only needs OUTCOMES, so Data_Vis_D01 (applications) is opened for its
// header row alone, to validate the release's structure; none of its rows are read.
//
// Categories: every row has a visa type group (e.g. a group covering all
// visitor visas) and a visa type. Each row is counted at both levels, as
// category keys `group:<slug>` and `type:<group slug>:<type slug>`, so a rubric
// can point at either. The rubric's mapping (data) chooses; no code here names
// a route.
//
// Double counting: some subgroups are published BOTH as an "All" applicant
// series and as Main Applicant / Dependant series covering the same decisions.
// For each (group, type, subgroup) that has an "All" series in the window,
// only "All" is used; where it does not, the applicant-type rows are summed.

/** Display name of the publisher, shown with the figures. */
const PUBLISHER = "UK Home Office";

/** The page that lists the release. */
export const UK_STATISTICS_PAGE_URL =
  "https://www.gov.uk/government/statistical-data-sets/immigration-system-statistics-data-tables";

/** Start of the link text of the entry we want (the rest names the release). */
const RELEASE_LINK_TITLE_PREFIX = "Entry clearance visa applications and outcomes detailed datasets";

/** Hosts a release file may be downloaded from (suffix match, https only). */
const ALLOWED_FILE_HOST_SUFFIX = ".gov.uk";

/** Refuse a download larger than this (the real file is ~33 MB). */
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

/** Give up on a download after this long. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** The flat data sheets. */
export const SHEET_APPLICATIONS = "Data_Vis_D01";
export const SHEET_OUTCOMES = "Data_Vis_D02";

/** The workbook's notes sheet (read only for the publisher's "provisional" statement). */
const SHEET_NOTES = "Notes";

/** 1-based number of the header row in both data sheets. */
const HEADER_ROW = 4;

/** Columns both sheets must have (exact header text). */
const COMMON_COLUMNS = [
  "Year",
  "Quarter",
  "Nationality",
  "Region",
  "Visa type group",
  "Visa type",
  "Visa type subgroup",
  "Applicant type",
] as const;

/** Columns each sheet must have. */
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  [SHEET_APPLICATIONS]: [...COMMON_COLUMNS, "Applications"],
  [SHEET_OUTCOMES]: [...COMMON_COLUMNS, "Case outcome", "Decisions"],
};

/** Published outcome labels that mean a grant / a refusal. Anything else is "other". */
const OUTCOME_GRANTED = "Issued";
const OUTCOME_REFUSED = "Refused";

/** The "all applicants" series label in the Applicant type column. */
const APPLICANT_ALL = "All";

/**
 * The publisher's note on these figures, from the workbook's Notes sheet
 * (note 2). It travels with every figure. Source: the Notes sheet of the
 * release, read 2026-11-10: "An outcome in a given quarter may relate to an
 * application raised in a previous quarter."
 */
const CAVEATS = ["An outcome in a given quarter may relate to an application raised in a previous quarter."];

/** Collapse whitespace so link text and header cells compare reliably. */
function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** "27 August 2026" -> "2026-08-27"; null when it does not parse. */
function parseLongDate(text: string): string | null {
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text);
  if (!m) return null;
  const month = months.indexOf(m[2].toLowerCase());
  if (month === -1) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/**
 * Pure: find the release entry in the data tables page's HTML. Exported for
 * the QA pass. Throws when there is no such link, or more than one distinct one
 * (ambiguity is an error, never a guess).
 */
export function parseReleasePage(html: string, pageUrl: string = UK_STATISTICS_PAGE_URL): ReleaseDescriptor {
  const $ = cheerio.load(html);
  const found = new Map<string, string>(); // absolute URL -> link text

  $("a[href]").each((_i, el) => {
    const text = clean($(el).text());
    if (!text.startsWith(RELEASE_LINK_TITLE_PREFIX)) return;
    const href = $(el).attr("href") ?? "";
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!url.pathname.toLowerCase().endsWith(".xlsx")) return;
    found.set(url.toString(), text);
  });

  if (found.size === 0) {
    throw new Error(`No "${RELEASE_LINK_TITLE_PREFIX}" .xlsx link found on ${pageUrl}`);
  }
  if (found.size > 1) {
    throw new Error(`More than one "${RELEASE_LINK_TITLE_PREFIX}" .xlsx link found on ${pageUrl}; refusing to guess`);
  }
  const [fileUrl, text] = [...found.entries()][0];

  // Safety: the file must be served over https from a gov.uk host.
  const u = new URL(fileUrl);
  if (u.protocol !== "https:" || !u.hostname.endsWith(ALLOWED_FILE_HOST_SUFFIX)) {
    throw new Error(`Release link ${fileUrl} is not an https gov.uk address; refusing to download`);
  }

  // Publisher's own release label, from the link text ("year ending June 2026").
  const labelMatch = /year ending\s+[A-Za-z]+\s+\d{4}/i.exec(text);

  // The page's own "Last updated" date (the <dd> after the "Last updated:" <dt>).
  let releaseDate = null as string | null;
  $("dt").each((_i, el) => {
    if (releaseDate) return;
    if (/last updated/i.test($(el).text())) releaseDate = parseLongDate($(el).next("dd").text());
  });

  return {
    publisher: PUBLISHER,
    pageUrl,
    fileUrl,
    fileName: decodeURIComponent(u.pathname.split("/").pop() ?? ""),
    releaseLabel: labelMatch ? labelMatch[0] : null,
    releaseDate,
  };
}

/**
 * Pure: map a header row to column indexes and check every required column is
 * present under its exact (whitespace-trimmed) name. Throws OutcomeSchemaError
 * naming every missing column and the sheet. Exported for the QA pass.
 */
export function mapHeader(sheet: string, header: XlsxRow): Record<string, number> {
  const required = REQUIRED_COLUMNS[sheet];
  const index: Record<string, number> = {};
  header.forEach((cell, i) => {
    if (cell !== undefined) index[clean(cell)] = i;
  });
  const missing = required.filter((c) => index[c] === undefined);
  if (missing.length > 0) {
    throw new OutcomeSchemaError(
      `Sheet ${sheet}: header row ${HEADER_ROW} is missing column(s) ${missing.map((m) => `"${m}"`).join(", ")}. ` +
        `Found: ${Object.keys(index).map((k) => `"${k}"`).join(", ") || "(empty row)"}. Nothing was imported.`
    );
  }
  return index;
}

/** Read one sheet's header row (stopping at once) and validate it. */
async function readAndCheckHeader(wb: XlsxWorkbook, sheet: string): Promise<Record<string, number>> {
  if (!wb.hasSheet(sheet)) {
    throw new OutcomeSchemaError(`Sheet ${sheet} is not in the workbook (sheets: ${wb.sheetNames.join(", ")}). Nothing was imported.`);
  }
  let header = null as XlsxRow | null;
  await wb.streamRows(sheet, (rowNumber, cells) => {
    if (rowNumber < HEADER_ROW) return false;
    if (rowNumber === HEADER_ROW) header = cells;
    return true; // stop at the header row, or at the first row past it
  });
  if (!header) throw new OutcomeSchemaError(`Sheet ${sheet}: no header row at row ${HEADER_ROW}. Nothing was imported.`);
  return mapHeader(sheet, header);
}

/**
 * Read the publisher's own "provisional" statement(s) from the Notes sheet, so
 * the caveat travels with the release it belongs to (and names the period it
 * applies to) instead of being a constant that could go stale. The real
 * release (read 2026-11-11) carries: "Data from Q1 2026 onwards are
 * provisional." Any Notes cell whose text mentions "provisional" is kept
 * verbatim. Best effort: a missing Notes sheet or no such cell gives no extra
 * caveat; it never fails the import (the Notes sheet is small, a few KB).
 */
async function readProvisionalCaveats(wb: XlsxWorkbook): Promise<string[]> {
  if (!wb.hasSheet(SHEET_NOTES)) return [];
  const found: string[] = [];
  try {
    await wb.streamRows(SHEET_NOTES, (_rowNumber, cells) => {
      for (const cell of cells) {
        const text = cell === undefined ? "" : clean(cell);
        // Whole-sentence cells only (short enough to be a statement, not a table dump).
        if (text && text.length <= 300 && /provisional/i.test(text) && !found.includes(text)) found.push(text);
      }
    });
  } catch {
    return []; // caveat is additive; a Notes read problem must not block a valid import
  }
  return found;
}

/** The UK adapter. */
export class UkHomeOfficeOutcomeAdapter implements OutcomeDataSourceAdapter {
  readonly destination = "GB";

  /** Find the current release link on the data tables page. */
  async discoverRelease(): Promise<ReleaseDescriptor> {
    if (!(await visaCatalogFetchService.isAllowedByRobots(UK_STATISTICS_PAGE_URL))) {
      throw new Error(`robots.txt disallows fetching ${UK_STATISTICS_PAGE_URL}`);
    }
    const resp = await visaCatalogFetchService.getRaw(UK_STATISTICS_PAGE_URL);
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Fetching ${UK_STATISTICS_PAGE_URL} failed (HTTP ${resp.status})`);
    }
    return parseReleasePage(resp.body, UK_STATISTICS_PAGE_URL);
  }

  /** Stream the file to disk, hashing and size-capping as it goes. */
  async download(release: ReleaseDescriptor, destPath: string): Promise<{ sha256: string; bytes: number }> {
    if (!(await visaCatalogFetchService.isAllowedByRobots(release.fileUrl))) {
      throw new Error(`robots.txt disallows fetching ${release.fileUrl}`);
    }
    const resp = await axios.get(release.fileUrl, {
      responseType: "stream",
      headers: { "User-Agent": VISA_CATALOG_USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      validateStatus: () => true, // judge the status ourselves
    });
    if (resp.status === 429 || resp.status === 503) {
      resp.data.destroy();
      throw new Error(`${release.fileUrl} is throttling requests (HTTP ${resp.status}); try again later`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      resp.data.destroy();
      throw new Error(`Downloading ${release.fileUrl} failed (HTTP ${resp.status})`);
    }

    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD_BYTES) return cb(new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes; aborted`));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(resp.data, meter, createWriteStream(destPath));
    return { sha256: hash.digest("hex"), bytes };
  }

  /**
   * Validate both headers (before any data is read), then stream the outcomes
   * sheet keeping the latest `windowQuarters` quarters in memory.
   */
  async read(path: string, windowQuarters: number): Promise<ReleaseReadResult> {
    const wb = await XlsxWorkbook.open(path);

    // 1. Structure first. Any missing/renamed column throws here, before a row is read.
    await readAndCheckHeader(wb, SHEET_APPLICATIONS);
    const col = await readAndCheckHeader(wb, SHEET_OUTCOMES);

    // 2. Stream the outcomes sheet. `window` holds one bucket per kept quarter:
    //    quarterIndex -> (row key -> decisions). Rows are in time order, so older
    //    quarters are evicted as newer ones arrive and memory stays bounded to
    //    `windowQuarters` quarters of aggregated rows.
    const window = new Map<number, Map<string, number>>();
    const nationalitiesSeen = new Set<string>();
    let rowsRead = 0;
    const SEP = "\u0000";

    await wb.streamRows(SHEET_OUTCOMES, (rowNumber, cells) => {
      if (rowNumber <= HEADER_ROW) return;
      const get = (name: string): string => clean(cells[col[name]] ?? "");
      const nationality = get("Nationality");
      const decisionsText = get("Decisions");
      // A row with neither a nationality nor a count is not data (blank line, footnote).
      if (!nationality && !decisionsText) return;
      rowsRead++;

      const q = parseQuarterLabel(get("Quarter"));
      const decisions = Number(decisionsText);
      if (!q || !nationality || !Number.isFinite(decisions) || decisions < 0 || !Number.isInteger(decisions)) {
        throw new OutcomeSchemaError(
          `Sheet ${SHEET_OUTCOMES} row ${rowNumber}: unreadable data ` +
            `(Quarter="${get("Quarter")}", Nationality="${nationality}", Decisions="${decisionsText}"). Nothing was imported.`
        );
      }
      nationalitiesSeen.add(nationality);

      // Keep only the latest `windowQuarters` quarters.
      const qi = quarterIndex(q);
      let bucket = window.get(qi);
      if (!bucket) {
        if (window.size >= windowQuarters) {
          const oldest = Math.min(...window.keys());
          if (qi < oldest) return; // older than everything kept: drop
          window.delete(oldest);
        }
        bucket = new Map();
        window.set(qi, bucket);
      }
      const key = [
        get("Visa type group"),
        get("Visa type"),
        get("Visa type subgroup"),
        get("Applicant type"),
        nationality,
        get("Case outcome"),
      ].join(SEP);
      bucket.set(key, (bucket.get(key) ?? 0) + decisions);
    });

    if (window.size === 0) {
      throw new OutcomeSchemaError(`Sheet ${SHEET_OUTCOMES} has no data rows. Nothing was imported.`);
    }

    // 3. Resolve overlapping applicant-type series within the window: for each
    //    (group, type, subgroup) that has an "All" series, use only that.
    const applicantTypes = new Map<string, Set<string>>(); // subgroup tuple -> applicant types present
    for (const bucket of window.values()) {
      for (const key of bucket.keys()) {
        const [group, type, subgroup, applicant] = key.split(SEP);
        const tuple = [group, type, subgroup].join(SEP);
        if (!applicantTypes.has(tuple)) applicantTypes.set(tuple, new Set());
        applicantTypes.get(tuple)!.add(applicant);
      }
    }

    // 4. Emit observations at group level and type level, with name -> code lookup.
    const unmapped = new Set<string>();
    for (const name of nationalitiesSeen) if (!UK_NATIONALITY_CODES[name]) unmapped.add(name);

    const observations: OutcomeObservation[] = [];
    for (const [qi, bucket] of window) {
      for (const [key, decisions] of bucket) {
        const [group, type, subgroup, applicant, nationality, outcomeLabel] = key.split(SEP);
        const present = applicantTypes.get([group, type, subgroup].join(SEP))!;
        if (present.has(APPLICANT_ALL) && applicant !== APPLICANT_ALL) continue; // covered by "All"

        const outcome = outcomeLabel === OUTCOME_GRANTED ? "granted" : outcomeLabel === OUTCOME_REFUSED ? "refused" : "other";
        const base = {
          nationalityName: nationality,
          nationalityCode: UK_NATIONALITY_CODES[nationality] ?? null,
          quarterIndex: qi,
          outcome,
          ...(outcome === "other" ? { otherLabel: outcomeLabel || "Other" } : {}),
          decisions,
        } as const;
        // The same decisions count once at each level (never twice at one level).
        observations.push({ ...base, categoryKey: `group:${slug(group)}`, categoryLabel: group });
        observations.push({ ...base, categoryKey: `type:${slug(group)}:${slug(type)}`, categoryLabel: type });
      }
    }

    return {
      observations,
      quarters: [...window.keys()].sort((a, b) => a - b),
      rowsRead,
      unmappedNames: [...unmapped].sort(),
      tableNames: [`Vis_D02 (data sheet ${SHEET_OUTCOMES})`],
      caveats: [...CAVEATS, ...(await readProvisionalCaveats(wb))],
    };
  }
}
