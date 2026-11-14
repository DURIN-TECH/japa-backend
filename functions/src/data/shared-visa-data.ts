// ============================================
// SHARED VISA DATA — THE FILE AN ADMIN FILLS IN (issue #239, P10 of #228)
// ============================================
//
// Shipped EMPTY on purpose. A bloc, its member countries and the shared visa
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

export const SHARED_VISA_DATA: unknown = { authorities: [], sharedRoutes: [] };
