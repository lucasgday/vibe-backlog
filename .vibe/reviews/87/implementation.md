# Implementation Pass

## Run 2026-02-27T10:40:00Z
- run_id: manual-issue-87-implementation
- findings: 0

### Summary
Added deterministic progress instrumentation to `runReviewCommand` so long phases no longer stay silent, including heartbeat updates for provider invocation, lifecycle/thread steps, publish, and autopush. Added pending draft cleanup integration before thread auto-resolve and after publish (best-effort, actor-scoped) to reduce orphaned `PENDING` reviews from interrupted/stalled runs.

### Findings
- none
