// ============================================
// Unit tests: audit-visa-items (issue #212, criterion F)
// ============================================
// No network, no Firestore: the audit is pure over its inputs and the page
// fetch is a stub. Also pins "read-only by construction" and the project refusal.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

import { AUDIT_PROJECT, auditVisaItems, formatVisaItemsReport, type AuditedVisa } from "../../../src/scripts/audit-visa-items";
import type { SourceDocument } from "../../../src/scrapers/visa-catalog/adapters";

const SRC = path.join(__dirname, "../../../src/scripts/audit-visa-items.ts");

/** A fetched document carrying `items` (and optionally withdrawn). */
function doc(items: string[], withdrawn = false): SourceDocument {
  return {
    url: "u", canonicalUrl: "u", sourceProvider: "govuk-content-api", withdrawn, sections: [], text: "", contentHash: "h",
    listItems: items.map((text) => ({ text, leadIn: "You’ll need to provide:", section: "s" })),
  };
}
const visa = (id: string, docs: string[] | undefined, v = "old"): AuditedVisa => ({
  id, name: id, sourceUrl: `https://www.gov.uk/${id}`, requiredDocuments: docs,
  scrapeMeta: { extractorPromptVersion: v, citations: Object.fromEntries((docs ?? []).map((d, i) => [`requiredDocuments.${i}`, d])) },
});

describe("auditVisaItems", () => {
  test("one row per visa: matched / missing counts with verbatim missing items; every skip reason is listed", async () => {
    const visas = [
      visa("full", ["a", "b"]),
      visa("short", ["a"]),
      visa("gone", ["a"]),
      visa("err", ["a"]),
      visa("legacy", undefined),
    ];
    const report = await auditVisaItems(visas, async (v) => {
      if (v.id === "err") throw new Error("HTTP 500");
      if (v.id === "gone") return doc([], true);
      return doc(["a", "b"]);
    });
    assert.equal(report.approvedScrapedGbVisas, 5);
    assert.equal(report.project, AUDIT_PROJECT);
    const by = Object.fromEntries(report.rows.map((r) => [r.visaId, r]));
    assert.deepEqual([by.full.status, by.full.pageItems, by.full.matched, by.full.missing.length], ["checked", 2, 2, 0]);
    assert.deepEqual([by.short.status, by.short.pageItems, by.short.matched], ["checked", 2, 1]);
    assert.deepEqual(by.short.missing, [{ text: "b", leadIn: "You’ll need to provide:", section: "s" }]);
    assert.equal(by.gone.status, "page_withdrawn");
    assert.equal(by.err.status, "fetch_error");
    assert.equal(by.err.detail, "HTTP 500");
    assert.equal(by.legacy.status, "no_stored_documents");
    assert.equal(by.full.extractorPromptVersion, "old");
    const text = formatVisaItemsReport(report);
    assert.match(text, /Approved scraped GB visas found: 5/);
    assert.match(text, /gone: page_withdrawn/);
    assert.match(text, /\[s\] You’ll need to provide: b/);
  });
});

describe("read-only by construction", () => {
  test("the script contains no Firestore write call", () => {
    const src = fs.readFileSync(SRC, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const call of [/\.set\(/, /\.update\(/, /\.delete\(/, /\.add\(/, /\.create\(/, /batch\(/, /runTransaction/, /FieldValue/]) {
      assert.equal(call.test(src), false, String(call));
    }
  });
  test("it refuses to run against japa-platform or without a project (exit 1, before any Firebase init)", () => {
    for (const args of [["--project", "japa-platform"], []]) {
      let code = 0;
      try {
        execFileSync(process.execPath, ["--import", "tsx", SRC, ...args], {
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          stdio: "pipe",
        });
      } catch (e) {
        code = (e as { status?: number }).status ?? -1;
      }
      assert.equal(code, 1, args.join(" ") || "(no project)");
    }
  });
});
