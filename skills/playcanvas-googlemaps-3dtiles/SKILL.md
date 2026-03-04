---
name: playcanvas-googlemaps-3dtiles
description: Streaming, rendering, and decoding Google Maps Photorealistic 3D Tiles in PlayCanvas
prerequisites: [PlayCanvas engine, 3d-tiles-renderer, Google Maps API Key]
tags: [playcanvas, google-maps, 3d-tiles, draco, gltf]
---

# Google Maps 3D Tiles Streaming (PlayCanvas)

This skill covers how to successfully stream, decode, and render Google Maps Photorealistic 3D Tiles into a WebGL engine (like PlayCanvas or Three.js) using the `3d-tiles-renderer` library.

It specifically addresses the complex session handshakes, strict plugin loading architectures in modern versions, and automatic Draco compression deployed by Google.

## When To Use This Skill

Use this when a project needs to:
- Render real-world cities or photorealistic environments using Google Maps data.
- Avoid 400/403 errors when requesting the Maps API.
- Support dynamically compressed (`.drc`/`KHR_draco_mesh_compression`) geometry from Google's servers.

## Prerequisites

1. A valid **Google Maps API Key** with the "Map Tiles API" enabled.
2. Install npm dependencies:
```bash
npm install 3d-tiles-renderer three
```

## Quick-Start Checklist

1. **Establish a Secure Session** — You cannot load tiles directly. You must first fetch the `root.json` to extract a unique session token.
2. **Configure TilesRenderer** — Initialize the renderer and set up the URL processor to append the API key and session token.
3. **Register URL Plugin (v0.4.x+)** — Register the URL preprocessor as a plugin.
4. **Register Draco Plugin** — Register the `DRACOLoader` plugin to handle compressed meshes.

## Critical Gotchas & Pitfalls

> [!CAUTION]
> **Draco Compression Crashes**: Google Maps will dynamically serve heavily compressed 3D geometries (`KHR_draco_mesh_compression`) to save bandwidth. If you do not provide a `DRACOLoader` instance, the application will crash with `No DRACOLoader instance provided` when a compressed tile loads.

> [!WARNING]
> **3d-tiles-renderer >= 0.4.x Plugin API**: In newer versions of the `3d-tiles-renderer`, direct property assignment like `tiles.preprocessURL = (...)` is silently ignored. This results in the engine requesting relative URLs against your localhost/VIVERSE Studio origin instead of `tile.googleapis.com`. You **MUST** use `tiles.registerPlugin({ preprocessURL: ... })`.

> [!IMPORTANT]
> **Session Tokens**: Google Maps requires a valid session token attached to every tile payload request (but *not* the root file). You must manually fetch `root.json` first, extract the `?session=` parameter, and inject it into subsequent URLs.

> [!CAUTION]
> **Never use mesh colliders on Google Maps geometry.** The tiles contain millions of triangles that will (1) crash with `.at()` errors on ASM.js Ammo builds, and (2) stack-overflow Ammo's recursive BVH tree builder even with the fix applied. Use AABB box collider ground planes instead. See [physics-colliders.md](patterns/physics-colliders.md).

> [!WARNING]
> **GLB container parsing can throw `Cannot destroy object`.** Always wrap `loadFromUrlAndFilename` callbacks with lifecycle guards and try-catch. See [physics-colliders.md](patterns/physics-colliders.md).

## Implementation Pattern

Here is the robust, production-ready initialization pattern:

```javascript
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

async function initGoogleMaps(apiKey, signal) {
    // 1. Establish DRACO Decoder (use official Google static CDN)
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

    // 2. Fetch root to establish session
    const baseUrl = `https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`;
    const response = await fetch(baseUrl, { headers: { 'X-Goog-Api-Key': apiKey }, signal });
    const data = await response.json();
    
    // Extract session from root.json payload
    let sessionToken = null;
    const findSession = (obj) => {
        if (obj.content && obj.content.uri) {
            const u = new URL(obj.content.uri, "https://dummy.com");
            return u.searchParams.get('session');
        }
        if (obj.children) {
            for (const child of obj.children) {
                const s = findSession(child);
                if (s) return s;
            }
        }
    };
    sessionToken = findSession(data.root);

    // 3. Initialize Renderer
    const tiles = new TilesRenderer(response.url);
    tiles.fetchOptions.headers = { 'X-Goog-Api-Key': apiKey };
    
    // 4. Register URL Interceptor Plugin (CRITICAL FOR 0.4.x+)
    const urlProcessor = (uri) => {
        try {
            const u = new URL(uri, response.url);
            if (!u.searchParams.has('key')) u.searchParams.set('key', apiKey);
            const isRoot = u.pathname.endsWith('root.json');
            if (sessionToken && !isRoot && !u.searchParams.has('session')) {
                u.searchParams.set('session', sessionToken);
            }
            return u.toString();
        } catch (e) { return uri; }
    };
    tiles.registerPlugin({ preprocessURL: urlProcessor });

    // 5. Register DRACO Decoder Plugin (CRITICAL FOR COMPRESSION)
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: dracoLoader }));

    return tiles;
}
```

## Pattern Files

| Pattern | Purpose |
|---------|---------|
| [physics-colliders.md](patterns/physics-colliders.md) | AABB ground plane colliders, why mesh colliders fail, safe GLB loading |
