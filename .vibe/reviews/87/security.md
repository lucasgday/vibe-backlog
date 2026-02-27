# Security Pass

## Run 2026-02-27T10:40:00Z
- run_id: manual-issue-87-security
- findings: 0

### Summary
Pending review cleanup is scoped to the authenticated actor (`gh api user` + `state=PENDING`) to avoid deleting drafts from other collaborators. Cleanup failures are non-fatal and do not block the review workflow, reducing risk of availability regressions while preserving safe defaults.

### Findings
- none
