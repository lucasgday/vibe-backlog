# Growth Pass

## Run 2026-03-02T11:16:56Z
- run_id: manual-issue-22-growth
- findings: 0

### Summary
Providing a standard workflow diagram directly in scaffolded READMEs should reduce onboarding confusion and improve adoption in external repos using `.vibe`. A practical follow-up is making the diagram shape configurable for teams with customized workflows while keeping managed markers stable.

### Findings
- none

## Run 2026-03-02T11:18:28.418Z
- run_id: issue-22-pr-96-attempt-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
Scaffolded workflow docs should improve activation by reducing setup ambiguity in external repos. No blocking growth regressions identified in this implementation.

### Findings
- none

## Run 2026-03-02T11:25:05.791Z
- run_id: issue-22-pr-96-attempt-1b
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
The fix improves trust in scaffold updates by avoiding unintended README rewrites, which reduces adoption friction for external repos using `.vibe`.

### Findings
- none

## Run 2026-03-02T11:35:21.612Z
- run_id: issue-22-pr-96-attempt-1-codex-review
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
The feature likely improves onboarding, but impact cannot currently be measured.

### Findings
- [P3] No measurable activation signal for README workflow scaffold adoption (src/core/init.ts:447)
