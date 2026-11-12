/**
 * Backfill: raise "shared contact across accounts" risk signals (issue #121)
 * for users that already exist.
 *
 * The trigger only looks at users whose phone / email changes from now on;
 * this scans everyone once. It uses the same rule and the same runner as the
 * trigger, so the results are identical, and it is IDEMPOTENT: a signal's
 * dedupe key comes from the hash of the shared value, so a re-run finds the
 * existing signal ("unchanged") and creates nothing new.
 *
 * It only raises signals (admin-only). It changes no user, application or
 * agency, and sends nothing.
 *
 * Run:  npm run backfill:risk-shared-contact:dev
 * Dry run (report only, raise nothing):  DRY_RUN=1 node lib/scripts/backfill-shared-contact-signals.js
 */
import { collections } from "../utils/firebase";
import { CONTACT_FIELDS, evaluateSharedContact } from "../services/risk-rules/shared-contact.runner";
import { SHARED_CONTACT_MIN_ACCOUNTS } from "../services/risk-rules/shared-contact.rule";
import { contactKey } from "../services/risk-rules/contact-normalise";

export async function backfillSharedContactSignals(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1";
  console.log(`Scanning users for shared contact details${dryRun ? " (DRY RUN, no signals raised)" : ""}...`);

  // Only the two contact fields are needed; avoids pulling whole profiles.
  const snapshot = await collections.users.select("phone", "email").get();

  // kind -> normalised value -> user ids. Held in memory only; never logged.
  const groups = {
    phone: new Map<string, string[]>(),
    email: new Map<string, string[]>(),
  };
  for (const doc of snapshot.docs) {
    const data = doc.data() as Record<string, unknown>;
    for (const { field, kind } of CONTACT_FIELDS) {
      const key = contactKey(kind, data[field]);
      if (!key) continue; // empty / placeholder
      const list = groups[kind].get(key) ?? [];
      list.push(doc.id);
      groups[kind].set(key, list);
    }
  }

  let candidates = 0;
  let raised = 0;
  let none = 0;
  let errors = 0;
  for (const { kind } of CONTACT_FIELDS) {
    for (const [key, ids] of groups[kind]) {
      // Cheap pre-filter: fewer user docs than N can never reach N accounts.
      if (ids.length < SHARED_CONTACT_MIN_ACCOUNTS) continue;
      candidates++;
      if (dryRun) {
        console.log(`  candidate ${kind} value shared by ${ids.length} profiles`);
        continue;
      }
      const outcome = await evaluateSharedContact(kind, key, ids);
      if (outcome === "raised") raised++;
      else if (outcome === "error") errors++;
      else none++;
    }
  }

  console.log(
    `\nDone. ${snapshot.size} users scanned, ${candidates} candidate values, ` +
      `${raised} evaluated and raised/merged, ${none} below threshold or exempt, ${errors} errors.`
  );
}

if (require.main === module) {
  backfillSharedContactSignals()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Shared contact backfill failed:", error instanceof Error ? error.name : error);
      process.exit(1);
    });
}
