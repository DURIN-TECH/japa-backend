// ============================================
// Unit tests — issue #413 (E): admin transaction filters never 500
// ============================================
//
// `GET /transactions?role=admin` pushes its equality filters (`type`,
// `paystackFeeStatus`, `status`, `applicationId`) and the date range into
// ONE Firestore query ordered by `createdAt` desc. Real Firestore refuses
// such a query without a matching composite index (FAILED_PRECONDITION, a
// 500); the emulator and the in-memory fake do not enforce indexes, so THIS
// test is the check:
//  - every combination the controller accepts is enumerated (all subsets of
//    the four equality filters, each with no dates, a start, an end, or both);
//  - each is either served (and then firestore.indexes.json has an index on
//    exactly those equality fields followed by `createdAt` DESCENDING; the
//    empty set uses Firestore's automatic single-field index), or refused by
//    the controller with 400 VALIDATION_ERROR naming the combination, before
//    any read;
//  - the D job's own query (paystackFeeStatus ==, createdAt asc) has its index.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { useHarness, harness, captureRes } from "../consultations/harness";
import { reqFor } from "../consultations/refund-fixtures";
import { transactionController } from "../../src/controllers/transaction.controller";
import {
  ADMIN_EQUALITY_FILTERS,
  AdminEqualityFilter,
  unsupportedAdminFilterCombination,
} from "../../src/services/transaction.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A platform admin. */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** One composite index as firestore.indexes.json stores it. */
interface IndexDef {
  collectionGroup: string;
  queryScope: string;
  fields: Array<{ fieldPath: string; order?: string }>;
}

/** The repo's index file (functions/ is the test cwd; the file is one level up). */
const INDEXES: IndexDef[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "firestore.indexes.json"), "utf8")
).indexes;

/** A sample value per filter (only presence matters for the index). */
const SAMPLE: Record<AdminEqualityFilter, string> = {
  type: "refund",
  paystackFeeStatus: "unknown",
  status: "failed",
  applicationId: "app-1",
};

/** Every subset of the admin equality filters. */
function subsets(): AdminEqualityFilter[][] {
  const out: AdminEqualityFilter[][] = [];
  const all = [...ADMIN_EQUALITY_FILTERS];
  for (let mask = 0; mask < 1 << all.length; mask++) out.push(all.filter((_, i) => mask & (1 << i)));
  return out;
}

/** The date-range variants the controller accepts. */
const DATES: Array<Record<string, string>> = [
  {},
  { startDate: "2026-11-01T00:00:00Z" },
  { endDate: "2026-11-30T00:00:00Z" },
  { startDate: "2026-11-01T00:00:00Z", endDate: "2026-11-30T00:00:00Z" },
];

/**
 * Whether firestore.indexes.json can serve equality on `fields` ordered by
 * `createdAt` (`order`): an index on transactions whose fields are exactly
 * those equality fields (any order among them) followed by createdAt.
 */
function hasIndex(fields: string[], order: "ASCENDING" | "DESCENDING"): boolean {
  if (fields.length === 0) return true; // single-field createdAt: automatic
  return INDEXES.some((ix) => {
    if (ix.collectionGroup !== "transactions" || ix.queryScope !== "COLLECTION") return false;
    if (ix.fields.length !== fields.length + 1) return false;
    const last = ix.fields[ix.fields.length - 1];
    if (last.fieldPath !== "createdAt" || last.order !== order) return false;
    const eq = ix.fields.slice(0, -1).map((f) => f.fieldPath).sort();
    return JSON.stringify(eq) === JSON.stringify([...fields].sort());
  });
}

before(async () => {
  await useHarness();
});
beforeEach(() => {
  harness.reset();
});

describe("admin transaction filters: an index or a 400, never a 500 (issue #413 E)", () => {
  for (const set of subsets()) {
    for (const dates of DATES) {
      const name = `${set.length ? set.join(" + ") : "(no equality filter)"}${Object.keys(dates).length ? ` + ${Object.keys(dates).join(" + ")}` : ""}`;
      test(name, async () => {
        const query: Record<string, string> = { role: "admin", ...dates };
        for (const key of set) query[key] = SAMPLE[key];
        const supported = unsupportedAdminFilterCombination(query as any) === null;
        const { out, res } = captureRes();
        await transactionController.getTransactions(reqFor(admin, { query }), res);
        if (supported) {
          assert.ok(hasIndex(set, "DESCENDING"), `firestore.indexes.json lacks transactions(${set.join(", ")}, createdAt desc)`);
          assert.equal(out.status, 200, JSON.stringify(out.body));
        } else {
          assert.equal(out.status, 400, JSON.stringify(out.body));
          assert.equal(out.body.error, "VALIDATION_ERROR");
          for (const key of set) assert.ok(out.body.message.includes(key), `the message names ${key}`);
        }
      });
    }
  }

  test("the ones the issue names are served: paystackFeeStatus alone, + status, + a date range", () => {
    for (const filters of [
      { paystackFeeStatus: "unknown" },
      { paystackFeeStatus: "unknown", status: "completed" },
      { paystackFeeStatus: "unknown", startDate: "2026-11-01", endDate: "2026-11-30" },
    ]) {
      assert.equal(unsupportedAdminFilterCombination(filters as any), null, JSON.stringify(filters));
    }
  });

  test("the fee lookup job's query (paystackFeeStatus ==, createdAt asc) has its index (D)", () => {
    assert.ok(hasIndex(["paystackFeeStatus"], "ASCENDING"));
  });
});
