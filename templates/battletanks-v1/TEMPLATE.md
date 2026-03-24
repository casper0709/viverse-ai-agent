# battletanks-v1 Template Contract

This template defines a VIVERSE-compatible tank game baseline derived from `EGalahad/BattleTanks` and adapted for the current VIVERSE agent workflow.

## Guardrails

- Immutable engine/asset zones must not be rewritten by generated feature tasks.
- Gameplay and adapter zones are the primary customization surface.
- Runtime verification requests must include preview probe evidence.

## Core Runtime Baseline

1. Local tank must always spawn even if matchmaking actor resolution is delayed.
2. Keyboard controls must work in iframe context (`preventDefault`, focus acquisition, WASD/Arrow/Space capture).
3. Auth profile chain must not stop at generic placeholders (`VIVERSE Player`/`VIVERSE Explorer`) when better identity sources exist.
4. `.env` App ID integrity must be preserved across fix loops.
5. App ID lifecycle is create-once then lock:
   - first publish may create app id then write `.env` `VITE_VIVERSE_CLIENT_ID=<id>`
   - all fix/rebuild/republish tasks must reuse same `.env` app id unless user explicitly requests migration.
6. UI icon/runtime symbol completeness is mandatory:
   - any JSX symbol used (for example `RefreshCw`) must be imported in that module.
   - generated output must avoid runtime `ReferenceError` from missing imports.
7. Arena map baseline must include visible maze walls and collision:
   - map is not just an empty plane; walls define tactical lanes/cover.
   - tank movement must block against walls and arena bounds.
8. Styling baseline must compile in production:
   - if using Tailwind utility classes, template output must include working Tailwind/PostCSS pipeline.
   - unprocessed `@tailwind/@apply` output in dist CSS is a blocker.

## Hook Inventory

- `GameManager.start()` auth-gated startup
- `IPlayerInput` abstraction
- `SyncManager.tick()` loop integration

## Customizable Surface

- scoring and victory model
- round timers and respawn policy
- powerup cadence and balancing
- HUD theme tokens and labels

## Non-Customizable Surface

- core engine loop/camera primitives
- heavy immutable assets bundle
- runtime gate harness in `tests/runtime-gates`
