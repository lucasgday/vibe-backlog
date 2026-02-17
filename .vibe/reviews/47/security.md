# Security Pass

## Threat model quick scan
- Secret scanning can fail-open if scanner availability is not explicit or if policy handling is ambiguous.
- CLI integration can leak sensitive output if raw scanner logs are echoed indiscriminately.

## Mitigations implemented
- Explicit policy model (`warn|fail`) with deterministic precedence and defaults.
- Missing-binary path is explicit and actionable; enforcement only blocks when policy is `fail`.
- Preflight security snapshot is non-blocking by design to preserve developer workflow continuity.
- Runtime record captures scan status for observability without persisting scanner raw payloads as artifacts.

## Concrete checks
- Input validation:
  - CLI validates allowed values for `--mode` and `--policy`.
- Secure defaults:
  - default policy is `warn` unless explicitly configured.
- Error leakage:
  - command reports concise scan detail and remediation, avoiding broad environment dumps.
- Supply chain/CI:
  - dedicated gitleaks workflow added with least-privilege permissions (`contents: read`).

## Run 2026-02-17T20:42:00Z
- issue: #47
- findings: 0

### Summary
No security regression identified. Changes improve baseline secret-detection posture with explicit enforcement controls and deterministic CI behavior.

### Findings
- none
