## Run 2026-03-02T19:43:57Z
- Scope: issue #16 (`feat(ui): dashboard shell for local project cockpit`).
- Implemented a new local cockpit module at `src/ui/cockpit.ts` with:
  - Workspace project discovery (`.git` marker, root + first-level repos).
  - Route layer for `/`, `/api/projects`, `/api/project-status`, `/healthz`.
  - Responsive dashboard shell (header/sidebar/main), project selector, workspace path visibility, and baseline branch/turn/issue status cards.
  - `startCockpitServer` / `stopCockpitServer` lifecycle for CLI usage.
- Wired CLI command `ui serve` in `src/cli-program.ts` with host/port/workspace options and graceful SIGINT/SIGTERM shutdown.
- Added docs mention for `ui serve` in README canonical command list and command summary.

## Run 2026-03-02T19:48:15.946Z
- run_id: issue-16-review-pass-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
UI shell, API route structure, and CLI wiring are coherent for the MVP scope; no direct functional defects were found in the reviewed diff.

### Findings
- none
