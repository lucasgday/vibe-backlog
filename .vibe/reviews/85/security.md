## Run 2026-03-01T23:07:40Z
Threat model quick scan:
This change exposes additional machine-readable metadata in CLI logs. Primary risk is accidental leakage of sensitive data if debug payload includes unsafe raw inputs.

Checks and mitigations:
- Debug payload uses already-normalized rationale signals (issue labels/title, changed file paths, derived profile/modules), not secrets.
- No new shell execution paths or privilege boundaries introduced.
- Output is opt-in via explicit CLI flag (`--rationale-signals-json`) for both `pr open` and `review`.

## Run 2026-03-01T23:11:44.756Z
- run_id: issue-85-pr-93-attempt-1
- attempt: 1/5
- findings: 0
- autofix_applied: yes

### Summary
No security regressions found in the changed behavior.

### Findings
- none

## Run 2026-03-01T23:15:10Z
Threat model quick scan:
Second pass mostly restructures data timing and output formatting. Security posture is unchanged; no extra external inputs or command paths were introduced.

Checks and mitigations:
- Debug schema versioning is additive and deterministic.
- Review findings summary exposure uses already-generated local findings data.
