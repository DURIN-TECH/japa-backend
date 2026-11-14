// ============================================
// Test helpers for the money module (issue #178). Not a test file.
// ============================================
//
// In-memory stores and fake providers so the rate service is tested with no
// Firestore, no network and a fixed clock.

import type { ConfigStore } from "../../src/money/config";
import { sameProviderState, type RateAuditEntry, type RateStore, type StoredRate } from "../../src/money/rate.types";
import { RateService } from "../../src/money/rate.service";
import type { ProviderResult, RateProvider } from "../../src/money/providers/types";

/** A clock the test moves by hand. */
export function fakeClock(startIso = "2026-11-13T09:00:00Z") {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advanceHours: (h: number) => {
      t += h * 3_600_000;
    },
  };
}

/** In-memory RateStore. */
export function memoryRateStore(): RateStore & { docs: Map<string, StoredRate>; audit: RateAuditEntry[] } {
  const docs = new Map<string, StoredRate>();
  const audit: RateAuditEntry[] = [];
  const blank = (currency: string): StoredRate => ({ currency, provider: null, override: null, lastError: null });
  return {
    docs,
    audit,
    async get(c) {
      return docs.get(c) ?? null;
    },
    // Issue #229: same contract as the Firestore store: written only while
    // the provider part is still what the caller read (`expected`).
    async saveProvider(c, provider, expected) {
      if (!sameProviderState(docs.get(c) ?? null, expected)) return { saved: false };
      const current = docs.get(c) ?? blank(c);
      docs.set(c, { ...current, provider, lastError: null });
      return { saved: true, override: current.override, hold: current.hold ?? null };
    },
    async saveError(c, error) {
      docs.set(c, { ...(docs.get(c) ?? blank(c)), lastError: error });
    },
    // Issue #214: same contract as the Firestore store. `decide` sees the doc
    // and may throw (nothing written); otherwise change + audit land together.
    async transact(c, decide) {
      const current = docs.get(c) ?? null;
      const m = decide(current ? { ...current } : null);
      const next: StoredRate = { ...(current ?? blank(c)) };
      if (m.override !== undefined) next.override = m.override;
      if (m.hold !== undefined) next.hold = m.hold; // issue #241
      // Like Firestore: dropping the provider map also clears providerCorrupt
      // (that flag is derived from the map being present but unreadable).
      if (m.clearProvider) {
        next.provider = null;
        next.providerCorrupt = false;
      }
      docs.set(c, next);
      audit.push(m.audit);
      for (const extra of m.extraAudits ?? []) audit.push(extra); // issue #241
    },
    async appendAudit(entry) {
      audit.push(entry);
    },
    async claimManualRefresh(c, at, cooldownMs) {
      const last = docs.get(c)?.manualRefreshAt ?? null;
      const waitMs = last ? last.getTime() + cooldownMs - at.getTime() : 0;
      if (waitMs > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
      docs.set(c, { ...(docs.get(c) ?? blank(c)), manualRefreshAt: at });
      return { allowed: true };
    },
    // Issue #229: give a claimed refresh slot back while it is still ours.
    async releaseManualRefresh(c, claimedAt) {
      const doc = docs.get(c);
      if (doc?.manualRefreshAt && doc.manualRefreshAt.getTime() === claimedAt.getTime()) {
        docs.set(c, { ...doc, manualRefreshAt: null });
      }
    },
    async listAudit(c, limit) {
      return audit.filter((a) => a.currency === c).reverse().slice(0, limit);
    },
  };
}

/** A provider whose answer the test sets. */
export function fakeProvider(
  id: "cbn" | "oanda",
  opts: { configured?: boolean; supports?: string[]; result?: ProviderResult } = {}
): RateProvider & { calls: number; result: ProviderResult } {
  const p = {
    id,
    calls: 0,
    result: opts.result ?? ({ ok: false, reason: "unset" } as ProviderResult),
    isConfigured: () => opts.configured ?? true,
    supports: (c: string) => (opts.supports ?? ["NGN"]).includes(c),
    async fetchRate() {
      p.calls++;
      return p.result;
    },
  };
  return p;
}

/** A RateService over in-memory parts. `config` is the raw stored doc (null = defaults). */
export function makeService(opts: {
  config?: Record<string, unknown> | null;
  cbn?: ReturnType<typeof fakeProvider>;
  oanda?: ReturnType<typeof fakeProvider>;
  clock?: ReturnType<typeof fakeClock>;
  store?: ReturnType<typeof memoryRateStore>;
} = {}) {
  const store = opts.store ?? memoryRateStore();
  const config: ConfigStore = { read: async () => opts.config ?? null };
  const clock = opts.clock ?? fakeClock();
  const cbn = opts.cbn ?? fakeProvider("cbn", { result: { ok: true, rate: 1500, asOf: new Date("2026-11-13T00:00:00Z") } });
  const oanda = opts.oanda ?? fakeProvider("oanda", { configured: false });
  const service = new RateService({ config, rates: store, providers: { cbn, oanda }, now: clock.now });
  return { service, store, clock, cbn, oanda };
}
