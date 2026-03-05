---
name: viverse-multiplayer
description: VIVERSE Matchmaking & Play SDK integration for multiplayer games. Use when building online 2-player games, turn-based sync, room create/join, or custom state sharing.
prerequisites: [VIVERSE Auth (checkAuth, account_id), VIVERSE SDK script tag, VIVERSE Studio App ID]
tags: [viverse, multiplayer, matchmaking, play-sdk, rooms, sync]
---

# VIVERSE Multiplayer Integration

Add real-time multiplayer to web games using the VIVERSE Matchmaking & Play SDK. Supports room create/join, player sync, and custom game state.

## When To Use This Skill

Use when a project needs:
- Online 2+ player games (e.g. chess, card games)
- Room-based matchmaking (create room, join room, list rooms)
- Custom state sync between players (moves, scores, events)
- Turn-based or real-time multiplayer

## Prerequisites

1. **VIVERSE Auth** — User must be logged in. Use `account_id` from `checkAuth` as `session_id`.
2. **VIVERSE SDK** in `index.html`:
   ```html
   <script src="https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs"></script>
   ```
3. **App ID** from [VIVERSE Studio](https://studio.viverse.com/).

## Quick-Start

### 1. Initialize Play & Matchmaking Clients

```javascript
const v = window.viverse || window.VIVERSE_SDK;
const PlayClass = v.Play || v.play;
globalThis.playClient = new PlayClass();

globalThis.matchmakingClient = await playClient.newMatchmakingClient(appId);
```

> [!IMPORTANT]
> The SDK may expose `v.Play` or `v.play` (capitalization varies). Check both.

### 2. Wait for Connection, Then Set Actor

**Do not** call `setActor` immediately — the matchmaking client connects asynchronously. Subscribe to `onConnect`:

```javascript
matchmakingClient.on("onConnect", async () => {
  await matchmakingClient.setActor({
    session_id: user.account_id,  // from auth
    name: user.displayName,
    properties: {}
  });
});
```

### 3. Create or Join Room

```javascript
// Create
const room = await matchmakingClient.createRoom({
  name: "My Game Room",
  mode: "Room",
  maxPlayers: 2,
  minPlayers: 2,
  properties: {}
});

// Join by ID
const joined = await matchmakingClient.joinRoom(roomId);
```

Handle response format: `createRoom` / `joinRoom` may return `{ room }` or `{ success, message, room }`. Use `res?.room ?? res`.

### 4. Start Game (Master Client Only)

When 2 players are in the room, the room creator calls:

```javascript
await matchmakingClient.startGame();
```

Non-master players receive `onGameStartNotify`.

### 5. Initialize Multiplayer Client for In-Game Sync

After game start, create a MultiplayerClient for message passing:

```javascript
const MClient = (v?.play || v?.Play)?.MultiplayerClient;
const mp = new MClient(roomId, appId, userSessionId);
await mp.init({ modules: { general: { enabled: true } } });
```

### 6. Send & Receive Custom Messages

```javascript
// Send (prefer FEN for reliability — see patterns/move-sync-reliability.md)
mp.general.sendMessage(JSON.stringify({ type: "fen", fen: chess.fen() }));

// Receive (handle both string and object — SDK may vary)
mp.general.onMessage((raw) => {
  const data = typeof raw === "object" ? raw : JSON.parse(raw);
  if (data.type === "fen") chess.load(data.fen);
});
```

## API Summary

| Matchmaking | Purpose |
|-------------|---------|
| `setActor({ session_id, name, properties })` | Required before create/join |
| `createRoom(config)` | Create room |
| `joinRoom(roomId)` | Join existing room |
| `getAvailableRooms()` | List joinable rooms |
| `leaveRoom()` | Leave current room |
| `startGame()` | Master only; notifies all |
| `disconnect()` | Disconnect matchmaking |

| Events | When |
|--------|------|
| `onConnect` | Client ready — call setActor |
| `onRoomListUpdate` | Room list changed |
| `onJoinRoom` | Joined room |
| `onRoomActorChange` | Players in room changed |
| `onGameStartNotify` | Master started game |
| `onError` | Error occurred |

| MultiplayerClient | Purpose |
|-------------------|---------|
| `general.sendMessage(msg)` | Send to all peers |
| `general.onMessage(cb)` | Receive from peers |
| `disconnect()` | Disconnect and cleanup |

## Gotchas

- **onConnect timing**: setActor must run after onConnect. Do not call setActor right after `newMatchmakingClient`.
- **Response shape**: createRoom/joinRoom may return `{ success, message }` on failure. Check `success === false` before using `room`.
- **Master client**: The room creator is `is_master_client: true`. Only master can call `startGame` and `closeRoom`.
- **Cleanup**: Call `multiplayerClient.disconnect()` when leaving the game or unmounting.
- **Move sync reliability**: Use **FEN (full board state)** instead of move deltas for turn-based games. Add a `requestState` flow so late joiners can catch up. **Critical**: Compute FEN and call `sendMessage` synchronously — never inside a React `setState` updater, or messages may never send. See [patterns/move-sync-reliability.md](patterns/move-sync-reliability.md).
- **Send context bug**: Do not call detached send refs. Use `mp.general.sendMessage(payload)` directly, otherwise Play SDK may throw `Cannot read properties of undefined (reading 'sdk')`.
- **Receive channel mismatch**: Listen on both `mp.onMessage` and `mp.general.onMessage` (or bridge both to one handler). Some environments only fire one channel.
- **Stale room reuse**: Before create/join during repeated tests, best-effort `closeRoom()` + `leaveRoom()`, then disconnect matchmaking/multiplayer to avoid joining an old room and `"game already started"` errors.
- **Session rebinding**: Using a static `session_id` across repeated tests can rebind to stale rooms. Prefer a fresh client session id per connect cycle.
- **Leave order matters**: Host should `closeRoom()` before/with `leaveRoom()` after disconnecting multiplayer; otherwise rooms can remain visible but unjoinable.
- **Creator state drift**: Do not auto-kick creator UI on `onRoomActorChange` when actor count drops below 2; keep room state so a rejoiner can start again.

## Example Files

| File | Purpose |
|------|---------|
| [patterns/matchmaking-flow.md](patterns/matchmaking-flow.md) | Full flow: connect → create/join → start → sync |
| [patterns/move-sync-reliability.md](patterns/move-sync-reliability.md) | FEN sync, requestState, connection timing |
| [examples/chess-move-sync.md](examples/chess-move-sync.md) | Turn-based chess move sync pattern |

## Reference

- [VIVERSE Matchmaking SDK Docs](https://docs.viverse.com/developer-tools/matchmaking-and-networking-sdk)
- [viverse_sdk_docs.md](../../docs/viverse_sdk_docs.md) §8 — Matchmaking & Play SDK
