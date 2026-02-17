# Implementation Pass

## Scope
- Implement portable security scanning via `vibe security scan` for repos that use `.vibe`.
- Keep `preflight` non-blocking while surfacing scanner readiness and latest scan outcome.
- Add CI workflow only for this repository.

## Changes
- Added `src/core/security-scan.ts` with:
  - gitleaks availability probe,
  - policy resolution (`flag > .vibe/contract.yml > default warn`),
  - mode mapping (`staged`, `working-tree`, `history`),
  - scan execution semantics and exit-code policy,
  - runtime persistence in `.vibe/runtime/security-scan.json`.
- Updated `src/cli-program.ts`:
  - new command `vibe security scan` (`--mode`, `--policy`, `--dry-run`),
  - preflight integration with `Security scan` snapshot output.
- Updated scaffold defaults in `src/core/init.ts` to include `security.gitleaks.policy: warn`.
- Exported security scan module in `src/core/index.ts`.
- Added repository config in `.vibe/contract.yml` with `security.gitleaks.policy: warn`.
- Added CI workflow `.github/workflows/gitleaks.yml` using fail policy on PR/main/manual runs.
- Updated docs in `README.md` and `.github/CI_SECURITY.md`.

## Run 2026-02-17T20:42:00Z
- issue: #47
- branch: codex/issue-47-gitleaks-security-scan
- findings: 0

### Summary
Implementation delivers issue scope end-to-end: portable local scan command plus non-blocking preflight visibility, and CI enforcement in this repo without coupling workflow scaffolding to `vibe init`.

### Findings
- none
