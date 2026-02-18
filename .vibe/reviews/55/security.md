# Security Pass

## Threat model quick scan
- Mixed marker compatibility can become a security/control bypass if permissive matching accepts stale legacy comments over stricter policy markers.

## Mitigations implemented
- Policy-aware review gate now prefers policy evidence when present for matching HEAD.
- Legacy compatibility remains only when no policy markers exist for that HEAD.

## Summary
Security/control integrity improved: policy mismatch can no longer be masked by legacy comments in mixed histories.

## Findings
- none
