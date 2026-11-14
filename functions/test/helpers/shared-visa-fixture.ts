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
