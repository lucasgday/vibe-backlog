# Quality Pass

## What I Tested
- `pnpm test`
- `pnpm build`
- `node dist/cli.cjs preflight`

## Coverage Added/Updated
- `tests/pr-open.test.ts`
  - dry-run body has no TODO placeholders.
- `tests/cli-pr-open.test.ts`
  - PR body template assertions no longer expect TODO.
  - existing PR rationale TODO placeholders trigger `gh pr edit` autofill.
- `tests/cli-review.test.ts`
  - rationale autofill when reusing PR in review flow.
  - early-stop for `no-autofix`.
  - early-stop for `no-autofix-changes`.
  - early-stop for `same-fingerprints`.
  - artifact persistence order + final head marker publishing.
  - explicit failure when tracked changes remain after `autopush`.
- `tests/review-pr.test.ts`
  - updated PR snapshot fixtures for new fields (`body`, `rationaleAutofilled`).

## Remaining Untested
- Real `gh` network behavior is mocked in unit tests; runtime GitHub API edge cases remain integration-level risk.
