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

# create a starter postflight artifact (required before postflight/apply)
mkdir -p .vibe/artifacts
cat > .vibe/artifacts/postflight.json <<'EOF'
{
  "version": 1,
  "meta": {
    "timestamp": "2026-01-01T00:00:00.000Z",
    "actor": "agent",
    "mode": "cli"
  },
  "work": {
    "issue_id": "1",
    "branch": "main",
    "base_branch": "main"
  },
  "checks": {
    "tests": {
      "ran": false,
      "result": "skipped"
    }
  },
  "tracker_updates": [
    {
      "type": "comment_append",
      "body": "Initial postflight draft."
    }
  ],
  "next_actions": [
    "Replace this line with the next concrete action."
  ],
  "risks": {
    "summary": "Initial draft before real changes.",
    "rollback_plan": "No tracker updates applied yet."
  }
}
EOF

# IMPORTANT: replace placeholder issue_id with your active GitHub issue number
# before any --apply command.
# Replace this field:
#   "issue_id": "1"
# with your real issue id, for example:
#   "issue_id": "42"

# now these commands are valid
vibe preflight
vibe tracker bootstrap --dry-run
vibe tracker bootstrap
vibe postflight
vibe postflight --apply --dry-run
```

If you want to avoid global bin drift, run from the vibe-backlog repo path:

```bash
node /path/to/vibe-backlog/dist/cli.cjs preflight
```

## 4) Recommended workflow (Issue-first + Postflight)

```bash
# 1) inspect repo + issue state
vibe preflight

# 1.1) one-time tracker taxonomy bootstrap (per repo)
vibe tracker bootstrap --dry-run
vibe tracker bootstrap

# 2) create or update postflight artifact
mkdir -p .vibe/artifacts
if [ ! -f .vibe/artifacts/postflight.json ]; then
  cat > .vibe/artifacts/postflight.json <<'EOF'
{
  "version": 1,
  "meta": {
    "timestamp": "2026-01-01T00:00:00.000Z",
    "actor": "agent",
    "mode": "cli"
  },
  "work": {
    "issue_id": "1",
    "branch": "main",
    "base_branch": "main"
  },
  "checks": {
    "tests": {
      "ran": false,
      "result": "skipped"
    }
  },
  "tracker_updates": [
    {
      "type": "comment_append",
      "body": "Initial postflight draft."
    }
  ],
  "next_actions": [
    "Replace this line with the next concrete action."
  ],
  "risks": {
    "summary": "Initial draft before real changes.",
    "rollback_plan": "No tracker updates applied yet."
  }
}
EOF
fi
cat .vibe/artifacts/postflight.json

# 2.1) set the real active issue id before apply
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
node dist/cli.cjs tracker bootstrap --dry-run
node dist/cli.cjs tracker bootstrap
node dist/cli.cjs postflight
node dist/cli.cjs postflight --apply --dry-run
node dist/cli.cjs postflight --apply
```
