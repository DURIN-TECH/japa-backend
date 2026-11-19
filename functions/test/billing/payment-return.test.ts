// ============================================
// Unit tests — Paystack return-to-app (issue #252)
// ============================================
//
// Run with `npm test`. Hermetic: no network, no emulator. Paystack's HTTP
// client is replaced by a recorder, and the Firestore refs the handlers touch
// are swapped for tiny in-memory stand-ins (restored after each test).
//
// Pinned here:
//  1. The return page: a 200 page whose meta refresh AND visible link point at
//     the FIXED `durintech://payment-return` (no 302: Android Custom Tabs), with
//     only the validated, URL-encoded `reference` (or `trxref`) forwarded and
//     every other param dropped; an HTML fallback link; no-store / CSP headers.
//  2. `returnTo` parsing: absent → default, "app" → app, anything else → 400.
//  3. Callback selection: the API base follows the running project (deployed,
//     emulator, explicit override), never hard-coded to prod.
//  4. Subscription checkout: `returnTo: "app"` sends the return page as
//     Paystack's `callback_url`; without it the provider default
//     (`PAYSTACK_CALLBACK_URL`) is sent, as before.
//  5. Payment-request approve: moved to
//     test/payment-requests/payment-request-return-to.test.ts (needs the #181
//     charge-path harness).

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "@durin-tech/authz";

import {
  APP_RETURN_URL,
  buildAppReturnUrl,
  extractReference,
  getApiBaseUrl,
  readEmulatorFunctionsPort,
  getAppReturnCallbackUrl,
  parseReturnTo,
  renderReturnPage,
  selectCallbackUrl,
} from "../../src/services/billing/payment-return";
import { paymentReturnController } from "../../src/controllers/payment-return.controller";
import { PaystackProvider, paystackProvider } from "../../src/services/billing/paystack.provider";
import { billingService } from "../../src/services/billing/billing.service";
import { entitlementController } from "../../src/controllers/entitlement.controller";
import { entitlementService } from "../../src/services/entitlement.service";
import { collections } from "../../src/utils/firebase";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Helpers
// ============================================

/** A minimal Express `res` that records status, headers, location and body. */
function fakeRes() {
  const out: { status: number | null; headers: Record<string, string>; location?: string; body?: any; type?: string } = {
    status: null,
    headers: {},
  };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    set(name: string, value: string) { out.headers[name.toLowerCase()] = value; return res; },
    location(url: string) { out.location = url; return res; },
    type(t: string) { out.type = t; return res; },
    send(body: unknown) { out.body = body; return res; },
    json(body: unknown) { out.body = body; return res; },
  };
  return { res, out };
}

/**
 * The meta-refresh target of a return page body, HTML-unescaped, or undefined.
 * This is where the page sends the browser (review fix: no 302 any more).
 */
function refreshTarget(body: string): string | undefined {
  const m = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(body);
  return m ? m[1].replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&") : undefined;
}

/** Run the return page handler; `location` = the page's meta-refresh target. */
function hitReturnPage(query: Record<string, unknown>) {
  const { res, out } = fakeRes();
  paymentReturnController.handleReturn({ query } as any, res);
  // The handler must not send a Location header (a 200 page, not a redirect).
  assert.equal(out.location, undefined);
  return { ...out, location: refreshTarget(String(out.body)) };
}

/** Env keys the base-URL logic reads; snapshot + restore so tests don't leak. */
const ENV_KEYS = ["API_PUBLIC_URL", "FUNCTIONS_EMULATOR", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "PAYSTACK_CALLBACK_URL"] as const;
let envSnapshot: Record<string, string | undefined> = {};
/** Monkeypatches to undo after each test: [object, key, original value]. */
const patches: Array<[any, string, unknown]> = [];
/** Replace `obj[key]` for the current test only. */
function patch(obj: any, key: string, value: unknown) {
  patches.push([obj, key, obj[key]]);
  obj[key] = value;
}

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.API_PUBLIC_URL;
  delete process.env.FUNCTIONS_EMULATOR;
  process.env.GCLOUD_PROJECT = "demo-unit-test";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  while (patches.length) {
    const [obj, key, original] = patches.pop()!;
    obj[key] = original;
  }
});

/**
 * Point the shared Paystack provider's HTTP client at a recorder. Returns the
 * recorded `/transaction/initialize` payloads.
 */
function recordPaystack() {
  const calls: any[] = [];
  patch(paystackProvider as any, "client", () => ({
    post: async (_url: string, payload: unknown) => {
      calls.push(payload);
      return { data: { data: { authorization_url: "https://checkout.paystack.com/x", access_code: "a", reference: "ref_123" } } };
    },
  }));
  return calls;
}

// ============================================
// 1. Return page
// ============================================

describe("GET /payments/return", () => {
  test("200 page that meta-refreshes to the fixed app deep link with the reference", () => {
    const out = hitReturnPage({ reference: "ref_123", trxref: "ref_123" });
    assert.equal(out.status, 200);
    // No scripts at all: navigation is meta refresh + a visible link only.
    assert.ok(!/<script/i.test(out.body));
    assert.equal(out.location, "durintech://payment-return?reference=ref_123");
    // HTML fallback link to the same target, and locked-down headers.
    assert.equal(out.type, "html");
    assert.match(out.body, /<a href="durintech:\/\/payment-return\?reference=ref_123">Return to Seli<\/a>/);
    assert.equal(out.headers["cache-control"], "no-store");
    assert.equal(out.headers["referrer-policy"], "no-referrer");
    assert.match(out.headers["content-security-policy"], /default-src 'none'/);
  });

  test("falls back to trxref when reference is missing", () => {
    assert.equal(hitReturnPage({ trxref: "T9876" }).location, "durintech://payment-return?reference=T9876");
  });

  test("drops every other param (no open redirect, nothing smuggled)", () => {
    const out = hitReturnPage({
      reference: "abc",
      redirect: "https://evil.example",
      next: "javascript:alert(1)",
      callback: "durintech://other",
    });
    assert.equal(out.location, "durintech://payment-return?reference=abc");
    assert.ok(!out.body.includes("evil"));
  });

  test("refuses a crafted reference rather than forwarding it", () => {
    for (const reference of [
      "abc&evil=1",
      "abc#frag",
      "https://evil.example",
      "a b",
      "<script>",
      "x".repeat(101),
      "",
    ]) {
      const out = hitReturnPage({ reference });
      assert.equal(out.status, 200);
      assert.equal(out.location, APP_RETURN_URL, `should drop ${JSON.stringify(reference)}`);
    }
  });

  test("ignores array / object query shapes beyond the first plain string", () => {
    assert.equal(extractReference({ reference: ["r1", "r2"] }), "r1");
    assert.equal(extractReference({ reference: { $ne: "x" } }), null);
    assert.equal(extractReference({}), null);
  });

  test("URL-encodes the forwarded reference", () => {
    // `=` is allowed by the pattern and must be encoded in the query value.
    assert.equal(buildAppReturnUrl({ reference: "a=b" }), "durintech://payment-return?reference=a%3Db");
  });

  test("the fallback page escapes its link", () => {
    assert.match(renderReturnPage("x\"<y>"), /href="x&quot;&lt;y&gt;"/);
  });
});

// ============================================
// 2 + 3. returnTo parsing and callback selection
// ============================================

describe("returnTo + callback URL selection", () => {
  test("parseReturnTo: absent → default, 'app' → app, anything else refused", () => {
    assert.deepEqual(parseReturnTo(undefined), { ok: true, value: undefined });
    assert.deepEqual(parseReturnTo(null), { ok: true, value: undefined });
    assert.deepEqual(parseReturnTo("app"), { ok: true, value: "app" });
    for (const bad of ["web", "APP", "", 1, true, "https://evil.example"]) {
      assert.deepEqual(parseReturnTo(bad), { ok: false });
    }
  });

  test("deployed base follows the running project (dev vs prod)", () => {
    process.env.GCLOUD_PROJECT = "durin-seli-dev";
    assert.equal(getAppReturnCallbackUrl(), "https://us-central1-durin-seli-dev.cloudfunctions.net/api/payments/return");
    process.env.GCLOUD_PROJECT = "japa-platform";
    assert.equal(getAppReturnCallbackUrl(), "https://us-central1-japa-platform.cloudfunctions.net/api/payments/return");
  });

  test("emulator base uses the firebase.json port, and API_PUBLIC_URL (http ok) wins", () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    process.env.GCLOUD_PROJECT = "japa-platform";
    // The repo's firebase.json sets emulators.functions.port.
    assert.equal(readEmulatorFunctionsPort(), 5001);
    assert.equal(getApiBaseUrl(), "http://127.0.0.1:5001/japa-platform/us-central1/api");
    // A different emulator port is followed (injected reader).
    assert.equal(getApiBaseUrl(process.env, () => 5099), "http://127.0.0.1:5099/japa-platform/us-central1/api");
    process.env.API_PUBLIC_URL = "http://10.0.2.2:5001/japa-platform/us-central1/api/";
    assert.equal(getApiBaseUrl(), "http://10.0.2.2:5001/japa-platform/us-central1/api");
  });

  test("API_PUBLIC_URL must be https outside the emulator; junk always throws", () => {
    process.env.API_PUBLIC_URL = "https://api.seli.test/api/";
    assert.equal(getApiBaseUrl(), "https://api.seli.test/api");
    process.env.API_PUBLIC_URL = "http://api.seli.test/api";
    assert.throws(() => getApiBaseUrl(), /https/);
    process.env.API_PUBLIC_URL = "durintech://x";
    assert.throws(() => getApiBaseUrl(), /https/);
    process.env.FUNCTIONS_EMULATOR = "true";
    assert.throws(() => getApiBaseUrl(), /http\(s\)/);
  });

  test("no project id (and no override) fails loudly instead of a broken URL", () => {
    assert.throws(() => getApiBaseUrl({}), /no project id/);
    assert.throws(() => getApiBaseUrl({ FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: " " }), /no project id/);
  });

  test("selectCallbackUrl: app → return page, default → the given fallback", () => {
    assert.match(selectCallbackUrl("app", "https://portal/x")!, /\/payments\/return$/);
    assert.equal(selectCallbackUrl(undefined, "https://portal/x"), "https://portal/x");
    assert.equal(selectCallbackUrl(undefined), undefined);
  });
});

// ============================================
// Provider: createCheckout callback option
// ============================================

describe("PaystackProvider.createCheckout callbackUrl", () => {
  /** Provider with a recording client (no network, no key needed). */
  function provider() {
    const calls: any[] = [];
    const p = new PaystackProvider();
    (p as any).client = () => ({
      post: async (_u: string, payload: unknown) => (calls.push(payload), {
        data: { data: { authorization_url: "https://pay/x", access_code: "a", reference: "r1" } },
      }),
    });
    return { p, calls };
  }
  const base = { subscriberType: "client" as const, subscriberId: "u1", planId: "client_pro", email: "delivered+u1@resend.dev", amountKobo: 500_000 };

  test("a per-request callbackUrl overrides PAYSTACK_CALLBACK_URL", async () => {
    process.env.PAYSTACK_CALLBACK_URL = "https://portal.test/billing/return";
    const { p, calls } = provider();
    await p.createCheckout({ ...base, callbackUrl: "https://api.test/payments/return" });
    assert.equal(calls[0].callback_url, "https://api.test/payments/return");
  });

  test("without one, the PAYSTACK_CALLBACK_URL default is sent (unchanged)", async () => {
    process.env.PAYSTACK_CALLBACK_URL = "https://portal.test/billing/return";
    const { p, calls } = provider();
    await p.createCheckout(base);
    assert.equal(calls[0].callback_url, "https://portal.test/billing/return");
    delete process.env.PAYSTACK_CALLBACK_URL;
    await p.createCheckout(base);
    assert.equal("callback_url" in calls[1], false);
  });
});

// ============================================
// 4. POST /subscriptions/checkout
// ============================================

describe("POST /subscriptions/checkout returnTo", () => {
  /** Fake the plan lookup + subscriber resolution; record Paystack payloads. */
  function setup() {
    const calls = recordPaystack();
    patch(collections as any, "plans", {
      doc: () => ({
        get: async () => ({
          exists: true,
          data: () => ({ id: "client_pro", audience: "client", priceKobo: 500_000 }),
        }),
      }),
    });
    patch(entitlementService as any, "resolveSubscriber", () => ({ type: "client", id: "u1" }));
    return calls;
  }
  /** Call the controller with a body. */
  async function call(body: Record<string, unknown>) {
    const { res, out } = fakeRes();
    await entitlementController.createCheckout(
      { authz: { role: ROLES.CLIENT, uid: "u1" }, user: { uid: "u1", email: "delivered+u1@resend.dev" }, body } as any,
      res
    );
    return out;
  }

  test("returnTo: 'app' sends the app return page as callback_url", async () => {
    process.env.GCLOUD_PROJECT = "durin-seli-dev";
    const calls = setup();
    const out = await call({ planId: "client_pro", returnTo: "app" });
    assert.equal(out.body.success, true);
    assert.equal(out.body.data.reference, "ref_123");
    assert.equal(calls[0].callback_url, "https://us-central1-durin-seli-dev.cloudfunctions.net/api/payments/return");
  });

  test("no returnTo keeps the PAYSTACK_CALLBACK_URL default (portal)", async () => {
    process.env.PAYSTACK_CALLBACK_URL = "https://portal.test/settings/billing";
    const calls = setup();
    await call({ planId: "client_pro" });
    assert.equal(calls[0].callback_url, "https://portal.test/settings/billing");
  });

  test("returnTo: 'app' with no project id → 500, no checkout opened", async () => {
    const calls = setup();
    delete process.env.GCLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const out = await call({ planId: "client_pro", returnTo: "app" });
    assert.equal(out.status, 500);
    assert.equal(calls.length, 0);
  });

  test("an unknown returnTo is a 400 and opens no checkout", async () => {
    const calls = setup();
    const out = await call({ planId: "client_pro", returnTo: "https://evil.example" });
    assert.equal(out.status, 400);
    assert.equal(calls.length, 0);
  });

  test("billingService.createCheckout without options still works (other callers)", async () => {
    process.env.PAYSTACK_CALLBACK_URL = "https://portal.test/settings/billing";
    const calls = setup();
    await billingService.createCheckout("client", "u1", "client_pro", "delivered+u1@resend.dev");
    assert.equal(calls[0].callback_url, "https://portal.test/settings/billing");
  });
});

// ============================================
// 5. PUT /payment-requests/:id/approve: moved
// ============================================
// Since #181 the approve opens its checkout through the shared charge path
// (race-safe claim -> open -> publish in Firestore transactions), which these
// hand-rolled stubs cannot drive. The same cases now run on the payment-request
// harness: test/payment-requests/payment-request-return-to.test.ts.

// ============================================
// Mounting: the real Express app serves the page with NO auth
// ============================================

describe("app mounting", () => {
  test("GET /payments/return is public and serves the return page without a token", async () => {
    // Imported lazily so the other suites don't pay for the full app import.
    const { app } = await import("../../src/app");
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(
        `http://127.0.0.1:${port}/payments/return?trxref=ref_9&reference=ref_9&next=https://evil.example`,
        { redirect: "manual" }
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("location"), null);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(refreshTarget(await res.text()), "durintech://payment-return?reference=ref_9");
    } finally {
      server.close();
    }
  });
});
