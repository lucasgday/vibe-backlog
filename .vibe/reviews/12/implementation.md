# Implementation Pass

- Scope: auto-create review templates under `.vibe/reviews/<issue_id>/` when running `turn start`.
- Changes:
  - Added `src/core/reviews.ts` with deterministic, non-overwriting template creation.
  - Wired template creation into `turn start` in `src/cli-program.ts`.
  - Exported new review helpers from `src/core/index.ts`.
  - Added tests for template creation/idempotency and CLI integration.
- Result: templates are now created automatically per issue while preserving existing notes.
