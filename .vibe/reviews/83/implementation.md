# Implementation Pass

## Scope
- Issue: #83
- Goal: Replace fixed PR rationale bullets with deterministic, signal-driven rationale generation while preserving headings and placeholder autofill behavior.

## Checklist
- [x] Diff kept focused to issue scope
- [x] Behavior changes documented
- [x] Follow-up work listed (if any)

## Notes
- Signal extraction is best-effort in command flows (`git diff`) and falls back explicitly to metadata-only rationale when unavailable.

## Run 2026-02-26T17:59:16Z
- run_id: manual-issue-83-implementation
- findings: 0

### Summary
Replaced the fixed rationale bullet sets in `src/core/pr-rationale.ts` with deterministic rule-based generation using issue metadata plus optional signals (labels, changed files, validation/review summaries). Wired `pr open` and review PR create/autofill paths to pass issue labels and best-effort changed-file signals, and added tests covering multi-context output differences, fallback behavior, determinism, and placeholder preservation.

### Findings
- none
