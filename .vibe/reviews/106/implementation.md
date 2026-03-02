## Run 2026-03-02T20:50:36Z
- Scope: issue #106 (`feat(init): make tracker bootstrap opt-in for external repos`) - incremental fix for managed snippet command path in external repos.
- Updated scaffold-managed AGENTS snippet generation in `src/core/init.ts`:
  - replaced `node dist/cli.cjs preflight` with `vibe preflight`
  - replaced `node dist/cli.cjs postflight`/`--apply` with `vibe postflight`/`--apply`
- This avoids false assumptions that every target repo has local `dist/cli.cjs`.
- Updated CLI tests to assert the new snippet contract (`tests/cli-init.test.ts`, `tests/cli-update.test.ts`).
