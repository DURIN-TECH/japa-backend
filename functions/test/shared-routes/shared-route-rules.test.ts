// ============================================
// Shared routes: pure rules (issue #231, P2 of #228)
// ============================================
// No Firebase. Ids and keys are made up; no real bloc, country or visa is named.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteStack,
  checkSharedRouteId,
  inheritedIds,
  isApplicationOpen,
  layersFromKeys,
  ownRulebookKey,
  routeStackKeys,
  sharedRulebookKey,
} from "../../src/shared-routes/shared-route-rules";
import { readDestinations, readInheritsFrom } from "../../src/shared-routes/shared-route.service";

describe("checkSharedRouteId", () => {
  test("accepts lower-case letters, digits and hyphens (3 to 60)", () => {
    for (const id of ["abc", "short-stay-1", "a1b"]) assert.deepEqual(checkSharedRouteId(id), { ok: true, id });
  });
  test("refuses an underscore, capitals, spaces, slashes, too short, too long, non-strings", () => {
    for (const id of ["a_b_c", "ABC", "ab", "a b c", "a/b/c", "-abc", "x".repeat(61), "", 5, null, undefined]) {
      assert.equal(checkSharedRouteId(id).ok, false, String(id));
    }
  });
});

describe("rulebook keys", () => {
  test("a shared layer is {issuingAuthorityId}_{sharedRouteId}; the own layer stays {countryCode}_{visaTypeId}", () => {
    assert.equal(sharedRulebookKey("test-bloc", "short-stay"), "test-bloc_short-stay");
    assert.equal(ownRulebookKey("XA", "xa-visitor"), "XA_xa-visitor");
  });
});

describe("buildRouteStack", () => {
  test("no shared route: just the own layer (every existing route)", () => {
    assert.deepEqual(buildRouteStack("XA", "v1", []), [{ authorityId: "XA", rulebookKey: "XA_v1", role: "own" }]);
  });
  test("one shared route: shared first, own last", () => {
    assert.deepEqual(buildRouteStack("XA", "v1", [{ id: "route-one", issuingAuthorityId: "test-bloc" }]), [
      { authorityId: "test-bloc", rulebookKey: "test-bloc_route-one", role: "shared" },
      { authorityId: "XA", rulebookKey: "XA_v1", role: "own" },
    ]);
  });
  test("two shared routes keep the order given, own layer still last", () => {
    const stack = buildRouteStack("XA", "v1", [
      { id: "route-two", issuingAuthorityId: "other-bloc" },
      { id: "route-one", issuingAuthorityId: "test-bloc" },
    ]);
    assert.deepEqual(routeStackKeys(stack), ["other-bloc_route-two", "test-bloc_route-one", "XA_v1"]);
    assert.deepEqual(stack.map((l) => l.role), ["shared", "shared", "own"]);
  });
  test("a visa id with an underscore keeps its key whole", () => {
    assert.equal(buildRouteStack("XA", "my_visa", [])[0].rulebookKey, "XA_my_visa");
  });
});

describe("layersFromKeys", () => {
  test("last key is the own layer, earlier ones shared", () => {
    assert.deepEqual(layersFromKeys(["test-bloc_route-one", "XA_v1"]), [
      { authorityId: "test-bloc", rulebookKey: "test-bloc_route-one", role: "shared" },
      { authorityId: "XA", rulebookKey: "XA_v1", role: "own" },
    ]);
  });
  test("absent, empty or malformed gives undefined (resolve live instead)", () => {
    for (const v of [undefined, null, [], "XA_v1", ["nounderscore"], ["XA_v1", 3]]) assert.equal(layersFromKeys(v), undefined);
  });
});

describe("isApplicationOpen", () => {
  test("terminal statuses are closed, everything else open", () => {
    for (const s of ["approved", "rejected", "withdrawn", "expired"] as const) assert.equal(isApplicationOpen(s), false);
    for (const s of ["draft", "pending_payment", "pending_documents", "under_review", "submitted_to_embassy", "interview_scheduled"] as const) assert.equal(isApplicationOpen(s), true);
  });
});

describe("inheritedIds", () => {
  test("reads ids in order and ignores junk", () => {
    assert.deepEqual(inheritedIds([{ sharedRouteId: "a-b-c" }, null, { x: 1 }, { sharedRouteId: "d-e-f" }]), ["a-b-c", "d-e-f"]);
    assert.deepEqual(inheritedIds(undefined), []);
  });
});

describe("readDestinations / readInheritsFrom", () => {
  test("listed: sorted, unique, codes valid", () => {
    assert.deepEqual(readDestinations({ mode: "listed", countryCodes: ["XB", "XA"] }), { mode: "listed", countryCodes: ["XA", "XB"] });
    for (const bad of [{ mode: "listed", countryCodes: [] }, { mode: "listed", countryCodes: ["xa"] }, { mode: "listed", countryCodes: ["XA", "XA"] }, { mode: "listed" }, { mode: "listed", countryCodes: ["XA"], extra: 1 }]) {
      assert.throws(() => readDestinations(bad), /./);
    }
  });
  test("members_of: a valid authority id; unknown modes and keys refused", () => {
    assert.deepEqual(readDestinations({ mode: "members_of", authorityId: "test-bloc" }), { mode: "members_of", authorityId: "test-bloc" });
    for (const bad of [{ mode: "members_of", authorityId: "a_b" }, { mode: "all" }, null, [], "x"]) assert.throws(() => readDestinations(bad), /./);
  });
  test("inheritsFrom: strict entries, no duplicates, empty is fine", () => {
    assert.deepEqual(readInheritsFrom([]), []);
    assert.deepEqual(readInheritsFrom([{ sharedRouteId: "abc" }]), [{ sharedRouteId: "abc" }]);
    for (const bad of ["x", [{ sharedRouteId: "abc" }, { sharedRouteId: "abc" }], [{ sharedRouteId: "a_c" }], [{ sharedRouteId: "abc", more: 1 }], ["abc"]]) {
      assert.throws(() => readInheritsFrom(bad), /./);
    }
  });
});
