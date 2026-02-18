# Implementation Pass

## Scope
- Issue #28: semantic, repo-agnostic milestone inference/creation assignment.
- Explicitly out of scope: `en foco/fuera de foco` state logic.

## What changed
- Centralized semantic milestone helpers and reconcile creation flow in `/Users/lucasgday/code/codex/vibe-backlog/src/core/tracker.ts`.
- Updated `/Users/lucasgday/code/codex/vibe-backlog/src/cli-program.ts`:
  - `tracker bootstrap` no longer creates hardcoded milestones.
  - `preflight` prints milestone suggestions in read-only mode.
- Updated follow-up issue flow in `/Users/lucasgday/code/codex/vibe-backlog/src/core/review-pr.ts` to reuse semantic tracker logic and create milestone when missing.
- Updated docs/policy in `/Users/lucasgday/code/codex/vibe-backlog/README.md`, `/Users/lucasgday/code/codex/vibe-backlog/AGENTS.md`, and `/Users/lucasgday/code/codex/vibe-backlog/src/core/init.ts`.

## Commands run
- `pnpm test`
- `pnpm build`
- `node dist/cli.cjs preflight`
- `node dist/cli.cjs tracker reconcile --dry-run`

## Result
- Milestone assignment is now semantic and repo-agnostic.
- Creation is restricted to write paths (`tracker reconcile` and issue creation flows), while `preflight` stays non-mutating.

## Residual risk
- Heuristic title generation can still produce occasional broad milestone titles for sparse issue text.

## Findings
- none
