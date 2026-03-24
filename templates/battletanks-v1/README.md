# battletanks-v1 (Seeded Template)

This folder is the first file-backed template seed for VIVERSE generation, sourced from:
- Repo: https://github.com/EGalahad/BattleTanks
- Commit: `2d0221f6470c15b9af67ab9e20d88848f1b58048`

## Split Strategy

- `core-engine/upstream-src/`
  - scene/camera/renderer/loop primitives
  - low-level utility modules
- `gameplay/upstream-src/`
  - tank/bullet/powerup gameplay logic
- `bootstrap/upstream-src/`
  - startup and world orchestration

## Why this split

This mirrors the contract in `template.json`:
- immutable zones protect engine baseline
- editable zones host gameplay and VIVERSE adapter integration

## Next migration step

Convert `upstream-src` slices into runnable template skeleton files under `core-engine/`, `gameplay/`, `adapters/`, and `bootstrap/` with explicit hook markers.

## Runtime lessons to preserve in generated apps

- Lock App ID after first app creation (`.env` is authoritative for republish).
- Ensure JSX icon/symbol import completeness (avoid runtime `ReferenceError` such as missing `RefreshCw` import).
- Preserve tactical arena identity: include maze-like wall map and wall collision by default.
- Ensure styling pipeline is complete (Tailwind/PostCSS if utility classes are generated), so lobby/HUD render as designed.

## Reusable map asset

- `gameplay/maze-layout.json` defines the default wall layout for generated battletanks arenas.

## Imported upstream art assets

- `assets/tank_model_new/` (tank glTF)
- `assets/bullet_model/` (bullet glTF)
- `assets/powerup_model/` (powerup glTF)
