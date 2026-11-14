// ============================================
// Authorities — pure rules (issue #230, P1 of #228)
// ============================================
//
// Id shapes, rulebook key splitting, calendar dates, membership on a date and
// member body validation. No Firestore, no network. Codes are ISO
// "user-assigned" ones (XA, XB, ...) and bloc ids are made up, so no test
// names a real country or bloc.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRulebookKey,
  checkAuthorityId,
  checkAuthorityIdForKind,
  isMemberOn,
  membersOn,
  parseCalendarDate,
  splitRulebookKey,
  todayUtc,
} from "../../src/authorities/authority-ids";
import { readMemberInput } from "../../src/authorities/authority.service";
import { RegistryError } from "../../src/scrapers";

describe("authority ids", () => {
  test("a two-letter upper-case code is a country id", () => {
    assert.deepEqual(checkAuthorityId("XA"), { ok: true, id: "XA", shape: "country" });
  });

  test("lower-case letters, digits and hyphens, 3+ chars, are a group id", () => {
    for (const id of ["abc", "test-bloc", "t1", "a-1-b", "123"].filter((x) => x.length >= 3)) {
      const r = checkAuthorityId(id);
      assert.equal(r.ok, true, id);
      if (r.ok) assert.equal(r.shape, "group");
    }
  });

  test("refuses: empty, non-string, underscore, too short, upper/mixed case, bad characters, edge hyphens, too long", () => {
    const bad: unknown[] = ["", undefined, null, 12, "XA_", "a_bc", "ab", "xa", "x", "Abc", "ABC", "a.bc", "a bc", "-abc", "abc-", "ab/c", "é-bloc", "a".repeat(65)];
    for (const id of bad) {
      const r = checkAuthorityId(id);
      assert.equal(r.ok, false, JSON.stringify(id));
      if (!r.ok) {
        assert.equal(r.code, "INVALID_AUTHORITY_ID");
        assert.ok(r.message.length > 10, "a plain-words message");
      }
    }
  });

  test("an underscore is named in the message", () => {
    const r = checkAuthorityId("my_bloc");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /underscore/);
  });

  test("the id must match the kind", () => {
    assert.equal(checkAuthorityIdForKind("XA", "country").ok, true);
    assert.equal(checkAuthorityIdForKind("test-bloc", "bloc").ok, true);
    assert.equal(checkAuthorityIdForKind("test-pact", "treaty").ok, true);
    assert.equal(checkAuthorityIdForKind("test-bloc", "country").ok, false);
    assert.equal(checkAuthorityIdForKind("XA", "bloc").ok, false);
    assert.equal(checkAuthorityIdForKind("XA", "treaty").ok, false);
  });
});

describe("splitRulebookKey", () => {
  test("a country key splits at the first underscore (today's keys read unchanged)", () => {
    assert.deepEqual(splitRulebookKey("XA_visitor"), { ok: true, authorityId: "XA", authorityIdKind: "country", routeSlug: "visitor" });
  });

  test("a group key splits the same way", () => {
    assert.deepEqual(splitRulebookKey("test-bloc_short-stay"), { ok: true, authorityId: "test-bloc", authorityIdKind: "group", routeSlug: "short-stay" });
  });

  test("underscores after the first belong to the route", () => {
    const r = splitRulebookKey("XA_a_b");
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.authorityId, r.routeSlug], ["XA", "a_b"]);
  });

  test("bad input is refused with a message", () => {
    for (const key of ["", undefined, 5, "XA", "XA_", "_visitor", "xa_visitor", "ab_visitor", "Test-Bloc_x", "XA_-x", "XA_a/b", "XA_a b", "XA__x"]) {
      const r = splitRulebookKey(key);
      assert.equal(r.ok, false, JSON.stringify(key));
      if (!r.ok) assert.equal(r.code, "INVALID_RULEBOOK_KEY");
    }
  });

  test("buildRulebookKey is the inverse and refuses bad parts", () => {
    assert.equal(buildRulebookKey("test-bloc", "short-stay"), "test-bloc_short-stay");
    assert.equal(buildRulebookKey("XA", "a_b"), "XA_a_b");
    assert.throws(() => buildRulebookKey("my_bloc", "x"));
    assert.throws(() => buildRulebookKey("XA", ""));
  });
});

describe("calendar dates", () => {
  test("real dates pass, impossible or malformed ones are refused", () => {
    assert.equal(parseCalendarDate("2026-02-28"), "2026-02-28");
    assert.equal(parseCalendarDate("2024-02-29"), "2024-02-29");
    for (const d of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-1-1", "26-01-01", "2026-01-01T00:00:00Z", "", null, 20260101]) {
      assert.equal(parseCalendarDate(d), undefined, JSON.stringify(d));
    }
  });

  test("today is the UTC date", () => {
    assert.equal(todayUtc(Date.parse("2026-11-14T23:59:59Z")), "2026-11-14");
  });
});

describe("membership on a date", () => {
  const m = { countryCode: "XA", joinedOn: "2020-01-01", leftOn: "2025-06-01" };

  test("before joining: not a member; on the join day: a member", () => {
    assert.equal(isMemberOn(m, "2019-12-31"), false);
    assert.equal(isMemberOn(m, "2020-01-01"), true);
  });

  test("the day before leftOn: a member; on and after leftOn: not", () => {
    assert.equal(isMemberOn(m, "2025-05-31"), true);
    assert.equal(isMemberOn(m, "2025-06-01"), false);
    assert.equal(isMemberOn(m, "2026-01-01"), false);
  });

  test("no leftOn: a member from joining onwards", () => {
    assert.equal(isMemberOn({ joinedOn: "2020-01-01" }, "2099-01-01"), true);
  });

  test("membersOn filters and sorts; an empty list stays empty", () => {
    const all = [
      { countryCode: "XC", joinedOn: "2020-01-01" },
      { countryCode: "XA", joinedOn: "2020-01-01", leftOn: "2024-01-01" },
      { countryCode: "XB", joinedOn: "2023-01-01" },
    ];
    assert.deepEqual(membersOn(all, "2023-06-01").map((x) => x.countryCode), ["XA", "XB", "XC"]);
    assert.deepEqual(membersOn(all, "2024-06-01").map((x) => x.countryCode), ["XB", "XC"]);
    assert.deepEqual(membersOn(all, "2021-06-01").map((x) => x.countryCode), ["XA", "XC"]);
    assert.deepEqual(membersOn([], "2024-06-01"), []);
  });
});

describe("member body validation", () => {
  const ok = { joinedOn: "2020-01-01", sourceQuote: "  The members are listed here.  ", sourceUrl: "https://www.gov.example.org/members" };
  const code = (body: Record<string, unknown>): string => {
    try {
      readMemberInput(body);
      return "ok";
    } catch (err) {
      assert.ok(err instanceof RegistryError);
      assert.equal(err.status, 400);
      return err.code;
    }
  };

  test("a valid body passes; the quote keeps its words (edges trimmed)", () => {
    const r = readMemberInput(ok);
    assert.equal(r.sourceQuote, "The members are listed here.");
    assert.equal(r.sourceHost, "www.gov.example.org");
    assert.equal(r.leftOn, undefined);
    assert.equal(readMemberInput({ ...ok, leftOn: null }).leftOn, undefined);
    assert.equal(readMemberInput({ ...ok, leftOn: "2021-01-01" }).leftOn, "2021-01-01");
  });

  test("a member without a quote or official URL is refused", () => {
    assert.equal(code({ ...ok, sourceQuote: undefined }), "SOURCE_QUOTE_REQUIRED");
    assert.equal(code({ ...ok, sourceQuote: "   " }), "SOURCE_QUOTE_REQUIRED");
    assert.equal(code({ ...ok, sourceQuote: 7 }), "SOURCE_QUOTE_REQUIRED");
    assert.equal(code({ ...ok, sourceQuote: "x".repeat(2001) }), "SOURCE_QUOTE_TOO_LONG");
    assert.equal(code({ ...ok, sourceUrl: undefined }), "SOURCE_URL_REQUIRED");
    assert.equal(code({ ...ok, sourceUrl: "" }), "SOURCE_URL_REQUIRED");
    assert.equal(code({ ...ok, sourceUrl: "http://www.gov.example.org/members" }), "NOT_HTTPS");
    assert.equal(code({ ...ok, sourceUrl: "https://10.0.0.1/x" }), "IP_LITERAL");
  });

  test("dates: joinedOn required and real; leftOn after joinedOn", () => {
    assert.equal(code({ ...ok, joinedOn: undefined }), "INVALID_DATE");
    assert.equal(code({ ...ok, joinedOn: "2020-02-30" }), "INVALID_DATE");
    assert.equal(code({ ...ok, leftOn: "soon" }), "INVALID_DATE");
    assert.equal(code({ ...ok, leftOn: "2020-01-01" }), "INVALID_DATE_RANGE");
    assert.equal(code({ ...ok, leftOn: "2019-01-01" }), "INVALID_DATE_RANGE");
  });
});
