# Quality Pass

- Added `tests/cli-status.test.ts` covering:
  - status output with ongoing issues + hygiene warnings + active issue labels + branch PRs
  - preflight ongoing/hygiene sections
  - no-network fallback behavior
- Updated `tests/cli-tracker.test.ts` preflight mock for the new issue-list query shape.
- Validation commands run:
  - `pnpm test` (pass)
  - `pnpm build` (pass)
