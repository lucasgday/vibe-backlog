# Implementation Pass

- Scope: issue #23 tracker taxonomy bootstrap for repos with `.vibe`.
- Added `tracker bootstrap` command (`src/cli-program.ts`) with `--dry-run` and apply paths.
- Added tracker core module (`src/core/tracker.ts`) with deterministic taxonomy definitions, missing-item selection, marker write, and hint detection.
- Added preflight hint when `.vibe` exists but tracker marker is missing.
- Updated docs in README command flow.
