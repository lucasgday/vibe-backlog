# Security Pass

- External agent execution is explicit via `VIBE_REVIEW_AGENT_CMD` or `--agent-cmd`.
- Added guardrails:
  - no-active-turn / invalid-turn explicit exits
  - clean working-tree requirement for mutating runs
  - autopush blocked on `main`
- Follow-up issue classification defaults to `bug` for defect/regression/security or high severity fallback.
- Residual risk: agent command itself is trusted input and can execute arbitrary shell via configured command.
