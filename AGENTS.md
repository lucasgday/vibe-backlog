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

---

## Role passes (State-of-the-art) — MUST

### What “subagents” means in this repo
We simulate specialist sub-agents by running **separate review passes**. Each pass must:
- Write notes to an append-only file: `.vibe/reviews/<issue_id>/<pass>.md`
- Add a `tracker_updates: comment_append` summary into `.vibe/artifacts/postflight.json`
- Never overwrite user-owned notes.

### Pass order (default)
1) **Implementation Pass** (role: owner of change)
2) **Security Pass** (role: AppSec)
3) **Quality Pass** (role: QA / Test)
4) **UX/Frontend Pass** (only if UI touched)
5) **Ops/Release Pass** (only if packaging/CLI/CI touched)

If the change is purely docs, skip to Quality Pass.

### Implementation Pass (Backend / Frontend)
**Backend SOTA checklist**
- “Small surface area” changes; avoid cascading refactors.
- Clear error handling + typed boundaries.
- Observability hooks where it matters (structured logs; future OTel-friendly). (OpenTelemetry as standard signals: traces/metrics/logs)  
  References: OpenTelemetry docs.  

**Frontend SOTA checklist**
- Accessibility baseline: semantic HTML, keyboard nav, focus management; follow WCAG 2.2 principles.  
  References: WCAG 2.2 + Next.js accessibility docs.  
- Performance mindset: align with Core Web Vitals (LCP/INP/CLS). INP replaces FID.  
  References: Google/Web.dev Core Web Vitals + INP update.  

### Security Pass (AppSec) — MUST for any code change
Use modern baselines:
- **OWASP Top 10** (current release noted by OWASP project; also keep prior risk categories in mind: access control, injection, misconfig, crypto).  
- **OWASP ASVS** for “what to verify” in web apps/services.
- **NIST SSDF (SP 800-218)** as secure SDLC practice set.
- **Supply-chain**: SLSA mindset + avoid dependency/supply chain footguns.
- **Secrets**: no secrets committed; prefer GitHub secret scanning when available.

Security pass outputs:
- Threat model quick scan (1–2 paragraphs): what could go wrong + mitigations.
- Concrete checks: authz, input validation, data exposure, error leakage, secure defaults.

### Quality Pass (QA/Test) — MUST
Modern test mix:
- Unit + integration where logic lives.
- Add/adjust CLI tests if CLI behavior changed.
- If UI flows exist, prefer Playwright E2E for critical paths (happy path + one failure).  
  Reference: Playwright docs.

Quality pass outputs:
- “What I tested” + exact commands.
- What remains untested (explicit).

### UX/Frontend Pass (only if UI touched)
- Check a11y regressions (WCAG 2.2 mindset).
- Check interaction latency (INP) and layout stability (CLS) basics.
- Validate copy + empty states + error states.

### Ops/Release Pass (only if packaging/CLI/CI touched)
- Deterministic execution: prefer repo-local commands:
  - `pnpm build`
  - `node dist/cli.cjs preflight`
  - `node dist/cli.cjs postflight --apply --dry-run`
- Supply-chain sanity: minimize new deps; note risk.

### References (canonical)
- Codex reads AGENTS.md before work.
- OWASP Top 10 + OWASP ASVS.
- NIST SSDF (SP 800-218).
- SLSA framework.
- OpenTelemetry docs.
- Core Web Vitals + INP replaces FID.
- WCAG 2.2.
- Playwright docs.

