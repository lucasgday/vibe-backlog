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
