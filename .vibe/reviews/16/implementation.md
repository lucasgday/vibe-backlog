## Run 2026-03-02T19:43:57Z
- Scope: issue #16 (`feat(ui): dashboard shell for local project cockpit`).
- Implemented a new local cockpit module at `src/ui/cockpit.ts` with:
  - Workspace project discovery (`.git` marker, root + first-level repos).
  - Route layer for `/`, `/api/projects`, `/api/project-status`, `/healthz`.
  - Responsive dashboard shell (header/sidebar/main), project selector, workspace path visibility, and baseline branch/turn/issue status cards.
  - `startCockpitServer` / `stopCockpitServer` lifecycle for CLI usage.
- Wired CLI command `ui serve` in `src/cli-program.ts` with host/port/workspace options and graceful SIGINT/SIGTERM shutdown.
- Added docs mention for `ui serve` in README canonical command list and command summary.
