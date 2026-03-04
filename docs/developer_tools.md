# VIVERSE Developer Tools Documentation

Official documentation for VIVERSE Developer Tools, including SDKs and services for 3D project development.

## 1. Overview of Tools

### Login & Authentication SDK [Beta]
Access user account information (display name, avatar, account ID) when they join a VIVERSE experience.
- **Access**: Access display name, avatar information, and account information.
- **SSO**: Enables seamless travel between VIVERSE experiences.

### Avatar SDK [Beta]
Download and use a user's avatar file in your VIVERSE experience.
- **Identity**: Integration of end-user avatars for a personalized experience.

### Leaderboard SDK [Beta]
Track high scores and player interaction to boost engagement.

### Matchmaking & Networking SDK [Beta]
Sync game-state between clients for multiplayer experiences.

- **Play Client**: `new viverse.Play()` or `new viverse.play()` — initialize before matchmaking.
- **Matchmaking Client**: `await playClient.newMatchmakingClient(appId)` — rooms, create, join, startGame.
- **Multiplayer Client**: `new play.MultiplayerClient(roomId, appId, userSessionId)` — in-game sync. Use `general.sendMessage` / `general.onMessage` for custom state (e.g. turn-based games).
- **Docs**: [Matchmaking & Networking SDK](https://docs.viverse.com/developer-tools/matchmaking-and-networking-sdk)

**Turn-based sync best practices** (from Chess Battle 2D):
- Prefer **FEN (full board state)** over move deltas — more robust to lost/reordered messages.
- Add a **requestState** flow: clients request state on mount; master responds with current FEN so late joiners catch up.
- Ensure both creator and joiner `await connectMultiplayer()` before entering the game.
- **Critical**: Compute state and FEN synchronously, then call `sendMessage` — never inside a React `setState` updater, or messages may never send.
- See `viverse_ai_agent/skills/viverse-multiplayer/patterns/move-sync-reliability.md` for details.

## 2. Login & Authentication API Reference

### Initialization
```javascript
new viverse.client(options)
```
**Options:**
- `clientId` (string, Required): Your App ID obtained from VIVERSE Studio.
- `domain` (string, Required): Authentication domain, set to `account.htcvive.com`.
- `cookieDomain` (string, Optional): Domain for the authentication cookie.

### Methods

#### `checkAuth()`
Checks if the user is currently authenticated.
- **Returns**: `Promise<object | undefined>`
- **Response Object**:
  - `access_token` (string): Token for API requests.
  - `account_id` (string): Unique user ID.
  - `expires_in` (number): Token lifetime in seconds.
  - `state` (string): Custom state value.

#### `loginWithWorlds(options)`
Redirects to the VIVERSE Worlds login page (Single Sign-On).
- **Options**: `state` (string, Optional) for custom value return.

## 3. Example Implementation (PlayCanvas)

```javascript
window.addEventListener('load', async () => {
  // Initialize client
  globalThis.viverseClient = new globalThis.viverse.client({
    clientId: '{yourAppID}',
    domain: 'account.htcvive.com'
  });

  // Check login status
  const result = await globalThis.viverseClient.checkAuth();
  if (result === undefined) {
    // Trigger login refresh
    globalThis.viverseClient.loginWithWorlds();
  } else {
    // authenticated, use result.access_token
  }
});
```

## 5. VIVERSE PlayCanvas Toolkit

The **VIVERSE PlayCanvas Toolkit** is a specialized extension for the PlayCanvas engine that enables direct publishing and deep integration with the VIVERSE platform.

### Key Components
- **PlayCanvas Extension (Chrome)**: Injects VIVERSE SDK APIs and adds a "VIVERSE" tab to the PlayCanvas Editor.
- **VIVERSE SDK APIs**: Automatically injected APIs for cameras, networking, and player logic.
- **IWorldNavigationService**: Programmatic scene switching and navigation.

### Core APIs
- `EntitySubscribeTriggerEnter`: Listen for interaction events.
- `TeleportAvatar`: Move the user's avatar.
- `NotificationCenterPublish`: Send system-wide notifications.
- `EntityPlayAnimation`: Trigger animations on entities.

### Publishing Flow
1. Install the PlayCanvas Extension from the Chrome Web Store.
2. Link your VIVERSE Studio App ID in the PlayCanvas project settings.
3. Use the "Publish to VIVERSE" button within the extension tab.

## 6. VIVERSE CLI Usage
- **Latest Version**: [v1.3.3](https://www.viverse.com/static-assets/viverse-sdk/1.3.3/index.umd.cjs)
- **General URL**: `https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs`
