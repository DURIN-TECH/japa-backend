/**
 * One-time migration: backfill RBAC role claims for every existing Firebase Auth
 * user from current Firestore state.
 *
 * Reconciles the previous dual-admin model (custom claim vs `users/{id}.admin`
 * field) and the collection-lookup agent/owner model into a single canonical
 * `role` (+ `agencyId`) custom claim. Idempotent — safe to re-run.
 *
 * Run:  npm run build && node lib/scripts/backfill-claims.js
 * (Against the emulator: set FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST.)
 */
import { auth } from "../utils/firebase";
import { claimsService } from "../services/claims.service";

/**
 * Sync RBAC role claims for every Auth user from Firestore state. Exported so the
 * consolidated `seed-all` can run it in-process; also runnable standalone (guard
 * below). Idempotent.
 */
export async function backfillClaims(): Promise<void> {
  let nextPageToken: string | undefined;
  let total = 0;
  let synced = 0;
  const tally: Record<string, number> = { admin: 0, owner: 0, agent: 0, client: 0 };

  console.log("Backfilling RBAC role claims for all users…");
  do {
    const page = await auth.listUsers(1000, nextPageToken);
    for (const user of page.users) {
      total++;
      try {
        const { role, agencyId } = await claimsService.syncClaimsFromDb(user.uid);
        synced++;
        tally[role] = (tally[role] ?? 0) + 1;
        console.log(
          `  ✓ ${user.uid} ${user.email || ""} → role=${role} agencyId=${agencyId || "-"}`
        );
      } catch (error) {
        console.error(`  ✗ ${user.uid} (${user.email || ""}):`, error);
      }
    }
    nextPageToken = page.pageToken;
  } while (nextPageToken);

  console.log(
    `\nDone. ${synced}/${total} users synced — ` +
      `admin:${tally.admin} owner:${tally.owner} agent:${tally.agent} client:${tally.client}`
  );
}

// Allow `node lib/scripts/backfill-claims.js` to still run it directly.
if (require.main === module) {
  backfillClaims()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Backfill failed:", error);
      process.exit(1);
    });
}
