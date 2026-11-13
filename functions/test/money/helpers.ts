// ============================================
// Test helpers for the money module (issue #178). Not a test file.
// ============================================
//
// In-memory stores and fake providers so the rate service is tested with no
// Firestore, no network and a fixed clock.

import type { ConfigStore } from "../../src/money/config";
import type { RateAuditEntry, RateStore, StoredRate } from "../../src/money/rate.types";
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
    async saveProvider(c, provider) {
      docs.set(c, { ...(docs.get(c) ?? blank(c)), provider, lastError: null });
    },
    async saveError(c, error) {
      docs.set(c, { ...(docs.get(c) ?? blank(c)), lastError: error });
    },
    async saveOverride(c, override, entry) {
      docs.set(c, { ...(docs.get(c) ?? blank(c)), override });
      audit.push(entry);
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
  cbn?: RateProvider;
  oanda?: RateProvider;
  clock?: { now: () => Date };
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
