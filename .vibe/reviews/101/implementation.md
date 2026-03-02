## Run 2026-03-02T17:27:37Z
- Scope: issue #101 bugfix for PR rationale architecture text being template/misaligned on dependency-security PRs.
- Changes:
  - Filtered generated `.vibe` review/postflight artifacts from rationale changed-file signals.
  - Added dependency-file detection (`package.json`, lockfiles) and `deps-only` change profile.
  - Added dependency-specific rationale lines for architecture/why/alternatives sections.
  - Added regression test covering dependency patch + `.vibe` artifact noise.
- Files:
  - `src/core/pr-rationale.ts`
  - `tests/pr-rationale.test.ts`

## Run 2026-03-02T17:27:37Z
- run_id: issue-101-review-pass-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
No implementation defects identified; fix directly addresses the observed misclassification path.

### Findings
- none
