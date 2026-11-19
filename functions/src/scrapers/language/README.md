# Language lexicons (`language/`; issue #220)

Language knowledge is DATA. One JSON file per language in `lexicons/`, found by
reading that folder: adding a language is adding a file, never a code branch
(`rubric-translation-firewall.test.ts` fails if code names a language). The
build copies the files next to the compiled code (`tsconfig.json` includes
`src/scrapers/language/lexicons/*.json`).

## What it is used for

`rubric-quote.ts` proves that everything a rule claims (a threshold, a unit, a
date, a number in a title) is written in the rule's own quote. The lexicon of the
SOURCE's language tells it how to read the quote: number words, month names, the
decimal and thousands separators, the shape of a date, the words that mean
"day / week / month / year", the words that name an appendix or part, the words
that start a legal reference ("Art. 12"). It holds only standard facts about the
language, never immigration content.

## File format (`<code>.json`, the file name equals `code`)

| field | meaning |
| --- | --- |
| `code` | two or three lower-case letters |
| `name` | the language's name (informational) |
| `isProductLanguage` | true on exactly ONE file: the language titles, questions and document names are written in, what a source with no declared language is read as, and the target of translations |
| `decimalSeparator` | one character, or `null` (only whole digits are read) |
| `thousandsSeparators` | list of one-character separators (groups of three); a character may not be both |
| `numberWords.units` / `tens` | lower-case word to value (0..19, or 0..29 with compound words; 20, 30 ...) |
| `numberWords.hundreds` | words that are themselves hundreds ("doscientos": 200); may open a group |
| `numberWords.scales` | multiplier words (`hundred` = 100 multiplies; 1000, 1000000 ... close a group) |
| `numberWords.scaleJoiners` | words that may join a scale to what follows ("hundred and fifty") |
| `numberWords.tensUnitsJoiners` / `tensUnitsNeedJoiner` | the word between a tens word and a unit ("treinta y cinco"); true when the language always writes it, so "tens unit" without it is two numbers |
| `numberWords.loneOneWords` | words for 1 that are also an article or pronoun: a number only before a duration word |
| `durationWords` | the words for day, week, month, year, in every form |
| `months` | lower-case name or abbreviation to 1..12 |
| `dateTemplates` | regular expressions (JSON-escaped) with the named groups `day`, `month`, `year` and the placeholder `{months}`; run on lower-cased, NFKC-folded text |
| `scopeWords` | the words that introduce an appendix or part ("Appendix", "Part") |
| `referenceWords` | the words that start a legal reference; `Word. 12` is then a reference label and a paragraph number |

A digit run in a shape the file does not list is UNREADABLE, and an unreadable
number is rejected, never guessed. Leave a word out when it is ambiguous (the
Spanish file explains three such choices).

## Adding a language

1. Copy `en.json` to `<code>.json` and fill every field from the language's
   standard grammar; no immigration terms.
2. Add readings tests next to `rubric-lexicon.test.ts` (numbers, dates, durations,
   separators, a reference shape, and what must be REJECTED).
3. Run the evaluation (`npm run evaluate:language`, see the script header) on a
   real official page and read the 20-rule sample sheet.
4. Only then does a person add the code to
   `appConfig/routeOnboardingSettings.supportedLanguages`. Until then a source in
   that language registers only if listed, and any version from it is held
   `language_not_supported`.

A file that fails validation (`lexiconProblems`) is not loaded at all: the
language is unavailable and read strictly, never half-loaded.
