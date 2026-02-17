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
