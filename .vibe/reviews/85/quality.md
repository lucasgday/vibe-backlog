## Run 2026-03-01T23:07:40Z
What I tested:
- Added deterministic unit coverage for rationale debug extraction in CLI-heavy/docs-only contexts plus fallback reason assertions.
- Added CLI tests for `pr open --rationale-signals-json` and `review --rationale-signals-json` output wiring.
- Ran full test suite and build.

Commands:
- `pnpm test -- tests/pr-rationale.test.ts tests/cli-pr-open.test.ts tests/cli-review.test.ts`
- `pnpm test`
- `pnpm build`

Untested:
- Live GH/real-repo rationale debug output outside mocked CLI tests.
