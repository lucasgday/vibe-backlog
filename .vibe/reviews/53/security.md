# Security Pass

## Threat model quick scan
- Review gate bypass risk: stale markers could skip a required re-review if policy context is ignored.
- PR-thread automation risk: batch operations could mutate unintended threads if targeting logic is unsafe.

## Mitigations implemented
- Gate dedupe now supports policy marker matching (`HEAD + policy`) while preserving legacy compatibility.
- `--force-review` provides explicit override to force a fresh run.
- `review threads resolve` enforces explicit target mode (`--thread-id` xor `--all-unresolved`).
- Mutation path remains auditable via explicit reply comments before resolve.

## Concrete checks
- Input validation:
  - `pr open` validates mutually exclusive flags (`--skip-review-gate` vs `--force-review`).
  - `review threads resolve` validates PR id and target mode.
- Secure defaults:
  - dedupe remains conservative when policy marker mismatches.
- Error handling:
  - per-thread failures are surfaced and return non-zero.

## Summary
No new high-risk security regression identified. The changes improve review gate integrity and keep thread mutation behavior explicit and auditable.

## Findings
- none
