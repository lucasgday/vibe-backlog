# Security Pass

- No new dependency or secret-handling surface introduced.
- File writes are constrained to repo-local paths and idempotent create/upsert behavior.
- Tracker bootstrap still relies on authenticated `gh` context; `--skip-tracker` allows local-only init when network/auth is unavailable.
- Residual risk: AGENTS upsert appends managed snippet when markers are absent; behavior is intentional but should be visible in docs.
