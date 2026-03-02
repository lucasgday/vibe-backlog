## Run 2026-03-02T19:43:57Z
Threat model quick scan:
The new surface is a local HTTP UI endpoint that reads project metadata from local filesystem and git state. Main risks are path traversal, accidental data disclosure in HTML/JSON rendering, and unstable handling of malformed local turn files.

Checks and mitigations:
- Route scope is read-only (`GET` only) and constrained to the configured workspace root.
- Project lookup is ID-based over discovered repos; unknown IDs return `404`.
- HTML content is escaped (`safeText`) and boot JSON escapes `<` to reduce script injection risk.
- Turn context parse failures are handled explicitly and returned as non-crashing status cards.
- No credentials, tokens, or remote network calls are introduced by this UI slice.

## Run 2026-03-02T19:48:15.948Z
- run_id: issue-16-review-pass-1
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
One security-relevant hardening gap was found around optional non-loopback exposure.

### Findings
- [P2] Remote host binding can expose local repo metadata without explicit warning or guard (src/cli-program.ts:1985)

## Run 2026-03-02T19:51:29Z
- run_id: issue-16-review-pass-2
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
Security finding addressed by requiring explicit `--allow-remote` for non-loopback binds and adding clear operator warnings/remediation output.

### Findings
- none

## Run 2026-03-02T19:53:14.521Z
- run_id: issue-16-review-pass-2
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
Non-loopback exposure is now explicitly gated behind `--allow-remote`, with safer defaults and remediation messaging; no remaining security findings in this scope.

### Findings
- none
