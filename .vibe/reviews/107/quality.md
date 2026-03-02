## Run 2026-03-02T20:31:32Z
What I tested:
- Updated `tests/pr-rationale.test.ts` assertions to enforce non-boilerplate behavior in non-fallback contexts.
- Added expectations that `why`/`alternatives` include concrete evidence/profile references in code-only and deps-only scenarios.
- Ran full repository test suite and build.

Commands:
- `pnpm test`
- `pnpm build`

Untested:
- Live GitHub PR body rendering outside mocked/local test flows.
