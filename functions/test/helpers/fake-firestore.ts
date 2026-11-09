// ============================================
// Test helper — a small in-memory Firestore fake (issue #61)
// ============================================
//
// Not a test file itself (`npm test` runs test/*.test.ts only). Shared by the
// pendingVisaChanges suites so they need NO emulator and NO network.
//
// Supports only what the visa-catalog services call:
//  - doc refs: get / set (+merge) / update (dotted paths, FieldValue.delete())
//    / collection(name) for subcollections (e.g. crawlRuns);
//  - collection refs + queries: doc(id?) (auto id when omitted), add,
//    where (==, <, <=, >, >=; Timestamps compared by millis), orderBy
//    (asc/desc), limit, get;
//  - runTransaction: tx.get(ref | query), tx.set / tx.update buffered and
//    applied only when the callback resolves — a throw writes NOTHING, like a
//    real transaction.
// Every update()/set() is recorded in `writes` so tests can assert exactly
// what was (or was not) written.

import { FieldValue, Timestamp } from "firebase-admin/firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Data = Record<string, unknown>;

/** "path/to/doc" -> stored data. */
export const store = new Map<string, Data>();
/** Every committed write, in order (raw payload, sentinels intact). */
export const writes: { op: "set" | "update"; path: string; data: Data }[] = [];

/** Reset the fake between tests. */
export function resetStore(): void {
  store.clear();
  writes.length = 0;
}

let autoId = 0;

/** Deep-copy plain objects/arrays; keep class instances (Timestamp,
 *  FieldValue sentinels) by reference so their prototypes survive. */
export function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  }
  return v;
}

/** Apply a Firestore-style update with dotted field paths. */
function applyUpdate(target: Data, update: Data): Data {
  const out: Data = clone(target);
  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    let cur = out as Data;
    for (const p of parts.slice(0, -1)) {
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p] as Data;
    }
    const last = parts[parts.length - 1];
    // FieldValue.delete() sentinel → remove the key, like Firestore.
    if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete cur[last];
    else cur[last] = clone(value);
  }
  return out;
}

/** Raw writes (no transaction). */
function doSet(path: string, data: Data, merge?: boolean): void {
  writes.push({ op: "set", path, data: { ...data } });
  store.set(path, applyUpdate(merge ? store.get(path) ?? {} : {}, data));
}
function doUpdate(path: string, data: Data): void {
  const cur = store.get(path);
  if (!cur) throw new Error(`NOT_FOUND ${path}`);
  writes.push({ op: "update", path, data: { ...data } });
  store.set(path, applyUpdate(cur, data));
}

/** A doc snapshot shaped like Firestore's. */
function snapshot(path: string, ref: any) {
  const d = store.get(path);
  return { id: ref.id, exists: d !== undefined, ref, data: () => (d ? clone(d) : undefined) };
}

/** A doc ref backed by `store`. */
export function fakeDoc(path: string): any {
  const ref = {
    id: path.split("/").pop()!,
    path,
    async get() {
      return snapshot(path, ref);
    },
    async set(data: Data, opts?: { merge?: boolean }) {
      doSet(path, data, opts?.merge);
    },
    async update(data: Data) {
      doUpdate(path, data);
    },
    collection: (name: string) => fakeCollection(`${path}/${name}`),
  };
  return ref;
}

/** Comparable form of a stored value (Timestamps by millis). */
function cmpValue(v: unknown): unknown {
  return v instanceof Timestamp ? v.toMillis() : v;
}

type Filter = [string, string, unknown];

/** A collection ref / query backed by `store` (direct children only). */
export function fakeCollection(
  path: string,
  filters: Filter[] = [],
  order?: { field: string; dir: "asc" | "desc" },
  max?: number
): any {
  const col = {
    path,
    doc: (id?: string) => fakeDoc(`${path}/${id ?? `auto${++autoId}`}`),
    async add(data: Data) {
      const ref = col.doc();
      doSet(ref.path, data);
      return ref;
    },
    where(field: string, op: string, value: unknown) {
      return fakeCollection(path, [...filters, [field, op, value]], order, max);
    },
    orderBy(field: string, dir: "asc" | "desc" = "asc") {
      return fakeCollection(path, filters, { field, dir }, max);
    },
    limit(n: number) {
      return fakeCollection(path, filters, order, n);
    },
    async get() {
      let entries = [...store.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
        .filter(([, d]) =>
          filters.every(([f, op, v]) => {
            const a = cmpValue(d[f]) as any;
            const b = cmpValue(v) as any;
            if (op === "==") return a === b;
            if (a === undefined) return false;
            if (op === "<") return a < b;
            if (op === "<=") return a <= b;
            if (op === ">") return a > b;
            if (op === ">=") return a >= b;
            throw new Error(`fake: unsupported op ${op}`);
          })
        );
      if (order) {
        const sign = order.dir === "desc" ? -1 : 1;
        entries = entries.sort(([, a], [, b]) => {
          const x = cmpValue(a[order.field]) as any;
          const y = cmpValue(b[order.field]) as any;
          return x === y ? 0 : x < y ? -sign : sign;
        });
      }
      if (max !== undefined) entries = entries.slice(0, max);
      const docs = entries.map(([p]) => snapshot(p, fakeDoc(p)));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
  return col;
}

/** Number of transactions run (and how many committed). */
export const txStats = { runs: 0, commits: 0 };

/**
 * In-memory runTransaction: reads go straight to the store, writes are
 * buffered and applied only after `fn` resolves (a throw discards them).
 */
export async function fakeRunTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  txStats.runs++;
  const pending: (() => void)[] = [];
  const tx = {
    get: (refOrQuery: any) => refOrQuery.get(),
    set(ref: any, data: Data, opts?: { merge?: boolean }) {
      pending.push(() => doSet(ref.path, data, opts?.merge));
      return tx;
    },
    update(ref: any, data: Data) {
      pending.push(() => doUpdate(ref.path, data));
      return tx;
    },
  };
  const result = await fn(tx);
  for (const w of pending) w();
  txStats.commits++;
  return result;
}

/**
 * Swap the real Firestore refs in utils/firebase for fakes, and the changes
 * service's transaction runner for the in-memory one. Call in `before()`.
 */
export async function installFakes(): Promise<void> {
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.appConfig = fakeCollection("appConfig");
  firebase.collections.visaSources = fakeCollection("visaSources");
  firebase.collections.countries = fakeCollection("countries");
  firebase.collections.pendingVisaChanges = fakeCollection("pendingVisaChanges");
  firebase.subcollections.visaTypes = (cc: string) => fakeCollection(`countries/${cc}/visaTypes`);
  const changes: any = await import("../../src/services/visa-catalog-changes.service");
  changes.visaChangeService.runTransaction = fakeRunTransaction;
}
