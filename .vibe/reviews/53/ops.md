# Ops Pass

## Operational readiness
- Changes are additive and scoped to CLI/review flow.
- No migration required for existing PRs: legacy summary markers remain valid.
- New helper command is optional and does not affect existing `review`/`postflight` flows.

## Determinism and observability
- Dedupe uses explicit markers in PR comments (`review-summary`, `review-head`, optional `review-policy`).
- `review threads resolve` returns deterministic counters and per-thread status (`planned/replied/resolved/skipped/failed`).

## Rollout notes
- Recommend documenting team usage:
  - normal flow: `commit -> vibe review -> vibe pr open --skip-review-gate` when same HEAD already reviewed,
  - recovery flow: `vibe pr open --force-review` to force rerun.

## Summary
Operational impact is low-risk and improves day-to-day workflow efficiency without breaking existing project state.

## Findings
- none
