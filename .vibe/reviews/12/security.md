# Security Pass

- Threat scan: low risk change, filesystem writes constrained to local workspace under `.vibe/reviews/<issue_id>/`.
- Checks:
  - Input guard: `issueId` must be positive safe integer.
  - Overwrite safety: existing files are never rewritten.
  - Error handling: unexpected FS errors surface and fail command (no silent corruption).
- Residual risk: none beyond standard local filesystem permissions/errors.
