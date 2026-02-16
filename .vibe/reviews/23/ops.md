# Ops/Release Pass

- CLI surface changed: new `tracker bootstrap` command and preflight hint branch.
- Execution remains repo-local compatible (`node dist/cli.cjs ...`).
- No new dependencies introduced; release risk is low and isolated to command output + GitHub API flow.

## Update 2026-02-16 (pagination fix)
- CLI tracker bootstrap is now resilient for repos with large label sets.
- No release/process changes required; behavior remains idempotent.
