# Implementation Pass

- Added shared rationale helper in `src/core/pr-rationale.ts` to build non-TODO rationale sections and section-scoped TODO detection/autofill.
- Updated `src/core/pr-open.ts` to:
  - generate body via rationale helper (no TODO placeholders),
  - detect TODO rationale placeholders on existing PR bodies,
  - autofill by editing only rationale sections,
  - expose `rationaleAutofilled` in the command result.
- Updated `src/core/review-pr.ts` to:
  - include PR body in open-PR snapshots,
  - autofill rationale placeholders when reusing open PRs,
  - expose `rationaleAutofilled` in review PR snapshot.
- Updated `src/core/review.ts` to:
  - add smart retry termination policy (`no-autofix`, `no-autofix-changes`, `same-fingerprints`, `max-attempts`, `completed`),
  - include termination reason in summaries and command result,
  - move postflight summary append before commit/push,
  - enforce final tracked-changes guard for `autopush` persistence,
  - publish PR summary after final commit head resolution.
- Updated `src/cli-program.ts` to print explicit rationale autofill and retry termination logs for `review` and `pr open` paths.

## Run 2026-02-17T02:20:13.400Z
- run_id: issue-44-pr-45-attempt-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
Review flow hardening is coherent: rationale section generation/autofill is centralized, retry termination policy is explicit, and commit/publish ordering now aligns with final-head consistency.

### Findings
- none

## Run 2026-02-17T02:27:19.401Z
- run_id: issue-44-pr-45-attempt-1-postflight-gate
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
The new postflight review gate is directionally correct and enforces the intended workflow, but it currently relies on resolving the branch head from local git state, which can break valid apply flows when the branch is not present locally.

### Findings
- [P2] Postflight review gate depends on local branch ref availability (src/cli-program.ts:354)
