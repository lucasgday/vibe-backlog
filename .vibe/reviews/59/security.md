## 2026-02-19 Security Pass (issue #59)

Threat model quick scan:
- The new behavior mutates tracker state by closing GitHub issues. Main risk is accidental closure of unrelated issues.
- Mitigation is marker-based scoping: only open issues with `<!-- vibe:review-followup:source-issue:<id> -->` matching the current source issue are eligible.

Concrete checks:
- Authz boundary remains GitHub CLI auth; no new credential paths introduced.
- Input handling is constrained to internal numeric issue ids and known run id string for close comments.
- Data exposure risk is low: close comment includes run id/source issue only (no secrets).
- Failure mode is safe: close failures become warnings and do not crash review execution.
