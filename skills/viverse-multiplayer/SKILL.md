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
   <script src="https://www.viverse.com/static-assets/play-sdk/1.0.1/play-sdk.umd.js"></script>
   ```
3. App ID from [VIVERSE Studio](https://studio.viverse.com/).
4. Stable actor identity input (account id + per-connect unique suffix).

2. **MUST** initialize the `MultiplayerClient` with `await mp.init({ modules: { general: { enabled: true } } })`. If this is skipped, `mp.general` will fail.
3. **MUST** use **Session-Matching Alpha** to find local `actor_id`: Match local `session_id` against the list in `mc.getMyRoomActors()` or `room.actors`.
4. **MUST NOT** call `mc.getActorId()` (Hallucination - Does not exist).
5. **MUST** run `setActor` immediately after the matchmaking client connects or joins.
4. **MUST** use a unique `session_id` for each connect to prevent stale room rebinding.

## Implementation Workflow

### 1) Init Play + Matchmaking (Hardened v3.7)

Do NOT rely on automatic connection. Use a Promise to guarantee the client is ready.

```javascript
const v = window.vSdk || window.viverse || window.VIVERSE_SDK;
const PlayClass = v.Play || v.play || window.play?.Play || window.Play;
const playClient = new PlayClass();

const mc = await playClient.newMatchmakingClient(appId);

// MANDATORY: Proactive unique session ID
const actorSessionId = `${user.accountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// MANDATORY: Explicit Connect with Promise Race
const isConnected = await new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    mc.on("onConnect", () => done(true));
    mc.on("connect", () => done(true));
    if (typeof mc.connect === 'function') mc.connect().catch(() => {});
    setTimeout(() => done(false), 5000); // 5s timeout
});

if (!isConnected) console.warn('Matchmaking connection could not be verified, proceeding anyway...');

// MANDATORY: Manual actor setup (v3.8)
// Use the UNIQUE actorSessionId as the session_id to prevent stale session rebinding
await mc.setActor({
    session_id: actorSessionId,
    name: user.displayName || 'Player',
    properties: { avatarUrl: user.avatarUrl },
});
```

### 3) Join or Create Room (Robust Flow)

**CRITICAL**: `joinRoom` requires a raw **Room ID string**, not an object.

```javascript
// Scan for existing lobby
const roomsRes = await mc.getAvailableRooms();
const rooms = roomsRes?.rooms || roomsRes || [];
const existing = rooms.find(r => r.name === "My_Game_Lobby");

let room;
if (existing) {
  // Join by ID
  const res = await mc.joinRoom(existing.id || existing.roomId);
  room = res?.room || res;
} else {
  // Create
  const res = await mc.createRoom({
    name: "My_Game_Lobby",
    mode: "Room",
    maxPlayers: 2,
    minPlayers: 1 // Allow host to enter immediately
  });
  room = res?.room || res;
  
  // MANDATORY: Host auto-join (ensures session consistency)
  const roomId = room?.id || room?.roomId;
  if (roomId) await mc.joinRoom(roomId);
}
```

### 4) Start game (host only)

```javascript
await matchmakingClient.startGame();
```

Joiner side listens for `onGameStartNotify`.

### 5) Init MultiplayerClient for sync

```javascript
const MClient =
  (v?.play || v?.Play)?.MultiplayerClient ||
  window.play?.MultiplayerClient ||
  window.Play?.MultiplayerClient;
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

### Protocol evolution checklist (required)

When adding a new gameplay message type (for example `WEAPON`, `POWERUP`):

1. Add it to message-type constants used for send.
2. Add it to parser/validator allowlist (`VALID_TYPES` or equivalent).
3. Add handler branch on receiver side.
4. Add test log/assertion for message acceptance.

If step 2 is missed, packets are silently dropped by strict parsers.

## Room Lifecycle Best Practice

Before create/join in repeated tests:

1. Disconnect multiplayer client
2. If host, close room
3. Leave room
4. Disconnect matchmaking
5. Re-init and set actor again

This prevents stale-room rebinding and "game already started" failures.

### Lobby UX requirements (must-have)

- Show a dedicated `Leave Room` button whenever user is inside a room (host and joiner).
- `Back` should run full lifecycle cleanup; `Leave Room` should leave current room but keep matchmaking connected.
- Host leave order must remain:
  1. disconnect multiplayer
  2. close room
  3. leave room
- Joiner leave order must remain:
  1. disconnect multiplayer
  2. leave room
- After leave/create/join failure, refresh room list immediately to remove stale or not-joinable entries from UI.
- Block `Start Match` until room has required player count (for 1v1, `2/2`).
- Auto-refresh room list should not fight user interaction:
  - use slower polling interval by default
  - pause or defer list refresh while user is hovering/focusing/touching the room list
  - keep room ordering stable to prevent "Join" button position jumps

### Mobile lifecycle + zombie-session prevention

- Treat `visibilitychange` / `pagehide` as lifecycle events:
  - if app is backgrounded in active session for too long (for example >10s), return to lobby and run cleanup.
  - on `pagehide`, best-effort call multiplayer lifecycle cleanup.
- Add in-game heartbeat messages from both peers (for example every 2s).
- Host tracks peer heartbeat timeout (for example 12s):
  - if timed out, terminate session gracefully and clean room.
- Handle WebGL context loss (`webglcontextlost`) on mobile resume:
  - trigger session interruption flow and return to lobby rather than keeping a broken white screen.

### Host-authoritative dynamic world state (pickups/buffs)

For collectible gameplay state (pickups, temporary buffs):

1. Host is sole authority for collision/consume decisions.
2. Peers send intent only when needed; host validates and applies.
3. Host broadcasts authoritative delta (affected pickup + affected player fields).
4. Include dynamic state in periodic snapshot fallback (for example `pickups[]`, buff expiry timestamps).
5. Include all combat-relevant fields in respawn/snapshot payloads (weapon, cooldowns, timed buffs, hit feedback timestamps).

## Verification Checklist

- [ ] Two different users can create/join/start
- [ ] Both sides receive game-start signal
- [ ] Host leave closes room for joiners
- [ ] Joiner leave does not break host's ability to restart
- [ ] Move/state sync works for first move and late joiner catch-up
- [ ] No stale room is auto-rejoined after cleanup
- [ ] New message types are accepted by strict parser (not dropped)
- [ ] Host-authoritative pickup/buff flow stays consistent for both peers
- [ ] Respawn/snapshot payloads restore full combat state (not just transform/hp)
- [ ] Room list remains usable under auto-refresh (stable ordering + interaction-safe polling)

## Critical Gotchas

- **Session-Matching Alpha**: To find your `actor_id`, iterate `room.actors` and find the one where `actor.session_id === mySessionId`.
- **MANDATORY**: Do NOT call `getActorId()`.
- Register/start handlers before calling `startGame` to avoid missed events.
- Use `mp.general.sendMessage(...)` with bound context; avoid detached fn refs.
- Bridge both `mp.onMessage` and `mp.general.onMessage` in mixed environments.
- Compute and send sync payload before React async state updates.
- Use room-properties fallback (`setRoomProperties/getAvailableRooms`) when websocket delivery is inconsistent.
- Host leave order matters: disconnect multiplayer -> close room -> leave room.
- Reuse of fixed session id can cause stale room rebinding; use fresh per-connect id.
- Adding send handlers without updating parser allowlist causes silent message loss in production.
- If joiner can directly mutate gameplay-critical state, desync and exploit risk increase; use host-authoritative apply + rebroadcast.

## References

- [patterns/matchmaking-flow.md](patterns/matchmaking-flow.md)
- [patterns/move-sync-reliability.md](patterns/move-sync-reliability.md)
- [examples/chess-move-sync.md](examples/chess-move-sync.md)
- [VIVERSE Matchmaking SDK Docs](https://docs.viverse.com/developer-tools/matchmaking-and-networking-sdk)
