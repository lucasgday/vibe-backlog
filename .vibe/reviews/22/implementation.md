# Implementation Pass

## Run 2026-03-02T11:16:56Z
- run_id: manual-issue-22-implementation
- findings: 0

### Summary
Added a managed README workflow scaffold block for `.vibe` repos using deterministic markers (`<!-- vibe:workflow-docs:start -->` / `<!-- vibe:workflow-docs:end -->`) and a Mermaid flowchart. The block is inserted on `vibe init`, refreshed on `vibe update`, and is idempotent (no duplicate managed blocks on rerun). Non-managed README content is preserved.

### Findings
- none
