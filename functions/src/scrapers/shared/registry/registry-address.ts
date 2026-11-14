import { isIP } from "node:net";

// ============================================
// SOURCE REGISTRY — ADDRESS AND COUNTRY-CODE VALIDATION (issue #215, pure)
// ============================================
//
// Every address an admin types into the registry API goes through this module
// BEFORE anything is stored and before anything is fetched. It is the first of
// two layers:
//
//   1. (here) the SHAPE of the address: https only, no credentials, no port,
//      no fragment, no IP literal, a real multi-label host. Judged on the text
//      alone, so a refusal means no request of any kind was made.
//   2. (fetch time) the guarded fetch service (address-guard.ts): DNS answers
//      are checked at connect time, so a NAME that resolves to a private or
//      metadata address is refused when the socket would open.
//
// Why shape rules the address guard does not already have: the guard allows
// plain http and ports 80/443 because older seeds need them. A registry entry
// decides which pages a rulebook can be read from, and rulebooks publish
// without a person reading them, so the registry is stricter than the guard.
//
// No Firebase imports: unit tests import this without Admin init. No country,
// publisher or government name appears here, on purpose.

/** A refusal with a stable machine code and a message an admin can read. */
export interface AddressProblem {
  code:
    | "INVALID_URL"
    | "NOT_HTTPS"
    | "HAS_CREDENTIALS"
    | "HAS_PORT"
    | "HAS_FRAGMENT"
    | "IP_LITERAL"
    | "INVALID_HOST"
    | "WILDCARD_NOT_ALLOWED"
    | "URL_TOO_LONG";
  message: string;
}

/** Longest address accepted, in characters. */
export const MAX_ADDRESS_CHARS = 2048;

/** One DNS label: letters, digits and inner hyphens (punycode `xn--` fits). */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A successfully parsed registry address. */
export interface ParsedRegistryUrl {
  ok: true;
  url: URL;
  /** Lowercased host exactly as the allow-list stores it. */
  host: string;
}

/** Either a parsed address or the first problem found. */
export type RegistryUrlResult = ParsedRegistryUrl | ({ ok: false } & AddressProblem);

const refuse = (code: AddressProblem["code"], message: string): { ok: false } & AddressProblem => ({ ok: false, code, message });

/**
 * Judge a bare HOST (no scheme, path or port) the way the allow-list stores
 * it: lowercase, at least two labels, valid characters, not an IP literal, no
 * wildcard, no trailing dot. Returns the normalised host or the problem.
 * Exact hosts only: the allow-list has no subdomain patterns in this version.
 */
export function parseRegistryHost(raw: unknown): { ok: true; host: string } | ({ ok: false } & AddressProblem) {
  if (typeof raw !== "string") return refuse("INVALID_HOST", "The website name must be text, for example www.example.org");
  const host = raw.trim().toLowerCase();
  if (!host) return refuse("INVALID_HOST", "Give the website name, for example www.example.org");
  if (host.includes("*")) {
    return refuse("WILDCARD_NOT_ALLOWED", "Wildcards are not allowed: confirm one exact website name at a time");
  }
  // Anything that is not a plain name: scheme, path, query, port, credentials, spaces, brackets.
  if (/[\s/\\?#@:[\]]/.test(host)) {
    return refuse("INVALID_HOST", "Give only the website name, without https://, a path, a port or a user name");
  }
  if (isIP(host) !== 0) return refuse("IP_LITERAL", "A numeric IP address cannot be an official website: use its name");
  // A pure-number or dotted-number name is an IP in disguise (the URL parser reads some of them as IPs).
  if (/^[0-9.x]+$/.test(host)) return refuse("IP_LITERAL", "A numeric address cannot be an official website: use its name");
  if (host.endsWith(".")) return refuse("INVALID_HOST", "Remove the dot at the end of the website name");
  if (host.length > 253) return refuse("INVALID_HOST", "That website name is too long");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) {
    return refuse("INVALID_HOST", "That is not a valid website name (letters, digits and hyphens, with at least one dot)");
  }
  return { ok: true, host };
}

/**
 * Judge a full address. Order of checks is the order an admin would fix them.
 * Nothing here makes a request.
 */
export function parseRegistryUrl(raw: unknown): RegistryUrlResult {
  if (typeof raw !== "string") return refuse("INVALID_URL", "The address must be text, for example https://www.example.org/page");
  const text = raw.trim();
  if (!text) return refuse("INVALID_URL", "Give the address of the page");
  if (text.length > MAX_ADDRESS_CHARS) return refuse("URL_TOO_LONG", `The address is longer than ${MAX_ADDRESS_CHARS} characters`);
  // Judge the TEXT before the URL parser normalises it: the parser quietly
  // fixes backslashes, strips ":443", and decodes odd IP spellings, which would
  // hide the very shapes we want to refuse.
  if (!/^https:\/\//i.test(text)) {
    return refuse("NOT_HTTPS", "Only https:// addresses are accepted");
  }
  // Authority = the text between "//" and the first "/", "?" or "#".
  const authority = text.slice("https://".length).split(/[/?#\\]/)[0];
  if (authority.includes("@")) return refuse("HAS_CREDENTIALS", "Addresses with a user name or password are not accepted");
  if (text.includes("#")) return refuse("HAS_FRAGMENT", "Remove the part after # from the address");
  // An IPv6 literal is bracketed and contains ":"; judged as a literal below.
  if (authority.startsWith("[")) return refuse("IP_LITERAL", "A numeric IP address cannot be an official website: use its name");
  if (authority.includes(":")) return refuse("HAS_PORT", "Addresses with a port number are not accepted");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse("INVALID_URL", "That does not look like a web address");
  }
  // Belt and braces: the parser's own view must agree with the text checks.
  if (url.protocol !== "https:") return refuse("NOT_HTTPS", "Only https:// addresses are accepted");
  if (url.username || url.password) return refuse("HAS_CREDENTIALS", "Addresses with a user name or password are not accepted");
  if (url.port !== "") return refuse("HAS_PORT", "Addresses with a port number are not accepted");
  if (url.hash) return refuse("HAS_FRAGMENT", "Remove the part after # from the address");
  const host = parseRegistryHost(url.hostname);
  if (!host.ok) return host;
  return { ok: true, url, host: host.host };
}

// ---------- Country code ----------

/** Two letters, any case. */
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

/**
 * English name of an ISO region code from the platform's own region names
 * (`Intl.DisplayNames`, fallback "none"), or undefined when the code is
 * malformed or unknown. There is NO list of countries in code. ICU labels its
 * "unknown region" code with a placeholder name instead of refusing it, so a
 * code whose name equals the placeholder's is refused too (the placeholder is
 * read from ICU, not written here).
 */
export function lookupRegionName(code: unknown): { code: string; name: string } | undefined {
  if (typeof code !== "string" || !COUNTRY_CODE_RE.test(code)) return undefined;
  const upper = code.toUpperCase();
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
    const name = names.of(upper);
    // The placeholder ICU gives for "no such region": the name of the reserved code ZZ.
    const placeholder = names.of("ZZ");
    if (!name || name === placeholder) return undefined;
    return { code: upper, name };
  } catch {
    return undefined;
  }
}

// ---------- Ids ----------

/** A visa id: lowercase letters, digits and hyphens, not starting or ending with a hyphen. */
export const VISA_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Longest visa id / guidance id accepted. */
export const REGISTRY_ID_MAX = 100;
