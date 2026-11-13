// ============================================
// Test helper — admin custom claims derived from the fake users store (#135)
// ============================================
//
// Not a test file itself. Admin notification recipients are chosen by admin
// CUSTOM CLAIM (claimsService.listAdminUids / isAdmin), not by the
// `users/{uid}.admin` document field. Suites that seed "admin users" as
// documents in the in-memory Firestore fake call this once so Firebase Auth
// is faked to match: an account holds the admin claim exactly when its
// seeded `users/{uid}` document says `admin: true`. No network, no emulator.

import { store } from "./fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Custom claims the fake Auth reports for `uid`, read from the fake store. */
function claimsFor(uid: string): { admin: boolean } {
  return { admin: store.get(`users/${uid}`)?.admin === true };
}

/** Replace auth.getUser / auth.listUsers with fakes backed by the store. */
export async function installAdminClaimsFromUserDocs(): Promise<void> {
  const firebase: any = await import("../../src/utils/firebase");
  firebase.auth.getUser = async (uid: string) => ({ uid, customClaims: claimsFor(uid) });
  firebase.auth.listUsers = async () => ({
    users: [...store.keys()]
      // Top-level users documents only ("users/<uid>").
      .filter((path) => /^users\/[^/]+$/.test(path))
      .map((path) => {
        const uid = path.slice("users/".length);
        return { uid, customClaims: claimsFor(uid) };
      }),
    pageToken: undefined,
  });
}
