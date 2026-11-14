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
//         // OPTIONAL (issue #299): the government fee the route's official
//         // source sets for every member, in the source's own currency. The
//         // seed converts it to USD with the stored exchange rate and writes
//         // it on each record under `inheritedBy` (which must then have no
//         // `baseCostUsd` of its own in the seed). Copy `quote` and `url`
//         // from the official source; the quote must itself state the amount
//         // and the currency code, or the file is refused.
//         fee: {
//           amount: 250,                   // the figure the quote states, above 0
//           currency: "SEK",               // ISO 4217, as the quote writes it
//           label: "Visa fee",             // the source's own name for the fee
//           quote: "<verbatim sentence stating the fee, e.g. '... SEK 250.'>",
//           url: "https://www.gov.example.org/fees",   // https only
//           guidanceSourceId: "<id of the stored official source (guidanceSources)>",
//           // ruleRef: { routeKey: "<rulebook key>", version: 1, criterionId: "<rule id>" },  // optional
//         },
//       },
//     ],
//   };
//
// Typed as `unknown` here so a half-filled file still compiles and is then
// rejected, with every problem listed, by the validator at run time.

// ---- CONTENTS ----
// The first real entry (issue #239, owner instruction of 2026-11-14): the
// Schengen area with ONE member recorded so far, the Netherlands. More members
// are added the same way, one official quote each. Issue #306 (2026-11-14)
// added the six other States the Netherlands' quoted sentence names (BE, DE,
// FR, LU, ES, PT), from that same sentence. The bloc's id and name and
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
        // ---- #306: the six other States the same sentence names ----
        // Owner request of 2026-11-14 ("add more ... members"). The quoted
        // decision (same read, same point 1, same address as the NL entry
        // above) brings the Convention into force on 26 March 1995 for the
        // initial Signatory States Belgium, Germany, France, Luxembourg and the
        // Netherlands and the acceding States Spain and Portugal. So each of
        // the six below carries the SAME quote, link and date as NL, copied
        // character for character (a unit test checks they are identical).
        {
          // Belgium: named in the quoted sentence (an initial Signatory State).
          countryCode: "BE",
          joinedOn: "1995-03-26",
          sourceQuote:
            "The Convention shall be brought into force in its entirety on 26 March 1995 for the initial Signatory States namely Belgium, Germany, France, Luxembourg and the Netherlands and the acceding States, Spain and Portugal.",
          sourceUrl: "https://publications.europa.eu/resource/celex/41994D0029",
        },
        {
          // Germany: named in the quoted sentence (an initial Signatory State).
          countryCode: "DE",
          joinedOn: "1995-03-26",
          sourceQuote:
            "The Convention shall be brought into force in its entirety on 26 March 1995 for the initial Signatory States namely Belgium, Germany, France, Luxembourg and the Netherlands and the acceding States, Spain and Portugal.",
          sourceUrl: "https://publications.europa.eu/resource/celex/41994D0029",
        },
        {
          // France: named in the quoted sentence (an initial Signatory State).
          countryCode: "FR",
          joinedOn: "1995-03-26",
          sourceQuote:
            "The Convention shall be brought into force in its entirety on 26 March 1995 for the initial Signatory States namely Belgium, Germany, France, Luxembourg and the Netherlands and the acceding States, Spain and Portugal.",
          sourceUrl: "https://publications.europa.eu/resource/celex/41994D0029",
        },
        {
          // Luxembourg: named in the quoted sentence (an initial Signatory State).
          countryCode: "LU",
          joinedOn: "1995-03-26",
          sourceQuote:
            "The Convention shall be brought into force in its entirety on 26 March 1995 for the initial Signatory States namely Belgium, Germany, France, Luxembourg and the Netherlands and the acceding States, Spain and Portugal.",
          sourceUrl: "https://publications.europa.eu/resource/celex/41994D0029",
        },
        {
          // Spain: named in the quoted sentence (an acceding State).
          countryCode: "ES",
          joinedOn: "1995-03-26",
          sourceQuote:
            "The Convention shall be brought into force in its entirety on 26 March 1995 for the initial Signatory States namely Belgium, Germany, France, Luxembourg and the Netherlands and the acceding States, Spain and Portugal.",
          sourceUrl: "https://publications.europa.eu/resource/celex/41994D0029",
        },
        {
          // Portugal: named in the quoted sentence (an acceding State).
          countryCode: "PT",
          joinedOn: "1995-03-26",
          sourceQuote:
            "The Convention shall be brought into force in its entirety on 26 March 1995 for the initial Signatory States namely Belgium, Germany, France, Luxembourg and the Netherlands and the acceding States, Spain and Portugal.",
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
      // #306: so are the short-stay records of the six members added above
      // (seed-countries-visas.ts, ids `<code>-visitor`). Each takes its price
      // from the route's `fee` below and states no fee of its own.
      inheritedBy: [
        { countryCode: "NL", visaTypeId: "nl-visitor" },
        { countryCode: "BE", visaTypeId: "be-visitor" },
        { countryCode: "DE", visaTypeId: "de-visitor" },
        { countryCode: "FR", visaTypeId: "fr-visitor" },
        { countryCode: "LU", visaTypeId: "lu-visitor" },
        { countryCode: "ES", visaTypeId: "es-visitor" },
        { countryCode: "PT", visaTypeId: "pt-visitor" },
      ],
      // ---- The route's government fee (issue #299) ----
      // Read on 2026-11-14 from the dev project (durin-seli-dev), not typed
      // from memory:
      //   - `quote` is the `source.quote` of rule crit_1cd0c13dfe34a0ff in the
      //     published shared rulebook
      //     visaRubrics/schengen-area_schengen-area-short-stay/rubricVersions/1,
      //     copied word for word. `amount` and `currency` are the figure that
      //     sentence states.
      //   - `url` is the `url` of the stored official source
      //     guidanceSources/<guidanceSourceId> (the Visa Code, consolidated
      //     text of 28 June 2024). Owner decision on #299: the source's own
      //     registered https address is recorded, NOT the rule's `source.url`,
      //     which is the same document's address after the publisher's
      //     redirect and is plain http (refused by the validator).
      // The seed converts the figure to USD with the stored exchange rate and
      // writes it on every record under `inheritedBy` (seed-sourced-fee.ts).
      fee: {
        amount: 90,
        currency: "EUR",
        // The quote's own name for it.
        label: "Visa fee",
        quote: "Applicants shall pay a visa fee of EUR 90.",
        url: "https://publications.europa.eu/resource/celex/02009R0810-20240628",
        guidanceSourceId: "schengen-area-visa-code-regulation-ec-no-810-2009-consolidated-text-of-28-june-2024",
        ruleRef: { routeKey: "schengen-area_schengen-area-short-stay", version: 1, criterionId: "crit_1cd0c13dfe34a0ff" },
      },
    },
  ],
};
