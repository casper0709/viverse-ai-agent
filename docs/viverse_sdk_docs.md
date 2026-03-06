# VIVERSE SDK Reference (Operational)

Concise reference for AI agents and developers integrating VIVERSE SDKs in web apps.

## Read Order

1. `skills/viverse-auth/SKILL.md`
2. `skills/viverse-multiplayer/SKILL.md`
3. `skills/viverse-leaderboard/SKILL.md`
4. `skills/viverse-world-publishing/SKILL.md`

Use this file as a cross-skill quick map, not a replacement for skill workflows.

## Core Setup

### SDK script

```html
<script src="https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs"></script>
```

### Namespace compatibility

Always check both:
- `window.viverse`
- `window.VIVERSE_SDK`

### Vite env variables

- `VITE_VIVERSE_CLIENT_ID=<app_id>`
- `VITE_VIVERSE_LEADERBOARD_NAME=<leaderboard_api_name>`

> `import.meta.env` is build-time. Rebuild after env changes.

## SDK Surface Map

- **Auth/Login SDK**
  - `new vSdk.client({ clientId, domain: "account.htcvive.com" })`
  - `checkAuth()`, `loginWithWorlds()`, `logout()`
- **Avatar SDK**
  - `new vSdk.avatar({ accessToken, appId, clientId, baseURL })`
  - `getProfile()`
- **Matchmaking SDK**
  - `playClient.newMatchmakingClient(appId)`
  - `setActor`, `createRoom`, `joinRoom`, `leaveRoom`, `startGame`
- **Play MultiplayerClient**
  - `new MultiplayerClient(roomId, appId, sessionId)`
  - `general.sendMessage`, `general.onMessage`
- **Leaderboard SDK**
  - `new vSdk.gameDashboard({ token })`
  - `uploadLeaderboardScore`, `getLeaderboard`

## Integration Blueprint (Web/React)

1. Authenticate user (`checkAuth`) and keep auth state in one source.
2. Fetch profile via Avatar SDK with fallback chain.
3. Initialize feature clients (matchmaking/leaderboard) after auth.
4. Build gameplay sync with reconnect-safe room lifecycle.
5. Publish with App ID/env match and fresh build.

## Matchmaking & Play Quick Reference

```javascript
const v = window.viverse || window.VIVERSE_SDK;
const PlayClass = v.Play || v.play;
const playClient = new PlayClass();
const mc = await playClient.newMatchmakingClient(appId);

mc.on("onConnect", async () => {
  await mc.setActor({ session_id: actorSessionId, name: displayName, properties: {} });
});
```

Critical notes:
- call `setActor` after connect
- handle response shape differences (`res.room ?? res`)
- register start/message handlers before or around init/start

## Publish Safety Checklist

- [ ] App ID in `.env` matches target app
- [ ] fresh `npm run build` after env changes
- [ ] publish to intended app id
- [ ] verify auth/profile in preview after publish

## Canonical References

- [Auth skill](../skills/viverse-auth/SKILL.md)
- [Multiplayer skill](../skills/viverse-multiplayer/SKILL.md)
- [Leaderboard skill](../skills/viverse-leaderboard/SKILL.md)
- [World publishing skill](../skills/viverse-world-publishing/SKILL.md)
- [Matchmaking docs](https://docs.viverse.com/developer-tools/matchmaking-and-networking-sdk)
