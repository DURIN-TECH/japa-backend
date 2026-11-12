// ============================================
// Behaviour tests — guarded HTTP client against local stub servers (issue #159)
// ============================================
//
// Stub servers bind to 127.0.0.1 only and nothing leaves the machine. Name
// resolution is an injected resolver (`stub.test` etc. -> 127.0.0.1), so no
// real DNS happens. The test hook (`AddressGuardOptions`) is what lets a stub
// through; the "no hook" tests show the production defaults refuse loopback.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  BlockedAddressError,
  createGuardedHttpClient,
  type AddressGuardOptions,
} from "../../../../src/scrapers/shared/fetch/address-guard";
import { VisaCatalogFetchService, visaCatalogFetchService } from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { createNewsHttpClient } from "../../../../src/scrapers/news/news-scraper.service";
import { isHostBackoffError } from "../../../../src/scrapers/shared/etiquette/visa-crawl-host-state";
import { UkHomeOfficeOutcomeAdapter } from "../../../../src/scrapers/outcome-statistics/adapters/uk-home-office/uk-home-office.adapter";

/** A loopback stub that records every connection and request it receives. */
interface Stub {
  server: http.Server;
  port: number;
  connections: number;
  requests: string[];
}

async function startStub(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Stub> {
  const stub = { connections: 0, requests: [] as string[] } as Stub;
  stub.server = http.createServer((req, res) => {
    stub.requests.push(req.url ?? "");
    handler(req, res);
  });
  stub.server.on("connection", () => stub.connections++);
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
  stub.port = (stub.server.address() as AddressInfo).port;
  return stub;
}

/** Resolver: every test hostname resolves to loopback (the stubs). */
const toLoopback = async () => [{ address: "127.0.0.1", family: 4 }];

/** Hook allowing only the named hosts to reach loopback, on any port. */
const allowHosts = (...hosts: string[]): AddressGuardOptions => ({
  resolver: toLoopback,
  allowAddress: (_ip, host) => hosts.includes(host),
  allowPort: () => true,
});

let ok: Stub; // answers 200 "ok", /go redirects to the second stub by name
let ok2: Stub; // a second allowed stub (redirect target)
let internal: Stub; // must never receive a request

before(async () => {
  ok2 = await startStub((_req, res) => res.end("second"));
  ok = await startStub((req, res) => {
    if (req.url === "/to-other") {
      res.statusCode = 302;
      res.setHeader("location", `http://other.test:${ok2.port}/landed`);
      return res.end();
    }
    if (req.url === "/to-internal-name") {
      res.statusCode = 302;
      res.setHeader("location", `http://internal.test:${internal.port}/secret`);
      return res.end();
    }
    if (req.url === "/to-internal-literal") {
      res.statusCode = 302;
      res.setHeader("location", `http://127.0.0.1:${internal.port}/secret`);
      return res.end();
    }
    if (req.url === "/to-bad-port") {
      res.statusCode = 302;
      res.setHeader("location", `http://other.test:${internal.port}/secret`);
      return res.end();
    }
    res.end("ok");
  });
  internal = await startStub((_req, res) => res.end("secret"));
});

after(async () => {
  for (const s of [ok, ok2, internal]) await new Promise((r) => s.server.close(r));
});

describe("guarded client: allowed traffic still works (test hook)", () => {
  test("a stub on an allowed host returns 200, and a redirect to another allowed stub is followed", async () => {
    const client = createGuardedHttpClient({ validateStatus: () => true }, allowHosts("pub.test", "other.test"));
    const plain = await client.get(`http://pub.test:${ok.port}/plain`);
    assert.equal(plain.status, 200);
    assert.equal(plain.data, "ok");
    const redirected = await client.get(`http://pub.test:${ok.port}/to-other`);
    assert.equal(redirected.data, "second");
  });
});

describe("guarded client: refusals", () => {
  test("a hostname that resolves to loopback is refused before any connection", async () => {
    const before = ok.connections;
    const client = createGuardedHttpClient({}, { resolver: toLoopback, allowPort: () => true });
    await assert.rejects(client.get(`http://pub.test:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
  });

  test("the error message names only the host, never the resolved address", async () => {
    const client = createGuardedHttpClient({}, { resolver: toLoopback, allowPort: () => true });
    await assert.rejects(client.get(`http://pub.test:${ok.port}/plain`), (e: Error) => {
      assert.equal(e.message, "Refusing to fetch from pub.test: address not allowed");
      return true;
    });
  });

  test("a redirect to a loopback HOSTNAME is refused at that hop; the target gets no request", async () => {
    const client = createGuardedHttpClient({}, allowHosts("pub.test"));
    const before = internal.requests.length;
    await assert.rejects(client.get(`http://pub.test:${ok.port}/to-internal-name`), (e) => e instanceof BlockedAddressError);
    assert.equal(internal.requests.length, before);
  });

  test("a redirect to a loopback IP LITERAL is refused at that hop; the target gets no request", async () => {
    const client = createGuardedHttpClient({}, allowHosts("pub.test"));
    const before = internal.connections;
    await assert.rejects(client.get(`http://pub.test:${ok.port}/to-internal-literal`), (e) => e instanceof BlockedAddressError);
    assert.equal(internal.connections, before);
  });

  test("an initial IP-literal URL is refused with no connection", async () => {
    const client = createGuardedHttpClient({}, { allowPort: () => true });
    const before = ok.connections;
    await assert.rejects(client.get(`http://127.0.0.1:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
  });

  test("a hostname resolving to a mix of public and non-public addresses is refused", async () => {
    const client = createGuardedHttpClient(
      {},
      {
        resolver: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        allowPort: () => true,
      }
    );
    const before = ok.connections;
    await assert.rejects(client.get(`http://mixed.test:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
  });

  test("the connection that is made is the one that was checked (public, then loopback on the next lookup)", async () => {
    // Each request resolves afresh (no keep-alive pooling on the guarded agents).
    // The first lookup is allowed through (the hook stands in for "public");
    // the second returns the same name but is no longer allowed -> refused.
    let allowed = true;
    const client = createGuardedHttpClient({}, {
      resolver: toLoopback,
      allowAddress: () => allowed,
      allowPort: () => true,
    });
    assert.equal((await client.get(`http://flip.test:${ok.port}/plain`)).data, "ok");
    allowed = false;
    const before = ok.connections;
    await assert.rejects(client.get(`http://flip.test:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
  });

  test("ports other than 80/443 are refused on the first request and on a redirect hop", async () => {
    // Port hook NOT set: only 80/443 pass, so the stub's random port is refused.
    const first = createGuardedHttpClient({}, { resolver: toLoopback, allowAddress: () => true });
    const before = ok.connections;
    await assert.rejects(first.get(`http://pub.test:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
    // Hook allows the first stub's port only; the redirect to another port is refused.
    const hop = createGuardedHttpClient({}, {
      resolver: toLoopback,
      allowAddress: () => true,
      allowPort: (p) => p === ok.port,
    });
    const internalBefore = internal.requests.length;
    await assert.rejects(hop.get(`http://pub.test:${ok.port}/to-bad-port`), (e) => e instanceof BlockedAddressError);
    assert.equal(internal.requests.length, internalBefore);
  });

  test("an environment proxy is ignored (proxy:false), so it cannot bypass the lookup", async () => {
    const proxy = await startStub((_req, res) => res.end("via proxy"));
    const saved = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    try {
      const client = createGuardedHttpClient({}, allowHosts("pub.test"));
      const resp = await client.get(`http://pub.test:${ok.port}/plain`);
      assert.equal(resp.data, "ok"); // came from the stub itself
      assert.equal(proxy.connections, 0);
      // And with no allowance it is refused outright instead of tunnelled.
      const strict = createGuardedHttpClient({}, { resolver: toLoopback, allowPort: () => true });
      await assert.rejects(strict.get(`http://pub.test:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
      assert.equal(proxy.connections, 0);
    } finally {
      if (saved === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = saved;
      await new Promise((r) => proxy.server.close(r));
    }
  });
});

describe("production defaults refuse loopback with no hook", () => {
  test("createNewsHttpClient()", async () => {
    const before = ok.connections;
    await assert.rejects(createNewsHttpClient().get(`http://127.0.0.1:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
  });

  test("VisaCatalogFetchService.createDefaultClient()", async () => {
    const before = ok.connections;
    await assert.rejects(VisaCatalogFetchService.createDefaultClient().get(`http://127.0.0.1:${ok.port}/plain`), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
  });

  test("the exported visaCatalogFetchService singleton (robots fails open, the page is still refused)", async () => {
    const before = ok.connections;
    const url = `http://127.0.0.1:${ok.port}/plain`;
    // robots.txt is unreadable (refused), which fails open today ...
    assert.equal(await visaCatalogFetchService.isAllowedByRobots(url), true);
    // ... but the page fetch is refused by the same guard.
    await assert.rejects(visaCatalogFetchService.getRaw(url), (e) => e instanceof BlockedAddressError);
    await assert.rejects(visaCatalogFetchService.fetchAndClean(url), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);
  });

  test("a refusal is not a 429/503 host backoff", async () => {
    try {
      await visaCatalogFetchService.getRaw(`http://127.0.0.1:${ok.port}/plain`);
      assert.fail("expected a refusal");
    } catch (e) {
      assert.equal(isHostBackoffError(e), false);
    }
  });

  test("the UK outcome adapter download goes through the guard", async () => {
    // Robots check (singleton, fail-open) then a download that must be refused.
    const adapter = new UkHomeOfficeOutcomeAdapter();
    const before = ok.connections;
    await assert.rejects(
      adapter.download({ fileUrl: `http://127.0.0.1:${ok.port}/file.ods` } as never, "/dev/null"),
      (e) => e instanceof BlockedAddressError
    );
    assert.equal(ok.connections, before);
  });
});

describe("fetch service robots + page through a guarded default client", () => {
  test("a refused robots.txt does not let the page through, and the allowed host works", async () => {
    // Robots + page on a name that is refused.
    const refused = new VisaCatalogFetchService({
      minIntervalMs: 0,
      addressGuard: { resolver: toLoopback, allowPort: () => true },
    });
    const before = ok.connections;
    const url = `http://pub.test:${ok.port}/plain`;
    assert.equal(await refused.isAllowedByRobots(url), true); // fail-open on the robots fetch
    await assert.rejects(refused.getRaw(url), (e) => e instanceof BlockedAddressError);
    assert.equal(ok.connections, before);

    // Same service shape with the stub allowed: robots + page both flow.
    const allowed = new VisaCatalogFetchService({ minIntervalMs: 0, addressGuard: allowHosts("pub.test") });
    assert.equal(await allowed.isAllowedByRobots(url), true);
    assert.equal((await allowed.getRaw(url)).body, "ok");
  });
});
