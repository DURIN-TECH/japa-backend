// ============================================
// Unit tests: the public pay-link routes behind Google's front end
// (issue #391, review round 1)
// ============================================
//
// Hermetic: the REAL app (src/app.ts) on a local port, the in-memory
// Firestore. Checks the two app-level fixes of review round 1:
//  - `trust proxy` is 1 hop: the rate-limit key is the address the front end
//    appended (the RIGHTMOST `X-Forwarded-For` entry), so a client that sends
//    its own leftmost entries cannot change its bucket or spread over many;
//  - a body that is not valid JSON is a 400 VALIDATION_ERROR, never a 500.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../../src/app";
import { payLinkRateLimit } from "../../src/middleware/public-rate-limit";
import { installFakes, resetStore } from "../helpers/fake-firestore";

let server: Server;
let base = "";
const realLog = console.log;
const realWarn = console.warn;

/** POST the lookup route with a raw body and an `X-Forwarded-For` header. */
async function lookup(forwardedFor: string, rawBody = JSON.stringify({ token: "not-a-token" })) {
  const res = await fetch(`${base}/consultations/public/pay-links/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
    body: rawBody,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

before(async () => {
  await installFakes();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  resetStore();
  payLinkRateLimit.reset();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});

describe("review round 1: trust proxy 1 and the pay-link rate limit key", () => {
  test("the app trusts exactly one proxy hop (never `true`)", () => {
    assert.equal(app.get("trust proxy"), 1);
  });

  test("a spoofed leftmost X-Forwarded-For entry does not change the key: 30 per caller, then 429", async () => {
    // The same caller (front end saw 203.0.113.7) sends a different fake
    // leftmost address every time.
    for (let i = 0; i < 30; i++) {
      const out = await lookup(`10.0.0.${i}, 203.0.113.7`);
      assert.equal(out.status, 400, "malformed token: 400, but counted");
    }
    const over = await lookup("10.0.0.99, 203.0.113.7");
    assert.equal(over.status, 429);
    assert.equal(over.json.error, "RATE_LIMITED");
  });

  test("two real callers behind the same front end have their own buckets", async () => {
    for (let i = 0; i < 30; i++) await lookup("198.51.100.1");
    assert.equal((await lookup("198.51.100.1")).status, 429);
    assert.equal((await lookup("198.51.100.2")).status, 400, "another caller is not limited");
  });
});

describe("review round 1: a body that is not valid JSON", () => {
  test("is 400 VALIDATION_ERROR, never 500, and the body is not logged", async () => {
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      const out = await lookup("198.51.100.3", "{\"token\": \"SECRET-TOKEN-VALUE\"");
      assert.equal(out.status, 400);
      assert.equal(out.json.error, "VALIDATION_ERROR");
    } finally {
      console.error = realError;
      console.warn = realWarn;
      console.log = realLog;
    }
    assert.ok(!logged.join("\n").includes("SECRET-TOKEN-VALUE"), "the body is never logged");
  });
});
