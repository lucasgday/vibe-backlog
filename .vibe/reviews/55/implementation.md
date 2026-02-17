# Implementation Pass

## Scope
- Resolve follow-up findings from issue #55 on PR #54.

## Changes
- Updated `src/core/review-pr.ts`:
  - hardened mixed-marker gate logic so legacy head-only comments cannot bypass policy mismatch when policy markers coexist for the same HEAD.
- Updated `src/core/review-threads.ts`:
  - removed hard dependency on current branch when `--pr <n>` is provided.
- Updated tests:
  - `tests/review-pr.test.ts`: added mixed legacy+policy coexistence regression.
  - `tests/review-threads.test.ts`: verifies no branch lookup when `prNumber` is explicit.
  - `tests/cli-review-threads.test.ts`: CLI regression for explicit `--pr` without branch dependency.

## Summary
All three findings from #55 are addressed in code and tests.

## Findings
- none
