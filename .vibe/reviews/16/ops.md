## Run 2026-03-02T19:43:57Z
Ops/release pass:
- No new dependencies were added; implementation stays within existing Node + execa footprint.
- Build and test remained deterministic under repo-local commands:
  - `pnpm test`
  - `pnpm build`
- CI/supply-chain impact is minimal for this slice because assets are inline and packaged through existing `tsup` pipeline.
