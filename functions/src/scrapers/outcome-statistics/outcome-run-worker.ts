import { Timestamp } from "firebase-admin/firestore";
import { collections } from "../../utils/firebase";
import { ImportAlreadyRunningError, outcomeImportService } from "./outcome-import.service";

// ============================================
// OUTCOME STATISTICS: "RUN NOW" WORKER (issue #116)
// ============================================
//
// Processes one `outcomeStatisticsRunRequests/{id}` doc written by the admin
// API (POST /admin/outcome-statistics/runs). Never throws: every outcome is
// written back on the request doc. The import itself writes its own run
// record (listed by GET /admin/outcome-statistics/runs).

class OutcomeRunWorker {
  async process(requestId: string): Promise<void> {
    const ref = collections.outcomeStatisticsRunRequests.doc(requestId);
    try {
      const snap = await ref.get();
      if (!snap.exists) return;
      const req = snap.data() as { destination: string; requestedBy: string | null; status: string };
      if (req.status !== "queued") return; // already handled

      await ref.update({ status: "running", startedAt: Timestamp.now() });
      const outcome = await outcomeImportService.run(req.destination, "manual", req.requestedBy);
      await ref.update({
        status: "done",
        finishedAt: Timestamp.now(),
        runId: outcome?.runId ?? null,
        result: outcome?.result ?? null,
        error: outcome?.error ?? null,
      });
    } catch (err) {
      // Already-running is an expected, non-fatal refusal.
      const message = err instanceof ImportAlreadyRunningError ? err.message : err instanceof Error ? err.message : String(err);
      console.error("Outcome-statistics run request failed:", err);
      await ref.update({ status: "failed", finishedAt: Timestamp.now(), error: message.slice(0, 2000) }).catch(() => undefined);
    }
  }
}

export const outcomeRunWorker = new OutcomeRunWorker();
