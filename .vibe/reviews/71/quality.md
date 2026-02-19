## 2026-02-19 Quality Pass (issue #71)

What I tested:
- `pnpm test -- tests/branch-cleanup.test.ts tests/cli-branch-cleanup.test.ts`
- `pnpm test`
- `pnpm build`

Coverage added:
- Core cleanup:
  - auto-delete `pr-merged` on merged PR head match
  - skip with explicit reason on merged PR head mismatch
  - warning-only fallback on gh lookup failure
- CLI/reporting:
  - `pr-merged` category appears in dry-run output.

What remains untested:
- Live GitHub API behavior under rate limiting; mocked command responses cover control flow only.
