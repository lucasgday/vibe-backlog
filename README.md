# vibe-backlog

CLI-first project workflow for solo builders using GitHub issues + postflight artifacts.

This project has two usage modes:

- Canonical and reproducible commands (recommended for agents): `pnpm build && node dist/cli.cjs ...`
- Convenience commands (for shorter typing): global `vibe` via `pnpm link --global` + `hash -r`

Do not rely only on the global bin path. Always keep the canonical path available.

## 0) Requirements

```bash
pnpm -v
gh auth status
git --version
```

## 1) Create a new repo (local + private remote)

```bash
# 1) create folder and git
mkdir my-project && cd my-project
git init -b main

# 2) minimal gitignore
cat > .gitignore <<'EOF'
node_modules
dist
.DS_Store
*.log
.vibe/runtime
.vibe/artifacts
EOF

# 3) first commit
git add .
git commit -m "chore: init"

# 4) create private remote and push
git remote -v
# if empty:
gh repo create <NAME> --private --source=. --remote=origin --push
```

## 2) Install vibe-backlog (from the vibe-backlog repo, dev mode)

This is for developing `vibe-backlog` from source.

```bash
# inside vibe-backlog repo
pnpm install
pnpm test
pnpm build

# option A (recommended for agents / reproducible)
node dist/cli.cjs --help

# option B (convenience: global "vibe" command)
pnpm link --global
hash -r
vibe --help
```

## 3) Use vibe-backlog in another repo (with global bin already linked)

```bash
cd /path/to/another-repo

# one-time setup for agent-first workflow
vibe init --dry-run
vibe init
# if gh is unavailable, scaffold local files only
# vibe init --skip-tracker

# now these commands are valid
vibe preflight
vibe postflight
vibe postflight --apply --dry-run
```

If you want to avoid global bin drift, run from the vibe-backlog repo path:

```bash
node /path/to/vibe-backlog/dist/cli.cjs preflight
```

## 4) Recommended workflow (Issue-first + Postflight)

```bash
# 0) one-time setup in this repo
vibe init --dry-run
vibe init

# 1) inspect repo + issue state
vibe preflight
vibe status

# 2) set the real active issue id before apply
# Edit .vibe/artifacts/postflight.json and replace:
#   "issue_id": "1"
# with your real issue number, for example:
#   "issue_id": "42"

# 3) validate artifact
vibe postflight

# 4) preview tracker updates first
vibe postflight --apply --dry-run

# 5) apply for real
vibe postflight --apply
```

`preflight` now prints a hint when `.vibe` exists but tracker bootstrap marker is missing.
`status` shows active turn, in-progress issues, hygiene warnings, and branch PR snapshot.

## Agent workflow (AGENTS.md)

This repo supports LLM-driven development. The file `AGENTS.md` is the agent contract:

- Issue-first (one topic = one issue)
- Mandatory preflight -> work -> postflight
- Append-only (never overwrite user notes)
- Multi-pass reviews (Security/Quality/UX/Ops)

LLMs (Codex, Claude, etc.) must read and follow `AGENTS.md` before making changes.

## Canonical commands (recommended)

Use these for deterministic execution:

```bash
pnpm build
node dist/cli.cjs preflight
node dist/cli.cjs status
node dist/cli.cjs init --dry-run
node dist/cli.cjs init
node dist/cli.cjs tracker bootstrap --dry-run
node dist/cli.cjs tracker bootstrap
node dist/cli.cjs postflight
node dist/cli.cjs postflight --apply --dry-run
node dist/cli.cjs postflight --apply
```
