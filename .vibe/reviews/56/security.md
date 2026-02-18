## 2026-02-18 Security Pass (issue #56)

Threat model quick scan:
This change only adds read-only merge readiness checks plus an optional `git fetch origin`. The main risk is acting on stale PR metadata and allowing merges while head/protection state is inconsistent. The new flow reduces that risk by requiring explicit `OPEN`, non-draft, `CLEAN`, remote head sync, and review marker match for the exact `headRefOid`.

The next risk is unsafe remediation. To avoid introducing destructive behavior, remediation is non-mutating and deterministic (`pr ready --refresh --wait-seconds 30`), with no rebase/force-push/auto-merge side effects.

Concrete checks:
- Authz/context: uses current authenticated `gh` session and repository scope already required by existing commands.
- Input validation: CLI enforces positive integer `--pr` and non-negative integer `--wait-seconds`.
- Data exposure: output is operational metadata only (PR id/url/branch/head state); no secret material is emitted.
- Error leakage: command errors are surfaced consistently as existing CLI errors.
- Secure defaults: strict policy defaults to `mergeStateStatus=CLEAN`, blocks on missing review marker, and blocks desync.

## Run 2026-02-18T14:21:11.006Z
- run_id: review-56-attempt1-20260218T1121Z
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
No direct AppSec vulnerabilities identified in this diff; checks are read-only and default posture is strict (`CLEAN` + review marker).

### Findings
- none

## 2026-02-18 Security Pass (follow-up #58)

- Defensive failure handling improved: transient/remote git lookup failures now fail closed (`NOT READY`) instead of aborting the whole command unexpectedly.
- This reduces operational ambiguity and keeps merge gate behavior deterministic under transport/network errors.

## Run 2026-02-18T14:27:06.153Z
- run_id: review-56-attempt1-20260218T1126Z
- attempt: 1/5
- findings: 0
- autofix_applied: yes
- changed_files: src/core/pr-ready.ts, tests/pr-ready.test.ts, .vibe/reviews/56/implementation.md, .vibe/reviews/56/security.md, .vibe/reviews/56/quality.md, .vibe/reviews/56/ops.md

### Summary
No new security issues found; the command remains fail-closed for readiness and avoids destructive remediation actions.

### Findings
- none
