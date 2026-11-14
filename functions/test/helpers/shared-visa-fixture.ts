// ============================================
// Fixture — an EXAMPLE-SHAPED shared visa data file with MADE-UP content (issue #239)
// ============================================
// Made-up ids, user-assigned country codes (XA, XB) and placeholder quotes. It shows
// the format; it is not, and must never be copied as, real bloc data.

export const BLOC_HOST = "bloc.example.org";

export const FIXTURE_DATA = {
  authorities: [
    {
      id: "example-area",
      kind: "bloc",
      name: "Example Travel Area",
      members: [
        { countryCode: "XA", joinedOn: "2000-01-01", sourceQuote: "Placeholder sentence stating that XA is a member.", sourceUrl: `https://${BLOC_HOST}/members` },
        { countryCode: "XB", joinedOn: "2001-01-01", sourceQuote: "Placeholder sentence stating that XB is a member.", sourceUrl: `https://${BLOC_HOST}/members` },
      ],
    },
  ],
  sharedRoutes: [
    {
      id: "example-short-stay",
      name: "Example Short Stay Visa",
      category: "tourist",
      issuingAuthorityId: "example-area",
      destinations: { mode: "members_of", authorityId: "example-area" },
      inheritedBy: [{ countryCode: "XA", visaTypeId: "xa-visitor" }],
    },
  ],
};

// ---- Issue #299: a MADE-UP fee for the fixture route ----
// A placeholder sentence, amount and ids. The currency code is a real ISO 4217
// code only because the validator requires one; nothing here is a real fee.
export const FIXTURE_FEE = {
  amount: 250,
  currency: "SEK",
  label: "Placeholder fee",
  quote: "Placeholder sentence stating that the fee is SEK 250.",
  url: `https://${BLOC_HOST}/fees`,
  guidanceSourceId: "example-area-fee-source",
  ruleRef: { routeKey: "example-area_example-short-stay", version: 1, criterionId: "crit_example" },
};

/** FIXTURE_DATA with the made-up fee on its one route (a fresh copy every call). */
export function fixtureDataWithFee(): typeof FIXTURE_DATA & { sharedRoutes: Array<{ fee: typeof FIXTURE_FEE }> } {
  const copy = JSON.parse(JSON.stringify(FIXTURE_DATA));
  copy.sharedRoutes[0].fee = JSON.parse(JSON.stringify(FIXTURE_FEE));
  return copy;
}
