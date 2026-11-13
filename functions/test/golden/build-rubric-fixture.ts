// ============================================
// Golden set — build the Standard Visitor rubric FIXTURE (issue #35)
// ============================================
//
//   node --import tsx test/golden/build-rubric-fixture.ts <path-to-extracted-draft.json>
//
// Reads the locally exported EXTRACTED DRAFT of the Standard Visitor rubric
// (276 criteria, review status `pending_review`, never approved) and writes a
// REDUCED copy into `fixtures/rubrics/gb-standard-visitor.draft-subset.json`.
//
// Why reduce: every recorded request lists the rubric's judgement criteria and
// asks the model to read the fields of every objective check. The full draft
// (203 judgement criteria, ~60 document fields, most of them about routes and
// activities that no seed applicant touches) would make each recording huge and
// each live refresh expensive. A small subset keeps the corpus cheap to
// re-record and its expected labels easy to review.
//
// How it is reduced: ONLY through the product's own `applyExclusions` (the
// same function the approval step uses). Nothing is hand-edited: no quote, no
// check, no title, no criterion is added or changed. The kept ids are listed
// below and recorded in the fixture's `_fixture.keptCriterionIds`, so a
// reviewer can see exactly what was kept. Mandatory bars are never excluded
// (applyExclusions refuses to), so both bars of the draft are in the subset.
//
// Two things are written that are NOT in the draft, both marked in `_fixture`:
//   - `intentPolarity` is set to the extractor's own PROPOSAL
//     (`intentPolarityProposal.value`). In the draft it is null (no admin has
//     decided it); without a value the intent criteria could never be exercised.
//     It is test data, not an admin decision.
//   - the discarded-criteria log is dropped (100 KB of review aid, unused).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyExclusions } from "../../src/scrapers/rubric/rubric-exclusions";
import type { VisaRubric } from "../../src/types/rubric";

/**
 * The criteria KEPT, by id, grouped by the Appendix V paragraph (or guidance
 * section) they exercise. Everything else in the draft is excluded.
 */
export const KEPT_CRITERION_IDS: Record<string, string[]> = {
  // V 4.2(a)-(e): the genuine-visitor factors and sufficient funds.
  "V 4.2(a)-(e)": ["crit_933b17521a137e13", "crit_a1953936aa9bb049", "crit_e15f6548bcd161d4", "crit_59f00013daef496c", "crit_5175afe9469a7d4c"],
  // V 4.3(a)-(c): the three third-party conditions.
  "V 4.3(a)-(c)": ["crit_b4324d35a09ca6ea", "crit_20ab5662fabb4db1", "crit_5ffc37848994f6c1"],
  // V 4.4(a): must not intend to work.
  "V 4.4(a)": ["crit_8ab7173ebc0de0c7"],
  // Visit guidance 7.2 / 7.3 / 7.4 / 7.5: history, ties, travel pattern, first-time travellers, deception.
  "Guidance 7.x": [
    "crit_bdcc89356811795c", "crit_2d31cb96e73e420b", "crit_7256046bc8894bc6", "crit_77c35c7610d721b5", "crit_204d86052fe47168",
    "crit_aa2be985d797c90c", "crit_e11e1bd8bf2c3f4d", "crit_52a33245bfca81a7", "crit_294206ebcab3a49e", "crit_82884e5d69bb3ccf", "crit_1597dbd5e344983a",
  ],
  // Visit guidance 8.1 / 8.2: funds factors and third-party support.
  "Guidance 8.x": [
    "crit_a6efd28d5c5e8b21", "crit_c832ab9cd1a8bc8b", "crit_01aa3b76aa14511b", "crit_aadfe74b10983a2c", "crit_c710077a5986e35b", "crit_3e0fc62a83fc412c", "crit_2456f6f820599e2a",
  ],
  // The four OBJECTIVE checks kept: funds held in a permitted institution (V 8.1),
  // electronic record keeping (FIN 2.1(c)), overdraft not counted (FIN 3.1) and
  // the dating of the most recent evidence (FIN 7.1). Mandatory bars are not
  // listed: they cannot be excluded.
  "Objective checks": ["crit_47fc4bc353520e7e", "crit_bbcbf75eca0a33ea", "crit_0179e361d0b306e4", "crit_eb69a8754bd82075"],
};

/** Where the fixture is written (relative to functions/). */
export const RUBRIC_FIXTURE_PATH = "test/golden/fixtures/rubrics/gb-standard-visitor.draft-subset.json";

/** Build the reduced fixture from the extracted draft and return it. */
export function buildFixture(draftPath: string): Record<string, unknown> {
  const exported = JSON.parse(readFileSync(draftPath, "utf8")) as { versions: Array<VisaRubric & Record<string, unknown>> };
  const draft = exported.versions[0];
  const kept = new Set(Object.values(KEPT_CRITERION_IDS).flat());
  const known = new Set(draft.criteria.map((c) => c.criterionId));
  const missing = [...kept].filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`kept ids not in the draft: ${missing.join(", ")}`);

  // Exclude everything not kept. Mandatory bars are skipped by applyExclusions itself.
  const excludedCriterionIds = draft.criteria.filter((c) => !kept.has(c.criterionId) && c.kind !== "mandatory_bar").map((c) => c.criterionId);
  const reduced = applyExclusions({ ...draft, excludedCriterionIds }) as VisaRubric & Record<string, unknown>;
  const keptIds = new Set(reduced.criteria.map((c) => c.criterionId));

  const proposal = (draft.intentPolarityProposal as { value?: string } | null) ?? null;
  const { discarded: _discarded, ...rest } = reduced as Record<string, unknown>;
  void _discarded;
  return {
    _fixture: {
      notice: "EXTRACTED DRAFT, NOT APPROVED, TEST DATA ONLY. Do not treat anything in this file as the approved rules of any route.",
      source: "local draft 3 of the Standard Visitor rubric (#112), review status pending_review, 276 criteria",
      reducedWith: "applyExclusions (src/scrapers/rubric/rubric-exclusions.ts); no quote, check or title edited, no criterion added",
      builtBy: "test/golden/build-rubric-fixture.ts",
      keptCriterionIds: [...keptIds],
      keptByParagraph: KEPT_CRITERION_IDS,
      intentPolarityNote: "intentPolarity is the extractor's PROPOSAL, set for test purposes; the draft has null (no admin decision).",
    },
    ...rest,
    intentPolarity: proposal?.value ?? null,
    discardedCount: 0,
    discarded: [],
    // Review flags that point at a criterion no longer in the subset are dropped.
    flags: ((draft.flags as Array<{ target?: string }>) ?? []).filter((f) => !f.target || keptIds.has(f.target)),
  };
}

// Run as a script only (the gate imports KEPT_CRITERION_IDS, never runs this).
if (require.main === module) {
  const draftPath = process.argv[2];
  if (!draftPath) {
    console.error("usage: node --import tsx test/golden/build-rubric-fixture.ts <path-to-extracted-draft.json>");
    process.exit(2);
  }
  const out = buildFixture(draftPath);
  writeFileSync(resolve(process.cwd(), RUBRIC_FIXTURE_PATH), JSON.stringify(out, null, 1) + "\n");
  const r = out as unknown as VisaRubric;
  console.log(`wrote ${RUBRIC_FIXTURE_PATH}: ${r.criteria.length} criteria, ${r.intakeQuestions.length} intake questions, ${r.evidenceItems.length} evidence items`);
}
