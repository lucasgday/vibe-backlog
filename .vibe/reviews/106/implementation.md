## Run 2026-03-02T20:50:36Z
- Scope: issue #106 (`feat(init): make tracker bootstrap opt-in for external repos`) - incremental fix for managed snippet command path in external repos.
- Updated scaffold-managed AGENTS snippet generation in `src/core/init.ts`:
  - replaced `node dist/cli.cjs preflight` with `vibe preflight`
  - replaced `node dist/cli.cjs postflight`/`--apply` with `vibe postflight`/`--apply`
- This avoids false assumptions that every target repo has local `dist/cli.cjs`.
- Updated CLI tests to assert the new snippet contract (`tests/cli-init.test.ts`, `tests/cli-update.test.ts`).

## Run 2026-03-02T20:54:10.191Z
- run_id: pr-109-issue-106-attempt-1
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
The diff updates managed snippet wording to `vibe` commands, but the core `init` flow still runs tracker bootstrap by default, so the opt-in behavior in issue #106 is not implemented.

### Findings
- [P1] `init` still performs tracker bootstrap by default instead of opt-in (src/cli-program.ts:1868)

## Run 2026-03-02T20:57:28.634Z
- run_id: pr-109-issue-106-attempt-1-rerun
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
`init` now defaults to scaffold-only and requires explicit opt-in (`--bootstrap-tracker`) for tracker bootstrap; behavior matches issue intent.

### Findings
- none
