// ============================================
// Unit tests — status wording and refusal-analysis notice (issue #268)
// ============================================
//
// Part 1: the pure status copy (`applicationStatusMessage`).
// Part 2: `refusalLetterService.notifyApplicant` over the in-memory Firestore with
// FCM (`messaging`) and `emailService` replaced by recorders. No network.

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, resetStore, store } from "../helpers/fake-firestore";
import { applicationStatusMessage } from "../../src/utils/application-status-copy";
import { DEFAULT_CHANNELS_BY_TYPE } from "../../src/services/notification-policy";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
describe("applicationStatusMessage", () => {
  // The eight statuses the issue lists, for agent and self-service.
  const eight = ["pending_documents", "pending_payment", "expired", "withdrawn", "draft", "under_review", "submitted_to_embassy", "interview_scheduled"];

  test("the five existing statuses keep their agent copy word for word", () => {
    assert.equal(applicationStatusMessage("under_review", false), "Your application is now under review.");
    assert.equal(applicationStatusMessage("submitted_to_embassy", false), "Your application has been submitted to the embassy.");
    assert.equal(applicationStatusMessage("interview_scheduled", false), "Your interview has been scheduled.");
    assert.equal(applicationStatusMessage("approved", false), "Congratulations! Your visa has been approved.");
    assert.equal(applicationStatusMessage("rejected", false), "Unfortunately, your visa application was not approved.");
  });

  test("self-service gets the same copy for the statuses that do not differ", () => {
    for (const s of ["submitted_to_embassy", "interview_scheduled", "approved", "rejected", "pending_documents", "pending_payment", "expired", "draft"]) {
      assert.equal(applicationStatusMessage(s, true), applicationStatusMessage(s, false), s);
    }
  });

  test("under_review: self-service confirms the submission, agent keeps the old wording", () => {
    assert.match(applicationStatusMessage("under_review", true), /application is in/i);
    assert.match(applicationStatusMessage("under_review", true), /readiness review/i);
    assert.doesNotMatch(applicationStatusMessage("under_review", true), /now under review/i);
    assert.equal(applicationStatusMessage("under_review", false), "Your application is now under review.");
  });

  test("withdrawn: its own sentence for both, a short confirmation for self-service", () => {
    assert.match(applicationStatusMessage("withdrawn", false), /withdrawn/i);
    assert.match(applicationStatusMessage("withdrawn", true), /withdrawn/i);
    assert.notEqual(applicationStatusMessage("withdrawn", true), applicationStatusMessage("withdrawn", false));
  });

  test("pending_documents, pending_payment and expired say what to do / what is waiting", () => {
    assert.match(applicationStatusMessage("pending_documents", false), /documents/i);
    assert.match(applicationStatusMessage("pending_payment", false), /payment is waiting/i);
    assert.match(applicationStatusMessage("expired", false), /expired/i);
    assert.match(applicationStatusMessage("expired", false), /new application/i);
  });

  test("none of the eight statuses reaches the generic fallback, for either kind of applicant", () => {
    for (const s of eight) {
      for (const self of [true, false]) {
        const m = applicationStatusMessage(s, self);
        assert.doesNotMatch(m, /status is now/i, `${s} self=${self}`);
        assert.doesNotMatch(m, /case/i, `${s} self=${self}`);
        assert.doesNotMatch(m, /_/, `${s} self=${self}`);
      }
    }
  });

  test("the raw word 'submitted' is never a status string", () => {
    assert.match(applicationStatusMessage("submitted", true), /status is now: submitted/);
    for (const s of eight) assert.doesNotMatch(applicationStatusMessage(s, true), /status is now: submitted/);
  });

  test("an unknown status falls back to the humanised sentence", () => {
    assert.equal(applicationStatusMessage("on_hold_for_review", false), "Your application status is now: on hold for review");
    assert.equal(applicationStatusMessage("on_hold_for_review", true), "Your application status is now: on hold for review");
  });
});

// ---------------------------------------------------------------------------
let refusalLetterService: any;
let messaging: any;
let emailService: any;
let pushes: any[] = [];
let emails: any[] = [];

const APP = "app-1";
const USER = "user-1";
const AN = "analysis-1";

before(async () => {
  const firebase: any = await import("../../src/utils/firebase");
  for (const name of ["applications", "users", "refusalAnalyses", "refusalAnalysisNotifications", "notifications", "notificationDeliveries"]) {
    firebase.collections[name] = fakeCollection(name);
  }
  messaging = firebase.messaging;
  emailService = (await import("../../src/services/email/email.service")).emailService;
  refusalLetterService = (await import("../../src/services/ai/refusal-letter.service")).refusalLetterService;
  messaging.sendEachForMulticast = async (m: any) => {
    pushes.push(m);
    return { successCount: m.tokens.length, failureCount: 0, responses: [] };
  };
  Object.defineProperty(emailService, "isConfigured", { get: () => true, configurable: true });
  emailService.sendNotification = async (m: any) => {
    emails.push(m);
    return { status: "sent", providerId: "p-1" };
  };
});

beforeEach(() => {
  resetStore();
  pushes = [];
  emails = [];
  store.set(`users/${USER}`, { email: "delivered+selfservice@resend.dev", fcmTokens: ["tok-1"] });
});

function seedApp(extra: Record<string, unknown> = {}) {
  store.set(`applications/${APP}`, { userId: USER, mode: "self", ...extra });
}

/** A stored analysis. The `reasons` text must never reach a notice. */
function seedAnalysis(id: string, extra: Record<string, unknown> = {}) {
  store.set(`refusalAnalyses/${id}`, {
    userId: USER,
    applicationId: APP,
    status: "succeeded",
    outcome: "analysed",
    reasons: [{ id: "r1", quote: "SECRET-REASON-TEXT insufficient funds" }],
    createdAt: Timestamp.fromMillis(1000),
    ...extra,
  });
}

const inbox = () => [...store.entries()].filter(([p]) => p.startsWith("notifications/")).map(([, d]) => d as any);
const claims = () => [...store.keys()].filter((p) => p.startsWith("refusalAnalysisNotifications/"));

describe("refusalLetterService.notifyApplicant", () => {
  test("policy: in_app + push, no email", () => {
    assert.deepEqual(DEFAULT_CHANNELS_BY_TYPE.refusal_analysis_ready, ["in_app", "push"]);
  });

  test("analysed: in_app + push, application link, analysisId, no email, no reason text", async () => {
    seedApp();
    seedAnalysis(AN);
    await refusalLetterService.notifyApplicant(AN);
    const n = inbox();
    assert.equal(n.length, 1);
    assert.equal(n[0].type, "refusal_analysis_ready");
    assert.equal(n[0].userId, USER);
    assert.equal(n[0].relatedEntityType, "application");
    assert.equal(n[0].relatedEntityId, APP);
    // `data` rides on the push payload (the inbox record has no data field).
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].data.analysisId, AN);
    assert.equal(emails.length, 0);
    const text = `${n[0].title} ${n[0].body} ${JSON.stringify(pushes[0])}`;
    assert.doesNotMatch(text, /SECRET-REASON-TEXT|insufficient funds/i);
    assert.doesNotMatch(text, /case/i);
    assert.deepEqual(claims(), [`refusalAnalysisNotifications/${AN}`]);
  });

  for (const outcome of ["unreadable", "not_a_refusal_letter"]) {
    test(`${outcome}: in_app only, no push, copy says a clearer copy may help`, async () => {
      seedApp();
      seedAnalysis(AN, { outcome });
      await refusalLetterService.notifyApplicant(AN);
      const n = inbox();
      assert.equal(n.length, 1);
      assert.equal(pushes.length, 0);
      assert.equal(emails.length, 0);
      assert.match(n[0].body, /couldn’t use/i);
      assert.match(n[0].body, /clearer copy/i);
      assert.doesNotMatch(`${n[0].title} ${n[0].body}`, /SECRET-REASON-TEXT|case/i);
    });
  }

  test("a duplicate delivery sends nothing; a re-requested letter (new id) notifies once more", async () => {
    seedApp();
    seedAnalysis(AN);
    seedAnalysis("analysis-2");
    await refusalLetterService.notifyApplicant(AN);
    await refusalLetterService.notifyApplicant(AN);
    assert.equal(inbox().length, 1);
    await refusalLetterService.notifyApplicant("analysis-2");
    assert.equal(inbox().length, 2);
    assert.equal(claims().length, 2);
  });

  test("failed, queued, running, missing: nothing", async () => {
    seedApp();
    seedAnalysis("f", { status: "failed", outcome: null });
    seedAnalysis("q", { status: "queued", outcome: null });
    seedAnalysis("r", { status: "running", outcome: null });
    for (const id of ["f", "q", "r", "missing"]) await refusalLetterService.notifyApplicant(id);
    assert.equal(inbox().length, 0);
    assert.equal(claims().length, 0);
  });

  test("agent and agency applications get nothing, and no claim", async () => {
    seedAnalysis(AN);
    for (const extra of [{ agentId: "a1" }, { agencyId: "g1" }, { mode: "agent" }]) {
      store.set(`applications/${APP}`, { userId: USER, mode: "self", ...extra });
      await refusalLetterService.notifyApplicant(AN);
    }
    assert.equal(inbox().length, 0);
    assert.equal(claims().length, 0);
  });

  test("never throws and never alters the stored analysis", async () => {
    seedApp();
    seedAnalysis(AN);
    const before = JSON.stringify(store.get(`refusalAnalyses/${AN}`));
    // A broken notification path (no users doc / push throws) must not escape.
    messaging.sendEachForMulticast = async () => {
      throw new Error("fcm down");
    };
    await assert.doesNotReject(refusalLetterService.notifyApplicant(AN));
    assert.equal(JSON.stringify(store.get(`refusalAnalyses/${AN}`)), before);
    await assert.doesNotReject(refusalLetterService.notifyApplicant("nope"));
  });
});
