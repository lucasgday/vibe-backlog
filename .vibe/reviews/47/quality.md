# Quality Pass

## What I tested
- `pnpm test`
- `pnpm build`
- `node dist/cli.cjs preflight`
- `node dist/cli.cjs security scan --mode staged`
- `node dist/cli.cjs security scan --mode history --policy fail --dry-run`

## Coverage added/updated
- Added `tests/security-scan.test.ts`:
  - policy resolution precedence,
  - mode-to-command mapping,
  - missing scanner behavior (`warn` vs `fail`),
  - findings behavior (`warn` vs `fail`),
  - runtime record read/write and malformed record handling.
- Added `tests/cli-security.test.ts`:
  - default dry-run command behavior,
  - invalid flag validation,
  - fail policy when scanner missing,
  - warn mode with findings.
- Updated `tests/cli-status.test.ts`:
  - preflight now prints `Security scan` section,
  - non-blocking behavior when probe fails.
- Updated `tests/cli-init.test.ts`:
  - scaffold contract now includes `security.gitleaks.policy: warn`.

## Remaining untested
- End-to-end GitHub Actions execution of `.github/workflows/gitleaks.yml` is not executed locally in this turn.

## Run 2026-02-17T20:42:00Z
- issue: #47
- findings: 0

### Summary
Test coverage is strong for core policy/scan logic and CLI integration, including failure-path and non-blocking preflight guarantees.

### Findings
- none
