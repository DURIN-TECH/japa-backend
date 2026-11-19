# Outcome statistics importer (issue #116)

Imports a government's PUBLISHED decision statistics (granted / refused / other,
per published visa category and nationality, latest four quarters) so the
assessment can attach a "country context" note. Figures are stored as published,
with source URL, table, period and retrieval date. Nothing is estimated.

- Generic contract: `outcome-source-adapter.ts`. One adapter per destination,
  registered in `registry.ts`. Only `adapters/uk-home-office/` knows the UK.
- `xlsx-stream.ts`: streaming .xlsx reader (zip directory + SAX), so a 31 MB
  workbook with ~300 MB of sheet XML is never held in memory.
- `outcome-aggregate.ts`: pure sums + grant rate = granted / (granted + refused).
- `outcome-import.service.ts`: find release -> skip if unchanged (URL, then
  SHA-256) -> download -> validate headers -> read -> write under a new
  releaseId -> flip `outcomeStatisticsReleases/{destination}` LAST (no partial
  replace) -> delete the previous release. Every attempt writes an
  `outcomeStatisticsRuns` record.
- Admin: `GET/POST /admin/outcome-statistics/runs` (admin-only; no route returns
  statistics). Schedule: `importOutcomeStatistics` (Mondays 05:00 UTC in
  Feb/May/Aug/Nov); manual: `processOutcomeStatisticsRunRequest`.
- Read side (outside this folder): `src/services/outcome-statistics/`
  (`getCurrentStatistic`, `buildCountryContext`).
