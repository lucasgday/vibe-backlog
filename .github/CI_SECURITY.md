# CI Security Policy (Logs + Artifacts)

This policy applies to all workflows in this repository.

## Artifact Policy

- Upload only minimal outputs required for debugging or release evidence.
- Set short retention by default (`retention-days: 3` to `7`).
- Never upload secrets, environment files, credential stores, or full workspace snapshots.
- Never upload `.env*`, `*.pem`, `*.key`, `.vibe/runtime`, `.vibe/artifacts`, or package manager caches.
- Prefer explicit include lists over broad globs.

## Logs Policy

- Do not print secrets, tokens, headers, cookies, or full environment variables.
- Avoid `set -x` in jobs that may touch credentials; if needed, disable before sensitive steps (`set +x`).
- Mask dynamic sensitive values with workflow commands (`::add-mask::`).
- Avoid verbose flags that may print auth material (for example curl/http debug modes).
- Use least-privilege workflow/job permissions.

## CI Secret-Safe Checklist

- [ ] Workflow permissions are scoped to minimum required.
- [ ] Secrets are consumed only where needed and never echoed.
- [ ] No step dumps full environment/context to logs.
- [ ] Artifact paths are explicit and exclude sensitive files.
- [ ] Artifact retention is short and justified.
- [ ] Secret scan runs (for example gitleaks) in CI before publish/release.
