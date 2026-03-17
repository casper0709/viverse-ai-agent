# Matchmaking Flow Pattern

End-to-end flow for VIVERSE multiplayer: connect → create/join room → start game → sync state.

## 1. Connect to Matchmaking

```javascript
await initPlayClient();
await initMatchmakingClient();

// MUST wait for onConnect before setActor
await new Promise((resolve) => {
  matchmakingClient.on("onConnect", resolve);
  matchmakingClient.on("connect", resolve); 
});

// Proactive connect call (Tank Shooter pattern)
if (typeof matchmakingClient.connect === 'function') await matchmakingClient.connect();

// Generate unique session ID to prevent "undefined" or guest collisions
const actorSessionId = `${user.account_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

await matchmakingClient.setActor({
  session_id: actorSessionId,
  name: user.displayName,
  properties: {}
});
```

## 2. Join or Create Room (Robust Flow)

**CRITICAL**: `joinRoom` requires a raw **Room ID string**, not an object.

```javascript
// Scan for existing sessions by name
const roomsRes = await matchmakingClient.getAvailableRooms();
const rooms = roomsRes?.rooms || roomsRes || [];
const existingRoom = rooms.find(r => r.name === "My_Game_Room");

let room;
if (existingRoom) {
  // JOIN: Must use the roomId string
  const roomId = existingRoom.id || existingRoom.roomId;
  const res = await matchmakingClient.joinRoom(roomId);
  room = res?.room || res;
} else {
  // CREATE
  const res = await matchmakingClient.createRoom({
    name: "My_Game_Room",
    mode: "Room",
    maxPlayers: 2,
    minPlayers: 1 // Recommended: allow host entry
  });
  room = res?.room || res;
  
  // HOST AUTO-JOIN: Ensures creator is bound to the room session
  const roomId = room?.id || room?.roomId;
  if (roomId) await matchmakingClient.joinRoom(roomId);
}
```

**List rooms** (optional):
```javascript
const { rooms } = await matchmakingClient.getAvailableRooms();
// Or subscribe: matchmakingClient.on("onRoomListUpdate", setRooms);
```

## 3. Wait for 2 Players, Start Game

Listen for actor changes:
```javascript
matchmakingClient.on("onRoomActorChange", (actors) => {
  if (actors.length >= 2 && amMaster) {
    // Show "Start Game" button
  }
});
```

Master starts:
```javascript
await matchmakingClient.startGame();
```

Non-master listens:
```javascript
matchmakingClient.on("onGameStartNotify", () => {
  // Init MultiplayerClient and enter game
});
```

## 4. Init Multiplayer Client

After start (both master and non-master):
```javascript
const roomId = room.id || room.game_session;
const mp = new (v.play?.MultiplayerClient || v.Play?.MultiplayerClient)(roomId, appId, user.account_id);
// Register listeners BEFORE init (Play SDK example pattern)
mp.onConnected(() => console.log("connected"));
mp.onMessage?.((msg) => console.log("top-level message", msg));
mp.general?.onMessage?.((msg) => console.log("general message", msg));

await mp.init({
  modules: {
    game: { enabled: true },
    networkSync: { enabled: true },
    actionSync: { enabled: true },
    leaderboard: { enabled: true }
  }
});
```

When sending, call `mp.general.sendMessage(payload)` directly (do not detach the function reference), or Play SDK may throw `...reading 'sdk'`.

## 5. Sync Game State

Use `general.sendMessage` / `general.onMessage` for custom state. See [chess-move-sync.md](../examples/chess-move-sync.md).

## 6. Leave / Close Room Order (Important)

To avoid orphaned or unjoinable rooms:

- **Host leave flow**: `disconnect multiplayer -> closeRoom -> leaveRoom`
- **Joiner leave flow**: `disconnect multiplayer -> leaveRoom`

If host leaves with `leaveRoom` before `closeRoom`, room entries may remain visible but fail to join.
