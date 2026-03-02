## Run 2026-03-02T20:50:36Z
Threat model quick scan:
The change only modifies scaffolded instruction text in AGENTS managed blocks. Main risk is operator confusion leading to incorrect command execution paths in external repos.

Checks and mitigations:
- Replacing `node dist/cli.cjs` with `vibe` reduces command-path coupling to this repository internals.
- No new command execution surface, network behavior, or secret handling was introduced.
- Existing marker-safe scaffold update semantics remain unchanged.
