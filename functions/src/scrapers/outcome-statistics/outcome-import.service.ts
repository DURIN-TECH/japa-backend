import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../../utils/firebase";
import type {
  OutcomeImportRun,
  OutcomeReleasePointer,
  OutcomeRunTrigger,
  OutcomeStatistic,
} from "../../types/outcome-statistics";
import { loadOutcomeSettings } from "../../services/outcome-statistics/config";
import { buildPeriod } from "../../services/outcome-statistics/period";
import { getReleasePointer, statisticDocId } from "../../services/outcome-statistics/outcome-statistics.service";
import { aggregateObservations } from "./outcome-aggregate";
import type { OutcomeDataSourceAdapter } from "./outcome-source-adapter";
import { getOutcomeAdapter } from "./registry";

// ============================================
// OUTCOME STATISTICS: IMPORT SERVICE (issue #116)
// ============================================
//
// Generic orchestrator: find the destination's current release (adapter),
// skip it if it is unchanged, download it, validate + read it (adapter),
// aggregate (pure), write, then switch the current-release pointer.
//
// Safety properties:
//  - NO PARTIAL REPLACE. A release's docs are written under a new releaseId and
//    the pointer (`outcomeStatisticsReleases/{destination}`) is flipped LAST.
//    The lookup only reads docs of the pointer's release, so a header mismatch,
//    a parse error or a crash mid-write leaves the previous data exactly as it
//    was. A failed attempt deletes its own half-written docs (best effort).
//  - IDEMPOTENT. The release file URL (which changes with every release) and
//    then the file's SHA-256 are compared with the current release; the same
//    file again writes nothing.
//  - MEMORY. The file is downloaded to the temp dir and read with the
//    streaming reader (xlsx-stream.ts); only the latest quarters are held.
//  - EVERY attempt leaves a run record, including failures and skips.
//
// Hosting: a function with 2 GB (index.ts: importOutcomeStatistics /
// processOutcomeStatisticsRunRequest). The temp dir of a function is memory
// backed, so the ~33 MB download counts toward that; the sheets themselves
// (~300 MB of XML) are streamed, never held.

/** How many latest quarters make a period ("year ending ..."). */
export const PERIOD_QUARTERS = 4;

/** A run still "running" after this long is treated as dead (function timeout is 9 min). */
const STALE_RUN_MS = 15 * 60 * 1000;

/** Docs per Firestore batch delete. */
const DELETE_PAGE = 400;

/** Another import for the destination is in progress. */
export class ImportAlreadyRunningError extends Error {
  constructor(destination: string) {
    super(`An outcome-statistics import for ${destination} is already running`);
    this.name = "ImportAlreadyRunningError";
  }
}

/** Unknown destination. */
export class UnknownDestinationError extends Error {
  constructor(destination: string) {
    super(`No outcome data source is registered for destination "${destination}"`);
    this.name = "UnknownDestinationError";
  }
}

/** What a run returns to its caller. */
export interface ImportOutcome {
  runId: string;
  result: OutcomeImportRun["result"];
  note: string | null;
  error: string | null;
}

/** Delete every statistic of (destination, releaseId); returns the count. */
async function deleteRelease(destination: string, releaseId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await collections.outcomeStatistics
      .where("destination", "==", destination)
      .where("releaseId", "==", releaseId)
      .limit(DELETE_PAGE)
      .get();
    if (snap.empty) return deleted;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
  }
}

export class OutcomeImportService {
  /**
   * Run one import for a destination.
   *
   * @param trigger "scheduled" honours the scheduledImportEnabled switch;
   *                "manual" (admin) always runs.
   * @param requestedBy uid of the admin for a manual run.
   * @returns what happened; failures are RETURNED (and recorded), not thrown,
   *          except ImportAlreadyRunningError / UnknownDestinationError which
   *          are thrown before a run record exists.
   */
  async run(destination: string, trigger: OutcomeRunTrigger, requestedBy: string | null = null): Promise<ImportOutcome | null> {
    const adapter = getOutcomeAdapter(destination);
    if (!adapter) throw new UnknownDestinationError(destination);

    // Kill switch for unattended runs only: return at once, no run record.
    if (trigger === "scheduled" && !(await loadOutcomeSettings()).scheduledImportEnabled) return null;

    // One import per destination at a time (stale "running" records are ignored).
    const running = await collections.outcomeStatisticsRuns
      .where("destination", "==", destination)
      .where("result", "==", "running")
      .get();
    const live = running.docs.some((d) => {
      const started = (d.data() as OutcomeImportRun).startedAt;
      return Date.now() - started.toMillis() < STALE_RUN_MS;
    });
    if (live) throw new ImportAlreadyRunningError(destination);

    // Run record, written first so even a crash leaves a trace.
    const runRef = collections.outcomeStatisticsRuns.doc();
    const run: OutcomeImportRun = {
      destination,
      trigger,
      requestedBy,
      result: "running",
      startedAt: Timestamp.now(),
      finishedAt: null,
      releaseDate: null,
      releaseLabel: null,
      fileName: null,
      fileUrl: null,
      fileHash: null,
      period: null,
      releaseId: null,
      counts: null,
      unmappedNames: [],
      error: null,
      note: null,
    };
    await runRef.set(run);

    const tmpPath = join(tmpdir(), `outcome-${destination}-${runRef.id}.xlsx`);
    // Holder object (not a bare variable) because execute() sets it from a callback.
    const created = { releaseId: null as string | null };
    try {
      const outcome = await this.execute(adapter, run, tmpPath, (id) => {
        created.releaseId = id;
      }, runRef.id);
      Object.assign(run, outcome);
    } catch (err) {
      run.result = "failed";
      run.error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
      // Remove our half-written docs; the pointer was never flipped, so the
      // previous release is untouched either way.
      if (created.releaseId) {
        const pointer = await getReleasePointer(destination).catch(() => null);
        if (!pointer || pointer.releaseId !== created.releaseId) {
          await deleteRelease(destination, created.releaseId).catch((e) => console.error("Cleanup of failed import failed:", e));
        }
      }
      console.error(`Outcome-statistics import (${destination}) failed:`, err);
    } finally {
      await unlink(tmpPath).catch(() => undefined); // no file if we never downloaded
      run.finishedAt = Timestamp.now();
      await runRef.set(run);
    }
    return { runId: runRef.id, result: run.result, note: run.note, error: run.error };
  }

  /** The import proper; mutates nothing but returns the fields to merge into the run. */
  private async execute(
    adapter: OutcomeDataSourceAdapter,
    run: OutcomeImportRun,
    tmpPath: string,
    onReleaseId: (id: string) => void,
    runId: string
  ): Promise<Partial<OutcomeImportRun>> {
    const destination = adapter.destination;

    // 1. Where is the current release?
    const release = await adapter.discoverRelease();
    run.releaseDate = release.releaseDate;
    run.releaseLabel = release.releaseLabel;
    run.fileName = release.fileName;
    run.fileUrl = release.fileUrl;
    const pointer = await getReleasePointer(destination);

    const base = {
      releaseDate: release.releaseDate,
      releaseLabel: release.releaseLabel,
      fileName: release.fileName,
      fileUrl: release.fileUrl,
    };

    // 2. Same file address as the current release: nothing to do, no download.
    if (pointer && pointer.fileUrl === release.fileUrl) {
      return { ...base, result: "skipped_unchanged", fileHash: pointer.fileHash, period: pointer.period, note: "Same release file address as the current release" };
    }

    // 3. Download (hashing as it streams), then compare the hash.
    const { sha256 } = await adapter.download(release, tmpPath);
    if (pointer && pointer.fileHash === sha256) {
      return { ...base, result: "skipped_unchanged", fileHash: sha256, period: pointer.period, note: "Same file content as the current release" };
    }
    run.fileHash = sha256;

    // 4. Validate headers + stream-read (throws OutcomeSchemaError BEFORE any write).
    const read = await adapter.read(tmpPath, PERIOD_QUARTERS);
    const period = buildPeriod(read.quarters);
    const stats = aggregateObservations(read.observations);
    if (stats.length === 0) throw new Error("The release produced no statistics; nothing was imported");

    // 5. Write all docs under a new releaseId. A re-import of the same file
    //    uses the same ids (overwrite); the pointer still decides what is live.
    const releaseId = sha256.slice(0, 16);
    onReleaseId(releaseId);
    const retrievedAt = Timestamp.now();
    const writer = db.bulkWriter();
    let writeFailures = 0;
    writer.onWriteError(() => {
      writeFailures++;
      return false; // do not retry: fail the whole import instead
    });
    for (const s of stats) {
      const doc: OutcomeStatistic = {
        destination,
        categoryKey: s.categoryKey,
        categoryLabel: s.categoryLabel,
        scope: s.scope,
        nationalityKey: s.nationalityKey,
        nationalityName: s.nationalityName,
        nationalityCode: s.nationalityCode,
        period,
        periodEnd: period.end,
        counts: s.counts,
        otherBreakdown: s.otherBreakdown,
        decisions: s.decisions,
        grantRate: s.grantRate,
        releaseId,
        source: {
          publisher: release.publisher,
          pageUrl: release.pageUrl,
          fileUrl: release.fileUrl,
          fileName: release.fileName,
          tableNames: read.tableNames,
          releaseLabel: release.releaseLabel,
          releaseDate: release.releaseDate,
          caveats: read.caveats,
        },
        retrievedAt,
      };
      void writer.set(collections.outcomeStatistics.doc(statisticDocId(destination, releaseId, s.categoryKey, s.nationalityKey)), doc);
    }
    await writer.close();
    if (writeFailures > 0) throw new Error(`${writeFailures} statistic write(s) failed; import aborted, previous data kept`);

    // 6. Flip the pointer LAST: from here the new release is live.
    const newPointer: OutcomeReleasePointer = {
      destination,
      releaseId,
      fileHash: sha256,
      fileUrl: release.fileUrl,
      pageUrl: release.pageUrl,
      fileName: release.fileName,
      releaseDate: release.releaseDate,
      releaseLabel: release.releaseLabel,
      periodEnd: period.end,
      period,
      runId,
      docsWritten: stats.length,
      importedAt: Timestamp.now(),
      previousReleaseId: pointer?.releaseId ?? null,
    };
    await collections.outcomeStatisticsReleases.doc(destination).set(newPointer);

    // 7. Old release is no longer read; delete it (best effort, the flip already happened).
    let oldDocsDeleted = 0;
    if (pointer && pointer.releaseId !== releaseId) {
      oldDocsDeleted = await deleteRelease(destination, pointer.releaseId).catch((e) => {
        console.error("Deleting the previous release failed (it is no longer read):", e);
        return 0;
      });
    }

    return {
      ...base,
      result: "imported",
      fileHash: sha256,
      period,
      releaseId,
      unmappedNames: read.unmappedNames,
      counts: {
        rowsRead: read.rowsRead,
        docsWritten: stats.length,
        nationalities: new Set(stats.filter((s) => s.scope === "nationality").map((s) => s.nationalityName)).size,
        categories: new Set(stats.map((s) => s.categoryKey)).size,
        oldDocsDeleted,
      },
    };
  }
}

export const outcomeImportService = new OutcomeImportService();
