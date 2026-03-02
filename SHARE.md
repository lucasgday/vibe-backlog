# Share Playbook

Operational guide to share `vibe-backlog` in three phases:

1. personal pilot
2. private beta with friends
3. public social launch

## Phase 1: Personal Pilot (Your Repo)

Goal: verify the full loop in a real repo you control.

Checklist:

- Install and build locally from source.
- Link global binary (`pnpm link --global`) or use canonical `node dist/cli.cjs`.
- Run `vibe init --dry-run` then `vibe init` in target repo.
- Run `vibe preflight`.
- Create/update `.vibe/artifacts/postflight.json` with real `issue_id`.
- Run `vibe postflight` then `vibe postflight --apply --dry-run`.
- Confirm generated files are clear (`AGENTS.md`, `.vibe/contract.yml`, README managed block).

Exit criteria:

- You can complete preflight -> work -> postflight without manual workarounds.
- Outputs are understandable to you without reading source code.

## Phase 2: Private Beta (Friends)

Goal: validate onboarding clarity and identify friction points.

Checklist:

- Send the short invite message below.
- Share the "beta quickstart" command block.
- Ask each beta tester for:
  - first blocker command
  - most useful command
  - one thing that was unclear
- Track feedback in GitHub issues (one issue per topic).

Exit criteria:

- At least 3 testers complete quickstart.
- No critical blocker remains in setup flow.

## Phase 3: Public Social Launch

Goal: collect broader inbound interest once onboarding is stable.

Checklist:

- Ensure no open P0/P1 issues affecting CLI basics.
- Keep a short CTA:
  - "comment beta" / "DM me"
- Be explicit that this is CLI-first and UI is roadmap.
- Point to README + quickstart section.

Exit criteria:

- People can self-serve first run from docs.
- You can triage incoming feedback within 24-48h.

## Beta Quickstart (Send This)

```bash
# 1) in vibe-backlog repo
pnpm install
pnpm build
pnpm link --global
hash -r

# 2) in your target repo
cd /path/to/your-repo
vibe init --dry-run
vibe init
vibe preflight
vibe postflight --apply --dry-run
```

Fallback without GitHub CLI:

```bash
vibe init --skip-tracker
```

## Message Templates

### Beta DM (short)

```text
Estoy probando una CLI para flujo issue-first + postflight en repos con GitHub.
Si te copa, te paso un quickstart de 5 minutos para probarla en un repo de prueba.
Me sirve feedback de fricción de instalación y claridad de comandos.
```

### Beta DM (expanded)

```text
Estoy abriendo beta chica de vibe-backlog.
Es una CLI para trabajar issue-first con guardrails de git/tracker y cierre con postflight.
¿Te sumás a probarla 10-15 minutos en un repo personal?
Si querés, te paso quickstart + checklist y me dejás feedback de onboarding.
```

### Social Post (X/LinkedIn)

```text
Estoy abriendo beta de vibe-backlog: una CLI para operar proyectos con issue-first + postflight, guardrails de git/tracker y review flow.
Es CLI-first (UI queda en roadmap).
Si querés probarla en tu repo, comentá “beta” y te paso quickstart.
```

## Common Setup Friction

- `vibe: command not found`
  - rerun `pnpm link --global` and `hash -r`
- `gh` not available
  - use `vibe init --skip-tracker`
- confused between global and canonical execution
  - run canonical path from this repo: `node dist/cli.cjs <command>`

## Canonical References

- Main docs and command references: [README.md](./README.md)
- Agent workflow contract: [AGENTS.md](./AGENTS.md)
