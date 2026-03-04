---
name: viverse-leaderboard
description: How to implement a global leaderboard for VIVERSE worlds using the official VIVERSE gameDashboard SDK
prerequisites: [VIVERSE Auth integration (checkAuth), ViverseService, Viverse Studio App ID]
tags: [viverse, leaderboard, tracking, gamedashboard, api]
---

# VIVERSE Leaderboard (Official Game Dashboard SDK)

The VIVERSE SDK provides a native backend **Leaderboard SDK** via the `gameDashboard` client. This allows for persistent, cross-device global rankings without needing to build your own custom database backend. **Do not use `localStorage` for leaderboards, as it is strictly limited to the local browser.**

## When To Use

- Global rankings (high scores, longest distance, landmarks visited)
- Showing player rank relative to the rest of the world
- Tracking engagement over different time periods (all-time, weekly, daily)

## Prerequisites & Setup (VIVERSE Studio)

Before writing code, the leaderboard must be configured in the **VIVERSE Studio / Developer Console**:
1. You must have a registered App ID.
2. In the VIVERSE Studio, create a new Leaderboard configuration.
3. Note the **Leaderboard Name** (API Name), **Data Type** (e.g., Integer, Milliseconds), **Sort Type** (Ascending/Descending), and **Update Type** (Append/Update/Best).

## Architecture

```
ViverseLayer.jsx  →  Authenticates user, gets access_token
PlayCanvasScene.jsx  →  Initializes gameDashboardClient with the token
PlayCanvasScene.jsx  →  Calls uploadLeaderboardScore() when events happen
LeaderboardPanel.jsx  →  Calls getLeaderboard() to fetch rankings and renders UI
```

## 1. Initializing the Game Dashboard Client

After successful user authentication (using `viverseClient.checkAuth()`), you must use the `access_token` to initialize the `gameDashboardClient`.

```javascript
// Example initialization after VIVERSE Auth
let __viverseToken = null;
let gameDashboardClient = null;

const initLeaderboard = async () => {
    // 1. Get the auth token from your viverse client instance
    const authResult = await window.viverseClient.checkAuth();
    if (authResult?.access_token) {
        __viverseToken = authResult.access_token;
        
        // 2. Initialize the Game Dashboard Client
        // Ensure you import/load the VIVERSE SDK script first
        gameDashboardClient = new window.viverse.gameDashboard({
            token: __viverseToken,
            // baseURL and communityBaseURL may be required depending on the SDK version, check official docs if initializing fails
        });
        
        console.log("VIVERSE Leaderboard SDK Initialized!");
    } else {
        console.warn("User not authenticated, Leaderboard SDK cannot be initialized.");
    }
};
```

## 2. Uploading a Score (`uploadLeaderboardScore`)

To submit a score, use the `uploadLeaderboardScore` method. You need your Studio App ID and an array of score objects. The `name` must match the Leaderboard Name defined in VIVERSE Studio.

```javascript
const submitDistanceScore = async (appId, distanceInMeters) => {
    if (!gameDashboardClient) return;
    
    try {
        const response = await gameDashboardClient.uploadLeaderboardScore(appId, [
            {
                name: "TotalDistanceWalked", // Match the API Name in VIVERSE Studio exactly
                value: Math.floor(distanceInMeters)
            }
        ]);
        console.log("Score uploaded successfully:", response);
    } catch (error) {
        console.error("Failed to upload score:", error);
    }
};
```

### Tracking Triggers Example (PlayCanvas)

Accumulate velocity in the game loop and flush periodically:

```javascript
// Inside PlayCanvas animLoop
const vel = avatar.rigidbody?.linearVelocity;
if (vel) {
    const spd = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    ma._distAccum = (ma._distAccum || 0) + (spd * dt);
    
    // Upload score every 10 meters to avoid API spam
    if (ma._distAccum >= 10) {
        // App ID from Viverse Studio
        submitDistanceScore('YOUR_VIVERSE_APP_ID', ma._distAccum); 
        ma._distAccum = 0; // Reset accumulator
    }
}
```

## 3. Retrieving the Leaderboard (`getLeaderboard`)

Use `getLeaderboard` to fetch the rankings and display them in your UI. This required a configuration object to specify pagination, geography, and time filters.

```javascript
const fetchTopRankings = async (appId) => {
    if (!gameDashboardClient) return [];
    
    try {
        const leaderboardConfig = {
            name: "TotalDistanceWalked", // Match the API Name in VIVERSE Studio exactly
            range_start: 1,              // Top of the list
            range_end: 10,               // Fetch top 10 players
            region: "global",            // 'global' or 'local'
            time_range: "alltime",       // 'alltime', 'daily', 'weekly'
            around_user: false           // true to fetch ranks specifically around current user
        };
        
        const response = await gameDashboardClient.getLeaderboard(appId, leaderboardConfig);
        
        // The response format typically includes an array of rankings
        console.log("Leaderboard Data:", response);
        return response.rankings || []; 
    } catch (error) {
        console.error("Failed to fetch leaderboard:", error);
        return [];
    }
};

// Example output ranking object:
// {
//    user_id: "...",
//    name: "PlayerName",
//    value: 1250,
//    rank: 1
// }
```

## Gotchas

> [!WARNING]
> The Leaderboard APIs (`uploadLeaderboardScore`, `getLeaderboard`) strictly require user authentication to work. The `viverse.gameDashboard` constructor will fail or return unauthorized errors if an invalid or missing `access_token` is provided.

> [!IMPORTANT]
> Do not spam `uploadLeaderboardScore` every frame. Aggregate the player's metrics locally (in game state) and only upload the score at logical checkpoints (e.g., every 10 meters walked, level completed, daily login).

> [!NOTE]
> If you need to retrieve scores for unauthenticated users, VIVERSE provides a `getGuestLeaderboard()` variant. However, uploading scores requires a logged-in account.
