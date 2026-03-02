## Run 2026-03-01T23:07:40Z
What I tested:
- Added deterministic unit coverage for rationale debug extraction in CLI-heavy/docs-only contexts plus fallback reason assertions.
- Added CLI tests for `pr open --rationale-signals-json` and `review --rationale-signals-json` output wiring.
- Ran full test suite and build.

Commands:
- `pnpm test -- tests/pr-rationale.test.ts tests/cli-pr-open.test.ts tests/cli-review.test.ts`
- `pnpm test`
- `pnpm build`

Untested:
- Live GH/real-repo rationale debug output outside mocked CLI tests.

## Run 2026-03-01T23:11:44.756Z
- run_id: issue-85-pr-93-attempt-1
- attempt: 1/5
- findings: 1
- autofix_applied: yes

### Summary
Found 1 quality gap in machine-readable contract stability.

### Findings
- [P2] Machine-readable debug output lacks explicit schema contract/versioning (README.md:280)

## Run 2026-03-01T23:15:10Z
What I tested:
- Verified rationale debug output now includes schema version and final review findings summary.
- Verified no regression in `pr open`/`review` option behavior and rationale tests.
- Re-ran full suite/build.

Commands:
- `pnpm test -- tests/pr-rationale.test.ts tests/cli-pr-open.test.ts tests/cli-review.test.ts tests/review-pr.test.ts`
- `pnpm test`
- `pnpm build`

## Run 2026-03-01T23:16:05.585Z
- run_id: issue-85-pr-93-attempt-1b
- attempt: 1/5
- findings: 0
- autofix_applied: yes

### Summary
Contract/versioning and test coverage for rationale debug output are now adequate for this scope.

### Findings
- none
