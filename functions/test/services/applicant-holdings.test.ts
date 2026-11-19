// ============================================
// Unit tests — "What you hold": profile endpoints' service and the copy an
// application takes (issue #234, P5 of #228)
// ============================================
//
// The service over an in-memory store (no Firestore, no emulator). Covers:
// validation (codes, kinds, exactly one issuer, real dates, past dates stored
// but expired, bounds, unknown keys refused), add / remove / replace, the
// "not stated" vs "none" difference, the copy with its time taken, the
// controller acting on the caller's own uid only, and case lists stripping the
// copy. Every code and id is made up.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import {
  ApplicantHoldingsService,
  HoldingsValidationError,
  applicantFactsFromUser,
  holdingsViewOf,
  readHeldDocument,
  readHoldingsPatch,
  readNationalities,
  type HoldingsStore,
} from "../../src/services/applicant-holdings.service";
import { ApplicantHoldingsController } from "../../src/controllers/applicant-holdings.controller";
import { withoutApplicantFacts } from "../../src/controllers/application.controller";
import type { User } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 2026-11-14T10:00:00Z: "today" for every test. */
const NOW_MS = Date.parse("2026-11-14T10:00:00Z");

/** An in-memory store of user profiles and authority ids, recording every write. */
function memoryStore(users: Record<string, Partial<User>>, authorities: string[] = []): HoldingsStore & { writes: Array<{ uid: string; fields: Record<string, unknown> }> } {
  const writes: Array<{ uid: string; fields: Record<string, unknown> }> = [];
  return {
    writes,
    async readUser(uid) {
      return (users[uid] as User) ?? null;
    },
    async writeHoldings(uid, fields) {
      writes.push({ uid, fields });
      users[uid] = { ...users[uid], ...(fields as Partial<User>) };
    },
    async authorityExists(id) {
      return authorities.includes(id);
    },
  };
}

/** Ids made in order, so assertions are stable. */
function ids() {
  let n = 0;
  return () => `doc-${++n}`;
}

/** Expect a validation refusal naming `field`. */
function refuses(fn: () => unknown, field: string) {
  assert.throws(fn, (e: unknown) => e instanceof HoldingsValidationError && e.field === field);
}

describe("validation (pure)", () => {
  test("nationalities: two-letter codes, case folded, duplicates dropped, at most five", () => {
    assert.deepEqual(readNationalities(["qa", "QB", "QA"]), ["QA", "QB"]);
    refuses(() => readNationalities(["QAX"]), "nationalities");
    refuses(() => readNationalities("QA"), "nationalities");
    refuses(() => readNationalities(["QA", "QB", "QC", "QD", "QE", "QF"]), "nationalities");
  });

  test("a held document: one issuer exactly, a real date, a known kind, a short note", () => {
    const make = ids();
    assert.deepEqual(readHeldDocument({ kind: "visa", issuerCountryCode: "qd", validUntil: "2027-02-28", note: "  multiple entry  " }, new Set(), make), { id: "doc-1", kind: "visa", issuerCountryCode: "QD", validUntil: "2027-02-28", note: "multiple entry" });
    assert.deepEqual(readHeldDocument({ kind: "residence_permit", issuerAuthorityId: "zq-bloc", validUntil: "2020-01-01" }, new Set(), make), { id: "doc-2", kind: "residence_permit", issuerAuthorityId: "zq-bloc", validUntil: "2020-01-01" }, "a past date is accepted (stored, then reported expired)");
    refuses(() => readHeldDocument({ kind: "passport", issuerCountryCode: "QD", validUntil: "2027-01-01" }, new Set()), "kind");
    refuses(() => readHeldDocument({ kind: "visa", validUntil: "2027-01-01" }, new Set()), "issuer");
    refuses(() => readHeldDocument({ kind: "visa", issuerCountryCode: "QD", issuerAuthorityId: "zq-bloc", validUntil: "2027-01-01" }, new Set()), "issuer");
    refuses(() => readHeldDocument({ kind: "visa", issuerCountryCode: "QD", validUntil: "2027-02-30" }, new Set()), "validUntil");
    refuses(() => readHeldDocument({ kind: "visa", issuerCountryCode: "QD", validUntil: "1800-01-01" }, new Set()), "validUntil");
    refuses(() => readHeldDocument({ kind: "visa", issuerAuthorityId: "q_x", validUntil: "2027-01-01" }, new Set()), "issuerAuthorityId");
    refuses(() => readHeldDocument({ kind: "visa", issuerCountryCode: "QD", validUntil: "2027-01-01", note: "x".repeat(201) }, new Set()), "note");
  });

  test("an edit keeps a known id; an unknown id gets a new one", () => {
    assert.equal(readHeldDocument({ id: "keep", kind: "visa", issuerCountryCode: "QD", validUntil: "2027-01-01" }, new Set(["keep"]), ids()).id, "keep");
    assert.equal(readHeldDocument({ id: "forged", kind: "visa", issuerCountryCode: "QD", validUntil: "2027-01-01" }, new Set(["keep"]), ids()).id, "doc-1");
  });

  test("a PUT body: only the three fields, at least one; unknown keys are refused, not dropped", () => {
    assert.deepEqual(readHoldingsPatch({ residentialCountry: null }, new Set()), { residentialCountry: null });
    refuses(() => readHoldingsPatch({ nationality: ["QA"] }, new Set()), "nationality");
    refuses(() => readHoldingsPatch({}, new Set()), "");
    refuses(() => readHoldingsPatch([], new Set()), "");
  });
});

describe("the service: the caller's own profile", () => {
  test("nothing stated: empty nationalities, null residence, null documents (never stated)", async () => {
    const svc = new ApplicantHoldingsService(memoryStore({ u1: { residentialCountry: "Somewhere" } }), () => NOW_MS);
    assert.deepEqual(await svc.get("u1"), { nationalities: [], residentialCountry: null, heldDocuments: null, updatedAt: null }, "a legacy non-code residence is not guessed from");
    assert.deepEqual(await svc.get("nobody"), { nationalities: [], residentialCountry: null, heldDocuments: null, updatedAt: null });
  });

  test("PUT replaces the fields given and stamps the time; documents are marked expired against today", async () => {
    const store = memoryStore({ u1: {} });
    const svc = new ApplicantHoldingsService(store, () => NOW_MS);
    const view = await svc.update("u1", {
      nationalities: ["QA", "QB"],
      residentialCountry: "QC",
      heldDocuments: [
        { kind: "visa", issuerCountryCode: "QD", validUntil: "2026-11-14" },
        { kind: "visa", issuerCountryCode: "QE", validUntil: "2026-11-13" },
      ],
    });
    assert.deepEqual(view.nationalities, ["QA", "QB"]);
    assert.equal(view.residentialCountry, "QC");
    assert.deepEqual(view.heldDocuments?.map((d) => [d.issuerCountryCode, d.expired]), [["QD", false], ["QE", true]], "valid through its last day");
    assert.equal(view.updatedAt, new Date(NOW_MS).toISOString());
    assert.equal(store.writes.length, 1);
    assert.deepEqual(Object.keys(store.writes[0].fields).sort(), ["heldDocuments", "holdingsUpdatedAt", "nationalities", "residentialCountry", "updatedAt"], "nothing else on the profile is written");
  });

  test("an issuer authority must exist", async () => {
    const svc = new ApplicantHoldingsService(memoryStore({ u1: {} }, ["zq-bloc"]), () => NOW_MS);
    await assert.rejects(svc.addDocument("u1", { kind: "visa", issuerAuthorityId: "zq-other", validUntil: "2027-01-01" }), (e: any) => e.field === "issuerAuthorityId");
    const ok = await svc.addDocument("u1", { kind: "visa", issuerAuthorityId: "zq-bloc", validUntil: "2027-01-01" });
    assert.equal(ok.heldDocuments?.length, 1);
  });

  test("add then remove: removing the last document leaves [] (holds none), not 'never stated'", async () => {
    const users: Record<string, Partial<User>> = { u1: {} };
    const svc = new ApplicantHoldingsService(memoryStore(users), () => NOW_MS);
    const added = await svc.addDocument("u1", { kind: "travel_authorisation", issuerCountryCode: "QF", validUntil: "2028-01-01" });
    const id = added.heldDocuments![0].id;
    await assert.rejects(svc.removeDocument("u1", "not-there"), (e: any) => e.status === 404);
    const removed = await svc.removeDocument("u1", id);
    assert.deepEqual(removed.heldDocuments, []);
  });

  test("a write without a profile is a 404", async () => {
    const svc = new ApplicantHoldingsService(memoryStore({}), () => NOW_MS);
    await assert.rejects(svc.update("ghost", { nationalities: ["QA"] }), (e: any) => e.status === 404);
  });

  test("the controller always acts on the signed-in uid; a body naming another user changes nothing", async () => {
    const users: Record<string, Partial<User>> = { me: {}, other: { nationalities: ["QZ"] } };
    const store = memoryStore(users);
    const ctrl = new ApplicantHoldingsController(new ApplicantHoldingsService(store, () => NOW_MS));
    const res = { statusCode: 0, body: null as any, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
    await ctrl.update({ userId: "me", body: { userId: "other", nationalities: ["QA"] } } as any, res as any);
    assert.equal(res.statusCode, 400, "an unknown key (userId) is refused");
    await ctrl.update({ userId: "me", body: { nationalities: ["QA"] } } as any, res as any);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(store.writes.map((w) => w.uid), ["me"]);
    assert.deepEqual(users.other.nationalities, ["QZ"]);
  });
});

describe("the copy an application takes when it starts", () => {
  const takenAt = Timestamp.fromMillis(NOW_MS);

  test("copied with the time taken; each document records whether it had expired", () => {
    const facts = applicantFactsFromUser({ nationalities: ["QA", "QB"], residentialCountry: "QC", heldDocuments: [{ id: "d1", kind: "visa", issuerCountryCode: "QD", validUntil: "2026-01-01", note: "old" }] }, takenAt);
    assert.deepEqual(facts, {
      nationalities: ["QA", "QB"],
      residentialCountry: "QC",
      heldDocuments: [{ id: "d1", kind: "visa", issuerCountryCode: "QD", validUntil: "2026-01-01", note: "old", expiredWhenTaken: true }],
      takenAt,
    });
  });

  test("nothing stated is copied as not stated (no user, legacy residence)", () => {
    assert.deepEqual(applicantFactsFromUser(null, takenAt), { nationalities: [], residentialCountry: null, heldDocuments: null, takenAt });
    assert.deepEqual(applicantFactsFromUser({ residentialCountry: "Somewhere" }, takenAt).residentialCountry, null);
  });

  test("a later profile edit does not change the copy (it is a value, not a reference)", () => {
    const user: any = { nationalities: ["QA"] };
    const facts = applicantFactsFromUser(user, takenAt);
    user.nationalities.push("QB");
    assert.deepEqual(facts.nationalities, ["QA"]);
    assert.deepEqual(holdingsViewOf(user, "2026-11-14").nationalities, ["QA", "QB"]);
  });

  test("case lists strip the copy; other fields are untouched", () => {
    const app: any = { id: "a1", userId: "u1", applicantFacts: applicantFactsFromUser({ nationalities: ["QA"] }, takenAt) };
    const stripped = withoutApplicantFacts(app);
    assert.equal("applicantFacts" in stripped, false);
    assert.equal(stripped.id, "a1");
    assert.equal(withoutApplicantFacts({ id: "a2" } as any).id, "a2");
  });
});
