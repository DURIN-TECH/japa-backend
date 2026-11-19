// ============================================
// Unit tests — the shared storage path validator (issue #141)
// ============================================
//
// Pure string logic (src/utils/storage-paths.ts has no firebase imports), so
// these run in `npm test` with no emulator. They pin:
//  - what an issued path looks like for each purpose, and that an issued path
//    always validates for the scope it was issued for;
//  - every way a path is refused: not a plain bucket-relative key, a
//    backend-only prefix, another owner's / application's / purpose's folder,
//    or not an issued object name;
//  - that an unusable scope id fails closed.
// The end-to-end behaviour of the endpoints is covered on the emulators in
// test/emulator/storage-paths.emu.ts.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assertClientReachableKey,
  BACKEND_ONLY_PREFIXES,
  buildIssuedPath,
  checkStorageKey,
  requireRequestedPath,
  requireStoredPath,
  StoragePathRejectedError,
  StorageScope,
  StoredPathInvalidError,
  validateStoragePath,
} from "../../src/utils/storage-paths";

/** A syntactically valid issued object name. */
const NAME = "0f8fad5b-d9cb-469f-a165-70867728950e_passport.pdf";

/** One scope of each purpose, for the same imaginary user / agency. */
const scopes: Record<string, StorageScope> = {
  document: { purpose: "application-document", ownerUserId: "uidA", applicationId: "app1" },
  verification: { purpose: "agent-verification", userId: "uidA" },
  compliance: { purpose: "compliance-document", agencyId: "agency1", slots: ["idDocument"] },
  logo: { purpose: "agency-logo", agencyId: "agency1" },
  photo: { purpose: "profile-photo", userId: "uidA" },
  feedback: { purpose: "feedback-screenshot", userId: "uidA" },
};

/** The issue code for a refused path (fails the test if it was accepted). */
function issueOf(raw: unknown, scope: StorageScope): string {
  const check = validateStoragePath(raw, scope);
  assert.equal(check.ok, false, `expected ${JSON.stringify(raw)} to be refused`);
  return check.ok ? "" : check.issue;
}

describe("issued paths", () => {
  test("each purpose issues into its own folder, as {uuid}_{sanitised file name}", () => {
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const file = "my scan (1).pdf"; // spaces and brackets become underscores
    assert.match(buildIssuedPath(scopes.document, file), new RegExp(`^documents/uidA/app1/${uuid}_my_scan__1_\\.pdf$`));
    assert.match(buildIssuedPath(scopes.verification, file), new RegExp(`^verification/uidA/${uuid}_my_scan__1_\\.pdf$`));
    assert.match(
      buildIssuedPath(scopes.compliance, file),
      new RegExp(`^compliance/agency1/idDocument/${uuid}_my_scan__1_\\.pdf$`)
    );
    assert.match(buildIssuedPath(scopes.logo, file), new RegExp(`^agency-logos/agency1/${uuid}_my_scan__1_\\.pdf$`));
    assert.match(buildIssuedPath(scopes.photo, file), new RegExp(`^users/uidA/profile/${uuid}_my_scan__1_\\.pdf$`));
    assert.match(buildIssuedPath(scopes.feedback, file), new RegExp(`^users/uidA/feedback/${uuid}_my_scan__1_\\.pdf$`));
  });

  test("an issued path validates for its own scope, whatever the file name", () => {
    for (const fileName of ["a.pdf", "..", "../../etc/passwd", "ünïcödé.png", "a/b\\c?.jpg", " ", "x".repeat(300)]) {
      for (const scope of Object.values(scopes)) {
        const issued = buildIssuedPath(scope, fileName);
        assert.deepEqual(validateStoragePath(issued, scope), { ok: true, key: issued }, issued);
      }
    }
  });

  test("an issued path does not validate for any other scope", () => {
    const others: Record<string, StorageScope> = {
      otherUser: { purpose: "application-document", ownerUserId: "uidB", applicationId: "app1" },
      otherApplication: { purpose: "application-document", ownerUserId: "uidA", applicationId: "app2" },
      otherAgent: { purpose: "agent-verification", userId: "uidB" },
      otherSlot: { purpose: "compliance-document", agencyId: "agency1", slots: ["cacDocument"] },
      otherAgencyKyc: { purpose: "compliance-document", agencyId: "agency2", slots: ["idDocument"] },
      otherAgencyLogo: { purpose: "agency-logo", agencyId: "agency2" },
      otherPhoto: { purpose: "profile-photo", userId: "uidB" },
      otherFeedback: { purpose: "feedback-screenshot", userId: "uidB" },
    };
    for (const [issuedFor, scope] of Object.entries(scopes)) {
      const issued = buildIssuedPath(scope, "f.pdf");
      for (const [name, other] of [...Object.entries(others), ...Object.entries(scopes)]) {
        if (name === issuedFor) continue;
        assert.equal(issueOf(issued, other), "WRONG_PREFIX", `${issuedFor} path against ${name}`);
      }
    }
  });

  test("a uid that is a prefix of another uid does not match the longer one's folder", () => {
    assert.equal(issueOf(`verification/uidAB/${NAME}`, scopes.verification), "WRONG_PREFIX");
    assert.equal(issueOf(`documents/uidA/app10/${NAME}`, scopes.document), "WRONG_PREFIX");
  });

  test("a compliance path may sit in any of the slots the scope lists", () => {
    const anySlot: StorageScope = {
      purpose: "compliance-document",
      agencyId: "agency1",
      slots: ["idDocument", "proofOfAddress", "cacDocument"],
    };
    assert.equal(validateStoragePath(`compliance/agency1/cacDocument/${NAME}`, anySlot).ok, true);
    assert.equal(issueOf(`compliance/agency1/somethingElse/${NAME}`, anySlot), "WRONG_PREFIX");
  });
});

describe("a path must be a normalised, bucket-relative key", () => {
  const ok = `verification/uidA/${NAME}`;
  const cases: [unknown, string][] = [
    [undefined, "NOT_A_STRING"],
    [null, "NOT_A_STRING"],
    [42, "NOT_A_STRING"],
    [{ toString: () => ok }, "NOT_A_STRING"],
    [[ok], "NOT_A_STRING"],
    ["", "EMPTY"],
    [`${ok}${"a".repeat(1100)}`, "TOO_LONG"],
    [`gs://bucket/${ok}`, "HAS_SCHEME"],
    [`https://storage.googleapis.com/bucket/${ok}`, "HAS_SCHEME"],
    [`https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent(ok)}?alt=media`, "HAS_SCHEME"],
    [`file:${ok}`, "HAS_SCHEME"],
    [`/${ok}`, "LEADING_SLASH"],
    [`//bucket/${ok}`, "LEADING_SLASH"],
    [`verification/uidA/${NAME} `, "BAD_CHARACTERS"],
    [`verification/uidA/${NAME}\n`, "BAD_CHARACTERS"],
    [`verification/uidA/${NAME}\u0000`, "BAD_CHARACTERS"],
    [`verification\\uidA\\${NAME}`, "BAD_CHARACTERS"],
    [`verification/uidA/${NAME}?generation=1`, "BAD_CHARACTERS"],
    [`verification/uidA/${NAME}#x`, "BAD_CHARACTERS"],
    [`verification/uidA/%2e%2e/uidB/${NAME}`, "BAD_CHARACTERS"],
    ["verification/uidA/*", "BAD_CHARACTERS"],
    [`verification/uidA//${NAME}`, "EMPTY_SEGMENT"],
    [`verification/uidA/${NAME}/`, "EMPTY_SEGMENT"],
    [`verification/uidA/../uidB/${NAME}`, "RESERVED_SEGMENT"],
    [`verification/uidA/./${NAME}`, "RESERVED_SEGMENT"],
    [`verification/uidB/../uidA/${NAME}`, "RESERVED_SEGMENT"],
  ];

  for (const [raw, issue] of cases) {
    test(`${JSON.stringify(raw)?.slice(0, 70)} -> ${issue}`, () => {
      assert.equal(issueOf(raw, scopes.verification), issue);
      // The structural check alone gives the same answer.
      assert.deepEqual(checkStorageKey(raw), { ok: false, issue });
    });
  }

  test("the bucket name in front of a valid key is just a wrong prefix", () => {
    assert.equal(issueOf(`my-project.firebasestorage.app/${ok}`, scopes.verification), "WRONG_PREFIX");
  });
});

describe("an object in the right folder must be an issued name, directly in it", () => {
  const cases: [string, string][] = [
    ["verification/uidA", "WRONG_PREFIX"], // the folder itself, no trailing slash
    ["verification/uidA/passport.pdf", "NOT_AN_ISSUED_NAME"], // no uuid
    [`verification/uidA/sub/${NAME}`, "NOT_AN_ISSUED_NAME"], // deeper than issued
    [`verification/uidA/${NAME.toUpperCase()}`, "NOT_AN_ISSUED_NAME"], // uuid is lower-case hex
    ["verification/uidA/0f8fad5b-d9cb-469f-a165-70867728950e_", "NOT_AN_ISSUED_NAME"], // empty file part
    ["verification/uidA/0f8fad5b-d9cb-469f-a165-70867728950e_a b.pdf", "BAD_CHARACTERS"],
    ["verification/uidA/0f8fad5b-d9cb-469f-a165-70867728950e_a+b.pdf", "NOT_AN_ISSUED_NAME"],
  ];
  for (const [raw, issue] of cases) {
    test(`${raw} -> ${issue}`, () => assert.equal(issueOf(raw, scopes.verification), issue));
  }
});

describe("backend-only prefixes", () => {
  test("guidance snapshots (and every listed prefix) are refused for every purpose", () => {
    assert.ok(BACKEND_ONLY_PREFIXES.includes("guidance-snapshots"));
    for (const prefix of BACKEND_ONLY_PREFIXES) {
      for (const scope of Object.values(scopes)) {
        assert.equal(issueOf(`${prefix}/source-1/abc.json`, scope), "BACKEND_ONLY_PREFIX");
        assert.equal(issueOf(`${prefix}/${NAME}`, scope), "BACKEND_ONLY_PREFIX");
      }
      assert.throws(() => assertClientReachableKey(`${prefix}/source-1/abc.json`), StoredPathInvalidError);
    }
  });

  test("a scope cannot be aimed at a backend-only prefix through its ids", () => {
    // Even if an id were attacker-influenced, ids are single segments, so no
    // scope's folder can start with a backend-only prefix.
    const sneaky: StorageScope = { purpose: "agent-verification", userId: "../guidance-snapshots" };
    assert.equal(issueOf(`verification/../guidance-snapshots/${NAME}`, sneaky), "RESERVED_SEGMENT");
    assert.equal(issueOf(`verification/x/${NAME}`, sneaky), "INVALID_SCOPE");
  });

  test("the storage-service backstop lets ordinary keys through", () => {
    assert.equal(assertClientReachableKey(`documents/uidA/app1/${NAME}`), `documents/uidA/app1/${NAME}`);
    assert.throws(() => assertClientReachableKey(`gs://b/documents/uidA/app1/${NAME}`), StoredPathInvalidError);
    assert.throws(() => assertClientReachableKey(undefined), StoredPathInvalidError);
  });
});

describe("unusable scope ids fail closed", () => {
  const bad: unknown[] = ["", undefined, null, "a/b", ".", "..", "a b", "a%2Fb", 7];
  for (const id of bad) {
    test(`id ${JSON.stringify(id)} -> INVALID_SCOPE, and no path is issued`, () => {
      const scope = { purpose: "agent-verification", userId: id } as unknown as StorageScope;
      assert.equal(validateStoragePath(`verification/uidA/${NAME}`, scope).ok, false);
      assert.throws(() => buildIssuedPath(scope, "f.pdf"));
      const docScope = { purpose: "application-document", ownerUserId: "uidA", applicationId: id } as unknown as StorageScope;
      assert.equal(validateStoragePath(`documents/uidA/app1/${NAME}`, docScope).ok, false);
      assert.throws(() => buildIssuedPath(docScope, "f.pdf"));
    });
  }

  test("a compliance scope with no slots, or more than one when issuing, is refused", () => {
    const none: StorageScope = { purpose: "compliance-document", agencyId: "agency1", slots: [] };
    assert.equal(issueOf(`compliance/agency1/idDocument/${NAME}`, none), "INVALID_SCOPE");
    const two: StorageScope = { purpose: "compliance-document", agencyId: "agency1", slots: ["idDocument", "cacDocument"] };
    assert.throws(() => buildIssuedPath(two, "f.pdf"));
  });
});

describe("throwing helpers", () => {
  test("requireRequestedPath returns the key or throws the request error with the issue", () => {
    const good = `documents/uidA/app1/${NAME}`;
    assert.equal(requireRequestedPath(good, scopes.document), good);
    assert.throws(
      () => requireRequestedPath(`documents/uidB/app1/${NAME}`, scopes.document),
      (e: unknown) => e instanceof StoragePathRejectedError && e.issue === "WRONG_PREFIX"
    );
  });

  test("requireStoredPath returns the key or throws the stored-record error with the issue", () => {
    const good = `documents/uidA/app1/${NAME}`;
    assert.equal(requireStoredPath(good, scopes.document), good);
    assert.throws(
      () => requireStoredPath("gs://japa-platform.firebasestorage.app/documents/seed-app-001/passport.pdf", scopes.document),
      (e: unknown) => e instanceof StoredPathInvalidError && e.issue === "HAS_SCHEME"
    );
  });

  test("the error messages do not echo the path", () => {
    const secret = `documents/uidB/app1/${NAME}`;
    for (const fn of [requireRequestedPath, requireStoredPath]) {
      try {
        fn(secret, scopes.document);
        assert.fail("expected a throw");
      } catch (e) {
        assert.equal((e as Error).message.includes("uidB"), false);
      }
    }
  });
});
