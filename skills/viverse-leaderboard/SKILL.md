---
name: viverse-leaderboard
description: How to implement a global leaderboard for VIVERSE worlds using the official VIVERSE gameDashboard SDK
prerequisites: [VIVERSE Auth integration (checkAuth), ViverseService, Viverse Studio App ID]
tags: [viverse, leaderboard, tracking, gamedashboard, api]
---

# VIVERSE Leaderboard Integration

Use `viverse.gameDashboard` to upload and fetch persistent global rankings.

## When To Use This Skill

- Global scoreboards (wins, time, distance, points)
- Top-N ranking views
- Around-user rank queries

## Read Order

1. This file (workflow + constraints)
2. Project leaderboard service implementation
3. Studio leaderboard configuration

## Studio Preflight

Before coding:

1. Registered App ID exists.
2. Leaderboard is created in Studio for that app.
3. You know:
   - Leaderboard API name
   - Data type
   - Sort direction
   - Update rule (append/update/best)

## Runtime Preflight

- [ ] Auth success (`access_token` present)
- [ ] `VITE_VIVERSE_CLIENT_ID` matches target app
- [ ] `VITE_VIVERSE_LEADERBOARD_NAME` matches Studio API name
- [ ] Initialize client once per token
- [ ] Handle API errors in UI (not just console)

## Implementation Workflow

### 1) Initialize Dashboard Client

```javascript
const v = window.viverse || window.VIVERSE_SDK;
const DashboardClass = v?.gameDashboard || v?.GameDashboard;
const gameDashboardClient = new DashboardClass({ token: accessToken });
```

### 2) Upload score

The `name` must exactly match Studio API name.

```javascript
await gameDashboardClient.uploadLeaderboardScore(appId, [
  { name: leaderboardName, value: scoreValue },
]);
```

### 3) Fetch leaderboard

```javascript
const res = await gameDashboardClient.getLeaderboard(appId, {
  name: leaderboardName,
  range_start: 1,
  range_end: 10,
  region: "global",
  time_range: "alltime",
  around_user: false,
});
const rankings = res?.rankings || [];
```

## Scoring Best Practices

- Upload at game checkpoints/end state, not every frame.
- Normalize score values before upload (integer/clamped) to match Studio type.
- Keep scoring logic deterministic and documented.

## App Scope and Naming

Leaderboard lookup key is: **App ID + Leaderboard Name**.

For test/prod:
- Keep one env variable name (for example `VITE_VIVERSE_LEADERBOARD_NAME`)
- Configure same leaderboard API name in each app
- Ensure runtime App ID points to intended app

## Verification Checklist

- [ ] Authenticated user can upload score successfully
- [ ] Top ranking fetch returns rows in expected order
- [ ] UI handles empty/error states
- [ ] Test/prod apps both have leaderboard configured in Studio

## Critical Gotchas

- APIs require valid auth token; guest users cannot upload.
- Do not spam uploads in render/game loops.
- A leaderboard name valid in app A fails in app B if not configured there.
- Build-time env drift can target wrong App ID; rebuild before publish after env changes.

## References

- [viverse-auth](../viverse-auth/SKILL.md)
- [VIVERSE SDK docs](../../docs/viverse_sdk_docs.md)
