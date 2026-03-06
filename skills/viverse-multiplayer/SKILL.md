---
name: viverse-multiplayer
description: VIVERSE Matchmaking & Play SDK integration for multiplayer games. Use when building online 2-player games, turn-based sync, room create/join, or custom state sharing.
prerequisites: [VIVERSE Auth (checkAuth, account_id), VIVERSE SDK script tag, VIVERSE Studio App ID]
tags: [viverse, multiplayer, matchmaking, play-sdk, rooms, sync]
---

# VIVERSE Multiplayer Integration

Add online multiplayer with VIVERSE Matchmaking + Play SDK for room lifecycle and in-game sync.

## When To Use This Skill

Use when a project needs:
- Online 2+ player rooms
- Create/join/start game flow
- Custom state sync (turn-based or real-time)
- Reliable rejoin/leave behavior between test sessions

## Read Order (Important)

1. This file (workflow + safety rules)
2. [patterns/matchmaking-flow.md](patterns/matchmaking-flow.md)
3. [patterns/move-sync-reliability.md](patterns/move-sync-reliability.md)
4. [examples/chess-move-sync.md](examples/chess-move-sync.md) for turn-based games

## Prerequisites

1. User authenticated (`checkAuth` success).
2. VIVERSE SDK loaded:
   ```html
   <script src="https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs"></script>
   ```
3. App ID from [VIVERSE Studio](https://studio.viverse.com/).
4. Stable actor identity input (account id + per-connect unique suffix).

## Preflight Checklist

- [ ] `VITE_VIVERSE_CLIENT_ID` matches target app
- [ ] User auth is valid (has account id/token)
- [ ] SDK namespace checked with `window.viverse || window.VIVERSE_SDK`
- [ ] You have cleanup logic for stale rooms
- [ ] You have fallback sync path (room properties) if messages drop

## Implementation Workflow

### 1) Init Play + Matchmaking

```javascript
const v = window.viverse || window.VIVERSE_SDK;
const PlayClass = v.Play || v.play;
globalThis.playClient = new PlayClass();
globalThis.matchmakingClient = await playClient.newMatchmakingClient(appId);
```

### 2) Wait for connect, then set actor

```javascript
matchmakingClient.on("onConnect", async () => {
  await matchmakingClient.setActor({
    session_id: actorSessionId, // recommended: account-based + per-connect suffix
    name: user.displayName,
    properties: {},
  });
});
```

### 3) Create or join room

```javascript
const room = await matchmakingClient.createRoom({
  name: "My Game Room",
  mode: "Room",
  maxPlayers: 2,
  minPlayers: 2,
  properties: {}
});

const joined = await matchmakingClient.joinRoom(roomId);
```

Handle both response shapes:
- `{ room }`
- `{ success, message, room }`

### 4) Start game (host only)

```javascript
await matchmakingClient.startGame();
```

Joiner side listens for `onGameStartNotify`.

### 5) Init MultiplayerClient for sync

```javascript
const MClient = (v?.play || v?.Play)?.MultiplayerClient;
const mp = new MClient(roomId, appId, userSessionId);
await mp.init({ modules: { general: { enabled: true } } });
```

Register listeners before/around init when possible, then bridge both receive channels.

### 6) Send and receive messages

```javascript
mp.general.sendMessage(JSON.stringify({ type: "fen", fen: chess.fen() }));

mp.general.onMessage((raw) => {
  const data = typeof raw === "object" ? raw : JSON.parse(raw);
  if (data.type === "fen") chess.load(data.fen);
});
```

For turn-based games, send full state snapshots (for example FEN), not deltas.

## Room Lifecycle Best Practice

Before create/join in repeated tests:

1. Disconnect multiplayer client
2. If host, close room
3. Leave room
4. Disconnect matchmaking
5. Re-init and set actor again

This prevents stale-room rebinding and "game already started" failures.

## Verification Checklist

- [ ] Two different users can create/join/start
- [ ] Both sides receive game-start signal
- [ ] Host leave closes room for joiners
- [ ] Joiner leave does not break host's ability to restart
- [ ] Move/state sync works for first move and late joiner catch-up
- [ ] No stale room is auto-rejoined after cleanup

## Critical Gotchas

- `setActor` must run after matchmaking connect.
- Register/start handlers before calling `startGame` to avoid missed events.
- Use `mp.general.sendMessage(...)` with bound context; avoid detached fn refs.
- Bridge both `mp.onMessage` and `mp.general.onMessage` in mixed environments.
- Compute and send sync payload before React async state updates.
- Use room-properties fallback (`setRoomProperties/getAvailableRooms`) when websocket delivery is inconsistent.
- Host leave order matters: disconnect multiplayer -> close room -> leave room.
- Reuse of fixed session id can cause stale room rebinding; use fresh per-connect id.

## References

- [patterns/matchmaking-flow.md](patterns/matchmaking-flow.md)
- [patterns/move-sync-reliability.md](patterns/move-sync-reliability.md)
- [examples/chess-move-sync.md](examples/chess-move-sync.md)
- [VIVERSE Matchmaking SDK Docs](https://docs.viverse.com/developer-tools/matchmaking-and-networking-sdk)
