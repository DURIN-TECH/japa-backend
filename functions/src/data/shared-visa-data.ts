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
// Issue #322 (2026-11-15) added the twenty other members except Italy and
// Austria (GR, DK, FI, SE, IS, NO, CZ, EE, LV, LT, HU, MT, PL, SI, SK, CH, LI,
// HR, BG, RO), in seven groups, each from its own official decision; their
// short-stay records inherit the same route.
// Issue #331 (2026-11-15) added Italy and Austria, the last two members, with
// the date and the official sentence already stored for Denmark (see the note
// next to their entries); their short-stay records inherit the same route.
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
        // ---- #322: the twenty other members except Italy and Austria ----
        // Owner request of 2026-11-15 ("sure" to adding the remaining members).
        // Seven groups, each with ONE official sentence, link and date: every
        // sentence was read on 2026-11-15 from the Official Journal text served by
        // the EU Publications Office (publications.europa.eu, already a confirmed
        // official website) and extracted by script. The entries below were
        // GENERATED by script from the JSON block of issue #322 (never retyped);
        // a unit test compares them with a copy of that block
        // (test/data/fixtures/schengen-members-322.json), character for character.
        // Editing note (all groups): paragraph numbers ("1.") and one footnote
        // marker are left out of the quotes; nothing else is changed.
        // Italy and Austria are NOT here: their bringing-into-force decisions are
        // not published in the Official Journal, so no official sentence with a
        // start date is on record (owner decision pending, separate issue).
        // -- #322 group: GR (from 2000-01-01) --
        // Source: Council Decision 1999/848/EC, Article 1, first sentence.
        // Editing note (GR date): the date is the first day of the period Article 1
        // gives for lifting internal border controls. An earlier decision
        // (SCH/Com-ex (97) 29 rev. 2) began an "initial phase" on 1 December 1997;
        // the later, full-application date is used.
        {
          // Greece: named in the quoted sentence.
          countryCode: "GR",
          joinedOn: "2000-01-01",
          sourceQuote:
            "Controls on persons at internal borders between Greece and the Member States which fully apply the Schengen acquis shall be lifted in the period from 1 January 2000 to 26 March 2000.",
          sourceUrl: "https://publications.europa.eu/resource/celex/31999D0848",
        },
        // -- #322 group: DK, FI, SE, IS, NO (from 2001-03-25) --
        // Source: Council Decision 2000/777/EC, Article 1.
        // Every member of this group carries the SAME quote, link and date.
        // Editing note: one footnote marker ("(2)" after "acquis") and the
        // paragraph number are left out of the quote; nothing else is changed.
        {
          // Denmark: named in the quoted sentence.
          countryCode: "DK",
          joinedOn: "2001-03-25",
          sourceQuote:
            "As from 25 March 2001, and subject to Article 3(2): (a) all the provisions of the Schengen acquis referred to in Annexes A, B, C and D to Council Decision 1999/436/EC of 20 May 1999 determining, in conformity with the relevant provisions of the Treaty establishing the European Community and the Treaty on European Union, the legal basis for each of the provisions or decisions which constitute the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Denmark, Finland and Sweden, in their relations between each other and with Belgium, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria and Portugal; (b) all the provisions referred to in Annexes A and B to the Agreement of 18 May 1999 concluded by the Council of the European Union, the Republic of Iceland and the Kingdom of Norway concerning the latters' association with the implementation, application, and development of the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Iceland and Norway, in their relations between each other and with Belgium, Denmark, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria, Portugal, Finland and Sweden.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32000D0777",
        },
        {
          // Finland: named in the quoted sentence.
          countryCode: "FI",
          joinedOn: "2001-03-25",
          sourceQuote:
            "As from 25 March 2001, and subject to Article 3(2): (a) all the provisions of the Schengen acquis referred to in Annexes A, B, C and D to Council Decision 1999/436/EC of 20 May 1999 determining, in conformity with the relevant provisions of the Treaty establishing the European Community and the Treaty on European Union, the legal basis for each of the provisions or decisions which constitute the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Denmark, Finland and Sweden, in their relations between each other and with Belgium, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria and Portugal; (b) all the provisions referred to in Annexes A and B to the Agreement of 18 May 1999 concluded by the Council of the European Union, the Republic of Iceland and the Kingdom of Norway concerning the latters' association with the implementation, application, and development of the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Iceland and Norway, in their relations between each other and with Belgium, Denmark, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria, Portugal, Finland and Sweden.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32000D0777",
        },
        {
          // Sweden: named in the quoted sentence.
          countryCode: "SE",
          joinedOn: "2001-03-25",
          sourceQuote:
            "As from 25 March 2001, and subject to Article 3(2): (a) all the provisions of the Schengen acquis referred to in Annexes A, B, C and D to Council Decision 1999/436/EC of 20 May 1999 determining, in conformity with the relevant provisions of the Treaty establishing the European Community and the Treaty on European Union, the legal basis for each of the provisions or decisions which constitute the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Denmark, Finland and Sweden, in their relations between each other and with Belgium, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria and Portugal; (b) all the provisions referred to in Annexes A and B to the Agreement of 18 May 1999 concluded by the Council of the European Union, the Republic of Iceland and the Kingdom of Norway concerning the latters' association with the implementation, application, and development of the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Iceland and Norway, in their relations between each other and with Belgium, Denmark, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria, Portugal, Finland and Sweden.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32000D0777",
        },
        {
          // Iceland: named in the quoted sentence.
          countryCode: "IS",
          joinedOn: "2001-03-25",
          sourceQuote:
            "As from 25 March 2001, and subject to Article 3(2): (a) all the provisions of the Schengen acquis referred to in Annexes A, B, C and D to Council Decision 1999/436/EC of 20 May 1999 determining, in conformity with the relevant provisions of the Treaty establishing the European Community and the Treaty on European Union, the legal basis for each of the provisions or decisions which constitute the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Denmark, Finland and Sweden, in their relations between each other and with Belgium, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria and Portugal; (b) all the provisions referred to in Annexes A and B to the Agreement of 18 May 1999 concluded by the Council of the European Union, the Republic of Iceland and the Kingdom of Norway concerning the latters' association with the implementation, application, and development of the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Iceland and Norway, in their relations between each other and with Belgium, Denmark, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria, Portugal, Finland and Sweden.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32000D0777",
        },
        {
          // Norway: named in the quoted sentence.
          countryCode: "NO",
          joinedOn: "2001-03-25",
          sourceQuote:
            "As from 25 March 2001, and subject to Article 3(2): (a) all the provisions of the Schengen acquis referred to in Annexes A, B, C and D to Council Decision 1999/436/EC of 20 May 1999 determining, in conformity with the relevant provisions of the Treaty establishing the European Community and the Treaty on European Union, the legal basis for each of the provisions or decisions which constitute the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Denmark, Finland and Sweden, in their relations between each other and with Belgium, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria and Portugal; (b) all the provisions referred to in Annexes A and B to the Agreement of 18 May 1999 concluded by the Council of the European Union, the Republic of Iceland and the Kingdom of Norway concerning the latters' association with the implementation, application, and development of the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Iceland and Norway, in their relations between each other and with Belgium, Denmark, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria, Portugal, Finland and Sweden.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32000D0777",
        },
        // -- #322 group: CZ, EE, LV, LT, HU, MT, PL, SI, SK (from 2007-12-21) --
        // Source: Council Decision 2007/801/EC, title and Article 1(1) first sentence.
        // Every member of this group carries the SAME quote, link and date.
        // Editing note (2007/801/EC): Article 1(1) says "the Member States
        // concerned" and the title names them, so the quote is the title, then
        // ` [...] `, then the Article 1(1) sentence. Both parts are word for word.
        {
          // Czechia: named in the quoted title.
          countryCode: "CZ",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Estonia: named in the quoted title.
          countryCode: "EE",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Latvia: named in the quoted title.
          countryCode: "LV",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Lithuania: named in the quoted title.
          countryCode: "LT",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Hungary: named in the quoted title.
          countryCode: "HU",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Malta: named in the quoted title.
          countryCode: "MT",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Poland: named in the quoted title.
          countryCode: "PL",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Slovenia: named in the quoted title.
          countryCode: "SI",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        {
          // Slovakia: named in the quoted title.
          countryCode: "SK",
          joinedOn: "2007-12-21",
          sourceQuote:
            "COUNCIL DECISION of 6 December 2007 on the full application of the provisions of the Schengen acquis in the Czech Republic, the Republic of Estonia, the Republic of Latvia, the Republic of Lithuania, the Republic of Hungary, the Republic of Malta, the Republic of Poland, the Republic of Slovenia and the Slovak Republic [...] The provisions of the Schengen acquis referred to in Annex I shall apply to the Member States concerned amongst themselves and in their relations with the Kingdom of Belgium, the Kingdom of Denmark, the Federal Republic of Germany, the Hellenic Republic, the Kingdom of Spain, the Republic of France, the Italian Republic, the Grand Duchy of Luxembourg, the Kingdom of the Netherlands, the Republic of Austria, the Portuguese Republic, the Republic of Finland and the Kingdom of Sweden, as well as with the Republic of Iceland and the Kingdom of Norway as from 21 December 2007.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32007D0801",
        },
        // -- #322 group: CH (from 2008-12-12) --
        // Source: Council Decision 2008/903/EC, Article 1(1) first sentence.
        {
          // Switzerland: named in the quoted sentence.
          countryCode: "CH",
          joinedOn: "2008-12-12",
          sourceQuote:
            "All the provisions referred to in Annexes A and B to the Agreement and any act constituting a further development of one or more of these provisions, shall apply to the Swiss Confederation, in its relations with Kingdom of Belgium, the Czech Republic, the Kingdom of Denmark, the Federal Republic of Germany, the Republic of Estonia, the Hellenic Republic, the Kingdom of Spain, the French Republic, the Italian Republic, the Republic of Latvia, the Republic of Lithuania, the Grand Duchy of Luxembourg, the Republic of Hungary, the Republic of Malta, the Kingdom of the Netherlands, the Republic of Austria, the Republic of Poland, the Portuguese Republic, the Republic of Slovenia, the Slovak Republic, the Republic of Finland, and the Kingdom of Sweden as from 12 December 2008.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32008D0903",
        },
        // -- #322 group: LI (from 2011-12-19) --
        // Source: Council Decision 2011/842/EU, Article 1(1) first sentence.
        {
          // Liechtenstein: named in the quoted sentence.
          countryCode: "LI",
          joinedOn: "2011-12-19",
          sourceQuote:
            "All the provisions referred to in Annexes A and B to the Agreement between the European Union, the European Community and the Swiss Confederation on the Swiss Confederation’s association with the implementation, application and development of the Schengen acquis and all the provisions listed in the Annex to the Protocol to that Agreement and any act constituting a further development of one or more of these provisions, shall apply to the Principality of Liechtenstein, in its relations with the Kingdom of Belgium, the Czech Republic, the Kingdom of Denmark, the Federal Republic of Germany, the Republic of Estonia, the Hellenic Republic, the Kingdom of Spain, the French Republic, the Italian Republic, the Republic of Latvia, the Republic of Lithuania, the Grand Duchy of Luxembourg, Hungary, Malta, the Kingdom of the Netherlands, the Republic of Austria, the Republic of Poland, the Portuguese Republic, the Republic of Slovenia, the Slovak Republic, the Republic of Finland, and the Kingdom of Sweden as from 19 December 2011.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32011D0842",
        },
        // -- #322 group: HR (from 2023-01-01) --
        // Source: Council Decision (EU) 2022/2451, Article 1(1).
        {
          // Croatia: named in the quoted sentence.
          countryCode: "HR",
          joinedOn: "2023-01-01",
          sourceQuote:
            "From 1 January 2023, checks on persons at internal land and sea borders with Croatia shall be lifted and the provisions of the Schengen acquis referred to in the Annex shall apply to Croatia in its relations with the Kingdom of Belgium, the Czech Republic, the Kingdom of Denmark, the Federal Republic of Germany, the Republic of Estonia, the Hellenic Republic, the Kingdom of Spain, the French Republic, the Italian Republic, the Republic of Latvia, the Republic of Lithuania, the Grand Duchy of Luxembourg, Hungary, Malta, the Kingdom of the Netherlands, the Republic of Austria, the Republic of Poland, the Portuguese Republic, the Republic of Slovenia, the Slovak Republic, the Republic of Finland and the Kingdom of Sweden, as well as Iceland, the Principality of Liechtenstein, the Kingdom of Norway and the Swiss Confederation.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32022D2451",
        },
        // -- #322 group: BG, RO (from 2024-03-31) --
        // Source: Council Decision (EU) 2024/210, Article 1, first sentence.
        // Every member of this group carries the SAME quote, link and date.
        // Editing note (BG, RO date): 31 March 2024 is when the provisions started
        // to apply (air and sea borders); land border checks were lifted from
        // 1 January 2025 by Decision (EU) 2024/3212. The earlier date is the
        // membership date.
        {
          // Bulgaria: named in the quoted sentence.
          countryCode: "BG",
          joinedOn: "2024-03-31",
          sourceQuote:
            "From 31 March 2024, checks on persons at internal air and sea borders with and between Bulgaria and Romania shall be lifted and the provisions of the Schengen acquis referred to in the Annex shall apply to Bulgaria and Romania between themselves and in their relations with the Kingdom of Belgium, the Czech Republic, the Kingdom of Denmark, the Federal Republic of Germany, the Republic of Estonia, the Hellenic Republic, the Kingdom of Spain, the French Republic, the Republic of Croatia, the Italian Republic, the Republic of Latvia, the Republic of Lithuania, the Grand Duchy of Luxembourg, Hungary, Malta, the Kingdom of the Netherlands, the Republic of Austria, the Republic of Poland, the Portuguese Republic, the Republic of Slovenia, the Slovak Republic, the Republic of Finland and the Kingdom of Sweden, as well as Iceland, the Principality of Liechtenstein, the Kingdom of Norway and the Swiss Confederation.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32024D0210",
        },
        {
          // Romania: named in the quoted sentence.
          countryCode: "RO",
          joinedOn: "2024-03-31",
          sourceQuote:
            "From 31 March 2024, checks on persons at internal air and sea borders with and between Bulgaria and Romania shall be lifted and the provisions of the Schengen acquis referred to in the Annex shall apply to Bulgaria and Romania between themselves and in their relations with the Kingdom of Belgium, the Czech Republic, the Kingdom of Denmark, the Federal Republic of Germany, the Republic of Estonia, the Hellenic Republic, the Kingdom of Spain, the French Republic, the Republic of Croatia, the Italian Republic, the Republic of Latvia, the Republic of Lithuania, the Grand Duchy of Luxembourg, Hungary, Malta, the Kingdom of the Netherlands, the Republic of Austria, the Republic of Poland, the Portuguese Republic, the Republic of Slovenia, the Slovak Republic, the Republic of Finland and the Kingdom of Sweden, as well as Iceland, the Principality of Liechtenstein, the Kingdom of Norway and the Swiss Confederation.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32024D0210",
        },
        // ---- #331: Italy and Austria (from 2001-03-25) ----
        // Owner decision of 2026-11-15 ("add italy and austria with the 2001 date").
        // This supersedes the #322 note above saying Italy and Austria are not here.
        // Source: Council Decision 2000/777/EC, Article 1: the SAME quote, link and
        // date as the DK entry of the #322 group above, COPIED BY SCRIPT from that
        // entry (never retyped); a unit test checks they equal DK's.
        // Why this date: their own bringing-into-force decisions (SCH/Com-ex (97)
        // 27 and 28) are not published in the Official Journal. 25 March 2001 is
        // the EARLIEST date a published official sentence proves both were
        // applying the rules, by owner decision of 2026-11-15. Both joined
        // EARLIER: the quote lists Italy and Austria among the states already
        // applying the provisions ("in their relations between each other and
        // with ... Italy ... Austria ..."). Replace this date (and the quote and
        // link) if a published official sentence with their own start date is
        // found.
        {
          // Italy: named in the quoted sentence among the states already applying.
          countryCode: "IT",
          joinedOn: "2001-03-25",
          sourceQuote:
            "As from 25 March 2001, and subject to Article 3(2): (a) all the provisions of the Schengen acquis referred to in Annexes A, B, C and D to Council Decision 1999/436/EC of 20 May 1999 determining, in conformity with the relevant provisions of the Treaty establishing the European Community and the Treaty on European Union, the legal basis for each of the provisions or decisions which constitute the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Denmark, Finland and Sweden, in their relations between each other and with Belgium, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria and Portugal; (b) all the provisions referred to in Annexes A and B to the Agreement of 18 May 1999 concluded by the Council of the European Union, the Republic of Iceland and the Kingdom of Norway concerning the latters' association with the implementation, application, and development of the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Iceland and Norway, in their relations between each other and with Belgium, Denmark, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria, Portugal, Finland and Sweden.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32000D0777",
        },
        {
          // Austria: named in the quoted sentence among the states already applying.
          countryCode: "AT",
          joinedOn: "2001-03-25",
          sourceQuote:
            "As from 25 March 2001, and subject to Article 3(2): (a) all the provisions of the Schengen acquis referred to in Annexes A, B, C and D to Council Decision 1999/436/EC of 20 May 1999 determining, in conformity with the relevant provisions of the Treaty establishing the European Community and the Treaty on European Union, the legal basis for each of the provisions or decisions which constitute the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Denmark, Finland and Sweden, in their relations between each other and with Belgium, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria and Portugal; (b) all the provisions referred to in Annexes A and B to the Agreement of 18 May 1999 concluded by the Council of the European Union, the Republic of Iceland and the Kingdom of Norway concerning the latters' association with the implementation, application, and development of the Schengen acquis, and any act adopted by the Council establishing an instrument which has entered into force and constitutes a further development of one or more of these provisions, shall apply to Iceland and Norway, in their relations between each other and with Belgium, Denmark, Germany, Greece, Spain, France, Italy, Luxembourg, Netherlands, Austria, Portugal, Finland and Sweden.",
          sourceUrl: "https://publications.europa.eu/resource/celex/32000D0777",
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
      // #322: and the short-stay records of the twenty members added in #322,
      // same ids `<code>-visitor`, same rule: no fee of their own.
      inheritedBy: [
        { countryCode: "NL", visaTypeId: "nl-visitor" },
        { countryCode: "BE", visaTypeId: "be-visitor" },
        { countryCode: "DE", visaTypeId: "de-visitor" },
        { countryCode: "FR", visaTypeId: "fr-visitor" },
        { countryCode: "LU", visaTypeId: "lu-visitor" },
        { countryCode: "ES", visaTypeId: "es-visitor" },
        { countryCode: "PT", visaTypeId: "pt-visitor" },
        // #322: the twenty members added in #322, in the issue's order.
        { countryCode: "GR", visaTypeId: "gr-visitor" },
        { countryCode: "DK", visaTypeId: "dk-visitor" },
        { countryCode: "FI", visaTypeId: "fi-visitor" },
        { countryCode: "SE", visaTypeId: "se-visitor" },
        { countryCode: "IS", visaTypeId: "is-visitor" },
        { countryCode: "NO", visaTypeId: "no-visitor" },
        { countryCode: "CZ", visaTypeId: "cz-visitor" },
        { countryCode: "EE", visaTypeId: "ee-visitor" },
        { countryCode: "LV", visaTypeId: "lv-visitor" },
        { countryCode: "LT", visaTypeId: "lt-visitor" },
        { countryCode: "HU", visaTypeId: "hu-visitor" },
        { countryCode: "MT", visaTypeId: "mt-visitor" },
        { countryCode: "PL", visaTypeId: "pl-visitor" },
        { countryCode: "SI", visaTypeId: "si-visitor" },
        { countryCode: "SK", visaTypeId: "sk-visitor" },
        { countryCode: "CH", visaTypeId: "ch-visitor" },
        { countryCode: "LI", visaTypeId: "li-visitor" },
        { countryCode: "HR", visaTypeId: "hr-visitor" },
        { countryCode: "BG", visaTypeId: "bg-visitor" },
        { countryCode: "RO", visaTypeId: "ro-visitor" },
        // #331: Italy and Austria, same ids `<code>-visitor`, same rule: no fee
        // of their own.
        { countryCode: "IT", visaTypeId: "it-visitor" },
        { countryCode: "AT", visaTypeId: "at-visitor" },
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
