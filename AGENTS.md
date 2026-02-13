# Vibe-Backlog — Agent Contract (MUST)

This repo is dogfooding itself: the development workflow MUST use `vibe` (preflight/postflight) and keep project state consistent with the tracker.

## Golden Rules
1) **Always run preflight before coding**:
   - `vibe preflight`
2) **Every work must be tied to a tracker item** (GitHub Issue by default).
3) **Never overwrite user notes** (append-only policy). If uncertain, propose a diff and ask.
4) **Do not ship without tests**:
   - Create/edit tests for each feature or bugfix.
   - Run `pnpm test` before finishing a turn.
5) **Postflight is mandatory to close a work turn**:
   - Ensure `.vibe/artifacts/postflight.json` is valid
   - `vibe postflight` (validate)
   - If applicable: `vibe postflight --apply` (sync tracker updates)

---

## Required “First Message” in any new work turn
Before starting any implementation, 
- `git status` if not provided after the last changes 
- (Optional but helpful) `tree -L 3`

and ask the user for:
- A screenshot of the current state (if relevant)

---

## Workflow (Default)
### 0) Pick an Issue
- If no issue exists, create one: `gh issue create ...`
- Reference its number in all branch/PR work.

### 1) Create a branch (required)
Branch naming:
- `issue-<N>-<slug>`
Example:
- `issue-1-postflight-apply`

### 2) Implement with minimal changes
- Prefer small diffs and clean commits.
- Avoid scope creep.

### 3) Tests & commands
For every feature:
- List which tests were created/edited.
- List which docs/markdown files were updated (if behavior changed).
- Provide the exact commands to verify:
  - `pnpm test`
  - `pnpm build`

### 4) Postflight (required)
- Update `.vibe/artifacts/postflight.json`:
  - Include `work.issue_id`, `work.branch`, `work.base_branch`
  - Include `tracker_updates` (append-only)
  - Include `next_actions`, `risks.rollback_plan`
- Validate:
  - `vibe postflight`
- Apply tracker updates (if configured):
  - `vibe postflight --apply`

### 5) PR (preferred)
- Open a PR linked to the issue:
  - Include: `Fixes #<N>` in the PR body/title so GitHub can auto-close on merge.
- Ask the user for the GitHub issue number if missing.
- End with: **"crear PR — cuál es el # del gh issue?"** (if not already known)

---

## Tracker rules (GitHub default)
- Status is represented by labels:
  - `status:backlog`
  - `status:in-progress`
  - `status:in-review`
  - `status:done`
- Use `vibe postflight --apply` to add/remove labels and append comments.

---

## Files & Ownership
Protected / user-owned content MUST NOT be overwritten:
- Any section between:
  - `<!-- vibe:user-notes:start -->` and `<!-- vibe:user-notes:end -->`

Agent-owned sections are append-only:
- `<!-- vibe:agent-log:start -->` and `<!-- vibe:agent-log:end -->`

If a change touches protected content:
- Propose a diff and ask for explicit approval.

---

## Worktrees (Optional)
Use git worktrees only when working on multiple issues in parallel.
Example:
- `git worktree add ../vibe-backlog-issue-2 -b issue-2-turn-context`

---

## Repo Intent (MVP path)
Phase 1 (CLI dogfood):
- `vibe preflight` (git + issues)
- `vibe postflight` validate
- `vibe postflight --apply` sync via `gh`

Phase 2 (Turn context):
- `vibe turn start/show/end` stores state in `.vibe/runtime/turn.json` (gitignored)

Phase 3 (UI):
- Only after Phase 1–2 is stable.
