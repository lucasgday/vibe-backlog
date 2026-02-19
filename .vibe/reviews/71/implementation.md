## 2026-02-19 Implementation Pass (issue #71)

- Extended branch cleanup classification with `pr-merged` to keep stale-branch removal inside the vibe flow.
- Added merged-PR detection for upstream-gone non-merged branches.
- Added strict safety guard: auto-delete only when local branch HEAD SHA matches merged PR head SHA.
- Preserved existing behavior for merged, patch-equivalent, and forced non-merged deletion paths.
- Added warning-only fallback when gh PR lookup fails.
