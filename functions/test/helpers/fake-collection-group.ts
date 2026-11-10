// ============================================
// Test helper — in-memory collection-group query (issue #100)
// ============================================
//
// Not a test file. Extends the in-memory Firestore fake
// (./fake-firestore.ts, same `store`) with `db.collectionGroup(id)`: every
// doc whose PARENT collection id is `id`, at any depth (e.g. all
// `countries/*/visaTypes/*`). Supports what the agency visa service calls:
// where(==), orderBy(asc|desc), limit, get. Returned doc snapshots carry real
// fake refs (fakeDoc), so tx.get(ref) / tx.update(ref) on them work.
// Kept in its own file so it does not touch the shared fake.

import { Timestamp } from "firebase-admin/firestore";
import { clone, fakeDoc, store } from "./fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Comparable form of a stored value (Timestamps by millis). */
const cmp = (v: unknown): unknown => (v instanceof Timestamp ? v.toMillis() : v);

/**
 * A fake collection-group query over `store`.
 *
 * @param collectionId the subcollection id to match (e.g. "visaTypes")
 */
export function fakeCollectionGroup(
  collectionId: string,
  filters: [string, unknown][] = [],
  order?: { field: string; dir: "asc" | "desc" },
  max?: number
): any {
  return {
    where(field: string, op: string, value: unknown) {
      if (op !== "==") throw new Error(`fake collectionGroup: unsupported op ${op}`);
      return fakeCollectionGroup(collectionId, [...filters, [field, value]], order, max);
    },
    orderBy(field: string, dir: "asc" | "desc" = "asc") {
      return fakeCollectionGroup(collectionId, filters, { field, dir }, max);
    },
    limit(n: number) {
      return fakeCollectionGroup(collectionId, filters, order, n);
    },
    async get() {
      let entries = [...store.entries()].filter(([path, data]) => {
        const parts = path.split("/");
        // A doc path has an even number of segments; its parent collection
        // id is the second to last one.
        if (parts.length % 2 !== 0 || parts[parts.length - 2] !== collectionId) return false;
        return filters.every(([f, v]) => cmp(data[f]) === cmp(v));
      });
      if (order) {
        const sign = order.dir === "desc" ? -1 : 1;
        entries = entries.sort(([, a], [, b]) => {
          const x = cmp(a[order.field]) as any;
          const y = cmp(b[order.field]) as any;
          return x === y ? 0 : x < y ? -sign : sign;
        });
      }
      if (max !== undefined) entries = entries.slice(0, max);
      const docs = entries.map(([path, data]) => {
        const ref = fakeDoc(path);
        return { id: ref.id, exists: true, ref, data: () => clone(data) };
      });
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
}
