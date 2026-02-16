# Ops/Release Pass

- New CLI entrypoint: `vibe init`.
- Release impact is additive; existing commands remain backward-compatible.
- Recommended rollout path:
  - validate `vibe init --dry-run` in a target repo
  - then run `vibe init` and confirm tracker/bootstrap and generated files.
