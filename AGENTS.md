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
## Issue-first + Triage (MUST)

### When the user introduces a new topic
The agent MUST NOT start implementation immediately. It MUST:

1) Run (or request) **current context**:
   - Run: `git status` (+ optional `tree -L 3`)
   - Ask the user for: a screenshot (if relevant)
   - Run: `pnpm build && node dist/cli.cjs preflight`

2) **Detect whether the topic maps to an existing issue**:
   - If yes: confirm with the user: "seguimos con #<N>?"
   - If not: propose creating a new issue with a clear title and DoD.

3) **Ask about in-progress / pending topics** and propose priorities:
   - Summarize open issues briefly (max 5) from preflight.
   - Ask: "¿Querés retomar alguno de estos o creamos uno nuevo?"
   - Suggest a priority order using this rubric:
     - (P0) blocks shipping / breaks workflow / data loss risk
     - (P1) improves dogfooding loop (preflight/postflight/apply/turn context)
     - (P2) usability improvements and niceties
   - Provide 2-3 recommended next actions and ask the user to pick one.

### One topic = one issue (scope control)
- Do not mix multiple unrelated topics in a single issue/branch.
- If the user expands scope mid-way, propose:
  - keep current issue focused
  - create a follow-up issue for the new topic

### Issue status hygiene (MUST)
- Every turn should update GitHub status labels via `postflight --apply`:
  - `status:backlog`, `status:in-progress`, `status:in-review`, `status:done`
- If blocked, add a comment explaining the blocker and label (optional): `status:blocked` (if exists).

### Commands to prefer (avoid global-bin drift)
- Always build before running vibe:
  - `pnpm build`
- Prefer repo-local CLI:
  - `node dist/cli.cjs preflight`
  - `node dist/cli.cjs postflight`
  - `node dist/cli.cjs postflight --apply`

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
