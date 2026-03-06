# VIVERSE Developer Tools (Quick Operator Guide)

Practical map of SDK/tool choices and when to use each.

## Tool Selection

- **Auth/Login SDK**: user login, token, account id, profile bootstrap
- **Avatar SDK**: display name and avatar asset/profile details
- **Matchmaking + Play SDK**: room lifecycle and multiplayer sync
- **Leaderboard SDK**: score upload and ranking retrieval
- **VIVERSE CLI**: app create/list/publish and auth status

## Read Order for Integration

1. `skills/viverse-auth/SKILL.md`
2. `skills/viverse-multiplayer/SKILL.md`
3. `skills/viverse-leaderboard/SKILL.md`
4. `skills/viverse-world-publishing/SKILL.md`

## Core API Signatures

### Auth

```javascript
const client = new vSdk.client({ clientId: appId, domain: "account.htcvive.com" });
const auth = await client.checkAuth(); // access_token, account_id, expires_in
client.loginWithWorlds({ state: "optional" });
await client.logout();
```

### Avatar

```javascript
const avatarClient = new vSdk.avatar({ baseURL, accessToken, appId, clientId: appId });
const profile = await avatarClient.getProfile();
```

### Matchmaking/Play

```javascript
const playClient = new (vSdk.Play || vSdk.play)();
const mc = await playClient.newMatchmakingClient(appId);
const mp = new (vSdk.play || vSdk.Play).MultiplayerClient(roomId, appId, sessionId);
```

### Leaderboard

```javascript
const dashboard = new vSdk.gameDashboard({
  token: accessToken,
  baseURL: "https://www.viveport.com/",
  communityBaseURL: "https://www.viverse.com/",
});
await dashboard.uploadLeaderboardScore(appId, [{ name, value }]);
await dashboard.getLeaderboard(appId, query);
```

Leaderboard query defaults that are robust in practice:

```javascript
const query = {
  name,
  range_start: 0,
  range_end: 9,
  region: "global",
  time_range: "alltime",
  around_user: false,
};
```

## High-Impact Best Practices

- Keep auth state in one top-level source (App/provider), pass down via props/context.
- Never rely on `checkAuth()` for profile name/avatar; always fetch profile.
- Match App ID across env, runtime config, and publish target.
- For turn-based multiplayer, send full state snapshots + catch-up flow.
- Rebuild after env/App ID changes before publishing.
- For leaderboard incidents, log `appId`, `leaderboardName`, `value`, token source, and fetched row count.

## CLI Essentials

```bash
viverse-cli auth status
viverse-cli app list
viverse-cli app publish ./dist --app-id <APP_ID>
```

## References

- [VIVERSE Matchmaking docs](https://docs.viverse.com/developer-tools/matchmaking-and-networking-sdk)
- [SDK reference](./viverse_sdk_docs.md)
- [Skills guide](./skills-guide.md)
