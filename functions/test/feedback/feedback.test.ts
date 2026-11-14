// ============================================
// Unit tests: in-app feedback (issue #257)
// ============================================
//
// Covers body validation, the screenshot-path ownership check, the stored
// document, the escaped team email, email failures, and the hourly rate limit.
// The service runs against in-memory fakes (FeedbackDeps): no Firestore,
// Storage or Resend call is made. Test addresses use resend.dev.

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  FeedbackService,
  FEEDBACK_HOURLY_LIMIT,
  buildEmailBody,
  buildSubject,
  escapeHtml,
  feedbackService,
  type FeedbackDeps,
} from "../../src/services/feedback.service";
import { feedbackController, validateFeedbackBody } from "../../src/controllers/feedback.controller";
import { buildIssuedPath, validateStoragePath } from "../../src/utils/storage-paths";
import { storageService } from "../../src/services/storage.service";

const UID = "uidA";
const valid = () => ({
  kind: "bug",
  message: "  The button does nothing  ",
  route: "/(tabs)/home",
  appVersion: "1.4.0",
  platform: "ios",
  osVersion: "26.5",
  appEnv: "dev",
});

// ---------- validation ----------
describe("validateFeedbackBody", () => {
  test("accepts a good body and trims the message", () => {
    const r = validateFeedbackBody(valid(), UID);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.message, "The button does nothing");
      assert.equal(r.value.screenshotPath, null);
    }
  });

  test("optional device fields default to 'unknown'", () => {
    const { osVersion, appEnv, ...rest } = valid();
    void osVersion; void appEnv;
    const r = validateFeedbackBody(rest, UID);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.osVersion, "unknown");
      assert.equal(r.value.appEnv, "unknown");
    }
  });

  const bad: [string, Record<string, unknown>][] = [
    ["unknown kind", { kind: "praise" }],
    ["missing kind", { kind: undefined }],
    ["empty message", { message: "" }],
    ["whitespace-only message", { message: "   \n " }],
    ["message over 2000", { message: "x".repeat(2001) }],
    ["non-string message", { message: 5 }],
    ["missing route", { route: undefined }],
    ["route over 200", { route: "/" + "a".repeat(200) }],
    ["missing appVersion", { appVersion: "" }],
    ["bad platform", { platform: "symbian" }],
    ["bad appEnv", { appEnv: "Prod!" }],
  ];
  for (const [name, patch] of bad) {
    test(`rejects ${name}`, () => {
      assert.equal(validateFeedbackBody({ ...valid(), ...patch }, UID).ok, false);
    });
  }

  test("accepts exactly 2000 characters and a 200-char route", () => {
    const r = validateFeedbackBody({ ...valid(), message: "x".repeat(2000), route: "/".padEnd(200, "a") }, UID);
    assert.ok(r.ok);
  });

  test("accepts the caller's own screenshot path", () => {
    const own = buildIssuedPath({ purpose: "feedback-screenshot", userId: UID }, "shot.png");
    const r = validateFeedbackBody({ ...valid(), screenshotPath: own }, UID);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.screenshotPath, own);
  });

  test("rejects a screenshot path under another user's prefix", () => {
    const foreign = buildIssuedPath({ purpose: "feedback-screenshot", userId: "uidB" }, "shot.png");
    assert.equal(validateFeedbackBody({ ...valid(), screenshotPath: foreign }, UID).ok, false);
  });

  test("rejects other purposes' paths, URLs and traversal", () => {
    const photo = buildIssuedPath({ purpose: "profile-photo", userId: UID }, "p.png");
    const own = buildIssuedPath({ purpose: "feedback-screenshot", userId: UID }, "shot.png");
    for (const p of [photo, `gs://bucket/${own}`, `users/${UID}/feedback/../profile/x.png`, 42, {}]) {
      assert.equal(validateFeedbackBody({ ...valid(), screenshotPath: p }, UID).ok, false, String(p));
    }
  });
});

describe("feedback-screenshot storage scope", () => {
  test("issues users/{uid}/feedback/{uuid}_{file} and validates for the same user only", () => {
    const p = buildIssuedPath({ purpose: "feedback-screenshot", userId: UID }, "a b.png");
    assert.match(p, /^users\/uidA\/feedback\/[0-9a-f-]{36}_a_b\.png$/);
    assert.equal(validateStoragePath(p, { purpose: "feedback-screenshot", userId: UID }).ok, true);
    assert.equal(validateStoragePath(p, { purpose: "feedback-screenshot", userId: "uidB" }).ok, false);
    assert.equal(validateStoragePath(p, { purpose: "profile-photo", userId: UID }).ok, false);
  });
});

// ---------- service ----------
interface Harness {
  svc: FeedbackService;
  saved: Record<string, unknown>[];
  emails: { to: string; subject: string; html: string; text: string }[];
  state: { recent: number; fileExists: boolean; emailResult: "sent" | "failed" | "throw" };
}

function harness(): Harness {
  const saved: Record<string, unknown>[] = [];
  const emails: Harness["emails"] = [];
  const state: Harness["state"] = { recent: 0, fileExists: true, emailResult: "sent" };
  const deps: FeedbackDeps = {
    countSince: async () => state.recent,
    save: async (doc) => {
      saved.push(doc as unknown as Record<string, unknown>);
      return "fb1";
    },
    fileExists: async () => state.fileExists,
    signDownload: async (path) => `https://signed.example/${path}?sig=1`,
    sendEmail: async (m) => {
      emails.push(m);
      if (state.emailResult === "throw") throw new Error("boom");
      return state.emailResult === "sent" ? { status: "sent" } : { status: "failed", error: "nope" };
    },
    now: () => 1_700_000_000_000,
  };
  const svc = new FeedbackService();
  svc.deps = deps;
  return { svc, saved, emails, state };
}

const input = (over: Record<string, unknown> = {}) => ({
  userId: UID,
  userEmail: "delivered+tester@resend.dev",
  role: "client",
  kind: "bug" as const,
  message: "It <b>broke</b> & burned",
  route: "/home",
  appVersion: "1.4.0",
  platform: "ios",
  osVersion: "26.5",
  appEnv: "dev",
  screenshotPath: null as string | null,
  ...over,
});

describe("FeedbackService.submit", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.FEEDBACK_TO_EMAIL;
    delete process.env.FEEDBACK_TO_EMAIL;
    mock.method(console, "warn", () => {});
    mock.method(console, "error", () => {});
  });
  afterEach(() => {
    mock.restoreAll();
    if (savedEnv === undefined) delete process.env.FEEDBACK_TO_EMAIL;
    else process.env.FEEDBACK_TO_EMAIL = savedEnv;
  });

  test("writes the document with status new and a Timestamp", async () => {
    const h = harness();
    const r = await h.svc.submit(input());
    assert.deepEqual(r, { ok: true, id: "fb1", screenshotAttached: false });
    assert.equal(h.saved.length, 1);
    const doc = h.saved[0];
    assert.equal(doc.userId, UID);
    assert.equal(doc.userEmail, "delivered+tester@resend.dev");
    assert.equal(doc.role, "client");
    assert.equal(doc.kind, "bug");
    assert.equal(doc.status, "new");
    assert.equal(doc.screenshotPath, null);
    assert.ok(doc.createdAt instanceof Timestamp);
    assert.equal((doc.createdAt as Timestamp).toMillis(), 1_700_000_000_000);
  });

  test("emails the team at the default address with an escaped body and subject", async () => {
    const h = harness();
    await h.svc.submit(input());
    assert.equal(h.emails.length, 1);
    const m = h.emails[0];
    assert.equal(m.to, "info@weareseli.com");
    assert.equal(m.subject, "[Seli feedback] bug: It <b>broke</b> & burned");
    assert.ok(m.html.includes("It &lt;b&gt;broke&lt;/b&gt; &amp; burned"));
    assert.ok(!m.html.includes("<b>broke</b>"));
    assert.ok(m.html.includes("1.4.0") && m.html.includes("/home") && m.html.includes("uidA"));
  });

  test("FEEDBACK_TO_EMAIL overrides the recipient", async () => {
    process.env.FEEDBACK_TO_EMAIL = "delivered+team@resend.dev";
    const h = harness();
    await h.svc.submit(input());
    assert.equal(h.emails[0].to, "delivered+team@resend.dev");
  });

  test("a screenshot adds a signed link to the email and is stored", async () => {
    const h = harness();
    const path = buildIssuedPath({ purpose: "feedback-screenshot", userId: UID }, "s.png");
    const r = await h.svc.submit(input({ screenshotPath: path }));
    assert.ok(r.ok && r.screenshotAttached);
    assert.equal(h.saved[0].screenshotPath, path);
    assert.ok(h.emails[0].html.includes("https://signed.example/"));
    assert.ok(h.emails[0].text.includes("https://signed.example/"));
  });

  test("a screenshot that was never uploaded is dropped, note still saved", async () => {
    const h = harness();
    h.state.fileExists = false;
    const path = buildIssuedPath({ purpose: "feedback-screenshot", userId: UID }, "s.png");
    const r = await h.svc.submit(input({ screenshotPath: path }));
    assert.ok(r.ok && !r.screenshotAttached);
    assert.equal(h.saved[0].screenshotPath, null);
  });

  test("a failed or throwing email does not fail the request", async () => {
    for (const mode of ["failed", "throw"] as const) {
      const h = harness();
      h.state.emailResult = mode;
      const r = await h.svc.submit(input());
      assert.equal(r.ok, true, mode);
      assert.equal(h.saved.length, 1);
    }
  });

  test("refuses the 11th note in an hour and writes nothing", async () => {
    const h = harness();
    h.state.recent = FEEDBACK_HOURLY_LIMIT - 1;
    assert.equal((await h.svc.submit(input())).ok, true);
    h.state.recent = FEEDBACK_HOURLY_LIMIT;
    const r = await h.svc.submit(input());
    assert.equal(r.ok, false);
    assert.equal(h.saved.length, 1);
    assert.equal(h.emails.length, 1);
  });
});

describe("email helpers", () => {
  test("escapeHtml escapes the five special characters", () => {
    assert.equal(escapeHtml("<a href=\"x\">'&'</a>"), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
  test("subject is one line and cut at 60 characters", () => {
    const s = buildSubject("idea", `line1\nline2 ${"x".repeat(100)}`);
    assert.ok(!s.includes("\n"));
    assert.ok(s.startsWith("[Seli feedback] idea: line1 line2 "));
    assert.equal(s.length, "[Seli feedback] idea: ".length + 60 + 1);
  });
  test("a hostile screenshot link cannot break out of the href", () => {
    const { html } = buildEmailBody(input(), "id", "https://x/\"><script>alert(1)</script>");
    assert.ok(!html.includes("<script>"));
  });
});

// ---------- controller ----------
function fakeRes() {
  const res: { statusCode: number; body: any; headers: Record<string, string> } = { statusCode: 200, body: null, headers: {} };
  const api = {
    status(c: number) { res.statusCode = c; return api; },
    json(b: unknown) { res.body = b; return api; },
    setHeader(k: string, v: string) { res.headers[k] = v; },
  };
  return { api: api as any, res };
}
const fakeReq = (body: unknown) =>
  ({ userId: UID, body, user: { email: "delivered+tester@resend.dev" }, authz: { uid: UID, role: "agent", agencyId: null } }) as any;

describe("FeedbackController", () => {
  let h: Harness;
  let original: FeedbackDeps;
  beforeEach(() => {
    h = harness();
    original = feedbackService.deps;
    feedbackService.deps = h.svc.deps;
    mock.method(console, "warn", () => {});
  });
  afterEach(() => {
    feedbackService.deps = original;
    mock.restoreAll();
  });

  test("201 on success; identity and role come from the token", async () => {
    const { api, res } = fakeRes();
    await feedbackController.create(fakeReq({ ...valid(), userId: "attacker", role: "admin" }), api);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.id, "fb1");
    assert.equal(h.saved[0].userId, UID);
    assert.equal(h.saved[0].role, "agent");
  });

  test("400 on an invalid body, nothing stored", async () => {
    const { api, res } = fakeRes();
    await feedbackController.create(fakeReq({ ...valid(), message: "" }), api);
    assert.equal(res.statusCode, 400);
    assert.equal(h.saved.length, 0);
  });

  test("400 on a foreign screenshot path", async () => {
    const foreign = buildIssuedPath({ purpose: "feedback-screenshot", userId: "uidB" }, "s.png");
    const { api, res } = fakeRes();
    await feedbackController.create(fakeReq({ ...valid(), screenshotPath: foreign }), api);
    assert.equal(res.statusCode, 400);
    assert.equal(h.saved.length, 0);
  });

  test("429 with Retry-After once the hourly limit is reached", async () => {
    h.state.recent = FEEDBACK_HOURLY_LIMIT;
    const { api, res } = fakeRes();
    await feedbackController.create(fakeReq(valid()), api);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, "RATE_LIMITED");
    assert.ok(res.headers["Retry-After"]);
  });

  test("screenshot-url: rejects non-image content types and missing fields", async () => {
    for (const body of [{ fileName: "a.pdf", contentType: "application/pdf" }, { fileName: "a.png" }, {}]) {
      const { api, res } = fakeRes();
      await feedbackController.getScreenshotUploadUrl(fakeReq(body), api);
      assert.equal(res.statusCode, 400);
    }
  });

  test("screenshot-url: returns the URL and a path under the caller's feedback folder", async () => {
    const m = mock.method(storageService, "getSignedFeedbackScreenshotUploadUrl", async (uid: string, f: string) => ({
      uploadUrl: "https://upload.example/put",
      storagePath: buildIssuedPath({ purpose: "feedback-screenshot", userId: uid }, f),
      expiresAt: new Date(),
    }));
    const { api, res } = fakeRes();
    await feedbackController.getScreenshotUploadUrl(fakeReq({ fileName: "s.png", contentType: "image/png" }), api);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.uploadUrl, "https://upload.example/put");
    assert.match(res.body.data.storagePath, /^users\/uidA\/feedback\//);
    assert.equal(m.mock.callCount(), 1);
    assert.equal(Object.keys(res.body.data).sort().join(), "storagePath,uploadUrl");
  });
});
