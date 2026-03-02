## Run 2026-03-02T20:31:32Z
Threat model quick scan:
This change only modifies generated PR-body rationale text. Main risks are accidental inclusion of unsafe/unescaped data in markdown output or overclaiming evidence that was not present in signals.

Checks and mitigations:
- Content remains deterministic and derived from existing local signals (issue metadata + changed files + validation/review summaries).
- Fallback lines remain explicit when changed-file signals are unavailable.
- No new command execution, auth surface, network paths, or secret-handling behavior introduced.
