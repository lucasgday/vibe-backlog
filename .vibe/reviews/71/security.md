## 2026-02-19 Security Pass (issue #71)

Threat model quick scan:
- Risk: accidental deletion of local work if stale-branch classification is too permissive.
- Mitigation: new auto-delete path requires both conditions: merged PR exists AND local branch head SHA equals merged PR head SHA.

Concrete checks:
- Destructive action remains explicit `git branch -D`, but now gated by stronger evidence.
- On gh lookup failure, behavior degrades safely to warning + skip (no deletion broadening).
- No new secrets, auth flows, or data exposure paths added.
