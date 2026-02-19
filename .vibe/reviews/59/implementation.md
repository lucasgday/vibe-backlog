## 2026-02-19 Implementation Pass (issue #59)

- Implemented follow-up auto-close path for `vibe review` when unresolved findings reach `0` in non-dry-run runs.
- Added exported helper `closeResolvedReviewFollowUpIssues` in `src/core/review-pr.ts`.
- Added reusable open follow-up listing by source marker to avoid duplicate lookup logic.
- Integrated closure results into review summary with explicit sections:
  - `### Follow-up Closure`
  - `### Follow-up Closure Warnings`
- Kept existing unresolved follow-up creation/update behavior unchanged (`max-attempts` path).
