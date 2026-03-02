## Run 2026-03-02T19:43:57Z
Growth pass:
- This shell increases activation by reducing setup ambiguity: users can immediately see workspace scope, available repos, and whether a repo has active turn linkage.
- Next measurable opportunities:
  - Add event counters for `project_selected`, `status_loaded`, and `no_turn_detected` to quantify onboarding friction.
  - Add CTA nudges when turn context is missing (e.g., inline `vibe turn start --issue <n>` copy button) to improve first successful workflow completion.
