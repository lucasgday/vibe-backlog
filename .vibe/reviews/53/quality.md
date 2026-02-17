# Quality Pass

## What I tested
- `pnpm test`
- `pnpm build`
- `node dist/cli.cjs preflight`

## Coverage added/updated
- Updated `tests/review-pr.test.ts`:
  - policy key generation,
  - summary policy marker emission,
  - compatibility behavior for legacy head-only marker,
  - mismatch behavior when policy marker exists.
- Updated `tests/cli-pr-open.test.ts`:
  - dedupe with matching policy marker,
  - rerun on policy mismatch,
  - forced rerun via `--force-review`,
  - conflict guard `--skip-review-gate` + `--force-review`.
- Added `tests/review-threads.test.ts`:
  - dry-run planning,
  - single-thread reply+resolve,
  - missing-thread failure reporting,
  - resolve-mutation failure path.
- Added `tests/cli-review-threads.test.ts`:
  - target mode validation,
  - dry-run behavior,
  - partial-failure non-zero exit,
  - single-thread apply path.

## Remaining untested
- Live GitHub GraphQL interaction against real PR threads (local tests use mocked gh responses).

## Summary
Coverage is strong for both new capabilities and critical edge-cases (policy mismatch, force path, batch/single thread modes, and failure reporting).

## Findings
- none
