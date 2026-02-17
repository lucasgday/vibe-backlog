# Ops Pass

- Change set is CLI/core-only with deterministic local verification.
- No new dependencies introduced.
- `review` autopush now has a stronger persistence invariant:
  - summary appended to postflight before commit,
  - one final commit/push,
  - explicit failure if tracked changes remain.
- Operational impact:
  - clearer termination telemetry for repeated review runs,
  - fewer wasted attempts when autofix does not produce real progress.
