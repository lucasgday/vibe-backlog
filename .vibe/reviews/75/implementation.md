# Implementation Pass

## Scope
- Issue: #75
- Goal: enforce `gh issue create --body-file` as the canonical issue-creation path.

## Checklist
- [x] Diff kept focused to issue scope
- [x] Behavior changes documented
- [x] Follow-up work listed (if any)

## Notes
- Centralized issue creation into `src/core/gh-issue.ts` via `createIssueWithBodyFile`.
- Migrated follow-up issue creation in `src/core/review-pr.ts` to use the shared helper.
- Added regression tests for `--body-file` usage and temp-file cleanup success/failure paths.
- Added README policy note to keep the behavior explicit.

## Run 2026-02-19T19:32:52Z
- run_id: issue-75-local-pass-1
- attempt: 1/1
- findings: 0
- autofix_applied: no

### Summary
The implementation is scoped to policy enforcement and extracts issue creation into one helper to reduce future regressions.

### Findings
- none

## Run 2026-02-19T19:36:32.845Z
- run_id: issue-75-pr-76-attempt-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
Centralization is correctly applied: follow-up issue creation now delegates to a single helper and behavior remains equivalent to the previous flow.

### Findings
- none
