# Implementation Pass

## Run 2026-03-02T11:16:56Z
- run_id: manual-issue-22-implementation
- findings: 0

### Summary
Added a managed README workflow scaffold block for `.vibe` repos using deterministic markers (`<!-- vibe:workflow-docs:start -->` / `<!-- vibe:workflow-docs:end -->`) and a Mermaid flowchart. The block is inserted on `vibe init`, refreshed on `vibe update`, and is idempotent (no duplicate managed blocks on rerun). Non-managed README content is preserved.

### Findings
- none

## Run 2026-03-02T11:18:28.416Z
- run_id: issue-22-pr-96-attempt-1
- attempt: 1/5
- findings: 0
- autofix_applied: no

### Summary
The change implements a managed README Mermaid workflow block for `.vibe` repos with explicit markers, hooks it into both `vibe init` and `vibe update`, and bumps scaffold template version to deliver the feature to existing repos via update flow.

### Findings
- none
