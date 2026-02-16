# Implementation Pass

- Added new review pipeline modules:
  - `src/core/review.ts` (orchestration)
  - `src/core/review-agent.ts` (external agent JSON contract)
  - `src/core/review-pr.ts` (PR resolve/create, summary upsert, inline dedupe, follow-up creation)
  - `src/core/review-postflight.ts` (postflight artifact append)
- Added CLI command `vibe review` with full option surface and exit code behavior.
- Added README command reference for `vibe review`.
- Kept one-shot final PR publication behavior and max-attempt retry loop.
