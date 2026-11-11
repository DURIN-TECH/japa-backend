/**
 * READ-ONLY audit of stored storage paths (issue #141).
 *
 * Background: a record that points at an uploaded file stores the object's
 * path, and the backend later signs a download link for that path. The path
 * originally came from the client. It is now validated when it is registered
 * and again before it is signed (utils/storage-paths.ts), so a record whose
 * path is outside its owner's upload folder can no longer be opened. This
 * script lists the records that ALREADY hold such a path, in one project, so
 * a human can see whether any exist, whose they are and what they point at.
 *
 * IT WRITES NOTHING. It only reads four Firestore collections (`documents`,
 * `applications`, `agents`, `agencies`) and prints a report. It does not
 * touch Cloud Storage or Auth at all. Fixing what it reports is a separate,
 * deliberate step (see "What to do with a finding" in the printed report).
 *
 * What it reports — every record whose stored path does NOT pass the same
 * validator the API uses, for the record's own owner:
 *  1. `documents/{id}.storageUrl` (application documents): must be an issued
 *     object under `documents/{document.userId}/{document.applicationId}/`.
 *     Also reported: a document whose `userId` is not the client of the
 *     application it names (or whose application is missing), because then
 *     "the owner's folder" itself is in doubt.
 *  2. `agents/{id}.verificationDocuments[]`: each entry must be an issued
 *     object under `verification/{agent.userId}/`.
 *  3. `agencies/{id}.compliance.{idDocumentPath,proofOfAddressPath,cacDocumentPath}`:
 *     each must be an issued object under `compliance/{agencyId}/{a known slot}/`.
 *
 * Each finding carries a severity:
 *  - "high": the path points INTO somebody else's upload folder or a
 *    backend-only prefix. Treat as a possible attempt to reach another
 *    user's file: find out who registered it and when.
 *  - "review": the path is malformed or in an unknown place, but does not
 *    name another owner's folder (for example the seeder's placeholder
 *    `gs://…/documents/seed-app-001/passport.pdf` records, which never
 *    pointed at a real object).
 *
 * Usage (run by a human, once per project; `npm run audit:storage-paths`
 * builds first):
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json> \
 *     npm run audit:storage-paths -- --project durin-seli-dev
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json> \
 *     npm run audit:storage-paths -- --project japa-platform
 *   # add --json to print the raw report object instead of text
 * A read-only role is enough (roles/datastore.viewer).
 *
 * Emulator safety (same rule as audit-role-trust.ts): when
 * FIRESTORE_EMULATOR_HOST is set, the Admin SDK reads the EMULATOR whatever
 * --project says. The script therefore refuses a non-demo project id in that
 * case (an empty emulator would otherwise look like an all-clear for the real
 * project) and prints a banner whenever it is reading an emulator.
 *
 * Against the emulator (how it is tested, see
 * test/emulator/audit-storage-paths.emu.ts): set FIRESTORE_EMULATOR_HOST and
 * pass a demo- project id.
 */

import type { CollectionReference } from "firebase-admin/firestore";
import {
  BACKEND_ONLY_PREFIXES,
  COMPLIANCE_DOCUMENT_SLOTS,
  StoragePathIssue,
  validateStoragePath,
} from "../utils/storage-paths";

// ============================================
// Types
// ============================================

/**
 * The read access the audit needs. Passed in (rather than imported) so the
 * audit can run against any initialised Admin SDK, and so it is obvious from
 * the signature that it gets four collections and nothing else.
 */
export interface StorageAuditSources {
  collections: {
    documents: CollectionReference;
    applications: CollectionReference;
    agents: CollectionReference;
    agencies: CollectionReference;
  };
}

/** How serious a finding is (see the file header). */
export type StorageAuditSeverity = "high" | "review";

/** Where a reported path points, as far as the path itself tells. */
export type PathTarget =
  | "BACKEND_ONLY" // under a backend-only prefix
  | "OTHER_OWNER_FOLDER" // a well-formed upload path in someone else's folder
  | "OTHER_UPLOAD_KIND" // the owner's id, but a different kind of upload folder
  | "SEED_PLACEHOLDER" // the seeder's made-up gs:// placeholder
  | "UNKNOWN"; // anything else (malformed, unknown prefix, not an issued name)

/** One stored path that failed validation. */
export interface StoredPathFinding {
  /** Firestore document that holds the path, e.g. `documents/abc`. */
  record: string;
  /** Field (and array index) the path was read from. */
  field: string;
  /** The stored value, as text. */
  storedPath: string;
  /** The folder the path was expected to be in. */
  expectedFolder: string;
  /** The validator's reason code. */
  issue: StoragePathIssue;
  target: PathTarget;
  severity: StorageAuditSeverity;
  /** The record's owner: user uid (documents, agents) or agency id. */
  owner: string | null;
  /** Who registered it, when the record says (documents only). */
  uploadedByUserId: string | null;
  /** When it was registered, ISO, when the record says. */
  recordedAt: string | null;
}

/** A document whose owner does not match its application's client. */
export interface DocumentOwnerFinding {
  record: string;
  applicationId: string | null;
  documentUserId: string | null;
  /** `applications/{id}.userId`, or null when the application is missing. */
  applicationUserId: string | null;
  applicationExists: boolean;
}

/** The whole report. Plain data: safe to JSON.stringify. */
export interface StorageAuditReport {
  totals: {
    documents: number;
    agents: number;
    /** Verification document entries across all agents. */
    verificationEntries: number;
    agencies: number;
    /** Compliance document paths across all agencies. */
    compliancePaths: number;
  };
  documentFindings: StoredPathFinding[];
  documentOwnerFindings: DocumentOwnerFinding[];
  verificationFindings: StoredPathFinding[];
  complianceFindings: StoredPathFinding[];
}

// ============================================
// Small helpers
// ============================================

/** A non-empty string field, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A Firestore Timestamp / Date field as an ISO string, or null. */
function iso(value: unknown): string | null {
  const v = value as { toDate?: () => Date } | Date | undefined;
  try {
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v.toDate === "function") return v.toDate().toISOString();
  } catch {
    // Not a date after all.
  }
  return null;
}

/** The stored value as printable text (it may not be a string). */
function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

/** The seeder's placeholder: gs://<bucket>/documents/seed-…  (data/seed-portal-data.ts). */
const SEED_PLACEHOLDER = /^gs:\/\/[^/]+\/documents\/seed-[^/]+\/[^/]+$/;

/** Top-level folders of the upload kinds that carry an owner id as the next segment. */
const OWNER_KEYED_FOLDERS = ["documents", "verification", "compliance", "agency-logos", "users"];

/**
 * Classify where a refused path points. `ownerIds` are the ids that would
 * make the path "the owner's own" (the user's uid, the agency id): a
 * well-formed path in an owner-keyed folder under a DIFFERENT id is another
 * owner's folder.
 */
function classify(stored: unknown, issue: StoragePathIssue, ownerIds: (string | null)[]): PathTarget {
  if (typeof stored !== "string") return "UNKNOWN";
  if (SEED_PLACEHOLDER.test(stored)) return "SEED_PLACEHOLDER";

  // Look at the key itself, ignoring a gs://bucket/ or leading slash in
  // front of it, so "gs://bucket/guidance-snapshots/…" is still recognised.
  const key = stored.replace(/^gs:\/\/[^/]+\//, "").replace(/^\/+/, "");
  const segments = key.split("/");
  if (issue === "BACKEND_ONLY_PREFIX" || BACKEND_ONLY_PREFIXES.includes(segments[0])) return "BACKEND_ONLY";
  if (OWNER_KEYED_FOLDERS.includes(segments[0]) && segments.length >= 2) {
    return ownerIds.includes(segments[1]) ? "OTHER_UPLOAD_KIND" : "OTHER_OWNER_FOLDER";
  }
  return "UNKNOWN";
}

/** Severity for a target: reaching into someone else's or the backend's files is high. */
function severityOf(target: PathTarget): StorageAuditSeverity {
  return target === "BACKEND_ONLY" || target === "OTHER_OWNER_FOLDER" ? "high" : "review";
}

// ============================================
// The audit (pure reads)
// ============================================

/**
 * Read the records of one project that store a storage path and report every
 * path the API's validator refuses for the record's own owner. Performs ONLY
 * collection `get()` calls.
 */
export async function auditStoragePaths(sources: StorageAuditSources): Promise<StorageAuditReport> {
  const { collections } = sources;

  // ---- Load everything once. `documents` is the largest of these; a full
  //      scan is intended (the audit is run by hand, once per project).
  const [documentSnap, applicationSnap, agentSnap, agencySnap] = await Promise.all([
    collections.documents.get(),
    collections.applications.select("userId").get(),
    collections.agents.get(),
    collections.agencies.get(),
  ]);

  /** applicationId -> the application's client uid (null when unset). */
  const clientByApplication = new Map<string, string | null>(
    applicationSnap.docs.map((d) => [d.id, str(d.data().userId)])
  );

  // ---- Section 1: application documents.
  const documentFindings: StoredPathFinding[] = [];
  const documentOwnerFindings: DocumentOwnerFinding[] = [];
  for (const d of documentSnap.docs) {
    const doc = d.data();
    const userId = str(doc.userId);
    const applicationId = str(doc.applicationId);

    // Exactly the check DocumentService.getDownloadUrl makes before signing.
    const check = validateStoragePath(doc.storageUrl, {
      purpose: "application-document",
      ownerUserId: userId as string,
      applicationId: applicationId as string,
    });
    if (!check.ok) {
      const target = classify(doc.storageUrl, check.issue, [userId]);
      documentFindings.push({
        record: `documents/${d.id}`,
        field: "storageUrl",
        storedPath: show(doc.storageUrl),
        expectedFolder: `documents/${userId ?? "(no userId)"}/${applicationId ?? "(no applicationId)"}/`,
        issue: check.issue,
        target,
        severity: severityOf(target),
        owner: userId,
        uploadedByUserId: str(doc.uploadedByUserId),
        recordedAt: iso(doc.uploadedAt),
      });
    }

    // The folder above is derived from the document's own userId; make sure
    // that userId really is the client of the application it names.
    const applicationExists = applicationId !== null && clientByApplication.has(applicationId);
    const applicationUserId = applicationExists ? clientByApplication.get(applicationId as string) ?? null : null;
    if (!applicationExists || applicationUserId !== userId) {
      documentOwnerFindings.push({
        record: `documents/${d.id}`,
        applicationId,
        documentUserId: userId,
        applicationUserId,
        applicationExists,
      });
    }
  }

  // ---- Section 2: agent verification documents.
  const verificationFindings: StoredPathFinding[] = [];
  let verificationEntries = 0;
  for (const d of agentSnap.docs) {
    const agent = d.data();
    const userId = str(agent.userId);
    const entries: unknown[] = Array.isArray(agent.verificationDocuments) ? agent.verificationDocuments : [];
    entries.forEach((entry, index) => {
      verificationEntries++;
      // Exactly the check the verification controller makes before signing.
      const check = validateStoragePath(entry, { purpose: "agent-verification", userId: userId as string });
      if (check.ok) return;
      const target = classify(entry, check.issue, [userId]);
      verificationFindings.push({
        record: `agents/${d.id}`,
        field: `verificationDocuments[${index}]`,
        storedPath: show(entry),
        expectedFolder: `verification/${userId ?? "(no userId)"}/`,
        issue: check.issue,
        target,
        severity: severityOf(target),
        owner: userId,
        uploadedByUserId: null,
        recordedAt: iso(agent.updatedAt),
      });
    });
  }

  // ---- Section 3: agency compliance documents.
  const complianceFindings: StoredPathFinding[] = [];
  let compliancePaths = 0;
  for (const d of agencySnap.docs) {
    const compliance = (d.data().compliance ?? {}) as Record<string, unknown>;
    for (const field of ["idDocumentPath", "proofOfAddressPath", "cacDocumentPath"]) {
      const stored = compliance[field];
      if (stored === undefined || stored === null || stored === "") continue;
      compliancePaths++;
      // Exactly the check the compliance controller makes before signing.
      const check = validateStoragePath(stored, {
        purpose: "compliance-document",
        agencyId: d.id,
        slots: COMPLIANCE_DOCUMENT_SLOTS,
      });
      if (check.ok) continue;
      const target = classify(stored, check.issue, [d.id]);
      complianceFindings.push({
        record: `agencies/${d.id}`,
        field: `compliance.${field}`,
        storedPath: show(stored),
        expectedFolder: `compliance/${d.id}/{${COMPLIANCE_DOCUMENT_SLOTS.join("|")}}/`,
        issue: check.issue,
        target,
        severity: severityOf(target),
        owner: d.id,
        uploadedByUserId: null,
        recordedAt: iso(compliance.updatedAt),
      });
    }
  }

  return {
    totals: {
      documents: documentSnap.size,
      agents: agentSnap.size,
      verificationEntries,
      agencies: agencySnap.size,
      compliancePaths,
    },
    documentFindings,
    documentOwnerFindings,
    verificationFindings,
    complianceFindings,
  };
}

// ============================================
// Text report
// ============================================

/** Render the report as plain text for a terminal. */
export function formatStorageAuditReport(report: StorageAuditReport, projectId: string): string {
  const lines: string[] = [];
  const add = (s = "") => lines.push(s);
  /** Print one section of path findings, high severity first. */
  const section = (findings: StoredPathFinding[]) => {
    const ordered = [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
    for (const f of ordered) {
      add(`   - [${f.severity}] ${f.record}  ${f.field}  owner=${f.owner ?? "(none)"}`);
      add(`       stored:   ${f.storedPath}`);
      add(`       expected: ${f.expectedFolder}<uuid>_<file>`);
      add(
        `       ${f.target} (${f.issue})` +
          (f.uploadedByUserId ? `  registered by ${f.uploadedByUserId}` : "") +
          (f.recordedAt ? `  at ${f.recordedAt}` : "")
      );
    }
  };
  const high = (findings: StoredPathFinding[]) => findings.filter((f) => f.severity === "high").length;

  add(`Stored storage-path audit for project: ${projectId}   (READ-ONLY: nothing was changed)`);
  add(
    `Scanned ${report.totals.documents} document records, ${report.totals.verificationEntries} verification ` +
      `entries on ${report.totals.agents} agents, ${report.totals.compliancePaths} compliance paths on ` +
      `${report.totals.agencies} agencies.`
  );

  add();
  add(
    `1. Application documents with a path outside the owner's folder: ${report.documentFindings.length}` +
      `  (${high(report.documentFindings)} high)`
  );
  section(report.documentFindings);

  add();
  add(`   Documents whose owner is not the client of their application: ${report.documentOwnerFindings.length}`);
  for (const f of report.documentOwnerFindings) {
    add(
      `   - ${f.record}  userId=${f.documentUserId ?? "(none)"}  application=${f.applicationId ?? "(none)"}  ` +
        (f.applicationExists ? `application.userId=${f.applicationUserId ?? "(unset)"}` : "APPLICATION MISSING")
    );
  }

  add();
  add(
    `2. Agent verification documents outside the agent's folder: ${report.verificationFindings.length}` +
      `  (${high(report.verificationFindings)} high)`
  );
  section(report.verificationFindings);

  add();
  add(
    `3. Agency compliance documents outside the agency's folder: ${report.complianceFindings.length}` +
      `  (${high(report.complianceFindings)} high)`
  );
  section(report.complianceFindings);

  add();
  add("What to do with a finding (by hand; the API already refuses to sign or delete every path listed here):");
  add("  - [high] OTHER_OWNER_FOLDER / BACKEND_ONLY: the record points at a file that is not its owner's. Find out");
  add("    who registered it (registered-by / owner above, request logs around the time shown) and whether the");
  add("    file it names was downloaded; then delete the RECORD (or the array entry), never the file it names.");
  add("  - [review] SEED_PLACEHOLDER: seeded demo records that never had a real file. Leave them or re-seed.");
  add("  - [review] anything else: check with the record's owner; they can delete it in the app and upload again.");
  add("  - Owner mismatch: confirm the document's userId against the application before trusting its folder.");
  return lines.join("\n");
}

// ============================================
// CLI
// ============================================

/** Parse --project <id> | --project=<id> | -p <id>, and --json. */
function parseArgs(argv: string[]): { project?: string; json: boolean } {
  let project: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--json") json = true;
  }
  return { project, json };
}

/** Entry point when run as `node lib/scripts/audit-storage-paths.js`. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Only Firestore is read, so only this variable redirects the audit.
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  const onEmulator = Boolean(emulatorHost);

  // Same project resolution as audit-role-trust.ts / seed-all.ts: no silent
  // default to a real project.
  const projectId =
    args.project ||
    process.env.SEED_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    (onEmulator ? "demo-seli" : undefined);
  if (!projectId) {
    console.error("\nNo target project. Pass --project <id> (or run against the emulator).\n");
    process.exit(1);
  }

  // Emulator safety. With the variable set, the SDK reads the emulator no
  // matter which project is named, so "nothing found" would say nothing about
  // the real project. Refuse a real project id outright.
  if (onEmulator) {
    if (!projectId.startsWith("demo-")) {
      console.error(
        `\nRefusing to audit project "${projectId}": FIRESTORE_EMULATOR_HOST=${emulatorHost} is set, so this run ` +
          "would read the EMULATOR, not that project, and its result would look like an all-clear.\n" +
          "Unset FIRESTORE_EMULATOR_HOST to audit the real project, or pass a demo- project id to audit the emulator.\n"
      );
      process.exit(1);
    }
    console.log(
      "\n************************************************************\n" +
        `* EMULATOR RUN (FIRESTORE_EMULATOR_HOST=${emulatorHost})\n` +
        `* Project "${projectId}" is a local emulator project.\n` +
        "* This says NOTHING about durin-seli-dev or japa-platform.\n" +
        "************************************************************"
    );
  }

  // Point the shared Admin SDK at this project BEFORE importing utils/firebase
  // (which initialises the app on import). Mirrors audit-role-trust.ts.
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  if (!onEmulator && !process.env.FIREBASE_STORAGE_BUCKET) {
    process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;
  }

  const { collections } = await import("../utils/firebase");
  const report = await auditStoragePaths({ collections });
  console.log(args.json ? JSON.stringify(report, null, 2) : `\n${formatStorageAuditReport(report, projectId)}\n`);
  process.exit(0);
}

// Only when executed directly: importing this module (tests) runs nothing.
if (require.main === module) {
  main().catch((error) => {
    console.error("\naudit-storage-paths failed:", error);
    process.exit(1);
  });
}
