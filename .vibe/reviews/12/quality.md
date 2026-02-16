# Quality Pass

- Added tests:
  - `tests/reviews.test.ts` (creation + idempotency/no-overwrite).
  - `tests/cli-turn.test.ts` (`turn start` creates turn context + review templates).
- Commands run:
  - `pnpm test`
  - `pnpm build`
- Result: all tests passing.
- Untested: real `gh` network execution path for `turn start` title lookup (mocked in tests).
