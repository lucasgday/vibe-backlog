## Run 2026-03-02T20:31:32Z
- Scope: issue #107 (`bug(pr): rationale sections remain generic in some PRs`).
- Updated rationale generation in `src/core/pr-rationale.ts` to make `Why` and `Alternatives` sections explicitly evidence-driven for non-fallback scenarios.
- Replaced generic boilerplate lead bullets with PR-specific context fields (profile/modules/signal evidence from changed files).
- Preserved deterministic/fallback behavior when changed-file signals are unavailable.
