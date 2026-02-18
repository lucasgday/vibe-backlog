# vibe-backlog

CLI-first project workflow for solo builders using GitHub issues + postflight artifacts.
One-liner: `vibe-backlog` turns issue context, git state, and postflight artifacts into one repeatable development loop.

This project has two usage modes:

- Canonical and reproducible commands (recommended for agents): `pnpm build && node dist/cli.cjs ...`
- Convenience commands (for shorter typing): global `vibe` via `pnpm link --global` + `hash -r`

Do not rely only on the global bin path. Always keep the canonical path available.

## 0) Requirements

```bash
pnpm -v
gh auth status
git --version
```

## 1) Create a new repo (local + private remote)

```bash
# 1) create folder and git
mkdir my-project && cd my-project
git init -b main

# 2) minimal gitignore
cat > .gitignore <<'EOF'
node_modules
dist
.DS_Store
*.log
.vibe/runtime
.vibe/artifacts
EOF

# 3) first commit
git add .
git commit -m "chore: init"

# 4) create private remote and push
git remote -v
# if empty:
gh repo create <NAME> --private --source=. --remote=origin --push
```

## 2) Install vibe-backlog (from the vibe-backlog repo, dev mode)

This is for developing `vibe-backlog` from source.

```bash
# inside vibe-backlog repo
pnpm install
pnpm test
pnpm build

# option A (recommended for agents / reproducible)
node dist/cli.cjs --help

# option B (convenience: global "vibe" command)
pnpm link --global
hash -r
vibe --help
```

## 3) Use vibe-backlog in another repo (with global bin already linked)

```bash
cd /path/to/another-repo

# one-time setup for agent-first workflow
vibe init --dry-run
vibe init
# if gh is unavailable, scaffold local files only
# vibe init --skip-tracker

# now these commands are valid
vibe preflight
vibe postflight
vibe postflight --apply --dry-run
```

If you want to avoid global bin drift, run from the vibe-backlog repo path:

```bash
node /path/to/vibe-backlog/dist/cli.cjs preflight
```

## 4) Recommended workflow (Issue-first + Postflight)

```bash
# 0) one-time setup in this repo
vibe init --dry-run
vibe init

# 1) inspect repo + issue state
vibe preflight
vibe status
vibe review --dry-run

# 2) set the real active issue id before apply
# Edit .vibe/artifacts/postflight.json and replace:
#   "issue_id": "1"
# with your real issue number, for example:
#   "issue_id": "42"

# 3) validate artifact
vibe postflight

# 4) preview tracker updates first
vibe postflight --apply --dry-run

# 5) apply for real
vibe postflight --apply
# optional: skip automatic local branch cleanup
# vibe postflight --apply --skip-branch-cleanup
```

`preflight` now prints a security snapshot (policy, gitleaks availability, last scan), a hint when `.vibe` exists but tracker bootstrap marker is missing, and read-only semantic milestone suggestions for issues without milestone.
`status` shows active turn, in-progress issues, hygiene warnings, and branch PR snapshot.
`turn start --issue <n>` now auto-creates `.vibe/reviews/<n>/` templates (`implementation`, `security`, `quality`, `ux`, `ops`) when missing.
`turn start --issue <n>` now enforces a remote-state guard (`git fetch origin`, `git status -sb`, `git branch -vv`, PR state check on current branch) and blocks branch creation on behind/diverged or closed/merged-PR branch states with explicit remediation commands.
`postflight --apply` now runs automatic local branch cleanup for `upstream gone` branches (safe delete for merged, force delete for patch-equivalent, non-merged require explicit manual confirmation). Use `--skip-branch-cleanup` to bypass it.
`branch cleanup` provides explicit cleanup control, including dry-run planning and guarded force path for non-merged branches.
`security scan` runs gitleaks in `staged`, `working-tree`, or `history` mode with configurable `warn|fail` policy (`.vibe/contract.yml` by default).
`review` runs the 5 role passes via external agent command, retries up to `--max-attempts`, publishes one final PR report, and can auto-create/update a single follow-up issue per source issue when unresolved findings remain.
`pr open` creates/reuses an open PR for the issue, injects deterministic architecture/rationale sections plus `Fixes #<issue>`, and enforces a review gate by HEAD marker (unless explicitly skipped).
`pr ready` validates final merge-readiness (`OPEN`, non-draft, `mergeStateStatus=CLEAN`, remote head sync, review marker) and prints non-destructive remediation for stale/desync states.
`tracker reconcile` fills missing `module:*` labels and milestone metadata using semantic signals (title/body/module history); when no existing milestone matches strongly, it can plan/create a repo-specific delivery milestone.

## Agent workflow (AGENTS.md)

This repo supports LLM-driven development. The file `AGENTS.md` is the agent contract:

- Issue-first (one topic = one issue)
- Mandatory preflight -> work -> postflight
- Append-only (never overwrite user notes)
- Multi-pass reviews (Security/Quality/UX/Ops)

LLMs (Codex, Claude, etc.) must read and follow `AGENTS.md` before making changes.

## Security

- Vulnerability reporting policy: `SECURITY.md`
- CI log/artifact hardening policy: `.github/CI_SECURITY.md`

## Canonical commands (recommended)

Use these for deterministic execution:

```bash
pnpm build
node dist/cli.cjs preflight
node dist/cli.cjs status
node dist/cli.cjs security scan --dry-run
node dist/cli.cjs security scan --mode staged
node dist/cli.cjs security scan --mode history --policy fail
node dist/cli.cjs branch cleanup --dry-run
node dist/cli.cjs branch cleanup
node dist/cli.cjs branch cleanup --force-unmerged --yes
node dist/cli.cjs review --dry-run
node dist/cli.cjs review threads resolve --pr <n> --all-unresolved --dry-run
node dist/cli.cjs review threads resolve --pr <n> --thread-id <id>
node dist/cli.cjs pr open --dry-run --issue <n> --branch <name>
node dist/cli.cjs pr open --force-review --issue <n> --branch <name>
node dist/cli.cjs pr ready --pr <n> --wait-seconds 30
node dist/cli.cjs pr ready --branch <name> --refresh --wait-seconds 30
node dist/cli.cjs init --dry-run
node dist/cli.cjs init
node dist/cli.cjs tracker bootstrap --dry-run
node dist/cli.cjs tracker bootstrap
node dist/cli.cjs tracker reconcile --dry-run
node dist/cli.cjs tracker reconcile --fallback-module module:core --fallback-milestone "<milestone>"
node dist/cli.cjs postflight
node dist/cli.cjs postflight --apply --dry-run
node dist/cli.cjs postflight --apply
node dist/cli.cjs postflight --apply --skip-branch-cleanup
```

## `vibe branch cleanup` command reference

```bash
vibe branch cleanup [options]
```

Options:

- `--dry-run`: plan cleanup without deleting local branches.
- `--base <name>`: override base ref for merged/patch-equivalent checks (default: `origin/HEAD`, fallback `main`).
- `--force-unmerged`: allow deleting non-merged branches (requires confirmation).
- `--yes`: confirmation required when using `--force-unmerged`.
- `--no-fetch-prune`: skip `git fetch --prune origin` before branch detection.

Policy:

- Candidate pool: local branches with `upstream gone`.
- Protected branches: current branch, `main`, and resolved base branch.
- Deletion mode:
  - merged into base -> `git branch -d`
  - patch-equivalent -> `git branch -D`
- non-merged -> skipped unless `--force-unmerged --yes`

## `vibe security scan` command reference

```bash
vibe security scan [options]
```

Options:

- `--mode <staged|working-tree|history>`: scan scope (default `staged`).
- `--policy <warn|fail>`: override policy for current run.
- `--dry-run`: print resolved command/policy without running gitleaks.

Policy resolution:

1. `--policy` flag (if provided)
2. `.vibe/contract.yml` -> `security.gitleaks.policy`
3. default `warn`

Behavior:

- `warn`: findings/missing gitleaks are reported but do not fail command.
- `fail`: findings/missing gitleaks fail command (exit code `1`).
- Last scan summary is stored at `.vibe/runtime/security-scan.json` for `preflight` visibility.

Portability note:

- The CLI security scan is intended for any repo using `.vibe` + `vibe`.
- This repository includes CI wiring for gitleaks; `vibe init` does not scaffold that workflow yet.

## `vibe tracker reconcile` command reference

```bash
vibe tracker reconcile [options]
```

Options:

- `--dry-run`: build and print reconcile plan only.
- `--fallback-module <name>`: module label/name to use when module inference is uncertain.
- `--fallback-milestone <title>`: milestone title to use when milestone inference is uncertain.

Behavior:

- Default mode applies updates (`gh issue edit`) to open issues with missing `module:*` or milestone.
- If milestone affinity is low, reconcile generates a delivery-goal milestone title (`<Area>: <Objective>`) and creates it before issue assignment.
- `preflight` remains read-only; milestone creation happens only in write flows (e.g. reconcile/apply flows).
- Reconcile never removes/replaces existing module labels or milestone; it only fills missing metadata.

## `vibe review` command reference

```bash
vibe review [options]
```

Options:

- `--issue <n>`: issue override (highest priority).
- `--agent-provider <auto|codex|claude|gemini|command>`: provider selection (default `auto`).
- `--agent-cmd "<cmd>"`: explicit external command (highest priority). Fallback: `VIBE_REVIEW_AGENT_CMD`.
- `--dry-run`: run planning path without mutating git/GitHub.
- `--no-autofix`: disable agent autofix mode.
- `--no-autopush`: disable final auto commit/push.
- `--no-publish`: skip PR summary/review/inline publication.
- `--max-attempts <n>`: max retry attempts (default `5`).
- `--strict`: exit non-zero when unresolved findings remain after final attempt.
- `--followup-label bug|enhancement`: override follow-up issue label.

Issue/base context resolution (without requiring an active turn):

1. `--issue <n>` (if provided)
2. valid active turn
3. branch inference:
   - `issue-<n>-...`
   - `<feat|fix|chore|docs|refactor|test>/<n>-...`
4. open PR body autoclose references (`Fixes #<n>`, `Closes #<n>`, `Resolves #<n>`)

If issue resolution still fails, command exits with remediation to provide `--issue <n>`.

Provider resolution (highest priority first):

1. `--agent-cmd`
2. `VIBE_REVIEW_AGENT_CMD`
3. `--agent-provider` forced mode (`codex|claude|gemini|command`)
4. `--agent-provider auto` (default):
   - persisted provider in `.vibe/runtime/review-agent-provider.json`
   - current host detection
   - available provider binaries/env overrides (`codex > claude > gemini`)

Provider-specific env overrides:

- `VIBE_REVIEW_CODEX_CMD`
- `VIBE_REVIEW_CLAUDE_CMD`
- `VIBE_REVIEW_GEMINI_CMD`

Codex same-session behavior:

- If `CODEX_THREAD_ID` exists, `vibe review` first tries `codex exec resume <thread_id>`.
- If resume fails or returns invalid JSON, it falls back to external non-interactive Codex execution.
- This is best-effort only; resume unavailability does not fail the run by itself.

## `vibe pr open` command reference

```bash
vibe pr open [options]
```

Options:

- `--issue <n>`: issue override.
- `--branch <name>`: branch override.
- `--base <name>`: base branch override.
- `--dry-run`: print PR payload plan only.
- `--skip-review-gate`: bypass review gate and publish an auditable PR comment marker.
- `--force-review`: force review rerun even when existing gate markers satisfy the current HEAD.

Review gate behavior:

- Default `pr open` enforces review execution for the target PR branch `HEAD` (resolved from `--branch`/turn/current branch).
- Dedupe is marker-based on PR comments: `<!-- vibe:review-summary -->` + `<!-- vibe:review-head:<sha> -->` (+ optional `<!-- vibe:review-policy:<key> -->`).
- Progressive compatibility:
  - legacy summary comments without policy marker still satisfy gate for matching HEAD.
  - if policy marker exists, `pr open` requires `HEAD + policy` match.
- If marker is missing, `pr open` auto-runs `vibe review` (full profile, non-strict).
- If `--force-review` is set, `pr open` reruns `vibe review` even when gate markers already match.
- For non-dry-run gate execution, target branch must be checked out before auto-review can run.
- If `--skip-review-gate` is set, no auto-review runs; PR receives `<!-- vibe:review-gate-skipped -->`.
- `--skip-review-gate` and `--force-review` are mutually exclusive.
- If `pr open` creates a PR and auto-review fails, the PR remains open and command exits with error.

## `vibe pr ready` command reference

```bash
vibe pr ready [options]
```

Options:

- `--pr <n>`: PR number override.
- `--branch <name>`: branch override when resolving open PR without `--pr`.
- `--refresh`: run `git fetch origin` before readiness checks.
- `--wait-seconds <n>`: wait/poll window for `mergeStateStatus=UNKNOWN` (default `0`).

Behavior:

- Resolves exactly one open PR target (`--pr` explicit or by branch lookup).
- Requires:
  - PR `state=OPEN`
  - PR `isDraft=false`
  - `mergeStateStatus=CLEAN`
  - `git ls-remote --heads origin <headRefName>` equals PR `headRefOid`
  - review gate marker exists for current HEAD + policy key
- On stale/unknown/desync failures, prints deterministic remediation:
  - `node dist/cli.cjs pr ready --pr <n> --refresh --wait-seconds 30`
- On success, prints freeze guidance before merge:
  - do not run `vibe review`, `vibe pr open`, or push new commits.

## `vibe review threads resolve` command reference

```bash
vibe review threads resolve [options]
```

Options:

- `--pr <n>`: PR number override. If omitted, resolve against the open PR for the current branch.
- `--thread-id <id>`: target thread id (repeatable). Single-target mode.
- `--all-unresolved`: batch mode for all unresolved threads on the target PR (including outdated threads).
- `--body <text>`: optional manual reply body (overrides auto-generated detailed body).
- `--dry-run`: show plan without replying/resolving.

Rules:

- Exactly one targeting mode is required: `--thread-id` (one or more) or `--all-unresolved`.
- In apply mode, each selected thread gets:
  1. reply comment (`addPullRequestReviewThreadReply`)
  2. resolve mutation (`resolveReviewThread`)
- Auto-body (when `--body` is not provided) includes: PR, HEAD, thread id, outdated status, location, finding title/severity/pass and fingerprint when available.
