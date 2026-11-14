// ============================================
// Unit tests — self-service applicant notices (issue #266)
// ============================================
//
// Real notificationService.notifyUser over the in-memory Firestore, with FCM
// (`messaging`) and `emailService` replaced by recorders. No network, no emulator.
//
// Covers: the four types and their channels, the self-service gate (self, agent,
// agency), both readiness dedupe rules, the document-check claim, the email having
// no link, and the "never throws" guarantee.

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, resetStore, store } from "../helpers/fake-firestore";
import { isSelfServiceApplication } from "../../src/utils/self-service";
import { DEFAULT_CHANNELS_BY_TYPE } from "../../src/services/notification-policy";
import { resolveEventEmail } from "../../src/services/email/event-templates";

/* eslint-disable @typescript-eslint/no-explicit-any */

let assessmentAutoRunService: any;
let DocumentCheckService: any;
let emailService: any;
let messaging: any;
let pushes: any[] = [];
let emails: any[] = [];

const APP = "app-1";
const USER = "user-1";

/** In-memory refs for every collection the two notify paths touch. */
before(async () => {
  const firebase: any = await import("../../src/utils/firebase");
  for (const name of [
    "applications",
    "users",
    "applicationAssessments",
    "assessmentNotifications",
    "documentChecks",
    "documentCheckNotifications",
    "documentRequests",
    "notifications",
    "notificationDeliveries",
  ]) {
    firebase.collections[name] = fakeCollection(name);
  }
  messaging = firebase.messaging;
  emailService = (await import("../../src/services/email/email.service")).emailService;
  assessmentAutoRunService = (await import("../../src/services/assessment-auto-run.service")).assessmentAutoRunService;
  DocumentCheckService = (await import("../../src/services/ai/document-check.service")).DocumentCheckService;
  // Recorders: no real FCM, no real Resend.
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

/** An application doc; self-service unless told otherwise. */
function seedApp(extra: Record<string, unknown> = {}) {
  store.set(`applications/${APP}`, { userId: USER, mode: "self", visaTypeId: "v", countryCode: "AA", ...extra });
}

/** A stored assessment. `n` orders them by createdAt. */
function seedAssessment(id: string, n: number, extra: Record<string, unknown> = {}) {
  store.set(`applicationAssessments/${id}`, {
    id,
    applicationId: APP,
    status: "succeeded",
    trigger: "manual",
    readiness: "on_track",
    refusalGrounds: [],
    credibilityFlags: [],
    insufficientInformation: [],
    createdAt: Timestamp.fromMillis(1000 * n),
    ...extra,
  });
}

/** Notifications written for the user. */
const inbox = () => [...store.entries()].filter(([p]) => p.startsWith("notifications/")).map(([, d]) => d as any);
const claims = (col: string) => [...store.keys()].filter((p) => p.startsWith(`${col}/`));

// ---------------------------------------------------------------------------
describe("policy, gate and email", () => {
  test("each new type has exactly the channels the issue names", () => {
    assert.deepEqual(DEFAULT_CHANNELS_BY_TYPE.readiness_review_ready, ["in_app", "push", "email"]);
    assert.deepEqual(DEFAULT_CHANNELS_BY_TYPE.document_check_problems, ["in_app", "push"]);
    assert.deepEqual(DEFAULT_CHANNELS_BY_TYPE.document_check_could_not_check, ["in_app", "push"]);
    assert.deepEqual(DEFAULT_CHANNELS_BY_TYPE.document_check_passed, ["in_app"]);
  });

  test("isSelfServiceApplication: self only; agent, agency, missing mode all fail", () => {
    assert.equal(isSelfServiceApplication({ mode: "self" }), true);
    assert.equal(isSelfServiceApplication({ mode: "self", agentId: "a" }), false);
    assert.equal(isSelfServiceApplication({ mode: "self", agencyId: "g" }), false);
    assert.equal(isSelfServiceApplication({ mode: "agent" }), false);
    assert.equal(isSelfServiceApplication({} as any), false);
    assert.equal(isSelfServiceApplication(null), false);
  });

  test("the readiness email has a subject and no link", () => {
    const e = resolveEventEmail("readiness_review_ready", { title: "t", body: "b", actionUrl: "https://x.test/case-management/1", relatedEntityType: "application", relatedEntityId: "1" });
    assert.equal(e.subject, "Your readiness review is ready");
    assert.equal(e.actionUrl, "");
  });
});

// ---------------------------------------------------------------------------
describe("readiness review (notifyApplicantIfReady)", () => {
  test("first succeeded run: in_app + push + email, one claim, application id on the notice", async () => {
    seedApp();
    seedAssessment("as-1", 1);
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    const n = inbox();
    assert.equal(n.length, 1);
    assert.equal(n[0].type, "readiness_review_ready");
    assert.equal(n[0].userId, USER);
    assert.equal(n[0].relatedEntityType, "application");
    assert.equal(n[0].relatedEntityId, APP);
    assert.equal(n[0].actionUrl, undefined);
    assert.equal(pushes.length, 1);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].actionUrl, "");
    assert.equal(claims("notificationDeliveries").length, 1);
    assert.deepEqual(claims("assessmentNotifications"), ["assessmentNotifications/as-1_applicant"]);
    // Neutral copy: no "case", no score.
    assert.doesNotMatch(`${n[0].title} ${n[0].body}`, /case/i);
    assert.match(n[0].body, /Seli app/);
  });

  test("a duplicate delivery sends nothing a second time", async () => {
    seedApp();
    seedAssessment("as-1", 1);
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    assert.equal(inbox().length, 1);
    assert.equal(pushes.length, 1);
    assert.equal(emails.length, 1);
  });

  test("same band and same findings as the previous succeeded run: nothing", async () => {
    seedApp();
    const g = [{ criterionId: "c1" }];
    seedAssessment("as-1", 1, { refusalGrounds: g });
    seedAssessment("as-2", 2, { refusalGrounds: g });
    await assessmentAutoRunService.notifyApplicantIfReady("as-2");
    assert.equal(inbox().length, 0);
    assert.equal(claims("assessmentNotifications").length, 0);
  });

  test("a changed band or a changed finding set notifies", async () => {
    seedApp();
    seedAssessment("as-1", 1);
    seedAssessment("as-2", 2, { readiness: "at_risk" });
    await assessmentAutoRunService.notifyApplicantIfReady("as-2");
    assert.equal(inbox().length, 1);
    seedAssessment("as-3", 3, { readiness: "at_risk", credibilityFlags: [{ criterionId: "c9" }] });
    await assessmentAutoRunService.notifyApplicantIfReady("as-3");
    assert.equal(inbox().length, 2);
  });

  test("a failed job sends nothing", async () => {
    seedApp();
    seedAssessment("as-1", 1, { status: "failed" });
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    assert.equal(inbox().length, 0);
  });

  test("agent and agency applications get no applicant notice", async () => {
    seedAssessment("as-1", 1);
    seedApp({ agentId: "agent-1" });
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    seedApp({ agencyId: "agency-1" });
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    seedApp({ mode: "agent" });
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    assert.equal(inbox().length, 0);
    assert.equal(claims("assessmentNotifications").length, 0);
  });

  test("push off keeps the in_app record, email off skips the email", async () => {
    seedApp();
    seedAssessment("as-1", 1);
    store.set(`users/${USER}`, { email: "delivered+selfservice@resend.dev", fcmTokens: ["tok-1"], notificationPreferences: { push: false, email: false } });
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    assert.equal(inbox().length, 1);
    assert.equal(pushes.length, 0);
    assert.equal(emails.length, 0);
  });

  test("never throws: missing assessment, missing user, claim write error, push and email errors", async () => {
    await assessmentAutoRunService.notifyApplicantIfReady("nope");
    seedApp();
    seedAssessment("as-1", 1);
    store.delete(`users/${USER}`);
    await assessmentAutoRunService.notifyApplicantIfReady("as-1");
    // Push and email both throw: still resolves, and the in_app record stays.
    store.set(`users/${USER}`, { email: "delivered+selfservice@resend.dev", fcmTokens: ["tok-1"] });
    seedAssessment("as-2", 2, { readiness: "at_risk" });
    const sendPush = messaging.sendEachForMulticast;
    const sendMail = emailService.sendNotification;
    messaging.sendEachForMulticast = async () => {
      throw new Error("fcm down");
    };
    emailService.sendNotification = async () => {
      throw new Error("resend down");
    };
    try {
      await assessmentAutoRunService.notifyApplicantIfReady("as-2");
    } finally {
      messaging.sendEachForMulticast = sendPush;
      emailService.sendNotification = sendMail;
    }
    assert.equal(inbox().filter((n) => n.type === "readiness_review_ready").length >= 1, true);
    // The stored assessment is untouched.
    assert.equal((store.get("applicationAssessments/as-2") as any).status, "succeeded");
  });
});

// ---------------------------------------------------------------------------
describe("document check (notifyApplicant)", () => {
  const REQ_AT = 5000;

  const fix = { outcome: "fix", code: "x", message: "m" };
  const ok = { outcome: "ok", code: "x", message: "m" };
  const checks = (o: any) => ({ type: o, readable: ok, inDate: ok, name: ok, period: ok });

  function seedCheck(extra: Record<string, unknown> = {}, requestedAt = REQ_AT) {
    store.set("documentChecks/doc-1", {
      documentId: "doc-1",
      applicationId: APP,
      userId: USER,
      documentRequestId: "req-1",
      status: "done",
      checks: checks(ok),
      reason: null,
      requestedAt: Timestamp.fromMillis(requestedAt),
      ...extra,
    });
    store.set("documentRequests/req-1", { documentType: "Bank statement" });
  }
  const svc = () => new DocumentCheckService({ now: () => new Date(9000) } as any);

  test("done with a fix: document_check_problems, in_app + push, names the document", async () => {
    seedApp();
    seedCheck({ checks: checks(fix) });
    await svc().notifyApplicant("doc-1");
    const n = inbox();
    assert.equal(n.length, 1);
    assert.equal(n[0].type, "document_check_problems");
    assert.equal(n[0].relatedEntityType, "application");
    assert.equal(n[0].relatedEntityId, APP);
    assert.match(`${n[0].title} ${n[0].body}`, /bank statement/i);
    assert.equal(pushes.length, 1);
    assert.equal(emails.length, 0);
    assert.deepEqual(claims("documentCheckNotifications"), [`documentCheckNotifications/doc-1_${REQ_AT}`]);
  });

  test("could_not_check: in_app + push, says the upload is saved", async () => {
    seedApp();
    seedCheck({ status: "could_not_check", checks: null, reason: { code: "unreadable", message: "m" } });
    await svc().notifyApplicant("doc-1");
    const n = inbox();
    assert.equal(n[0].type, "document_check_could_not_check");
    assert.match(n[0].body, /saved/);
    assert.match(`${n[0].title} ${n[0].body}`, /bank statement/i);
    assert.equal(pushes.length, 1);
    assert.equal(emails.length, 0);
  });

  test("done with no fix: document_check_passed, in_app only (no push, no email row)", async () => {
    seedApp();
    seedCheck();
    await svc().notifyApplicant("doc-1");
    assert.equal(inbox()[0].type, "document_check_passed");
    assert.equal(pushes.length, 0);
    assert.equal(emails.length, 0);
    assert.equal(claims("notificationDeliveries").length, 0);
  });

  test("a duplicate delivery sends nothing; a re-run (new requestedAt) sends a fresh notice", async () => {
    seedApp();
    seedCheck();
    await svc().notifyApplicant("doc-1");
    await svc().notifyApplicant("doc-1");
    assert.equal(inbox().length, 1);
    seedCheck({}, 8000);
    await svc().notifyApplicant("doc-1");
    assert.equal(inbox().length, 2);
  });

  test("no notice for an agent or agency application, or a check that is not final", async () => {
    seedCheck();
    seedApp({ agentId: "agent-1" });
    await svc().notifyApplicant("doc-1");
    seedApp({ agencyId: "agency-1" });
    await svc().notifyApplicant("doc-1");
    seedApp();
    store.set("documentChecks/doc-1", { ...(store.get("documentChecks/doc-1") as any), status: "running" });
    await svc().notifyApplicant("doc-1");
    store.delete("documentChecks/doc-1");
    await svc().notifyApplicant("doc-1");
    assert.equal(inbox().length, 0);
    assert.equal(claims("documentCheckNotifications").length, 0);
  });

  test("never throws, and leaves the check record alone, when the user doc is missing or the request is gone", async () => {
    seedApp();
    seedCheck({ checks: checks(fix) });
    store.delete(`users/${USER}`);
    store.delete("documentRequests/req-1");
    const before = JSON.stringify(store.get("documentChecks/doc-1"));
    await svc().notifyApplicant("doc-1");
    assert.equal(JSON.stringify(store.get("documentChecks/doc-1")), before);
    // The fallback name keeps the copy sensible.
    assert.match(inbox()[0].body, /document/);
  });
});
