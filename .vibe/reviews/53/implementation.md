# Implementation Pass

## Scope
- Avoid redundant `vibe review` reruns in `pr open` by honoring HEAD + policy markers.
- Add `vibe review threads resolve` helper for reply+resolve operations (single/batch).

## Changes
- Extended review markers in `src/core/review-pr.ts`:
  - added policy marker support (`<!-- vibe:review-policy:<key> -->`),
  - added `buildReviewPolicyKey(...)` (stable v1 key),
  - extended `buildReviewSummaryBody(...)` and `hasReviewForHead(...)` with progressive compatibility.
- Updated `src/core/review.ts`:
  - computes effective policy key from runtime review profile,
  - publishes summary marker with policy key.
- Updated `src/cli-program.ts`:
  - `vibe pr open --force-review`,
  - conflict guard for `--skip-review-gate` + `--force-review`,
  - gate check now uses HEAD + policy key (legacy head-only comments still valid),
  - added `vibe review threads resolve` subcommand.
- Added `src/core/review-threads.ts`:
  - GraphQL thread listing with pagination,
  - target selection by `--thread-id` or `--all-unresolved`,
  - reply + resolve mutations,
  - detailed auto-body generation,
  - dry-run planner and per-thread structured results.
- Exported new module in `src/core/index.ts`.

## Summary
Implementation is complete and aligned with issue scope: dedupe is now policy-aware and backward compatible, and thread resolution is available as a deterministic CLI helper.

## Findings
- none

## Run 2026-02-17T22:28:55.146Z
- run_id: issue-53-pr-54-attempt-1
- attempt: 1/5
- findings: 2
- autofix_applied: no

### Summary
Core scope is implemented, but two correctness regressions remain in policy-aware dedupe and explicit-PR thread resolution flow.

### Findings
- [P2] Policy-aware gate can be bypassed by legacy summary comments (src/core/review-pr.ts:466)
- [P2] `review threads resolve --pr <n>` still hard-depends on current branch (src/core/review-threads.ts:471)

## Run 2026-02-17T22:35:31.966Z
- run_id: issue-53-pr-54-attempt-1-rerun
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
The two previously reported P2 implementation defects are addressed: policy-aware gate now handles mixed legacy+policy markers safely, and explicit `--pr` thread resolution no longer depends on current branch state.

### Findings
- none
