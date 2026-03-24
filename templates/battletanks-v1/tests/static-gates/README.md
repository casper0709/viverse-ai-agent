# Static Gates

Required static checks for battletanks-v1:

1. No writes to immutable paths.
2. Injection hooks present:
   - GameManager.start auth gate
   - IPlayerInput abstraction
   - SyncManager.tick loop hook
3. No placeholder app IDs in source outputs.
4. No direct unmanaged SDK usage outside adapters.
5. No undefined JSX/runtime symbols in generated modules.
   - Example blocker: `ReferenceError: RefreshCw is not defined`.
   - If a symbol is referenced in JSX/code, it must exist in module scope via import/declaration.
6. App ID immutability after first creation.
   - Once `.env` has valid `VITE_VIVERSE_CLIENT_ID`, later fix/rebuild/republish steps must not rewrite it.
7. No unprocessed Tailwind directives in built CSS.
   - Blocker signatures: `@tailwind` / `@apply` present in `dist/assets/*.css`.
8. Maze map baseline present.
   - Generated arena must include wall geometry + movement collision (not empty ground-only map).
