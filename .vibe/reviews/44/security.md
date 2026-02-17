# Security Pass

- Threat model quick scan:
  - PR body autofill can accidentally overwrite meaningful reviewer context if replacement scope is too broad.
  - Review retry loops can create noisy issue churn or mask unresolved findings if termination signals are ambiguous.
- Mitigations implemented:
  - TODO detection/autofill is restricted to rationale sections only (`Architecture`, `Why`, `Alternatives`).
  - Non-rationale sections remain untouched.
  - Retry termination reasons are explicit and persisted in summary artifacts.
  - Artifact persistence guard fails closed when tracked changes remain after `autopush`.
- Security checks:
  - No auth/authz surface changes.
  - No new dependency or secrets handling changes.
  - GitHub mutation paths remain explicit (`gh pr edit`, comments/review publishing) with unchanged command contracts.
