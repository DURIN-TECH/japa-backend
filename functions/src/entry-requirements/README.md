# Entry requirements: "do you need a visa at all" (issue #236, P7 of #228)

Before an application starts, the app answers "do I need a visa for this
destination?" from **official sources only**. With no source it says it does
not know. Seli never answers "visa required" (or "no visa needed") by default.

## Data (all backend-only: no `firestore.rules` match)

| Collection | What |
|---|---|
| `entryRules/{ruleId}` | One sourced rule: `issuingAuthorityId`, `destination` (listed codes or `members_of` an authority), `outcome` (`visa_required`, `visa_free`, `visa_on_arrival`, `travel_authorisation`, `transit_visa`, `transit_free`), `group` (coded members as in P5 plus `uncoded` names), optional `maxStayDays` / `stayPeriodDays` / `purposes` / `authorisationName` / `notAVisa` / `applyUrl` / `fee` (source currency + quote), `conditions` (verbatim), `quote`, `url`, `listItems`, `sourceId`, `contentHash`, `fetchedAt`, `publishedAt`, `status`. The store refuses a rule without a quote and an https URL (`entry-rule-validate.ts`). |
| `entryRuleHeads/{authorityId}` | Which drafting run is served (`publishedRunId`); switching it is the atomic publish. Also the authority's registered entry pages (`sourceUrls`), the link of an `unknown` answer. |
| `entryRuleRuns/{runId}` | One record per drafting run: status, reasons, gates, spend, counts, refusals. The admin's review data. |

Indexes: `firestore.indexes.json` (`entryRules`: `destinationCodes` contains + `status`, and the equality pairs).

## Lookup: `GET /entry-requirements` (signed in, free, rate limited)

Stored data only, no AI call, so it is free for everyone signed in. Query:
`destination` (required), `nationality` (comma list), `residence`, `holds`
(`kind:issuer:YYYY-MM-DD`, comma list; the date is required so an expired
document never matches), `purpose`, `stayDays`, `useMyHoldings=true` (fills
what the query leaves out from the CALLER's own holdings). Answer:
`{ status: "answer", outcome, message, stay, conditions, sources, rules, disagree, mightAlsoApply, authorisation }`
or `{ status: "unknown", code, reason, needs?, destinationAuthorityPage?, mightApply? }`.
Rules: `entry-requirements-answer.ts` (strictest first; a stricter rule that
needs a missing fact gives `unknown`; a rule on a changed or old page is
`stale`; transit outcomes answer a transit only).

`POST /eligibility/pre-check` answers from the same lookup (`visaRequired`
is `null` when unknown).

Admin review (read-only, no screen): `GET /admin/entry-rules?authorityId=&status=`,
`GET /admin/entry-rules/runs?authorityId=`.

## Drafting (paid AI): `npm run draft:entry-rules`

```
npm run draft:entry-rules -- --project <id> --authority <id> --sources <sourceId,...> [--no-write]   # --no-write still makes the PAID model calls; there is no free dry run
```

Needs first: the authority (a country code, or an active bloc/treaty with
members), its website confirmed for it (`officialDomains`), the pages
registered as its guidance sources (`jurisdiction` = authority id, active) and
crawled once (a stored snapshot). Publishing needs
`appConfig/rubricPublishSettings.mode = "auto"` and, with an allowlist,
`{authorityId}_entry-requirements` on it; otherwise the run is held.

Pipeline (`entry-rule-pipeline.ts`): settings and caps before any spend (the
rulebook extraction kill switch and caps, the checker caps, runs per day) ->
sources and language gate -> draft per chunk (`judgement`) -> code checks
against the stored page (`entry-rule-draft.ts`: verbatim quote, numbers and
names in the quote, "not a visa" only from the page, list lines read by code in
full) -> list lines coded (`judgement`; no code = `uncoded`) -> independent
check (`verification`; every aspect `yes`, codes confirmed or kept uncoded)
-> gates (`entry-rule-gates.ts`: mode, allowlist, rules kept, leave-out budget,
shrink guard) -> one store write.

Prompt versions: drafting and list coding `entry-rules-2026-11-14.1`
(`ENTRY_RULE_PROMPT_VERSION`), check `entry-check-2026-11-14.1`
(`ENTRY_CHECK_PROMPT_VERSION`). The rulebook prompts are not used or changed.
