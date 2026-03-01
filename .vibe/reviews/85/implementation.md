## Run 2026-03-01T23:07:40Z
- Scope: issue #85 rationale signal debug/json output for PR rationale generation flows.
- Changes:
  - Added structured rationale signal debug payload (`buildRationaleSignalDebug`) exposing profile/modules/themes/sample files and explicit `fallback_reasons` codes.
  - Wired debug payload into `pr open` result/output (`--rationale-signals-json`).
  - Wired optional debug payload into `review` flow/output (`--rationale-signals-json`) using rationale changed-file extraction for review PR context.
  - Kept behavior deterministic by reusing existing normalization/classification logic.
- Files:
  - src/core/pr-rationale.ts
  - src/core/pr-open.ts
  - src/core/review.ts
  - src/cli-program.ts

## Run 2026-03-01T23:11:44.755Z
- run_id: issue-85-pr-93-attempt-1
- attempt: 1/5
- findings: 1
- autofix_applied: yes

### Summary
Found 1 behavior-level issue in review debug signal timing.

### Findings
- [P2] Review debug payload is emitted as final output but computed before findings exist (src/core/review.ts:875)
