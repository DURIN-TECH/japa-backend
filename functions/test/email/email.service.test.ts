// ============================================
// Unit tests — local email switch (issue #157)
// ============================================
//
// Covers EmailService's EMAIL_SENDING_ENABLED guard: suppressed under the
// emulator unless the switch is exactly "true", and ignored outside it.
// The Resend provider is stubbed, so no test makes a network call.

import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { emailService } from "../../src/services/email/email.service";
import { resendProvider } from "../../src/services/email/resend.provider";

const MSG = { to: "delivered+x@resend.dev", subject: "Hello", html: "<p>hi</p>" };

describe("EmailService local email switch", () => {
  let saved: NodeJS.ProcessEnv;
  let sendMock: ReturnType<typeof mock.method>;
  let infoMock: ReturnType<typeof mock.method>;

  beforeEach(() => {
    saved = { ...process.env };
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_SENDING_ENABLED;
    // Provider stubbed: records calls, never touches the network.
    sendMock = mock.method(resendProvider, "send", async () => ({ status: "sent" as const, providerId: "id1" }));
    infoMock = mock.method(console, "info", () => {});
  });

  afterEach(() => {
    mock.restoreAll();
    // Restore process.env exactly.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  test("emulator + switch off: skipped, no provider call, one 'would send' log", async () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    const res = await emailService.send(MSG);
    assert.equal(res.status, "skipped");
    assert.equal(sendMock.mock.callCount(), 0);
    assert.equal(infoMock.mock.callCount(), 1);
    const line = String(infoMock.mock.calls[0].arguments[0]);
    assert.match(line, /would send/);
    assert.ok(line.includes(MSG.to) && line.includes(MSG.subject));
  });

  test("emulator + switch not exactly 'true' (e.g. '1'): still suppressed", async () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.EMAIL_SENDING_ENABLED = "1";
    assert.equal((await emailService.send(MSG)).status, "skipped");
    assert.equal(sendMock.mock.callCount(), 0);
  });

  test("emulator + switch 'true': delegates to the provider", async () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.EMAIL_SENDING_ENABLED = "true";
    const res = await emailService.send(MSG);
    assert.equal(res.status, "sent");
    assert.equal(sendMock.mock.callCount(), 1);
  });

  test("non-emulator ignores the switch", async () => {
    delete process.env.FUNCTIONS_EMULATOR;
    process.env.EMAIL_SENDING_ENABLED = "false";
    assert.equal((await emailService.send(MSG)).status, "sent");
    assert.equal(sendMock.mock.callCount(), 1);
  });

  test("isConfigured is false while suppressed, provider-driven otherwise", () => {
    process.env.RESEND_API_KEY = "re_test_placeholder";
    process.env.EMAIL_FROM = "Seli <info@example.test>";
    process.env.FUNCTIONS_EMULATOR = "true";
    assert.equal(emailService.isConfigured, false);
    process.env.EMAIL_SENDING_ENABLED = "true";
    assert.equal(emailService.isConfigured, true);
    delete process.env.FUNCTIONS_EMULATOR;
    delete process.env.EMAIL_SENDING_ENABLED;
    assert.equal(emailService.isConfigured, true);
  });
});
