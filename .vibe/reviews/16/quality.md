## Run 2026-03-02T19:43:57Z
What I tested:
- Added route/render smoke coverage in `tests/ui-cockpit.test.ts` for:
  - Dashboard HTML shell rendering (`/`).
  - Projects snapshot route (`/api/projects`).
  - Project status route (`/api/project-status`) and unknown-project `404` handling.
- Added CLI validation coverage in `tests/cli-ui.test.ts` for invalid `--port` fast-fail behavior.

Commands:
- `pnpm test`
- `pnpm build`

Untested:
- Manual browser interaction of `ui serve` runtime (selector switching and visual polish) remains for interactive QA.
