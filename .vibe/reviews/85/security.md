## Run 2026-03-01T23:07:40Z
Threat model quick scan:
This change exposes additional machine-readable metadata in CLI logs. Primary risk is accidental leakage of sensitive data if debug payload includes unsafe raw inputs.

Checks and mitigations:
- Debug payload uses already-normalized rationale signals (issue labels/title, changed file paths, derived profile/modules), not secrets.
- No new shell execution paths or privilege boundaries introduced.
- Output is opt-in via explicit CLI flag (`--rationale-signals-json`) for both `pr open` and `review`.
