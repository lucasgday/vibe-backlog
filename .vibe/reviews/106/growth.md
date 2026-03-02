## Run 2026-03-02T20:50:36Z
Growth pass:
- This change reduces onboarding friction in external repos by removing an invalid default path (`dist/cli.cjs`) from generated guidance.
- Expected impact: fewer false starts and less unnecessary bootstrap work when users only need to run `vibe` commands.

## Run 2026-03-02T20:54:10.193Z
- run_id: pr-109-issue-106-attempt-1
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
The change likely reduces onboarding friction, but there is still no instrumentation to verify activation impact.

### Findings
- [P3] No measurable signal for `init` activation vs tracker-bootstrap friction (src/cli-program.ts:1850)
