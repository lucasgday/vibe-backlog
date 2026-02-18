## 2026-02-18 Implementation Pass (issue #56)

- Added new read-only merge-readiness flow in `src/core/pr-ready.ts`.
- Added `vibe pr ready` in `src/cli-program.ts` with options:
  - `--pr <n>`
  - `--branch <name>`
  - `--refresh`
  - `--wait-seconds <n>`
- Implemented readiness checks:
  - target PR resolution (explicit PR or branch lookup)
  - PR is `OPEN`
  - PR is not draft
  - `mergeStateStatus=CLEAN` (with optional polling for `UNKNOWN`)
  - remote branch head (`git ls-remote`) equals `headRefOid`
  - review marker exists for current head and policy
- Added deterministic remediation command output for stale/unknown/desync cases.
- Added success freeze guidance to prevent late head mutations before merge.
- Exported `pr-ready` from `src/core/index.ts`.
- Reused shared review-gate policy key via exported constant in `src/core/review-pr.ts`.
- Updated docs in `README.md` with command reference and canonical usage examples.

## Run 2026-02-18T14:21:11.004Z
- run_id: review-56-attempt1-20260218T1121Z
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
Core merge-readiness flow is well-structured, but there is one reliability defect in error handling for remote-head resolution.

### Findings
- [P2] `pr ready` hard-fails on `git ls-remote` errors instead of returning structured `NOT READY` check output (src/core/pr-ready.ts:229)
