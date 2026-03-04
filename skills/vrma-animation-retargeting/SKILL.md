---
name: vrma-animation-retargeting
description: How to correctly retarget VRMA animations onto VIVERSE avatars in PlayCanvas using per-bone frame correction
prerequisites: [PlayCanvas engine, VIVERSE Avatar SDK, VRMA animation files]
tags: [playcanvas, vrma, animation, retargeting, skeleton, viverse, avatar]
---

# VRMA Animation Retargeting for VIVERSE Avatars

Apply VRMA (.vrma) animations onto VIVERSE avatars in PlayCanvas using a manual sampler with per-bone frame correction. This skill covers the complete methodology discovered after extensive debugging — the VIVERSE SDK's built-in animation binder does NOT correctly retarget VRMA onto avatar bones, requiring a fully custom approach.

## The Core Problem

VIVERSE avatars use a **dual-skeleton structure**:
- `Avatar_*` bones — the actual skinned mesh bones (what you see rendered)
- `Normalized_Avatar_*` bones — a parallel normalized rig (only ~10 bones, NOT a full skeleton)

VRMA animations target the **VRM 1.0 normalized skeleton**, which has:
- **Identity local rest rotations** for all bones
- A root (`Avatar_Root`) with a **180° Z rest rotation** (in local space)
- This means all child bones' parent-world-rest is 180°Z × parent-chain

The avatar's `Avatar_*` bones have:
- A root with a **180° Y rest world rotation**
- This creates a **per-bone frame mismatch** between VRMA and avatar skeletons

> [!CAUTION]
> **PlayCanvas's AnimBinder ignores entityPath modifications at runtime.** You CANNOT remap animation curves by mutating `entityPath` after the asset is loaded. You MUST use a fully manual sampler that reads raw keyframe data and applies transforms directly.

> [!IMPORTANT]
> **VRMA animation values include the node's local rest rotation.** The raw value from the animation curve is NOT a delta — it's `rest × delta`. You must strip it: `delta = inv(vrmaLocalRest) × anim`.

> [!WARNING]
> **A single flat frame correction (e.g., negating X and Z) only works for the hips.** Child bones accumulate different parent-chain rotations, so each bone requires its own `frameCorrect` quaternion based on its actual parent world rests in both skeletons.

## The Correct Algorithm

### Step 1: Build the bone map

Collect `Avatar_*` bones only (skip `Normalized_Avatar_*`) using a stripped name comparison:

```javascript
const stripBoneName = (name) => name
    .replace(/^Normalized_Avatar_/i, '')
    .replace(/^Avatar_/i, '')
    .replace(/^J_Bip_[CLR]_/i, '')
    .replace(/[_\- ]/g, '')
    .toLowerCase();
```

### Step 2: Capture avatar parent world rests

At bind pose time (before any animations play), capture:
```javascript
const boneRestWorldQuats = new Map();      // boneName -> bone world rest
const avatarParentWorldQuats = new Map();  // boneName -> parent world rest
for (const [bone, node] of avatarBones) {
    boneRestWorldQuats.set(bone, node.getRotation().clone());
    avatarParentWorldQuats.set(bone, node.parent
        ? node.parent.getRotation().clone()
        : new pc.Quat());
}
```

### Step 3: Extract VRMA local rests AND parent world rests

Instantiate the VRMA container to walk the hierarchy and compute world rests manually (the asset's scene graph is NOT added to the world, so `.getRotation()` won't give world values — compute them by accumulation):

```javascript
const getVrmaRests = (asset) => {
    const localRests = new Map();
    const parentWorldRests = new Map();
    const container = asset.resource;
    if (typeof container.instantiateRenderEntity !== 'function') return { localRests, parentWorldRests };
    const instance = container.instantiateRenderEntity();

    const walk = (node, parentWorldQ) => {
        if (node.name) {
            const key = node.name.replace(/[_\- ]/g, '').toLowerCase();
            localRests.set(key, node.getLocalRotation().clone());
            parentWorldRests.set(key, parentWorldQ.clone());
        }
        const localQ = node.getLocalRotation();
        const nodeWorldQ = new pc.Quat().copy(parentWorldQ).mul(localQ);
        for (const child of node.children || []) walk(child, nodeWorldQ);
    };
    walk(instance, new pc.Quat()); // start with identity root
    instance.destroy();
    return { localRests, parentWorldRests };
};
```

### Step 4: Build the manual sampler

Read raw keyframe data from the animation track. Map each curve to an avatar bone plus its per-bone VRMA frame data:

```javascript
const buildAnimSampler = (asset, animationName) => {
    const { localRests: vrmaLocalRests, parentWorldRests: vrmaParentWorldRests } = getVrmaRests(asset);
    const track = asset.resource?.animations[0]?.resource;
    const boneAnims = [];

    track.curves.forEach(curve => {
        const animNodeName = curve.paths[0].entityPath.at(-1);
        const stripped = animNodeName.replace(/[_\- ]/g, '').toLowerCase();
        const property = curve.paths[0].propertyPath[0];
        const inputData = track._inputs[curve.input]._data;
        const outputData = track._outputs[curve.output]._data;
        const stride = Math.floor(outputData.length / inputData.length);

        let boneName = /* match via HUMANOID_BONES or BONE_ALIASES */;
        if (boneName) {
            boneAnims.push({
                boneName,
                node: avatarBones.get(boneName),
                property, inputData, outputData, stride,
                vrmaLocalRest: vrmaLocalRests.get(stripped),
                vrmaParentWorld: vrmaParentWorldRests.get(stripped) || new pc.Quat(),
                avatarParentWorld: avatarParentWorldQuats.get(boneName) || new pc.Quat(),
            });
        }
    });
    return { duration: track.duration, boneAnims };
};
```

### Step 5: Apply each frame with per-bone frame correction

```javascript
const applyAnimFrame = (sampler, time) => {
    for (const ba of sampler.boneAnims) {
        const v = sampleCurve(ba.inputData, ba.outputData, ba.stride, time);
        if (!v) continue;

        if (ba.property === 'localRotation' && ba.stride === 4) {
            // 1. Strip VRMA local rest to get the pure animation delta
            const tmpAnim = new pc.Quat(v[0], v[1], v[2], v[3]);
            let tmpDelta;
            if (ba.vrmaLocalRest) {
                tmpDelta = new pc.Quat().copy(ba.vrmaLocalRest).invert().mul(tmpAnim);
            } else {
                tmpDelta = tmpAnim.clone();
            }

            // 2. Compute per-bone frame correction quaternion
            //    = inv(avatarParentWorld) × vrmaParentWorld
            const frameCorrect = new pc.Quat()
                .copy(ba.avatarParentWorld).invert()
                .mul(ba.vrmaParentWorld);

            // 3. Conjugate delta into avatar's parent coordinate frame
            //    origLocal = frameCorrect × delta × inv(frameCorrect)
            const fcInv = frameCorrect.clone().invert();
            const origLocal = new pc.Quat().copy(frameCorrect).mul(tmpDelta).mul(fcInv);
            ba.node.setLocalRotation(origLocal);

        } else if (ba.property === 'localPosition' && ba.stride === 3) {
            ba.node.setLocalPosition(v[0], v[1], v[2]);
        }
    }
};
```

### Step 6: Drive the sampler in the update loop

```javascript
app.on('update', (dt) => {
    const anim = avatarEntity._manualAnim;
    if (!anim) return;
    const sampler = isWalking ? anim.walk : anim.idle;
    if (!sampler) return;
    anim.time = (anim.time + dt) % sampler.duration;
    applyAnimFrame(sampler, anim.time);
});
```

## Common Bone Aliases (VRMA → VRM 1.0)

| VRMA name | VRM 1.0 canonical |
|-----------|-------------------|
| `leftUpLeg` | `leftUpperLeg` |
| `leftLeg` | `leftLowerLeg` |
| `leftForeArm` | `leftLowerArm` |
| `leftArm` | `leftUpperArm` |
| `spine1` | `chest` |
| `spine2` | `upperChest` |

## Debugging Tips

- **53 curves bound** = good (all humanoid bones matched)
- **`vrmaParW` vs `avParW`** in logs shows the per-bone frame mismatch — if they differ, frame correction is needed
- **Avatar_Hips worldRot = (0,1,0,0)** = correct rest pose (180°Y around world Y)
- **Hips delta = identity** = animation is at rest pose (expected at frame 0 of idle)

## What NOT To Do

| Approach | Why It Fails |
|----------|-------------|
| Mutate `entityPath` in animation curves | AnimBinder uses pre-compiled bindings; mutations are ignored at runtime |
| Use `Normalized_Avatar_*` bones as a proxy rig | Only ~10 normalized bones exist (spine, hips etc.), not fullskeleton; they share the same 180°Y parent chain as `Avatar_*` anyway |
| Apply a flat 180°Y conjugation (`-x, y, -z, w`) | Only correct for hips; all child bones have different accumulated parent frames, causing arms/legs to swing in wrong planes |
| Apply delta directly without frame correction | Arms point backward because VRMA's local Y maps to a different world axis than avatar's local Y |
| Use `instantiateRenderEntity` world rotations directly | The instance is not in the scene; `.getRotation()` returns local values. Must accumulate world rests manually via parent-child traversal |
