## Run 2026-03-02T20:50:36Z
What I tested:
- Updated tests to verify managed snippet uses `vibe preflight` and `vibe postflight` commands.
- Ran repository test suite and build.

Commands:
- `pnpm test -- tests/cli-init.test.ts tests/cli-update.test.ts`
- `pnpm test`
- `pnpm build`

Untested:
- Manual execution in an external repo during this pass (recommended as follow-up smoke check).
