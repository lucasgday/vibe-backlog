# Ops Pass

- Determinism: behavior uses repo-local paths and deterministic file set/order.
- Repro validation:
  - `pnpm test`
  - `pnpm build`
- Release risk: low; change is additive and preserves existing files.
- Rollback: revert commit for this issue branch if needed.
