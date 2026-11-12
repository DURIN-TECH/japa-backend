// ============================================
// Unit tests — address guard: classifier, error, lookup (issue #159)
// ============================================
//
// Pure tests: no network, no DNS. The classifier is table driven (every refused
// class, both edges of each range, public addresses that must pass); the
// connect-time lookup is driven with an injected resolver.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BlockedAddressError,
  assertUrlAllowed,
  asBlockedAddressError,
  createGuardedLookup,
  isAllowedPort,
  isPublicAddress,
  isUrlAllowed,
} from "../../../../src/scrapers/shared/fetch/address-guard";

// ---------- classifier tables ----------

/** [address, why it must be refused] */
const REFUSED: Array<[string, string]> = [
  // IPv4: every refused class, and both edges of each range.
  ["0.0.0.0", "this-network first"],
  ["0.255.255.255", "this-network last"],
  ["10.0.0.0", "10/8 first"],
  ["10.255.255.255", "10/8 last"],
  ["100.64.0.0", "CGNAT first"],
  ["100.127.255.255", "CGNAT last"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.255", "loopback last"],
  ["169.254.0.0", "link-local first"],
  ["169.254.169.254", "metadata"],
  ["169.254.255.255", "link-local last"],
  ["172.16.0.0", "172.16/12 first"],
  ["172.31.255.255", "172.16/12 last"],
  ["192.0.0.0", "IETF assignments first"],
  ["192.0.0.255", "IETF assignments last"],
  ["192.0.2.1", "documentation"],
  ["192.88.99.1", "6to4 relay"],
  ["192.168.0.0", "192.168/16 first"],
  ["192.168.255.255", "192.168/16 last"],
  ["198.18.0.0", "benchmarking first"],
  ["198.19.255.255", "benchmarking last"],
  ["198.51.100.7", "documentation"],
  ["203.0.113.7", "documentation"],
  ["224.0.0.1", "multicast"],
  ["239.255.255.255", "multicast last"],
  ["240.0.0.0", "reserved first"],
  ["255.255.255.255", "broadcast"],
  // IPv6: classes outside 2000::/3 and the special blocks inside it.
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["fc00::1", "unique-local"],
  ["fdff:ffff::1", "unique-local"],
  ["fe80::1", "link-local"],
  ["fec0::1", "site-local"],
  ["ff02::1", "multicast"],
  ["::1.2.3.4", "IPv4-compatible (dotted)"],
  ["::102:304", "IPv4-compatible (hex)"],
  ["::ffff:1.2.3.4", "IPv4-mapped (dotted)"],
  ["::ffff:0102:0304", "IPv4-mapped (hex)"],
  ["0:0:0:0:0:ffff:8.8.8.8", "IPv4-mapped (long form, public embedded)"],
  ["64:ff9b::808:808", "NAT64"],
  ["64:ff9b:1::1", "local-use NAT64"],
  ["2002:808:808::1", "6to4"],
  ["2001::1", "Teredo / IETF assignments"],
  ["2001:db8::1", "documentation"],
  ["3fff::1", "documentation (3fff::/20)"],
  ["3fff:fff:ffff::1", "documentation last"],
  ["fe80::1%eth0", "zone id"],
];

/** Addresses that must pass, including just outside each refused range. */
const PUBLIC: string[] = [
  "8.8.8.8",
  "1.1.1.1",
  "9.255.255.255",
  "11.0.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "126.255.255.255",
  "128.0.0.0",
  "169.253.255.255",
  "169.255.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "192.0.1.1",
  "192.169.0.0",
  "192.167.255.255",
  "198.17.255.255",
  "198.20.0.0",
  "223.255.255.255",
  "2606:4700:4700::1111",
  "2a00:1450:4009::200e",
  "2001:200::1",
  "2001:4860:4860::8888",
  "2003::1",
  "2001:db9::1",
  "3ffe::1",
  "3fff:1000::1",
];

describe("isPublicAddress", () => {
  for (const [ip, why] of REFUSED) {
    test(`refuses ${ip} (${why})`, () => assert.equal(isPublicAddress(ip), false));
  }
  for (const ip of PUBLIC) {
    test(`accepts ${ip}`, () => assert.equal(isPublicAddress(ip), true));
  }

  test("a string that is not an IP is never accepted", () => {
    for (const bad of ["", "example.com", "localhost", "1.2.3", "1.2.3.4.5", "256.1.1.1", "[::1]", "2130706433", "0x7f.1", "::g", "1::2::3", " 8.8.8.8", "8.8.8.8/32"]) {
      assert.equal(isPublicAddress(bad), false, bad);
    }
    assert.equal(isPublicAddress(undefined as unknown as string), false);
  });
});

describe("isAllowedPort", () => {
  test("only 80 and 443 (or the scheme default)", () => {
    for (const p of ["", 80, 443, "80", "443"]) assert.equal(isAllowedPort(p), true, String(p));
    for (const p of [22, 8080, 8443, "9999", 1, 65535]) assert.equal(isAllowedPort(p), false, String(p));
  });
});

// ---------- literal URL check ----------

describe("assertUrlAllowed / isUrlAllowed (no DNS)", () => {
  test("public names and literals on default ports pass", () => {
    for (const u of ["https://example.org/a", "http://example.org:80/", "https://example.org:443/", "http://8.8.8.8/", "https://[2606:4700:4700::1111]/"]) {
      assert.equal(isUrlAllowed(u), true, u);
    }
  });
  test("IP literals that are non-public are refused", () => {
    for (const u of ["http://127.0.0.1/", "http://10.1.2.3/x", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://2130706433/"]) {
      assert.equal(isUrlAllowed(u), false, u);
    }
  });
  test("other ports and non-http schemes are refused", () => {
    for (const u of ["https://example.org:8443/", "http://example.org:22/", "ftp://example.org/", "file:///etc/hosts", "not a url"]) {
      assert.equal(isUrlAllowed(u), false, u);
    }
  });
  test("the test hook lets a loopback literal and a random port through", () => {
    const hook = { allowAddress: (ip: string) => ip === "127.0.0.1", allowPort: () => true };
    assert.doesNotThrow(() => assertUrlAllowed("http://127.0.0.1:34567/", hook));
    assert.throws(() => assertUrlAllowed("http://10.0.0.1:34567/", hook), BlockedAddressError);
  });
});

// ---------- error ----------

describe("BlockedAddressError", () => {
  test("one fixed message naming only the host, whatever the reason", () => {
    const reasons: Array<() => void> = [
      () => assertUrlAllowed("http://127.0.0.1/"),
      () => assertUrlAllowed("http://169.254.169.254/latest"),
      () => assertUrlAllowed("https://example.org:8443/"),
    ];
    const messages = reasons.map((fn) => {
      try {
        fn();
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("expected a refusal");
    });
    // IP-literal hosts are not echoed (they ARE an address); the port case names the host.
    assert.equal(messages[0], "Refusing to fetch from an IP address: address not allowed");
    assert.equal(messages[0], messages[1]);
    assert.equal(messages[2], "Refusing to fetch from example.org: address not allowed");
    for (const m of messages) assert.doesNotMatch(m, /127|169|8443/);
  });

  test("is found through an axios-style cause chain", () => {
    const inner = new BlockedAddressError("example.org");
    const wrapped = Object.assign(new Error("wrapped"), { cause: inner });
    assert.equal(asBlockedAddressError(wrapped), inner);
    assert.equal(asBlockedAddressError(new Error("plain")), undefined);
  });
});

// ---------- connect-time lookup ----------

/** Run a lookup and return what its callback received. */
function runLookup(
  lookup: ReturnType<typeof createGuardedLookup>,
  host: string,
  options: object = {}
): Promise<{ err: Error | null; address?: unknown; family?: number }> {
  return new Promise((resolve) => lookup(host, options, (err, address, family) => resolve({ err, address, family })));
}

describe("createGuardedLookup", () => {
  test("answers with one address (all:false) when the answer is public", async () => {
    const lookup = createGuardedLookup({ resolver: async () => [{ address: "8.8.8.8", family: 4 }] });
    const r = await runLookup(lookup, "example.org");
    assert.equal(r.err, null);
    assert.equal(r.address, "8.8.8.8");
    assert.equal(r.family, 4);
  });

  test("answers with every address when asked for all:true", async () => {
    const lookup = createGuardedLookup({
      resolver: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    });
    const r = await runLookup(lookup, "example.org", { all: true });
    assert.deepEqual(r.address, [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  test("refuses a loopback answer", async () => {
    const lookup = createGuardedLookup({ resolver: async () => [{ address: "127.0.0.1", family: 4 }] });
    assert.ok((await runLookup(lookup, "example.org")).err instanceof BlockedAddressError);
  });

  test("refuses a mixed public + non-public answer, in both all modes", async () => {
    const lookup = createGuardedLookup({
      resolver: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });
    assert.ok((await runLookup(lookup, "example.org", { all: true })).err instanceof BlockedAddressError);
    assert.ok((await runLookup(lookup, "example.org", { all: false })).err instanceof BlockedAddressError);
  });

  test("refuses an empty answer and a junk (non-IP) answer", async () => {
    assert.ok((await runLookup(createGuardedLookup({ resolver: async () => [] }), "example.org")).err instanceof BlockedAddressError);
    const junk = createGuardedLookup({ resolver: async () => [{ address: "not-an-ip", family: 4 }] });
    assert.ok((await runLookup(junk, "example.org")).err instanceof BlockedAddressError);
  });

  test("passes a resolver failure through (not a refusal)", async () => {
    const lookup = createGuardedLookup({
      resolver: async () => {
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      },
    });
    const r = await runLookup(lookup, "example.org");
    assert.equal((r.err as NodeJS.ErrnoException).code, "ENOTFOUND");
    assert.equal(r.err instanceof BlockedAddressError, false);
  });

  test("checks the answer of EVERY call: public first, loopback second -> second refused", async () => {
    let calls = 0;
    const lookup = createGuardedLookup({
      resolver: async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
    });
    assert.equal((await runLookup(lookup, "example.org")).err, null);
    assert.ok((await runLookup(lookup, "example.org")).err instanceof BlockedAddressError);
  });

  test("the hook can allow one loopback address, still refusing others", async () => {
    const lookup = createGuardedLookup({
      resolver: async (h) => [{ address: h === "stub.test" ? "127.0.0.1" : "10.0.0.1", family: 4 }],
      allowAddress: (ip) => ip === "127.0.0.1",
    });
    assert.equal((await runLookup(lookup, "stub.test")).err, null);
    assert.ok((await runLookup(lookup, "other.test")).err instanceof BlockedAddressError);
  });
});

// ---------- the module reads no environment ----------

describe("address-guard source", () => {
  test("never reads process.env (the test hook is an argument only)", () => {
    const src = readFileSync(path.join(__dirname, "../../../../src/scrapers/shared/fetch/address-guard.ts"), "utf8");
    // Comments may mention the word; code must not index the env object.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /process\.env/);
    assert.doesNotMatch(code, /functions\.config|getFirestore|firebase-admin/);
  });
});
