# Implementation Pass

## Scope
- Issue:
- Goal:

## Checklist
- [ ] Diff kept focused to issue scope
- [ ] Behavior changes documented
- [ ] Follow-up work listed (if any)

## Notes
- 

## Run 2026-03-02T21:56:55.104Z
- run_id: pr-111-issue-110-attempt-1
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
New newline normalization addresses the reported /n- formatting bug, but one transformation is broader than necessary and can mutate intentional escaped content.

### Findings
- [P2] Global \\n replacement can rewrite intentional escaped text (src/core/review-pr.ts:891)
