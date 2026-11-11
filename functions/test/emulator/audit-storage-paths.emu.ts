// ============================================
// Emulator test — the read-only stored storage-path audit (issue #141)
// ============================================
//
// Run with `npm run test:emulator`. Seeds the Firestore emulator with clean
// records (a document, an agent's verification entry, an agency's compliance
// paths, all inside their owners' folders) and one example of each kind of
// bad stored path, then checks that:
//  - every planted bad path is reported, with the right target and severity,
//  - the clean records are NOT reported,
//  - the audit changed nothing (every audited document is identical, down to
//    its update time, before and after),
//  - the command a human runs (`audit-storage-paths --project <id>`) works
//    end to end, announces that it read an emulator, and refuses a real
//    project id while the emulator variable is set.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { PROJECT_ID, resetEmulators, rulesEnv } from "./helpers";
import {
  auditStoragePaths,
  formatStorageAuditReport,
  StorageAuditReport,
  StoredPathFinding,
} from "../../src/scripts/audit-storage-paths";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** An issued-looking object name. */
const NAME = "0f8fad5b-d9cb-469f-a165-70867728950e_file.pdf";

let report: StorageAuditReport;
let stateBefore: unknown;
let stateAfter: unknown;

/** Everything the audit reads, in a comparable form. */
async function snapshotState(): Promise<unknown> {
  const { collections } = await import("../../src/utils/firebase");
  const dump = async (c: any) =>
    (await c.get()).docs
      .map((d: any) => ({ id: d.id, data: JSON.stringify(d.data()), updated: d.updateTime.toMillis() }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id));
  return {
    documents: await dump(collections.documents),
    applications: await dump(collections.applications),
    agents: await dump(collections.agents),
    agencies: await dump(collections.agencies),
  };
}

/** The finding for one record (and field), or undefined. */
function finding(list: StoredPathFinding[], record: string, field?: string): StoredPathFinding | undefined {
  return list.find((f) => f.record === record && (field === undefined || f.field === field));
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  const { collections } = await import("../../src/utils/firebase");

  // ---- Applications: one per client.
  await collections.applications.doc("app-a").set({ id: "app-a", userId: "client-a" });
  await collections.applications.doc("app-b").set({ id: "app-b", userId: "client-b" });

  /** Write a document record with the given stored path. */
  const doc = (id: string, storageUrl: unknown, extra: Record<string, unknown> = {}) =>
    collections.documents.doc(id).set({
      applicationId: "app-a",
      userId: "client-a",
      storageUrl,
      uploadedByUserId: "client-a",
      uploadedAt: new Date("2026-06-01T10:00:00Z"),
      ...extra,
    });

  // Clean: own folder, own application; and one filed by staff on behalf.
  await doc("doc-clean", `documents/client-a/app-a/${NAME}`);
  await doc("doc-clean-on-behalf", `documents/client-a/app-a/${NAME}`, { uploadedByUserId: "agent-user" });
  // Bad paths.
  await doc("doc-other-client", `documents/client-b/app-b/${NAME}`);
  await doc("doc-other-application", `documents/client-a/app-b/${NAME}`);
  await doc("doc-backend-only", "guidance-snapshots/source-1/abc.json");
  await doc("doc-verification-folder", `verification/agent-user/${NAME}`);
  await doc("doc-own-other-kind", `verification/client-a/${NAME}`);
  await doc("doc-seed-placeholder", "gs://japa-platform.firebasestorage.app/documents/seed-app-001/passport.pdf");
  await doc("doc-not-a-string", { path: "x" });
  // Clean path for its own userId, but that user is not the application's client.
  await doc("doc-owner-mismatch", `documents/client-b/app-a/${NAME}`, { userId: "client-b" });
  await doc("doc-missing-application", `documents/client-a/app-gone/${NAME}`, { applicationId: "app-gone" });

  // ---- Agents.
  await collections.agents.doc("agent-clean").set({
    id: "agent-clean",
    userId: "agent-user",
    verificationDocuments: [`verification/agent-user/${NAME}`],
  });
  await collections.agents.doc("agent-none").set({ id: "agent-none", userId: "agent-none-user" });
  await collections.agents.doc("agent-bad").set({
    id: "agent-bad",
    userId: "bad-agent-user",
    verificationDocuments: [
      `verification/bad-agent-user/${NAME}`, // fine
      `verification/agent-user/${NAME}`, // another agent's
      `documents/client-a/app-a/${NAME}`, // a client's document
      "guidance-snapshots/source-1/abc.json",
    ],
  });

  // ---- Agencies.
  await collections.agencies.doc("agency-clean").set({
    id: "agency-clean",
    compliance: {
      status: "in_progress",
      idDocumentPath: `compliance/agency-clean/idDocument/${NAME}`,
      // Registered against a different slot than its folder: still the
      // agency's own file, so not a finding.
      cacDocumentPath: `compliance/agency-clean/proofOfAddress/${NAME}`,
    },
  });
  await collections.agencies.doc("agency-bad").set({
    id: "agency-bad",
    compliance: {
      status: "in_progress",
      idDocumentPath: `compliance/agency-clean/idDocument/${NAME}`, // another agency's
      proofOfAddressPath: `compliance/agency-bad/proofOfAddress/not-issued.pdf`,
    },
  });
  await collections.agencies.doc("agency-no-compliance").set({ id: "agency-no-compliance" });

  stateBefore = await snapshotState();
  report = await auditStoragePaths({ collections });
  stateAfter = await snapshotState();
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

describe("audit-storage-paths", () => {
  test("it changes nothing", () => {
    assert.deepEqual(stateAfter, stateBefore);
  });

  test("totals count what was scanned", () => {
    assert.deepEqual(report.totals, {
      documents: 11,
      agents: 3,
      verificationEntries: 5,
      agencies: 3,
      compliancePaths: 4,
    });
  });

  test("application documents: every bad path is reported with its target and severity; clean ones are not", () => {
    const summary = Object.fromEntries(
      report.documentFindings.map((f) => [f.record, `${f.severity} ${f.target} ${f.issue}`])
    );
    assert.deepEqual(summary, {
      "documents/doc-other-client": "high OTHER_OWNER_FOLDER WRONG_PREFIX",
      // Same client, different application: the client's own files, so review.
      "documents/doc-other-application": "review OTHER_UPLOAD_KIND WRONG_PREFIX",
      "documents/doc-backend-only": "high BACKEND_ONLY BACKEND_ONLY_PREFIX",
      "documents/doc-verification-folder": "high OTHER_OWNER_FOLDER WRONG_PREFIX",
      "documents/doc-own-other-kind": "review OTHER_UPLOAD_KIND WRONG_PREFIX",
      "documents/doc-seed-placeholder": "review SEED_PLACEHOLDER HAS_SCHEME",
      "documents/doc-not-a-string": "review UNKNOWN NOT_A_STRING",
    });
    const other = finding(report.documentFindings, "documents/doc-other-client")!;
    assert.equal(other.expectedFolder, "documents/client-a/app-a/");
    assert.equal(other.owner, "client-a");
    assert.equal(other.uploadedByUserId, "client-a");
    assert.equal(other.recordedAt, "2026-06-01T10:00:00.000Z");
  });

  test("documents whose owner is not their application's client are listed separately", () => {
    assert.deepEqual(
      report.documentOwnerFindings.map((f) => [f.record, f.applicationExists, f.applicationUserId]),
      [
        ["documents/doc-missing-application", false, null],
        ["documents/doc-owner-mismatch", true, "client-a"],
      ]
    );
  });

  test("agent verification entries outside the agent's folder are reported, per entry", () => {
    assert.deepEqual(
      report.verificationFindings.map((f) => [f.record, f.field, f.severity, f.target]),
      [
        ["agents/agent-bad", "verificationDocuments[1]", "high", "OTHER_OWNER_FOLDER"],
        ["agents/agent-bad", "verificationDocuments[2]", "high", "OTHER_OWNER_FOLDER"],
        ["agents/agent-bad", "verificationDocuments[3]", "high", "BACKEND_ONLY"],
      ]
    );
  });

  test("agency compliance paths outside the agency's folder are reported", () => {
    assert.deepEqual(
      report.complianceFindings.map((f) => [f.record, f.field, f.severity, f.target, f.issue]),
      [
        ["agencies/agency-bad", "compliance.idDocumentPath", "high", "OTHER_OWNER_FOLDER", "WRONG_PREFIX"],
        ["agencies/agency-bad", "compliance.proofOfAddressPath", "review", "OTHER_UPLOAD_KIND", "NOT_AN_ISSUED_NAME"],
      ]
    );
  });

  test("the text report lists the findings and says it is read-only", () => {
    const text = formatStorageAuditReport(report, PROJECT_ID);
    assert.match(text, /READ-ONLY: nothing was changed/);
    assert.match(text, /1\. Application documents with a path outside the owner's folder: 7 {2}\(3 high\)/);
    assert.match(text, /2\. Agent verification documents outside the agent's folder: 3 {2}\(3 high\)/);
    assert.match(text, /3\. Agency compliance documents outside the agency's folder: 2 {2}\(1 high\)/);
    assert.match(text, /stored: {3}guidance-snapshots\/source-1\/abc\.json/);
  });

  test("the CLI runs against the emulator, prints the report with an emulator banner, and writes nothing", async () => {
    const cwd = path.resolve(__dirname, "../..");
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/scripts/audit-storage-paths.ts", "--project", PROJECT_ID],
      { cwd, env: process.env, encoding: "utf8" }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Stored storage-path audit for project/);
    assert.match(run.stdout, /Scanned 11 document records/);
    assert.match(run.stdout, /EMULATOR RUN/);
    assert.match(run.stdout, /says NOTHING about durin-seli-dev or japa-platform/);
    assert.deepEqual(await snapshotState(), stateBefore);

    // --json prints the report object.
    const json = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/scripts/audit-storage-paths.ts", "--project", PROJECT_ID, "--json"],
      { cwd, env: process.env, encoding: "utf8" }
    );
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout.slice(json.stdout.indexOf("{")));
    assert.equal(parsed.documentFindings.length, 7);
  });

  test("with the emulator variable set, a real project id is refused (no silent all-clear)", () => {
    const cwd = path.resolve(__dirname, "../..");
    for (const project of ["durin-seli-dev", "japa-platform"]) {
      const refused = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/scripts/audit-storage-paths.ts", "--project", project],
        { cwd, env: process.env, encoding: "utf8" }
      );
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, new RegExp(`Refusing to audit project "${project}"`));
      assert.match(refused.stderr, /would read the EMULATOR/);
      assert.doesNotMatch(refused.stdout, /Stored storage-path audit/); // no report printed
    }
  });
});
