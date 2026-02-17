# Security Pass

- The guard reduces workflow risk that can introduce unintended changes from stale/diverged bases.
- It enforces safer defaults by failing closed on known high-risk git states (behind/diverged/upstream-gone/closed-or-merged PR branch reuse).
- PR-state check is read-only and best-effort; guard logic does not expose tokens/secrets and does not persist remote metadata.
- Residual risk: if `gh` is unavailable, PR-state verification is skipped, so only git-based checks remain active.
