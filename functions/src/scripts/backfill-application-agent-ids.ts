/**
 * One-time repair: rewrite `Application.agentId` values that hold an
 * AgentProfile DOC id so they hold the agent's USER uid.
 *
 * WHY: `Application.agentId` is a user uid — assigned-case queries
 * (`getAgentApplications`) filter on it, and the CASL ability grants an agent
 * write access via `{ agentId: uid }`. The portal's case-assignment UI sent the
 * AgentProfile document id instead, which is an unrelated auto-generated id.
 * Nothing errored; the case simply detached:
 *
 *   • it disappeared from the assigned agent's case list,
 *   • its documents returned 403, so the case's Documents table sat empty, and
 *   • the assigned agent could not upload or review documents on it.
 *
 * The write paths are fixed (the portal now sends the uid, and the API
 * normalizes whatever it receives), but cases assigned before that fix still
 * carry the wrong id and stay broken until this runs.
 *
 * Idempotent: an `agentId` that is not an AgentProfile doc id is left alone, so
 * correct rows are untouched and re-running is safe.
 *
 * Run:  npm run build && node lib/scripts/backfill-application-agent-ids.js
 * (Against the emulator: set FIRESTORE_EMULATOR_HOST. Against a real project,
 *  select it as the other scripts do, e.g. GCLOUD_PROJECT=durin-seli-dev.)
 *
 * Dry run (report only, change nothing):  DRY_RUN=1 node lib/scripts/…js
 */
import { collections } from "../utils/firebase";
import { Application } from "../types";

export async function backfillApplicationAgentIds(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1";
  console.log(
    `Repairing Application.agentId values${dryRun ? " (DRY RUN — no writes)" : ""}…`
  );

  const snapshot = await collections.applications.get();

  // AgentProfile doc id → userId. Cached because many applications typically
  // point at the same handful of agents.
  const profileToUid = new Map<string, string | null>();

  let total = 0;
  let repaired = 0;
  let alreadyCorrect = 0;
  let unresolved = 0;

  for (const doc of snapshot.docs) {
    total++;
    const application = doc.data() as Application;
    const agentId = application.agentId;

    // Unassigned cases have nothing to repair.
    if (!agentId) {
      alreadyCorrect++;
      continue;
    }

    // Is this value an AgentProfile doc id? If the lookup misses, the value is
    // already a uid (or something we shouldn't touch) — leave it.
    if (!profileToUid.has(agentId)) {
      const profile = await collections.agents.doc(agentId).get();
      const uid = profile.exists
        ? ((profile.data() as { userId?: string }).userId ?? null)
        : null;
      profileToUid.set(agentId, uid);
    }

    const resolvedUid = profileToUid.get(agentId) ?? null;

    if (!resolvedUid) {
      alreadyCorrect++;
      continue;
    }

    // Guard against an agent profile with no userId — rewriting to an empty
    // string would detach the case just as badly as leaving it.
    if (!resolvedUid.trim()) {
      unresolved++;
      console.warn(
        `  ! ${application.id}: agent profile ${agentId} has no userId — left as-is`
      );
      continue;
    }

    if (!dryRun) {
      await doc.ref.update({ agentId: resolvedUid });
    }
    repaired++;
    console.log(`  ✓ ${application.id}: ${agentId} → ${resolvedUid}`);
  }

  console.log(
    `\nDone. ${total} applications — ${repaired} repaired, ` +
      `${alreadyCorrect} already correct/unassigned, ${unresolved} unresolved.`
  );
  if (dryRun && repaired > 0) {
    console.log("DRY RUN — re-run without DRY_RUN=1 to apply these changes.");
  }
}

// Allow `node lib/scripts/backfill-application-agent-ids.js` to run it directly.
if (require.main === module) {
  backfillApplicationAgentIds()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Agent id backfill failed:", error);
      process.exit(1);
    });
}
