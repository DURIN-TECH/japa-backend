// ============================================
// SHARED VISA DATA — THE FILE AN ADMIN FILLS IN (issue #239, P10 of #228)
// ============================================
//
// A bloc, its member countries and the shared visa
// route are legal facts: nothing here is guessed or written from memory. Fill
// it in only from OFFICIAL pages, and give every member country:
//   - `sourceQuote`  the sentence from the official page that states the
//                    membership, copied word for word, and
//   - `sourceUrl`    the address of that page (https).
// The host of every `sourceUrl` must also be confirmed as an official website
// (admin portal, "official websites") BEFORE the migration is applied, or that
// member is reported as blocked and not written.
//
// The seed (`seed-countries-visas.ts`) and the migration script read this file
// through `loadSharedVisaData()` (shared-visa-data-format.ts), which validates
// it and refuses an invalid file with a list of every problem.
//
// FORMAT (all ids below are made up; country codes are the user-assigned XA..XC):
//
//   export const SHARED_VISA_DATA = {
//     authorities: [
//       {
//         id: "example-area",              // lower case, 3+ chars, no underscore
//         kind: "bloc",                    // "bloc" | "treaty"
//         name: "Example Travel Area",     // as the official source writes it
//         members: [
//           {
//             countryCode: "XA",
//             joinedOn: "2000-01-01",      // "YYYY-MM-DD"
//             // leftOn: "2030-01-01",     // optional, first day NOT a member
//             sourceQuote: "<verbatim sentence from the official page>",
//             sourceUrl: "https://www.gov.example.org/members",
//           },
//         ],
//       },
//     ],
//     sharedRoutes: [
//       {
//         id: "example-short-stay",        // lower case, no underscore
//         name: "Example Short Stay Visa",
//         category: "tourist",
//         issuingAuthorityId: "example-area",
//         destinations: { mode: "members_of", authorityId: "example-area" },
//         // The visa records (through-country records) that inherit the route:
//         inheritedBy: [{ countryCode: "XA", visaTypeId: "xa-visitor" }],
//       },
//     ],
//   };
//
// Typed as `unknown` here so a half-filled file still compiles and is then
// rejected, with every problem listed, by the validator at run time.

// ---- CONTENTS ----
// The first real entry (issue #239, owner instruction of 2026-11-14): the
// Schengen area with ONE member recorded so far, the Netherlands. More members
// are added the same way, one official quote each. The bloc's id and name and
// the route's id, name and category repeat what is already registered on dev
// (so applying this file creates nothing new for them; it adds the member and
// the inheritance).
export const SHARED_VISA_DATA: unknown = {
  authorities: [
    {
      id: "schengen-area",
      kind: "bloc",
      name: "Schengen area",
      members: [
        {
          countryCode: "NL",
          // The day the Schengen Convention came into force for the Netherlands,
          // as the quoted decision states it.
          joinedOn: "1995-03-26",
          // Read on 2026-11-14 from the Official Journal (L 239, 22.9.2000, p. 130):
          // Decision of the Executive Committee of 22 December 1994 on bringing
          // into force the Convention implementing the Schengen Agreement
          // (SCH/Com-ex (94) 29 rev. 2), point 1. Copied word for word.
          sourceQuote:
            "The Convention shall be brought into force in its entirety on 26 March 1995 for the initial Signatory States namely Belgium, Germany, France, Luxembourg and the Netherlands and the acceding States, Spain and Portugal.",
          // Same official host as the Visa Code source (already a confirmed official website).
          sourceUrl: "https://publications.europa.eu/resource/celex/41994D0029",
        },
      ],
    },
  ],
  sharedRoutes: [
    {
      id: "schengen-area-short-stay",
      name: "Schengen short-stay visa",
      category: "tourist",
      issuingAuthorityId: "schengen-area",
      destinations: { mode: "members_of", authorityId: "schengen-area" },
      // The Netherlands short-stay record is assessed against the shared rulebook.
      inheritedBy: [{ countryCode: "NL", visaTypeId: "nl-visitor" }],
    },
  ],
};
