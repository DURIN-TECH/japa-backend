import axios, { type AxiosInstance, type CreateAxiosDefaults } from "axios";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { isIP } from "node:net";

// ============================================
// ADDRESS GUARD (issue #159)
// ============================================
//
// Every outbound request a scraper makes goes to an address that comes from
// stored, admin-editable or scraped data. This module makes sure such a
// request can never reach a private, loopback, link-local, metadata or
// otherwise non-public address. It is the single source of truth for BOTH:
//
//  - write time: `parseFeedUrl` (news-source-config.validate.ts) judges IP
//    literals with `isPublicAddress` and ports with `isAllowedPort`;
//  - fetch time: `createGuardedHttpClient` builds an axios client whose DNS
//    lookup is checked AT CONNECT TIME, so a DNS answer (or a rebinding
//    answer on the second query) is judged on the very address the socket
//    then connects to. There is no "resolve, check, resolve again" gap.
//
// Three things are NOT covered by a custom DNS `lookup`, and are handled
// separately here:
//  1. A host that is already an IP literal never reaches `lookup`, so the
//     first request and every redirect hop get a literal check
//     (`assertUrlAllowed`, from a request interceptor and `beforeRedirect`).
//  2. Node may call `lookup` with `all: true` (happy eyeballs): EVERY returned
//     address is checked, and the lookup is refused if any one is non-public.
//  3. An environment proxy would connect to the proxy, not the target, so
//     guarded clients set `proxy: false`.
//
// Test hook: loopback stub servers need a way in. It is an OPTIONAL ARGUMENT of
// the factory (`AddressGuardOptions`) and nothing else: this module never reads
// `process.env`, config, Firestore or request data. Production code constructs
// every client without it.

// ---------- Errors ----------

/**
 * Thrown whenever the guard refuses a request, for ANY reason (loopback,
 * private, metadata, wrong port, unresolvable-as-public). The message is fixed
 * and names only the requested host: it never contains a resolved address, and
 * it does not reveal which rule fired or whether anything is listening there.
 */
export class BlockedAddressError extends Error {
  readonly code = "BLOCKED_ADDRESS";

  constructor(readonly host: string) {
    super(blockedMessage(host));
    this.name = "BlockedAddressError";
  }
}

/** The one refusal message. A literal IP host is not echoed back (it IS an address). */
function blockedMessage(host: string): string {
  const bare = stripBrackets(host);
  const shown = isIP(bare) !== 0 ? "an IP address" : bare.slice(0, 255);
  return `Refusing to fetch from ${shown}: address not allowed`;
}

/** True for a BlockedAddressError, however many wrappers (axios, follow-redirects) sit around it. */
export function isBlockedAddressError(err: unknown): boolean {
  return asBlockedAddressError(err) !== undefined;
}

/** Find a BlockedAddressError in `err` or its `cause` chain (axios wraps socket errors). */
export function asBlockedAddressError(err: unknown): BlockedAddressError | undefined {
  let cur: unknown = err;
  // Bounded walk: a cause chain is short, a cycle must not hang us.
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof BlockedAddressError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// ---------- Address classifier (pure) ----------

/** Dotted IPv4 -> unsigned 32-bit integer (caller has checked isIP === 4). */
function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** [network address, prefix length] pairs of IPv4 space that is NOT global unicast. */
const REFUSED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network (includes 0.0.0.0)
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. the cloud metadata address
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. limited broadcast
];

/** True when `ip` (dotted IPv4) lies in none of the refused ranges. */
function isPublicIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return !REFUSED_IPV4.some(([net, bits]) => {
    // A /N mask keeps the top N bits; `>>> 0` keeps the result unsigned.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (ipv4ToInt(net) & mask) >>> 0;
  });
}

/**
 * Expand an IPv6 literal into its 8 16-bit groups, or undefined when it cannot
 * be read. A trailing dotted IPv4 (`::ffff:1.2.3.4`) becomes two groups. Any
 * zone id (`%eth0`) makes the address unreadable here: a scoped address is
 * never a public one.
 */
function expandIPv6(ip: string): number[] | undefined {
  if (ip.includes("%")) return undefined;
  let text = ip;
  // Fold a trailing dotted-quad into two hex groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return undefined;
    const n = ipv4ToInt(dotted[2]);
    text = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return undefined; // "::" must stand for at least one group
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * IPv6: only global unicast `2000::/3` can be public, minus the special-use
 * blocks inside it. Everything else (unspecified, loopback, IPv4-mapped and
 * IPv4-compatible in any spelling, NAT64, unique-local, link-local, site-local,
 * multicast) falls outside `2000::/3` and is refused WITHOUT unwrapping any
 * embedded IPv4 address, so no spelling of an embedded address can slip through.
 */
function isPublicIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  // Outside 2000::/3 (top three bits 001): not global unicast.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // 2001::/23 IETF assignments (Teredo 2001::/32, ...)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // 2001:db8::/32 documentation
  if (g[0] === 0x2002) return false; // 2002::/16 6to4
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

/**
 * True only for a globally routable unicast IP address literal (no brackets).
 * Anything that is not an IP literal returns false, so a bad lookup result can
 * never be allowed.
 */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const kind = isIP(ip);
  if (kind === 4) return isPublicIPv4(ip);
  if (kind === 6) return isPublicIPv6(ip);
  return false;
}

/** Only the standard web ports are fetched: 80 and 443 (explicit or the scheme's default). */
export function isAllowedPort(port: number | string): boolean {
  return port === "" || Number(port) === 80 || Number(port) === 443;
}

/** `[::1]` -> `::1`; other strings unchanged. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// ---------- Test hook ----------

/**
 * OPTIONAL, TEST-ONLY arguments of the guarded-client factory. Production code
 * never passes them, and nothing here is read from the environment or config.
 */
export interface AddressGuardOptions {
  /**
   * Return true to let an otherwise non-public address through (e.g. 127.0.0.1
   * for a stub). `host` is the name being resolved, or the literal host of the
   * URL being checked, so a test can allow one stub host and not another.
   */
  allowAddress?: (ip: string, host: string) => boolean;
  /** Return true to let an otherwise disallowed port through (a stub listens on a random port). */
  allowPort?: (port: number) => boolean;
  /** Replace DNS resolution (default: the system resolver). Always returns every address. */
  resolver?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

/** True when the guard lets `ip` through: public, or let in by the test hook. */
function addressAllowed(ip: string, opts: AddressGuardOptions, host: string): boolean {
  return isPublicAddress(ip) || opts.allowAddress?.(ip, host) === true;
}

/** Port check with the test hook. */
function portAllowed(port: string | number, opts: AddressGuardOptions): boolean {
  return isAllowedPort(port) || opts.allowPort?.(Number(port)) === true;
}

// ---------- Literal (no DNS) URL check ----------

/**
 * Check what can be judged without DNS: the scheme, the port, and the address
 * when the host is an IP literal. Names are NOT resolved here (the connect-time
 * lookup does that). Throws BlockedAddressError; returns void when fine.
 */
export function assertUrlAllowed(target: string | URL, opts: AddressGuardOptions = {}): void {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    throw new BlockedAddressError("(invalid URL)");
  }
  const host = url.hostname;
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedAddressError(host);
  if (!portAllowed(url.port, opts)) throw new BlockedAddressError(host);
  const bare = stripBrackets(host);
  if (isIP(bare) !== 0 && !addressAllowed(bare, opts, bare)) throw new BlockedAddressError(host);
}

/** Non-throwing form of assertUrlAllowed, for "skip this link" decisions. */
export function isUrlAllowed(target: string | URL, opts: AddressGuardOptions = {}): boolean {
  try {
    assertUrlAllowed(target, opts);
    return true;
  } catch {
    return false;
  }
}

// ---------- Connect-time DNS lookup ----------

/** Shape of the callback Node passes to a `lookup` function (both forms). */
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/** Default resolver: the system resolver, every address. */
function systemResolver(hostname: string, family?: number): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, family: family === 4 || family === 6 ? family : 0 }, (err, addrs) =>
      err ? reject(err) : resolve(addrs)
    );
  });
}

/**
 * Build the `lookup` function handed to the http/https agents. It resolves the
 * name, refuses when ANY address is non-public, and otherwise answers in the
 * form Node asked for (one address, or all of them when `all: true`). The
 * socket then connects to exactly the addresses that were checked.
 */
export function createGuardedLookup(opts: AddressGuardOptions = {}) {
  return (hostname: string, options: dns.LookupOptions | number | undefined, callback: LookupCallback): void => {
    const o: dns.LookupOptions = typeof options === "object" && options !== null ? options : { family: options as number | undefined };
    const resolve = opts.resolver ? opts.resolver(hostname) : systemResolver(hostname, o.family as number | undefined);
    resolve.then(
      (addrs) => {
        // An empty answer, or one bad address among good ones, is refused.
        if (addrs.length === 0 || !addrs.every((a) => addressAllowed(a.address, opts, hostname))) {
          callback(new BlockedAddressError(hostname));
          return;
        }
        if (o.all) callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, addrs[0].address, addrs[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err)
    );
  };
}

// ---------- Guarded axios client ----------

/**
 * Build an axios client that refuses non-public targets. `config` is the
 * client's own settings (timeout, headers, redirects, size cap...), passed
 * through untouched; this adds only the guard:
 *  - custom `lookup` on both agents (connect-time DNS check);
 *  - `proxy: false` (an env proxy would bypass the lookup);
 *  - a request interceptor (first request) and `beforeRedirect` (every hop)
 *    that check the scheme, port and any IP-literal host;
 *  - a response-error interceptor that surfaces the BlockedAddressError itself
 *    rather than axios's wrapper around it.
 */
export function createGuardedHttpClient(config: CreateAxiosDefaults = {}, opts: AddressGuardOptions = {}): AxiosInstance {
  // Node's agents type `lookup` as net.LookupFunction; ours is the same
  // contract with a looser callback type (the error form passes no address).
  const lookup = createGuardedLookup(opts) as unknown as net.LookupFunction;
  const client = axios.create({
    ...config,
    proxy: false,
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
    // Runs before follow-redirects re-requests; throwing aborts the hop with
    // no request sent to the new target.
    beforeRedirect: (options) => {
      const host = String(options.hostname ?? options.host ?? "");
      const proto = String(options.protocol ?? "https:");
      const port = options.port === undefined || options.port === null ? "" : String(options.port);
      assertUrlAllowed(`${proto}//${host.includes(":") ? `[${stripBrackets(host)}]` : host}${port ? `:${port}` : ""}/`, opts);
    },
  });
  // First request: literal host / port check before anything is sent.
  client.interceptors.request.use((cfg) => {
    assertUrlAllowed(new URL(cfg.url ?? "", cfg.baseURL), opts);
    return cfg;
  });
  // Unwrap: a refusal raised in lookup or beforeRedirect arrives wrapped.
  client.interceptors.response.use(undefined, (err) => {
    throw asBlockedAddressError(err) ?? err;
  });
  return client;
}
