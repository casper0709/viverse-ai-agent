---
name: viverse-avatar-sdk
description: Loading and displaying VIVERSE user avatars (GLB/VRM) in 3D scenes
prerequisites: [VIVERSE Auth integration, PlayCanvas or Three.js]
tags: [viverse, avatar, glb, vrm, playcanvas]
---

# VIVERSE Avatar SDK

Load a user's VIVERSE avatar into your 3D scene. Avatars are GLB files hosted by VIVERSE, accessible after authentication.

## When To Use This Skill

Use this when a project needs:
- Display the user's personalized VIVERSE avatar
- Load a GLB/VRM model into PlayCanvas or Three.js
- Replace a placeholder sphere with the real avatar model

## Prerequisites

- User authenticated via the [viverse-auth](../viverse-auth/) skill
- A 3D engine (PlayCanvas, Three.js, Babylon.js) capable of loading GLB files

## Getting the Avatar URL

After `checkAuth()` returns an `access_token`, use the **Avatar SDK** to fetch profile data:

```javascript
const vSdk = window.viverse || window.VIVERSE_SDK;
const avatarClient = new vSdk.avatar({
    baseURL: 'https://sdk-api.viverse.com/',
    accessToken: accessToken  // from checkAuth().access_token
});

const profile = await avatarClient.getProfile();
// profile.name → user's display name
// profile.activeAvatar?.headIconUrl → 2D avatar thumbnail
// profile.activeAvatar?.avatarUrl → GLB avatar file URL (for 3D)
```

> [!CAUTION]
> `checkAuth()` does **NOT** return avatar URLs or display name. You must use the Avatar SDK `getProfile()` method.

## Loading GLB into PlayCanvas

```javascript
async function loadAvatar(app, avatarUrl, position) {
    // TIP: If avatarUrl is missing, try deriving from headIconUrl:
    // url = headIconUrl.replace('filetype=headicon', 'filetype=model&lod=original');

    if (!avatarUrl) {
        console.warn('No avatar URL — using placeholder sphere');
        return createPlaceholderAvatar(app, position);
    }

    return new Promise((resolve, reject) => {
        // VRM Support: Use explicit pc.Asset to force GLB parser
        // The URL might vary (e.g. filetype=vrm or filetype=model), so we force the handler.
        const asset = new pc.Asset("avatar-asset", "container", {
            url: avatarUrl,
            filename: "avatar.glb" // Critical: Forces container/glb handler
        });

        asset.on('load', () => {
            try {
                const entity = asset.resource.instantiateRenderEntity();
                entity.name = 'avatar';
                app.root.addChild(entity);
                entity.setLocalPosition(position.x, position.y, position.z);

                // Scale Normalization (VRM units vary)
                // 1. Force update transform to get accurate bounds
                entity.syncHierarchy(); 
                
                // 2. Calculate bounds
                const bounds = calculateEntityBounds(entity);
                const currentHeight = bounds.halfExtents.y * 2;
                
                // 3. Rescale to standard height (e.g. 1.75m)
                if (currentHeight > 0.1) {
                    const targetHeight = 1.75;
                    const scale = targetHeight / currentHeight;
                    entity.setLocalScale(scale, scale, scale);
                }

                resolve(entity);
            } catch (e) {
                console.error("Avatar instantiation failed:", e);
                resolve(createPlaceholderAvatar(app, position));
            }
        });

        // Handle load errors (e.g. 400 Bad Request if URL is wrong)
        asset.on('error', (err) => {
             console.warn("Avatar load error:", err);
             resolve(createPlaceholderAvatar(app, position));
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
}
```

## Placeholder Avatar (Fallback)

When no avatar URL is available:

```javascript
function createPlaceholderAvatar(app, position) {
    const avatar = new pc.Entity('avatar');
    avatar.addComponent('render', { type: 'sphere' });
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(0.2, 0.8, 0.3);
    mat.update();
    if (avatar.render?.meshInstances[0]) {
        avatar.render.meshInstances[0].material = mat;
    }
    avatar.setLocalScale(1.5, 1.5, 1.5);
    avatar.setLocalPosition(position.x, position.y, position.z);
    app.root.addChild(avatar);
    return avatar;
}
```

## Adding Physics to the Avatar

After loading the visual model, attach physics components for navigation:

```javascript
// Add physics AFTER the model is loaded
avatar.addComponent('rigidbody', {
    type: 'dynamic',
    mass: 2,
    friction: 0.5,
    restitution: 0,
    angularDamping: 0.99,
    angularFactor: pc.Vec3.ZERO
});
avatar.addComponent('collision', {
    type: 'sphere',
    radius: 0.75
});

avatar.rigidbody.teleport(position.x, position.y, position.z);
avatar.rigidbody.activate();
```

See [avatar-controller.md](../playcanvas-avatar-navigation/patterns/avatar-controller.md) for full movement controls.

## Gotchas

- **CORS**: Avatar URLs from VIVERSE CDN may require CORS headers. PlayCanvas handles this for GLB loading.
- **VRM vs GLB**: VIVERSE avatars may be VRM format (extension of GLB). PlayCanvas loads them as standard GLB containers.
- **Scale variance**: Different avatars have different scales. Always normalize height after loading.
- **Mock mode**: For local development without VIVERSE login, use `null` avatar URL to trigger the placeholder.
- **Dual bone hierarchy**: VIVERSE avatars have TWO bone sets — `Avatar_*` (original, mesh-bound) and `Normalized_Avatar_*` (VRM 1.0, identity rest). Always **target Normalized** for VRMA animations.
- **AnimComponent doesn't work for VRMA**: PlayCanvas AnimBinder ignores modified `entityPath` values. Use **manual animation sampling** instead (see [avatar-animation.md](patterns/avatar-animation.md)).
- **upside-down avatar**: Applying VRM 1.0 rotations to `Avatar_*` bones causes flipped orientation. Target `Normalized_Avatar_*` bones.
- **glTF JSON unavailable**: PlayCanvas discards raw glTF JSON after parsing (`_parser` is `undefined`). Use bone name normalization instead.
- **Bone naming aliases needed**: VIVERSE uses `Spine1`/`Spine2` (not `Chest`/`UpperChest`), `HandThumb1`/`2`/`3` (not `ThumbMetacarpal`/`Proximal`/`Distal`), `EyeL`/`EyeR` (not `LeftEye`/`RightEye`).

## Pattern Files

| Pattern | Purpose |
|---------|---------|
| [avatar-animation.md](patterns/avatar-animation.md) | Manual VRMA animation sampling with bone normalization (the correct approach) |
| [avatar-animation-troubleshooting.md](patterns/avatar-animation-troubleshooting.md) | Step-by-step T-pose debugging, root causes, real-world debugging timeline |

## Example Files

| Example | Purpose |
|---------|---------|
| [glb-avatar-loader.md](examples/glb-avatar-loader.md) | End-to-end avatar loading example |

