# Matchmaking Flow Pattern

End-to-end flow for VIVERSE multiplayer: connect → create/join room → start game → sync state.

## 1. Connect to Matchmaking

```javascript
await initPlayClient();
await initMatchmakingClient();

// MUST wait for onConnect before setActor
await new Promise((resolve) => {
  matchmakingClient.on("onConnect", resolve);
});

await matchmakingClient.setActor({
  session_id: user.account_id,
  name: user.displayName,
  properties: {}
});
```

## 2. Create or Join Room

Before creating/joining, clear stale room state (important for repeated tests and tab/device switching):

```javascript
// best-effort cleanup
await closeRoom();   // only works if host; safe to ignore failure
await leaveRoom();   // safe to ignore failure
disconnectMultiplayer();
disconnectMatchmaking();
```

**Create**:
```javascript
const res = await matchmakingClient.createRoom({
  name: "Chess Room",
  mode: "Room",
  maxPlayers: 2,
  minPlayers: 2,
  properties: {}
});
const room = res?.room ?? res;
if (room?.id) { /* room created */ }
```

**Join**:
```javascript
const res = await matchmakingClient.joinRoom(roomId);
const room = res?.room ?? res;
if (room?.id) { /* joined */ }
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
