// ============================================
// Unit tests — risk-signal store, raise semantics and audit trail (issue #119)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firebase Admin is
// initialised against a dummy project id and every Firestore ref / the
// transaction runner are swapped for the in-memory fake
// (test/helpers/fake-firestore.ts).
//
// Covers the issue's backend criteria that live in the service:
//  - raise creates one `open` signal and exactly one `raised` event;
//  - a re-raise with the same dedupeKey while open/in_review merges new
//    evidence and writes one `evidence_added` event (never a second signal);
//  - a dismissed signal is not reopened; new evidence on a new subject/ref
//    creates a new generation linked by a `related_signal` evidence item;
//  - validation throws for an unknown subject type, an empty type or a
//    missing source, and writes nothing;
//  - a status change writes only the signal + one event: the subject's user,
//    application and agency docs are untouched and notifyUser is not called;
//  - events are append-only (no update / delete function exists and no write
//    ever updates or deletes an event doc);
//  - the list is newest first, filters on status/category/type/subjectType,
//    pages by cursor and caps the page size;
//  - transitions, the note rule, optimistic concurrency (409) and reopen.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { installFakes, resetStore, store, writes } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import {
  RISK_SIGNAL_LIST_MAX_LIMIT,
  RiskSignalError,
  RiskSignalService,
  riskSignalId,
  riskSignalService,
} from "../../src/services/risk-signal.service";
import * as riskSignalServiceModule from "../../src/services/risk-signal.service";
import {
  RISK_SIGNAL_LIMITS,
  RiskSignalValidationError,
} from "../../src/services/risk-signal.validation";
import {
  RISK_SIGNAL_EVIDENCE_KIND_RELATED,
  RISK_SIGNAL_SYSTEM_ACTOR,
  type RaiseRiskSignalInput,
} from "../../src/types/risk-signal";
import { notificationService } from "../../src/services/notification.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** A fixed base time; each raise in a test can advance it. */
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);

/** The admin who reviews signals in these tests. */
const ADMIN = { uid: "uid-admin-119", role: "admin" };

/** A valid raise input (override any field). */
function input(over: Partial<RaiseRiskSignalInput> = {}): RaiseRiskSignalInput {
  return {
    subject: { type: "user", id: "user-subject-1" },
    category: "trafficking",
    type: "shared_contact",
    severity: "medium",
    evidence: [{ kind: "shared_phone_hash", ref: "sha256:abc123", count: 3 }],
    source: {
      kind: "rule",
      ruleId: "shared_contact_v1",
      version: "1.0.0",
      sourceUrl: "https://www.gov.uk/government/publications/modern-slavery-statutory-guidance",
      sourceQuote: "Indicators include multiple workers sharing the same contact details.",
    },
    dedupeKey: "rule:shared_contact:user-subject-1",
    ...over,
  };
}

/** Every stored riskSignals doc as [id, data]. */
function signals(): [string, Data][] {
  return [...store.entries()].filter(([p]) => /^riskSignals\/[^/]+$/.test(p));
}

/** Every stored event doc path, in seq order. */
function eventPaths(): string[] {
  return [...store.keys()].filter((p) => /^riskSignals\/[^/]+\/events\/[^/]+$/.test(p)).sort();
}

/** The events of one signal, oldest first. */
function eventsOf(signalId: string): Data[] {
  return eventPaths()
    .filter((p) => p.startsWith(`riskSignals/${signalId}/events/`))
    .map((p) => store.get(p)!);
}

/** Writes to a path prefix since index `from`. */
function writesSince(from: number, prefix = "riskSignals/") {
  return writes.slice(from).filter((w) => w.path.startsWith(prefix));
}

/** Set the service clock to a fixed instant (returns a restore fn). */
function clockAt(ms: number): () => void {
  const previous = riskSignalService.realClock;
  riskSignalService.realClock = () => ms;
  return () => {
    riskSignalService.realClock = previous;
  };
}

// ============================================
// Setup
// ============================================

before(async () => {
  await installFakes();
});

beforeEach(() => {
  resetStore();
  riskSignalService.realClock = () => T0;
});

// ============================================
// Raising a signal
// ============================================

describe("raiseRiskSignal", () => {
  test("creates one open signal and exactly one raised event", async () => {
    const result = await riskSignalService.raiseRiskSignal(input());

    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;
    assert.equal(result.signalId, riskSignalId(input().dedupeKey, 1));
    assert.equal(result.revision, 1);

    const all = signals();
    assert.equal(all.length, 1);
    const [path, doc] = all[0];
    assert.equal(path, `riskSignals/${result.signalId}`);
    assert.equal(doc.status, "open");
    assert.equal(doc.revision, 1);
    assert.deepEqual(doc.subject, { type: "user", id: "user-subject-1" });
    assert.equal(doc.category, "trafficking");
    assert.equal(doc.type, "shared_contact");
    assert.equal(doc.severity, "medium");
    assert.equal(doc.dedupeKey, input().dedupeKey);
    assert.equal(doc.generation, 1);
    assert.ok(doc.createdAt instanceof Timestamp);
    assert.ok(doc.updatedAt instanceof Timestamp);
    assert.equal(doc.resolution, undefined);

    const events = eventsOf(result.signalId);
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 1);
    assert.equal(events[0].action, "raised");
    assert.equal(events[0].fromStatus, null);
    assert.equal(events[0].toStatus, "open");
    assert.equal(events[0].actorId, RISK_SIGNAL_SYSTEM_ACTOR);
    assert.equal(events[0].actorRole, RISK_SIGNAL_SYSTEM_ACTOR);
    // The note names what raised it (rule key + version), never the subject.
    assert.match(String(events[0].note), /rule shared_contact_v1 v1\.0\.0/);
  });

  test("a re-raise with the same key while open merges evidence and writes one evidence_added event", async () => {
    const first = await riskSignalService.raiseRiskSignal(input());
    assert.equal(first.outcome, "created");
    if (first.outcome !== "created") return;
    const restore = clockAt(T0 + 60_000);

    try {
      const second = await riskSignalService.raiseRiskSignal(
        input({
          evidence: [
            { kind: "shared_phone_hash", ref: "sha256:abc123", count: 3 },
            { kind: "shared_address_hash", ref: "sha256:def456", count: 2 },
          ],
          severity: "high",
        })
      );

      assert.equal(second.outcome, "merged");
      if (second.outcome !== "merged") return;
      assert.equal(second.signalId, first.signalId);
      assert.equal(second.revision, 2);
      assert.equal(second.evidenceAdded, 1);

      const all = signals();
      assert.equal(all.length, 1, "no second signal for the same key");
      const doc = store.get(`riskSignals/${first.signalId}`)!;
      assert.equal((doc.evidence as unknown[]).length, 2);
      assert.equal(doc.severity, "high", "the higher severity wins");
      assert.equal(doc.revision, 2);

      const events = eventsOf(first.signalId);
      assert.equal(events.length, 2);
      assert.equal(events[1].seq, 2);
      assert.equal(events[1].action, "evidence_added");
      assert.equal(events[1].fromStatus, "open");
      assert.equal(events[1].toStatus, "open");
    } finally {
      restore();
    }
  });

  test("a re-raise that adds nothing writes nothing", async () => {
    await riskSignalService.raiseRiskSignal(input());
    const before = writes.length;

    const result = await riskSignalService.raiseRiskSignal(input());

    assert.equal(result.outcome, "unchanged");
    assert.equal(writes.length, before, "no write at all");
    assert.equal(signals().length, 1);
    assert.equal(eventPaths().length, 1);
  });

  test("a dismissed signal is not reopened by the same raise", async () => {
    const raised = await riskSignalService.raiseRiskSignal(input());
    assert.equal(raised.outcome, "created");
    if (raised.outcome !== "created") return;
    await riskSignalService.changeStatus(raised.signalId, { status: "dismissed", note: "not a match", expectedRevision: 1 }, ADMIN);
    const before = writes.length;

    const again = await riskSignalService.raiseRiskSignal(input());

    assert.equal(again.outcome, "suppressed");
    assert.equal(again.signalId, raised.signalId);
    assert.equal(writes.length, before, "no write at all");
    assert.equal(signals().length, 1);
    assert.equal(store.get(`riskSignals/${raised.signalId}`)!.status, "dismissed");
  });

  test("a dismissed signal re-raised with a new ref creates a new generation linked to it", async () => {
    const raised = await riskSignalService.raiseRiskSignal(input());
    assert.equal(raised.outcome, "created");
    if (raised.outcome !== "created") return;
    await riskSignalService.changeStatus(raised.signalId, { status: "dismissed", note: "not a match", expectedRevision: 1 }, ADMIN);

    const again = await riskSignalService.raiseRiskSignal(
      input({ evidence: [{ kind: "shared_phone_hash", ref: "sha256:newref", count: 4 }] })
    );

    assert.equal(again.outcome, "created");
    if (again.outcome !== "created") return;
    assert.notEqual(again.signalId, raised.signalId);
    assert.equal(again.signalId, riskSignalId(input().dedupeKey, 2));
    assert.equal(signals().length, 2);

    const fresh = store.get(`riskSignals/${again.signalId}`)!;
    assert.equal(fresh.status, "open");
    assert.equal(fresh.generation, 2);
    const related = (fresh.evidence as { kind: string; ref: string }[]).find(
      (e) => e.kind === RISK_SIGNAL_EVIDENCE_KIND_RELATED
    );
    assert.ok(related, "links to the resolved signal");
    assert.equal(related!.ref, `riskSignals/${raised.signalId}`);
    // The dismissed signal is untouched.
    assert.equal(store.get(`riskSignals/${raised.signalId}`)!.status, "dismissed");
  });

  test("a re-raise naming a different subject creates a new generation even with no new ref", async () => {
    const raised = await riskSignalService.raiseRiskSignal(input());
    assert.equal(raised.outcome, "created");
    if (raised.outcome !== "created") return;
    await riskSignalService.changeStatus(raised.signalId, { status: "dismissed", note: "not a match", expectedRevision: 1 }, ADMIN);

    const again = await riskSignalService.raiseRiskSignal(input({ subject: { type: "application", id: "app-9" } }));

    assert.equal(again.outcome, "created");
    if (again.outcome !== "created") return;
    const fresh = store.get(`riskSignals/${again.signalId}`)!;
    assert.deepEqual(fresh.subject, { type: "application", id: "app-9" });
  });

  test("rejects an unknown subject type, an empty type and a missing source, writing nothing", async () => {
    const bad: [string, unknown][] = [
      ["unknown subject.type", input({ subject: { type: "galaxy" as any, id: "x" } })],
      ["empty type", input({ type: "  " })],
      ["missing source", { ...input(), source: undefined }],
    ];

    for (const [label, value] of bad) {
      await assert.rejects(
        () => riskSignalService.raiseRiskSignal(value as RaiseRiskSignalInput),
        RiskSignalValidationError,
        label
      );
      assert.equal(signals().length, 0, `${label}: no signal written`);
      assert.equal(eventPaths().length, 0, `${label}: no event written`);
      assert.equal(writes.length, 0, `${label}: nothing written`);
    }
  });

  test("keeps money in evidence labelled with currency and unit (naira as major)", async () => {
    const result = await riskSignalService.raiseRiskSignal(
      input({
        evidence: [
          {
            kind: "payment",
            ref: "applications/app-1",
            amount: { value: 450_000, currency: "NGN", unit: "major" },
          },
        ],
      })
    );
    assert.equal(result.outcome, "created");
    if (result.outcome !== "created") return;

    const doc = store.get(`riskSignals/${result.signalId}`)!;
    assert.deepEqual((doc.evidence as any[])[0].amount, { value: 450_000, currency: "NGN", unit: "major" });
  });

  test("refuses an unlabelled currency unit", async () => {
    await assert.rejects(
      () =>
        riskSignalService.raiseRiskSignal(
          input({
            evidence: [
              { kind: "payment", ref: "applications/app-1", amount: { value: 450_000, currency: "NGN", unit: "naira" as any } },
            ],
          })
        ),
      RiskSignalValidationError
    );
    assert.equal(writes.length, 0);
  });
});

// ============================================
// Nothing outside riskSignals
// ============================================

describe("a signal never touches its subject", () => {
  test("status = actioned writes no user/application/agency doc and sends no notification", async () => {
    // The subject's records.
    store.set("users/user-subject-1", { uid: "user-subject-1", role: "client", email: "delivered+subject@resend.dev" });
    store.set("applications/app-1", { id: "app-1", userId: "user-subject-1", status: "submitted" });
    store.set("agencies/agency-1", { id: "agency-1", name: "Acme", approvalStatus: "approved" });
    const subjectBefore = {
      user: structuredClone(store.get("users/user-subject-1")),
      application: structuredClone(store.get("applications/app-1")),
      agency: structuredClone(store.get("agencies/agency-1")),
    };

    let notifyCalls = 0;
    const originalNotify = notificationService.notifyUser;
    (notificationService as any).notifyUser = async () => {
      notifyCalls++;
    };
    try {
      const raised = await riskSignalService.raiseRiskSignal(input());
      assert.equal(raised.outcome, "created");
      if (raised.outcome !== "created") return;

      const before = writes.length;
      const updated = await riskSignalService.changeStatus(
        raised.signalId,
        { status: "actioned", note: "referred to the safeguarding lead", expectedRevision: 1 },
        ADMIN
      );

      assert.equal(updated.status, "actioned");
      assert.equal(notifyCalls, 0, "notifyUser is never called");
      assert.equal([...store.keys()].filter((p) => p.startsWith("notifications/")).length, 0);
      assert.deepEqual(store.get("users/user-subject-1"), subjectBefore.user);
      assert.deepEqual(store.get("applications/app-1"), subjectBefore.application);
      assert.deepEqual(store.get("agencies/agency-1"), subjectBefore.agency);

      const touched = writesSince(before);
      assert.ok(touched.length > 0);
      for (const write of touched) {
        assert.match(write.path, /^riskSignals\/[a-f0-9]{32}-[1-9][0-9]{0,2}(\/events\/[0-9]{6})?$/);
      }
    } finally {
      (notificationService as any).notifyUser = originalNotify;
    }
  });

  test("raising a signal sends nothing: no notifications and no writes outside riskSignals", async () => {
    const result = await riskSignalService.raiseRiskSignal(input());
    assert.equal(result.outcome, "created");
    for (const write of writes) {
      assert.match(write.path, /^riskSignals\//);
    }
    assert.equal([...store.keys()].filter((p) => p.startsWith("notifications/")).length, 0);
  });
});

// ============================================
// Audit trail is append-only
// ============================================

describe("audit trail", () => {
  test("there is no update or delete function for events", () => {
    const prototypeMethods = Object.getOwnPropertyNames(RiskSignalService.prototype).filter(
      (name) => typeof (RiskSignalService.prototype as any)[name] === "function"
    );
    const eventMutators = prototypeMethods.filter((n) => /event/i.test(n) && /(update|delete|remove|rewrite)/i.test(n));
    assert.deepEqual(eventMutators, []);

    // Nothing exported from the service modules mutates an event either.
    const serviceExports = Object.keys(riskSignalServiceModule);
    assert.deepEqual(
      serviceExports.filter((n) => /event/i.test(n) && /(update|delete|remove|rewrite)/i.test(n)),
      []
    );
  });

  test("every event write is a create (set) on a fresh seq id", async () => {
    const raised = await riskSignalService.raiseRiskSignal(input());
    assert.equal(raised.outcome, "created");
    if (raised.outcome !== "created") return;
    const restore = clockAt(T0 + 1000);
    try {
      await riskSignalService.raiseRiskSignal(input({ evidence: [{ kind: "shared_email_hash", ref: "sha256:x" }] }));
      await riskSignalService.changeStatus(raised.signalId, { status: "in_review", expectedRevision: 2 }, ADMIN);
      await riskSignalService.changeStatus(
        raised.signalId,
        { status: "dismissed", note: "no further action", expectedRevision: 3 },
        ADMIN
      );
    } finally {
      restore();
    }

    const eventWrites = writes.filter((w) => /^riskSignals\/[^/]+\/events\//.test(w.path));
    assert.ok(eventWrites.length >= 4);
    for (const write of eventWrites) {
      assert.equal(write.op, "set", `event write ${write.path} is a create`);
    }
    const seqs = eventsOf(raised.signalId).map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4]);
  });
});

// ============================================
// Admin queue reads
// ============================================

describe("listSignals", () => {
  /** Raise three signals at increasing times, returning their ids. */
  async function seedThree(): Promise<string[]> {
    const ids: string[] = [];
    const times = [T0, T0 + 1000, T0 + 2000];
    for (let i = 0; i < 3; i++) {
      const restore = clockAt(times[i]);
      try {
        const r = await riskSignalService.raiseRiskSignal(
          input({
            subject: { type: i === 1 ? "application" : "user", id: `subject-${i}` },
            category: i === 2 ? "scam" : "trafficking",
            type: i === 2 ? "payment_mismatch" : "shared_contact",
            dedupeKey: `rule:k${i}`,
          })
        );
        assert.equal(r.outcome, "created");
        if (r.outcome === "created") ids.push(r.signalId);
      } finally {
        restore();
      }
    }
    return ids;
  }

  test("returns newest first with no filter", async () => {
    const ids = await seedThree();
    const page = await riskSignalService.listSignals({ limit: 10 });
    assert.deepEqual(page.items.map((s) => s.id), [ids[2], ids[1], ids[0]]);
    assert.equal(page.nextCursor, null);
  });

  test("filters on status, category, type and subjectType", async () => {
    const ids = await seedThree();
    await riskSignalService.changeStatus(ids[0], { status: "in_review", expectedRevision: 1 }, ADMIN);

    assert.deepEqual((await riskSignalService.listSignals({ status: "in_review", limit: 10 })).items.map((s) => s.id), [ids[0]]);
    assert.deepEqual((await riskSignalService.listSignals({ category: "scam", limit: 10 })).items.map((s) => s.id), [ids[2]]);
    assert.deepEqual(
      (await riskSignalService.listSignals({ type: "shared_contact", limit: 10 })).items.map((s) => s.id),
      [ids[1], ids[0]]
    );
    assert.deepEqual(
      (await riskSignalService.listSignals({ subjectType: "application", limit: 10 })).items.map((s) => s.id),
      [ids[1]]
    );
  });

  test("pages by cursor and respects the page size", async () => {
    const ids = await seedThree();
    const first = await riskSignalService.listSignals({ limit: 2 });
    assert.deepEqual(first.items.map((s) => s.id), [ids[2], ids[1]]);
    assert.equal(first.nextCursor, ids[1]);

    const second = await riskSignalService.listSignals({ limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(second.items.map((s) => s.id), [ids[0]]);
    assert.equal(second.nextCursor, null);
  });

  test("an unknown cursor is a 400, not an empty page", async () => {
    await assert.rejects(
      () => riskSignalService.listSignals({ limit: 10, cursor: riskSignalId("missing", 1) }),
      (error: unknown) => error instanceof RiskSignalError && error.httpStatus === 400
    );
  });

  test("the max page size is a named constant", () => {
    assert.equal(RISK_SIGNAL_LIST_MAX_LIMIT, 100);
  });
});

describe("getSignal", () => {
  test("returns the signal with its events oldest first", async () => {
    const raised = await riskSignalService.raiseRiskSignal(input());
    assert.equal(raised.outcome, "created");
    if (raised.outcome !== "created") return;
    await riskSignalService.changeStatus(raised.signalId, { status: "in_review", expectedRevision: 1 }, ADMIN);

    const result = await riskSignalService.getSignal(raised.signalId);
    assert.ok(result);
    assert.equal(result!.signal.id, raised.signalId);
    assert.equal(result!.signal.status, "in_review");
    assert.equal(result!.signal.createdAt, new Date(T0).toISOString());
    assert.deepEqual(result!.events.map((e) => e.action), ["raised", "status_changed"]);
    assert.equal(result!.events[1].actorId, ADMIN.uid);
    assert.equal(result!.events[1].actorRole, "admin");
  });

  test("returns null for an unknown id", async () => {
    assert.equal(await riskSignalService.getSignal(riskSignalId("nope", 1)), null);
  });
});

// ============================================
// Status changes
// ============================================

describe("changeStatus", () => {
  /** Raise one signal and return its id. */
  async function raiseOne(): Promise<string> {
    const r = await riskSignalService.raiseRiskSignal(input());
    assert.equal(r.outcome, "created");
    return r.outcome === "created" ? r.signalId : "";
  }

  test("open -> in_review needs no note and writes one event with the admin uid", async () => {
    const id = await raiseOne();
    const signal = await riskSignalService.changeStatus(id, { status: "in_review", expectedRevision: 1 }, ADMIN);

    assert.equal(signal.status, "in_review");
    assert.equal(signal.revision, 2);
    const events = eventsOf(id);
    assert.equal(events.length, 2);
    assert.equal(events[1].action, "status_changed");
    assert.equal(events[1].fromStatus, "open");
    assert.equal(events[1].toStatus, "in_review");
    assert.equal(events[1].actorId, ADMIN.uid);
  });

  test("actioned / dismissed require a note, and nothing is written without one", async () => {
    for (const status of ["actioned", "dismissed"] as const) {
      resetStore();
      const id = await raiseOne();
      const before = writes.length;
      await assert.rejects(
        () => riskSignalService.changeStatus(id, { status, expectedRevision: 1 }, ADMIN),
        (error: unknown) => error instanceof RiskSignalError && error.code === "NOTE_REQUIRED" && error.httpStatus === 400
      );
      assert.equal(writes.length, before);
      assert.equal(store.get(`riskSignals/${id}`)!.status, "open");
    }
  });

  test("a decision records the resolution (admin uid, time, note)", async () => {
    const id = await raiseOne();
    const signal = await riskSignalService.changeStatus(
      id,
      { status: "dismissed", note: "  the shared contact is a family address  ", expectedRevision: 1 },
      ADMIN
    );

    assert.equal(signal.status, "dismissed");
    assert.equal(signal.resolution?.by, ADMIN.uid);
    assert.equal(signal.resolution?.note, "the shared contact is a family address");
    assert.equal(signal.resolution?.at, new Date(T0).toISOString());
  });

  test("only the allowed transitions pass", async () => {
    const id = await raiseOne();
    await riskSignalService.changeStatus(id, { status: "in_review", expectedRevision: 1 }, ADMIN);
    await riskSignalService.changeStatus(id, { status: "actioned", note: "done", expectedRevision: 2 }, ADMIN);

    for (const [target, reopen] of [
      ["in_review", undefined],
      ["open", undefined],
      ["dismissed", undefined],
    ] as const) {
      await assert.rejects(
        () => riskSignalService.changeStatus(id, { status: target, note: "n", reopen, expectedRevision: 3 }, ADMIN),
        (error: unknown) => error instanceof RiskSignalError && error.code === "INVALID_TRANSITION" && error.httpStatus === 400
      );
    }
  });

  test("a stale expectedRevision is a 409 and writes nothing", async () => {
    const id = await raiseOne();
    const before = writes.length;
    await assert.rejects(
      () => riskSignalService.changeStatus(id, { status: "in_review", expectedRevision: 99 }, ADMIN),
      (error: unknown) =>
        error instanceof RiskSignalError && error.code === "REVISION_MISMATCH" && error.httpStatus === 409
    );
    assert.equal(writes.length, before);
    assert.equal(store.get(`riskSignals/${id}`)!.status, "open");
  });

  test("a second admin deciding on the same revision gets 409 (only one decision lands)", async () => {
    const id = await raiseOne();
    const first = await riskSignalService.changeStatus(
      id,
      { status: "dismissed", note: "first admin", expectedRevision: 1 },
      { uid: "uid-admin-a", role: "admin" }
    );
    assert.equal(first.status, "dismissed");

    await assert.rejects(
      () =>
        riskSignalService.changeStatus(
          id,
          { status: "actioned", note: "second admin", expectedRevision: 1 },
          { uid: "uid-admin-b", role: "admin" }
        ),
      (error: unknown) => error instanceof RiskSignalError && error.code === "REVISION_MISMATCH"
    );
    const events = eventsOf(id);
    assert.equal(events.length, 2, "only the first decision is audited");
    assert.equal(events[1].actorId, "uid-admin-a");
  });

  test("reopen is explicit, needs a note and is audited, clearing the resolution", async () => {
    const id = await raiseOne();
    await riskSignalService.changeStatus(id, { status: "dismissed", note: "dismissed once", expectedRevision: 1 }, ADMIN);

    const reopened = await riskSignalService.changeStatus(
      id,
      { status: "open", note: "new context from the safeguarding lead", expectedRevision: 2, reopen: true },
      ADMIN
    );

    assert.equal(reopened.status, "open");
    assert.equal(reopened.resolution, null);
    assert.equal(reopened.revision, 3);
    const events = eventsOf(id);
    assert.equal(events[2].action, "reopened");
    assert.equal(events[2].fromStatus, "dismissed");
    assert.equal(events[2].toStatus, "open");
    assert.equal(events[2].actorId, ADMIN.uid);
    assert.equal(events[2].note, "new context from the safeguarding lead");
  });

  test("a reopen without a note is refused", async () => {
    const id = await raiseOne();
    await riskSignalService.changeStatus(id, { status: "dismissed", note: "dismissed once", expectedRevision: 1 }, ADMIN);
    await assert.rejects(
      () => riskSignalService.changeStatus(id, { status: "open", expectedRevision: 2, reopen: true }, ADMIN),
      (error: unknown) => error instanceof RiskSignalError && error.code === "NOTE_REQUIRED"
    );
  });

  test("a reopen is refused while a newer generation exists", async () => {
    const first = await riskSignalService.raiseRiskSignal(input());
    assert.equal(first.outcome, "created");
    if (first.outcome !== "created") return;
    await riskSignalService.changeStatus(first.signalId, { status: "dismissed", note: "no", expectedRevision: 1 }, ADMIN);
    const second = await riskSignalService.raiseRiskSignal(
      input({ evidence: [{ kind: "shared_phone_hash", ref: "sha256:newer" }] })
    );
    assert.equal(second.outcome, "created");
    if (second.outcome !== "created") return;

    await assert.rejects(
      () =>
        riskSignalService.changeStatus(
          first.signalId,
          { status: "open", note: "reopen the old one", expectedRevision: 2, reopen: true },
          ADMIN
        ),
      (error: unknown) => error instanceof RiskSignalError && error.code === "SUPERSEDED" && error.httpStatus === 409
    );
  });

  test("an unknown id is a 404", async () => {
    await assert.rejects(
      () => riskSignalService.changeStatus(riskSignalId("missing", 1), { status: "in_review", expectedRevision: 1 }, ADMIN),
      (error: unknown) => error instanceof RiskSignalError && error.httpStatus === 404
    );
  });

  test("an admin note longer than the cap is a 400", async () => {
    const id = await raiseOne();
    await assert.rejects(
      () =>
        riskSignalService.changeStatus(
          id,
          { status: "dismissed", note: "x".repeat(RISK_SIGNAL_LIMITS.maxStatusNoteLength + 1), expectedRevision: 1 },
          ADMIN
        ),
      (error: unknown) => error instanceof RiskSignalError && error.httpStatus === 400
    );
  });
});
