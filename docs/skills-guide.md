# Skills Guide (Best-Practice Usage)

How to use skills without missing critical guidance or wasting tokens.

## Recommended Mode

For most coding tasks, use **skills directly** (no server required):

```text
Read skills/viverse-auth/SKILL.md and integrate auth into my React app.
```

## Three Operating Modes

1. **Skills only (default)**
   - fastest setup
   - lowest token use
2. **Local agent server**
   - use when you want API/chat orchestration
3. **Delegated API tasks**
   - use from scripts or other agent systems

## Skill Selection Matrix

- `viverse-auth`: login, profile, SSO handling
- `viverse-multiplayer`: rooms, game start, state sync
- `viverse-leaderboard`: upload/fetch rankings
- `viverse-avatar-sdk`: 3D avatar loading
- `viverse-world-publishing`: CLI release workflow

## Prompt Template (Low Miss Risk)

Use this exact structure:

```text
Read:
- skills/viverse-auth/SKILL.md
- skills/viverse-multiplayer/SKILL.md

Task:
Integrate online chess room flow in /path/to/project.

Constraints:
- keep existing UI
- no raw account_id in display

Verification:
- run build
- summarize blockers
```

## Token-Efficient Workflow

1. Read only `SKILL.md` first.
2. Read linked `patterns/*.md` only for active sub-problem.
3. Read `examples/*.md` only if implementation is unclear.
4. Avoid loading unrelated skills in the same request.

## Completion Checklist

- [ ] Correct skill(s) were loaded first
- [ ] Preflight checklist from skill was executed
- [ ] Build/test was run after edits
- [ ] App ID/env/publish target are aligned

## Related Docs

- [usage.md](./usage.md)
- [viverse_sdk_docs.md](./viverse_sdk_docs.md)
