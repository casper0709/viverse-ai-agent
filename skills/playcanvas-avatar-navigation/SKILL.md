---
name: playcanvas-avatar-navigation
description: Physics-based avatar movement, colliders, and camera follow in PlayCanvas + Ammo.js scenes
prerequisites: [PlayCanvas engine, Ammo.js physics, HTML canvas]
tags: [playcanvas, physics, avatar, navigation, ammo.js]
---

# PlayCanvas Avatar Navigation

Add physics-based avatar movement to any PlayCanvas scene with Ammo.js. This skill covers ground planes, building colliders, rigidbody avatar controllers, camera systems, and the critical physics cleanup patterns that prevent crashes.

## When To Use This Skill

Use this when a project needs:
- A user-controllable avatar walking/flying on 3D geometry
- Physics colliders for buildings or terrain
- Third-person camera following the avatar
- Safe entity creation/destruction without Ammo.js crashes

## Prerequisites

- PlayCanvas engine loaded (`pc` global)
- Ammo.js initialized: `await new Promise(r => pc.WasmModule.setConfig('Ammo', { glueUrl, wasmUrl, fallbackUrl })); pc.WasmModule.getInstance('Ammo', r);`
- A canvas element for the PlayCanvas app

## Quick-Start Checklist

1. **Initialize physics** — Load Ammo.js WASM before creating the PlayCanvas app
2. **Create ground plane** — Static rigidbody + box collision (see [ground-and-colliders.md](patterns/ground-and-colliders.md))
3. **Add building colliders** — Generate from bounding box data or mesh geometry
4. **Spawn avatar** — Dynamic rigidbody + sphere collision (see [avatar-controller.md](patterns/avatar-controller.md))
5. **Set up camera** — Third-person orbit with follow mode (see [camera-follow.md](patterns/camera-follow.md))
6. **Handle cleanup** — ALWAYS use the safe destroy pattern (see [safe-physics-cleanup.md](patterns/safe-physics-cleanup.md))

## Critical Gotchas

> [!CAUTION]
> **Never call `entity.destroy()` directly on entities with rigidbody/collision components.** This will crash Ammo.js with "Cannot destroy object" assertions. Always use the safe destroy pattern.

> [!CAUTION]
> **PlayCanvas 2.14.4+ mesh colliders crash on ASM.js Ammo builds.** The engine calls `.at()` on Emscripten arrays that don't support it. Use the Vite build plugin to patch this. See [ammo-compatibility.md](patterns/ammo-compatibility.md).

> [!WARNING]
> **Parent entity destruction also destroys children.** If a parent entity (e.g., `landmark`) has children with physics components (e.g., building colliders), the parent MUST go through physics-safe cleanup too.

> [!WARNING]
> **Claim the canvas synchronously.** Always create `new pc.Application(canvas)` synchronously, then load Ammo.js asynchronously, then call `app.start()`. If you `await` Ammo before creating the Application, React may unmount the canvas during the wait, causing `Cannot read properties of null (reading 'id')`. See [ammo-compatibility.md](patterns/ammo-compatibility.md).

> [!IMPORTANT]
> **Reset camera distance when switching models.** The camera distance from the previous model persists and can cause a "black screen" effect if it's far larger than the new model.

> [!WARNING]
> **Missing Engine Dependency (`window.pc`)**: If your scene logic hangs indefinitely on "Initializing Engine" or fails to start, ensure `playcanvas` is explicitly imported and bound to the window object: `import * as pc from 'playcanvas'; window.pc = pc;`. Without this global binding, physics bridges (like Ammo.js) will fail to locate the engine instance.

## Pattern Files

| Pattern | Purpose |
|---------|---------|
| [safe-physics-cleanup.md](patterns/safe-physics-cleanup.md) | Prevent Ammo.js crashes during entity destroy |
| [ammo-compatibility.md](patterns/ammo-compatibility.md) | Ammo.js ASM/WASM compatibility, Vite plugin, engine init order |
| [ground-and-colliders.md](patterns/ground-and-colliders.md) | Ground planes, boundary walls, building colliders |
| [avatar-controller.md](patterns/avatar-controller.md) | Rigidbody avatar with WASD + fly controls |
| [camera-follow.md](patterns/camera-follow.md) | Third-person orbit camera with follow mode |

## Example Files

| Example | Purpose |
|---------|---------|
| [debug-tools.md](examples/debug-tools.md) | Debug collider visualization + ghost mode UI |
