// ============================================
// Emulator tests — storage.rules: what a client SDK can reach directly (#141)
// ============================================
//
// Run with `npm run test:emulator`. The Storage emulator loads the repo's real
// storage.rules (../firebase.emulator-test.json); these tests go through the
// client Storage SDK as different signed-in users (via
// @firebase/rules-unit-testing), so every read and write is decided by that
// file. Objects are put in place with the Admin SDK, which bypasses rules,
// exactly as the backend (or a signed upload URL) writes them.
//
// What is pinned:
//  1. Every prefix the backend uploads into or owns (documents/,
//     verification/, compliance/, agency-logos/, guidance-snapshots/) is
//     closed to client SDKs for everyone: the object's own user, another
//     user, a token with the admin claim, and a signed-out visitor. Those
//     files are only reachable through the API's signed URLs.
//  2. The older client-SDK prefixes whose read rule used to be "any signed-in
//     user" (applications/*/documents, consultations/*/recordings,
//     messages/*) can no longer be read by another signed-in user.
//  3. The rules that are meant to allow something still do: a user's own
//     profile photo (public read, owner write) and their own temp folder.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { getBytes, ref, uploadBytes } from "firebase/storage";

import { anonymousStorage, clearBucket, clientStorage, isStorageDenied, putObject, storageRulesEnv } from "./storage-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** uids used as rule subjects (no Auth account needed for rules tests). */
const ALICE = "rules-alice";
const BOB = "rules-bob";
const ADMIN = "rules-admin";

/** A small PNG-typed payload for uploads. */
const BYTES = new Uint8Array([1, 2, 3, 4]);

/** Read the object at `path` with the given client storage handle. */
const read = (storage: any, path: string) => getBytes(ref(storage, path));

/** Upload to `path` with the given client storage handle. */
const write = (storage: any, path: string, contentType = "image/png") =>
  uploadBytes(ref(storage, path), BYTES, { contentType });

let alice: any;
let bob: any;
let admin: any;
let anon: any;

before(async () => {
  await storageRulesEnv();
  await clearBucket();
  alice = await clientStorage(ALICE);
  bob = await clientStorage(BOB);
  admin = await clientStorage(ADMIN, { admin: true, role: "admin" });
  anon = await anonymousStorage();
});

after(async () => {
  await (await storageRulesEnv()).cleanup();
});

describe("backend-owned prefixes are closed to every client SDK", () => {
  /** One object per backend-owned prefix; the ones with a uid belong to ALICE. */
  const objects = [
    `documents/${ALICE}/app-1/0f8fad5b-d9cb-469f-a165-70867728950e_passport.pdf`,
    `verification/${ALICE}/0f8fad5b-d9cb-469f-a165-70867728950e_licence.pdf`,
    "compliance/agency-1/idDocument/0f8fad5b-d9cb-469f-a165-70867728950e_id.pdf",
    "agency-logos/agency-1/0f8fad5b-d9cb-469f-a165-70867728950e_logo.png",
    "guidance-snapshots/source-1/abc123.json",
  ];

  before(async () => {
    for (const path of objects) await putObject(path);
  });

  for (const path of objects) {
    test(`${path.split("/")[0]}/: no client can read or write`, async () => {
      const observed: Record<string, boolean> = {};
      for (const [name, storage] of [
        ["ownerRead", alice],
        ["otherUserRead", bob],
        ["adminClaimRead", admin],
        ["signedOutRead", anon],
      ] as const) {
        observed[name] = await isStorageDenied(read(storage, path));
      }
      // Writing next to it (a new object in the same folder) is refused too.
      const sibling = path.replace(/[^/]+$/, "client-written.png");
      observed.ownerWrite = await isStorageDenied(write(alice, sibling));
      observed.otherUserWrite = await isStorageDenied(write(bob, sibling));
      observed.adminClaimWrite = await isStorageDenied(write(admin, sibling));

      assert.deepEqual(observed, {
        ownerRead: true,
        otherUserRead: true,
        adminClaimRead: true,
        signedOutRead: true,
        ownerWrite: true,
        otherUserWrite: true,
        adminClaimWrite: true,
      });
    });
  }
});

describe("older client-SDK prefixes: being signed in is not enough to read", () => {
  const objects = [
    "applications/app-1/documents/passport.pdf",
    "consultations/consult-1/recordings/call.mp4",
    "messages/conversation-1/attachment.pdf",
  ];

  before(async () => {
    for (const path of objects) await putObject(path);
  });

  for (const path of objects) {
    test(`${path}: another signed-in user and a visitor cannot read; an admin can`, async () => {
      assert.deepEqual(
        {
          signedInUserDenied: await isStorageDenied(read(bob, path)),
          signedOutDenied: await isStorageDenied(read(anon, path)),
          adminDenied: await isStorageDenied(read(admin, path)),
        },
        { signedInUserDenied: true, signedOutDenied: true, adminDenied: false }
      );
    });
  }
});

describe("rules that are meant to allow access still do", () => {
  test("profile photo: owner can upload an image, anyone can view it, nobody else can replace it", async () => {
    const path = `users/${ALICE}/profile/avatar.png`;
    assert.equal(await isStorageDenied(write(alice, path)), false, "owner upload");
    assert.equal(await isStorageDenied(read(bob, path)), false, "another user can view");
    assert.equal(await isStorageDenied(read(anon, path)), false, "public can view");
    assert.equal(await isStorageDenied(write(bob, path)), true, "another user cannot overwrite");
    assert.equal(await isStorageDenied(write(alice, `users/${ALICE}/profile/doc.pdf`, "application/pdf")), true, "images only");
  });

  test("temp folder: its owner can write; nobody else can read or write it", async () => {
    const path = `temp/${ALICE}/scratch.bin`;
    assert.equal(await isStorageDenied(write(alice, path, "application/octet-stream")), false);
    // The owner's own READ is not asserted: the existing rule combines read
    // with a size check on the uploaded resource, which does not exist on a
    // read, so it has always denied reads. Unused by the apps and unchanged
    // by #141 (it errs on the closed side); noted for a follow-up.
    assert.equal(await isStorageDenied(read(bob, path)), true);
    assert.equal(await isStorageDenied(write(bob, path, "application/octet-stream")), true);
  });
});
