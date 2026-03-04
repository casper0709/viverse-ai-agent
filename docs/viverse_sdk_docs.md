# VIVERSE SDK Reference for AI Agents

This document provides technical details for integrating the VIVERSE Framework SDK into WebGL/React projects.

## 1. SDK Installation
Add the following script tag to `index.html`:
```html
<script src="https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs"></script>
```

## 2. Core API Initialization
The SDK is exposed via `window.VIVERSE_SDK`.

```javascript
// Check if SDK is loaded
if (window.VIVERSE_SDK) {
    const sdk = window.VIVERSE_SDK;
    // Initialization logic
}
```

## 3. Authentication (Login SDK)
Use the Login SDK to authenticate users and access their VIVERSE profile.

- **Login**: `sdk.login()` - Opens a login popup.
- **Logout**: `sdk.logout()` - Clears the session.
- **Get User Info**: `sdk.getUserInfo()` - Returns an object containing:
  - `displayName`: User's profile name.
  - `avatarUrl`: URL to the user's VIVERSE avatar (GLB).
  - `userId`: Unique identifier.

## 4. World Creation and Publishing
To transform a project into a VIVERSE World:
1. **Requirements**: A VIVERSE World App ID (created via VIVERSE Studio).
2. **CLI Usage**:
   - `npm install -g @viverse/cli`
   - `viverse-cli auth login`
   - `viverse publish <build_directory>`

## 5. Scripting Requirements
For projects like PlayCanvas being integrated into VIVERSE:
- Use `.mjs` files for custom scripts to support ES modules.
- Use `create-sdk.mjs` injected by the VIVERSE Chrome Extension for deep integration.

### Deep Integration Capabilities (create-sdk.mjs)

The `create-sdk.mjs` file provides advanced services for immersive experiences:

#### 1. Camera Management (CameraService)
Import `CameraService` and `CameraTypes` to control the viewport:
- `switchPov(type)`: Switch between POV types (First Person, Third Person, etc.).
- `switchCamera(cameraEntity)`: Change the active camera.
- `addLayer(layer)` / `removeLayer(layer)`: Manage camera rendering layers.

#### 2. Networking and Multiplayer
- **Networked Plugin**: Synchronizes entity transforms (position/rotation) across clients. Add the "Networking" module in the VIVERSE extension and enable "Transform" synchronization.
- **Play SDK**: For custom state management:
    - Use `playClient` for session management.
    - Use `matchmakingClient` for room connections and player data.
- **Automatic Sync**: The PlayCanvas VIVERSE SDK automatically handles avatar movement and spatial audio networking.

#### 3. Environment Interaction
- **Triggers**: Use the SDK to detect interactions with VIVERSE world objects.
- **Avatar Access**: Real-time access to other users' avatar entities for social features.

## 6. VIVERSE Creator SDK (2025 Updates)

The latest evolution of the framework introduces powerful new APIs for cross-platform interoperability.

### 1. Avatar API (v2)
- **Cross-Platform**: Avatars work across Unity, Web, and Mobile.
- **VRM Support**: Full support for standard VRM avatar files.
- **Outfit Library**: Programmatic access to user outfits and customization.

### 2. Scene API
- **Unity Interconnectedness**: Allows importing custom scenes from Unity directly into VIVERSE spatial experiences.
- **Scene Switching**: Programmatic navigation between different scenes in a world.

### 3. Polygon Streaming SDK
- **High Fidelity**: Embed large-scale, high-quality 3D assets into web experiences without performance bottlenecks.
- **Dynamic Optimization**: Assets are streamed and LOD-ed (Level of Detail) in real-time based on viewer position.

### 4. VIVERSE Studio & Worlds Creator Program
- **Engagement Metrics**: Track unique viewers, likes, and session times via the Studio dashboard.
- **Monetization**: Part of the new Worlds Creator Program for sustainable content creation.

## 7. VIVERSE PlayCanvas Toolkit Specifics

The toolkit extends PlayCanvas with high-level services:

### 1. IWorldNavigationService
Enables programmatic navigation between different scenes or worlds.
- `switchWorld(worldId)`: Change the active world.
- `switchScene(sceneId)`: Change the scene within the current world.

### 2. Event Bridge (No-Code to Code)
Allows PlayCanvas scripts to interoperate with VIVERSE's no-code logic tools.
- `on('viverse:event', callback)`: Listen for events triggered via the VIVERSE UI/No-code layer.
- `emit('viverse:event', data)`: Send events back to the VIVERSE system.

### 3. Multiplayer & Avatars
- **Automatic Sync**: Position, rotation, and animations of the local avatar are synced automatically.
- **Spatial Audio**: Powered by the toolkit's networking layer for proximity-based voice chat.

---

## 8. Matchmaking & Play SDK (Web / React)

The VIVERSE Matchmaking & Networking SDK enables multiplayer experiences in any web project (not just PlayCanvas). Use when building 2-player games, turn-based sync, or custom state sharing.

**Source**: [VIVERSE Matchmaking SDK Docs](https://docs.viverse.com/developer-tools/matchmaking-and-networking-sdk)

### Prerequisites

- **Auth**: User must be authenticated via Login SDK (`checkAuth`). Use `account_id` as `session_id`.
- **App ID**: From VIVERSE Studio.

### 8.1 Initialize Play Client

```javascript
const v = window.viverse || window.VIVERSE_SDK;
const PlayClass = v.Play || v.play;
globalThis.playClient = new PlayClass();
```

### 8.2 Initialize Matchmaking Client

```javascript
const matchmakingClient = await playClient.newMatchmakingClient(appId);
```

**Important**: Wait for `onConnect` before calling `setActor`. Subscribe to events:

```javascript
matchmakingClient.on("onConnect", async () => {
  await matchmakingClient.setActor({
    session_id: accountId,  // from auth
    name: displayName,
    properties: {}
  });
});
```

### 8.3 Matchmaking API Summary

| Method | Description |
|--------|-------------|
| `setActor({ session_id, name, properties })` | Must be called before create/join. Use auth `account_id` as `session_id`. |
| `createRoom({ name, mode, maxPlayers, minPlayers, properties })` | Create a room. Returns `{ room }` or `{ success, message }` on failure. |
| `joinRoom(roomId)` | Join by room ID. Returns `{ room }` on success. |
| `leaveRoom()` | Leave current room. |
| `getAvailableRooms()` | Get list of joinable rooms. Returns `{ success, rooms }`. |
| `startGame()` | Master client only. Notifies all players to begin. |
| `disconnect()` | Disconnect matchmaking client. |

### 8.4 Matchmaking Events

| Event | When | Payload |
|-------|------|---------|
| `onConnect` | Client connected to SDK | — |
| `onRoomListUpdate` | Room list changed | `rooms[]` |
| `onJoinRoom` | Joined a room | `room` |
| `onRoomActorChange` | Actors in room changed | `actors[]` |
| `onGameStartNotify` | Master started game | — |
| `onError` | Error occurred | `error` |

### 8.5 Multiplayer Client (In-Game Sync)

After joining a room and starting the game, create a `MultiplayerClient` for real-time sync:

```javascript
const MClient = (window.viverse?.play || window.play)?.MultiplayerClient;
const multiplayerClient = new MClient(roomId, appId, userSessionId);
await multiplayerClient.init({ modules: { general: { enabled: true } } });
```

### 8.6 General Module (Custom Game State)

Use `general.sendMessage` / `general.onMessage` for turn-based or custom sync (e.g. chess moves):

```javascript
// Send
multiplayerClient.general.sendMessage(JSON.stringify({ type: "move", from: "e2", to: "e4" }));

// Receive
multiplayerClient.general.onMessage((raw) => {
  const data = JSON.parse(raw);
  if (data.type === "move") applyMove(data.from, data.to);
});
```

### 8.7 Other Modules

- **NetworkSync**: `updateMyPosition`, `onNotifyPositionUpdate` — for 3D position sync.
- **ActionSync**: `competition`, `onCompetition` — for action arbitration.
- **Leaderboard**: `leaderboardUpdate`, `onLeaderboardUpdate` — real-time scores.

### Gotchas

- SDK may expose `v.Play` or `v.play` (capitalization varies).
- `setActor` must run **after** `onConnect`. Do not call it immediately after `newMatchmakingClient`.
- `createRoom` / `joinRoom` may return `{ success, message, room }` — check `room` or `success`.
