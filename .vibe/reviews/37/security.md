# Security Pass

## Threat Model Quick Scan
- Risk: accidental deletion of active or important local branches.
  - Mitigation: protected branch set always excludes current branch, `main`, and base branch.
- Risk: destructive deletion of non-merged work.
  - Mitigation: non-merged branches are never auto-deleted; explicit `--force-unmerged --yes` is required.
- Risk: cleanup failure interrupting tracker sync workflow.
  - Mitigation: postflight path downgrades cleanup failures to warnings and continues.

## Concrete Checks
- Auth/Authz: no auth boundary changes.
- Input validation: explicit validation for `--force-unmerged` requiring `--yes`.
- Data exposure: no new sensitive output surfaces.
- Secure defaults: conservative behavior for non-merged branches and fetch-prune failures.

## Run 2026-02-17T15:52:30Z
- issue: #37
- findings: 0

### Summary
No security regressions identified. The cleanup logic uses safe-by-default semantics and explicit operator confirmation for risky deletion paths.

### Findings
- none

## Run 2026-02-17T19:03:20.851Z
- run_id: issue-37-pr-49-attempt-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
No direct security vulnerabilities found in authz/input/data-exposure surfaces for this diff; guardrails for destructive paths are present (`--force-unmerged` requires `--yes`).

### Findings
- none
