## Run 2026-02-27T15:30:09Z
Release/ops checks:
- Deterministic local commands succeeded: 
> vibe-backlog@0.1.0 test /Users/lucasgday/code/codex/vibe-backlog
> vitest run


 RUN  v4.0.18 /Users/lucasgday/code/codex/vibe-backlog

 ✓ tests/security-scan.test.ts (10 tests) 27ms
stdout | tests/review-pr.test.ts > review PR helpers > creates follow-up issue with only labels available in repo
issue create: mode=body_file labels=2 milestone=no

stdout | tests/review-pr.test.ts > review PR helpers > retries follow-up issue creation without labels when label add fails
issue create: mode=body_file labels=3 milestone=no

stdout | tests/review-pr.test.ts > review PR helpers > retries follow-up issue creation without labels when label add fails
issue create: mode=body_file labels=0 milestone=no

stdout | tests/review-pr.test.ts > review PR helpers > inherits module labels from source issue when available
issue create: mode=body_file labels=3 milestone=no

stdout | tests/review-pr.test.ts > review PR helpers > creates and assigns semantic milestone for follow-up issues when source milestone is missing
issue create: mode=body_file labels=3 milestone=yes

 ✓ tests/review-pr.test.ts (28 tests) 23ms
 ✓ tests/cli-tracker.test.ts (9 tests) 24ms
 ✓ tests/review-agent.test.ts (7 tests) 260ms
 ✓ tests/cli-init.test.ts (3 tests) 47ms
 ✓ tests/cli-postflight.test.ts (12 tests) 47ms
 ✓ tests/cli-pr-open.test.ts (17 tests) 89ms
 ✓ tests/reviews.test.ts (2 tests) 15ms
 ✓ tests/cli-update.test.ts (7 tests) 30ms
 ✓ tests/tracker.test.ts (13 tests) 26ms
 ✓ tests/cli-turn.test.ts (6 tests) 42ms
 ✓ tests/review-provider.test.ts (7 tests) 20ms
 ✓ tests/cli-guard.test.ts (4 tests) 17ms
 ✓ tests/cli-security.test.ts (4 tests) 22ms
 ✓ tests/gh-issue.test.ts (3 tests) 23ms
 ✓ tests/service.test.ts (5 tests) 12ms
 ✓ tests/turn.test.ts (5 tests) 11ms
 ✓ tests/branch-cleanup.test.ts (10 tests) 24ms
 ✓ tests/cli-branch-cleanup.test.ts (3 tests) 18ms
 ✓ tests/pr-rationale.test.ts (6 tests) 11ms
 ✓ tests/cli-review.test.ts (34 tests) 653ms
 ✓ tests/review-threads.test.ts (11 tests) 7ms
 ✓ tests/gh-retry.test.ts (6 tests) 3ms
 ✓ tests/cli-review-threads.test.ts (6 tests) 8ms
 ✓ tests/pr-ready.test.ts (10 tests) 8ms
 ✓ tests/cli-pr-ready.test.ts (4 tests) 7ms
 ✓ tests/postflight.test.ts (6 tests) 5ms
 ✓ tests/pr-open.test.ts (2 tests) 4ms
 ✓ tests/git-changed-files.test.ts (3 tests) 2ms
 ✓ tests/parser.test.ts (3 tests) 2ms
 ✓ tests/review-policy.test.ts (6 tests) 2ms
 ✓ tests/cli-status.test.ts (7 tests) 1045ms
     ✓ keeps status non-blocking when gh is unavailable  1006ms

 Test Files  32 passed (32)
      Tests  259 passed (259)
   Start at  12:30:14
   Duration  1.57s (transform 1.43s, setup 0ms, import 4.52s, tests 2.53s, environment 2ms) and 
> vibe-backlog@0.1.0 build /Users/lucasgday/code/codex/vibe-backlog
> tsup src/core/index.ts src/cli.ts --dts --format esm,cjs

CLI Building entry: src/cli.ts, src/core/index.ts
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Target: es2022
ESM Build start
CJS Build start
CJS dist/cli.cjs        329.52 KB
CJS dist/core/index.cjs 272.27 KB
CJS ⚡️ Build success in 32ms
ESM dist/cli.js            73.27 KB
ESM dist/chunk-GZ2H26IT.js 256.47 KB
ESM dist/core/index.js     10.69 KB
ESM ⚡️ Build success in 32ms
DTS Build start
DTS ⚡️ Build success in 2484ms
DTS dist/cli.d.ts         20.00 B
DTS dist/core/index.d.ts  38.69 KB
DTS dist/cli.d.cts        20.00 B
DTS dist/core/index.d.cts 38.69 KB.
- No dependency changes; supply-chain risk unchanged.
- CLI/runtime behavior remains backward compatible; new phase metrics are additive output fields.

## Run 2026-02-27T15:30:40Z (correction)
Ops/release checks:
- Commands succeeded locally: pnpm test, pnpm build.
- No dependency additions; supply-chain posture unchanged.
- Added outputs are backward-compatible additive fields.

## Run 2026-02-27T16:14:44.889Z
- run_id: review-issue-89-attempt-1-20260227T1538Z
- attempt: 1/5
- findings: 1
- autofix_applied: no

### Summary
Found 1 operational observability risk for release metrics.

### Findings
- [P2] Postflight consumers receive incomplete phase timings for publish-related phases (src/core/review.ts:1234)
