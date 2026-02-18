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
