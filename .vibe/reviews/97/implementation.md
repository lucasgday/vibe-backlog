## Run 2026-03-02T12:51:18Z
- Scope: issue #97 (`feat(metrics): expose README workflow scaffold adoption signal in JSON output`).
- Changes:
  - Added `readme_workflow_status` to `VibeScaffoldUpdateResult` with enum values: `created`, `updated`, `unchanged`, `repaired`.
  - Updated README workflow upsert logic to return deterministic status across create/refresh/no-op/marker-repair scenarios.
  - Wired `applyVibeScaffoldUpdate` to expose the status in `update --json` payloads.
  - Added regression tests for all four status outcomes in `tests/cli-update.test.ts`.
  - Documented the new JSON field in README.
- Files:
  - `src/core/init.ts`
  - `tests/cli-update.test.ts`
  - `README.md`

## Run 2026-03-02T12:51:18Z
- run_id: issue-97-review-pass-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
No implementation defects found after adding `readme_workflow_status` plumbing and tests.

### Findings
- none

## Run 2026-03-02T12:55:10.143Z
- run_id: issue-97-review-pass-1
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
1 behavior-level issue found in the new status mapping for README workflow updates.

### Findings
- [P2] `readme_workflow_status` conflates first-time insertion with routine refresh (src/core/init.ts:503)
