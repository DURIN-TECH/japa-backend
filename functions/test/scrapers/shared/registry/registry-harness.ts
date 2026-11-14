// ============================================
// Test harness for the source registry API (issue #215)
// ============================================
//
// Not a test file. Wires the in-memory Firestore fake, fake Auth tokens for
// every role, a scripted FETCHER (no network: the preview service's fetcher
// is replaced, and the fake applies the host policy exactly as the real fetch
// service does) and an HTTP server over the REAL routers.

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { ROLES } from "@durin-tech/authz";
import { installFakes, fakeRunTransaction } from "../../../helpers/fake-firestore";
import { BlockedAddressError } from "../../../../src/scrapers/shared/fetch/address-guard";
import { HostNotAllowedError, type FetchedPage } from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Decoded ID tokens by bearer token: one per role. */
export const TOKENS: Record<string, any> = {
  "t-admin": { uid: "admin-uid", role: ROLES.ADMIN },
  "t-client": { uid: "client-uid", role: ROLES.CLIENT },
  "t-agent": { uid: "agent-uid", role: ROLES.AGENT, agencyId: "agency-1" },
  "t-owner": { uid: "owner-uid", role: ROLES.OWNER, agencyId: "agency-1" },
};
export const NON_ADMIN_TOKENS = ["t-client", "t-agent", "t-owner"];

/** What the scripted fetcher serves for one address. */
export interface FakePage {
  finalUrl?: string;
  text?: string;
  lang?: string | null;
  title?: string | null;
  pdf?: boolean;
  status?: number;
}
/** A page, or an error to throw. */
export type FakeResponse = FakePage | Error;

/** The scripted fetcher: addresses served, calls made. */
export const fetcher = {
  pages: new Map<string, FakeResponse>(),
  calls: [] as Array<{ url: string; allowedHost: boolean }>,
  async fetchAndClean(url: string, options?: { allowedHost?: (host: string) => boolean }): Promise<FetchedPage> {
    fetcher.calls.push({ url, allowedHost: Boolean(options?.allowedHost) });
    const r = fetcher.pages.get(url);
    if (!r) throw new Error(`Fetch failed for ${url} (HTTP 404)`);
    if (r instanceof Error) throw r;
    const finalUrl = r.finalUrl ?? url;
    // The real service applies the policy to the requested host and the final host.
    if (options?.allowedHost) {
      const req = new URL(url).hostname;
      if (!options.allowedHost(req)) throw new HostNotAllowedError(req, "request");
      const fin = new URL(finalUrl).hostname;
      if (!options.allowedHost(fin)) throw new HostNotAllowedError(fin, "redirect");
    }
    const cleanText = r.text ?? "Official guidance text. ".repeat(20);
    return {
      url,
      finalUrl,
      httpStatus: r.status ?? 200,
      cleanText,
      contentHash: "h".repeat(64),
      fetchedAt: 0,
      ...(r.pdf ? { pdf: { cleanText, pages: [cleanText], pageOffsets: [0] } as any } : { htmlLang: r.lang ?? null, title: r.title ?? null }),
    };
  },
};

/** A server over the real routers + its base URL. */
export interface Wired {
  baseUrl: string;
  close(): Promise<void>;
}

/** Install fakes and stubs once (call in `before`). Returns the running server. */
export async function wireRegistry(): Promise<Wired> {
  await installFakes();
  const firebase: any = await import("../../../../src/utils/firebase");
  firebase.auth.verifyIdToken = async (token: string) => {
    const d = TOKENS[token];
    if (!d) throw new Error("invalid token");
    return d;
  };
  const { entitlementService }: any = await import("../../../../src/services/entitlement.service");
  entitlementService.getEntitlements = async () => null;
  const { claimsService }: any = await import("../../../../src/services/claims.service");
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  // Services: in-memory transactions, injected fetcher.
  const preview: any = (await import("../../../../src/scrapers/shared/registry/source-preview.service")).sourcePreviewService;
  preview.fetcher = fetcher;
  for (const [mod, name] of [
    ["official-domains.service", "officialDomainsService"],
    ["route-registration.service", "routeRegistrationService"],
    ["guidance-source-edit.service", "guidanceSourceEditService"],
    ["registry-rate-limit", "registryRateLimiter"],
  ] as const) {
    const svc: any = (await import(`../../../../src/scrapers/shared/registry/${mod}`))[name];
    svc.runTransaction = fakeRunTransaction;
  }

  const { adminOfficialDomainRoutes, adminRouteSourceRoutes } = await import("../../../../src/scrapers/shared/registry/registry.routes");
  const { adminGuidanceSourceRoutes } = await import("../../../../src/scrapers/guidance/guidance-source.routes");
  const app = express();
  app.use(express.json());
  app.use("/admin/official-domains", adminOfficialDomainRoutes);
  app.use("/admin/route-sources", adminRouteSourceRoutes);
  app.use("/admin/guidance-sources", adminGuidanceSourceRoutes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => (server as http.Server).close(() => resolve())),
  };
}

/** Run `fn` with the console muted (the controllers log refusals). */
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** One HTTP call to the API. `token` null sends no Authorization header. */
export async function call(baseUrl: string, method: string, path: string, token: string | null, payload?: unknown): Promise<{ status: number; body: any }> {
  return quiet(async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
}

export { BlockedAddressError };
