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
