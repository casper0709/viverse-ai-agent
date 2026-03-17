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
  - `new vSdk.avatar({ accessToken, token, authorization, appId, clientId, baseURL: "https://sdk-api.viverse.com/" })`
  - `getProfile()`
- **Matchmaking SDK**
  - `playClient.newMatchmakingClient(appId)`
  - `setActor`, `createRoom`, `joinRoom`, `leaveRoom`, `startGame`
- **Play MultiplayerClient**
  - `new MultiplayerClient(roomId, appId, sessionId)`
  - `general.sendMessage`, `general.onMessage`
- **Leaderboard SDK**
  - `new vSdk.gameDashboard({ token, baseURL, communityBaseURL })`
  - `uploadLeaderboardScore`, `getLeaderboard`

## Integration Blueprint (Web/React)

1. Authenticate user (`checkAuth`) and keep auth state in one source.
2. Fetch profile via canonical fallback chain: `avatar.getProfile` -> `getUserInfo` -> `getUser` -> `getProfileByToken` -> direct API fallback.
3. Initialize feature clients (matchmaking/leaderboard) after auth.
4. Build gameplay sync with reconnect-safe room lifecycle.
5. Publish with App ID/env match and fresh build.

## Canonical Auth/Profile Rules

- `checkAuth()` is not profile data; it only provides auth/session fields.
- Never send/use header key `accesstoken` in browser calls.
- Direct browser calls to `account-profile.htcvive.com` or `avatar.viverse.com` can be CORS-blocked in iframe origins.
- UI fallback display name should be exactly `VIVERSE Player`; do not append account ID fragments.

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

## Leaderboard Debug Quick Reference

When leaderboard shows upload success but list is empty:

1. Split write vs read path:
   - if upload succeeds, treat write path as healthy
   - then debug read params/response shape
2. Use token from `client.getToken()` when available; fallback to `checkAuth().access_token`.
3. Prefer 0-based ranges in queries (`range_start: 0`, `range_end: 9`).
4. Try fallback read configs:
   - `global + around_user=false`
   - `global + around_user=true`
   - `local + around_user=false`
5. Parse multiple ranking response shapes:
   - `res.rankings`
   - `res.leaderboard_rankings`
   - nested data objects

Recommended runtime diagnostic tuple:

`diag(appId=..., leaderboard=..., tokenSource=..., token=present)`

Interpretation:

- `Unexpected token '<'` usually means app/name/token mismatch returned HTML, not JSON.
- Browser-extension errors (`chrome-extension://...`) are unrelated unless they reference your app bundle path.

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
