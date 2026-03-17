# VIVERSE Hub Resilience Guide (v4.5 - Bridge-First Identity)

> [!IMPORTANT]
> **MANDATORY RELEASE BLOCKER CHECKLIST**
> Before any VIVERSE publish:
> 1. [ ] **Bridge-First Identity**: PRIMARY identity MUST be attempt via `client.getUserInfo()` (CORS-safe bridge).
> 2. [ ] **Avatar SDK Fix**: Constructors MUST NOT include the forbidden `accesstoken` header.
> 3. [ ] **Session-Matching Alpha**: Local `actor_id` MUST be found by matching `session_id` in the actor list.
> 4. [ ] **Triple-Lock Auth**: Try `viverse.com` -> 1000ms delay -> Try `htcvive.com`.
> 5. [ ] **Stability Delay**: 2500ms delay after `checkAuth()` BEFORE any optional profile enhancement.
> 6. [ ] **Matchmaking v4.2**: `playClient.newMatchmakingClient(appId)` + Manual `session_id`.
> 7. [ ] **Session-Matching Alpha**: Find local `actor_id` by matching `session_id` in the actor list.

## 1. AUTH Resilience (Bridge-First Recovery)

- **Strategy 0 (Instant)**: Extract name/picture from `checkAuth()` result object.
- **Strategy 2 (Primary Recovery)**: Call `client.getUserInfo()`. This uses the CORS-safe message bridge.
- **Shotgun Constructor (Fixed)**: Pass token via `token` and `authorization`. DO NOT use `accesstoken`.
- **Base URL**: Use `https://avatar.viverse.com/` (stable URL).
- **Identity Delay**: 2500ms delay after login before attempting enhancement calls.

## 2. Matchmaking & Multiplayer (v4.2 Standards)

- **Constructor**: ALWAYS use `playClient.newMatchmakingClient(appId)`.
- **Manual Identity**: Generate `actorSessionId` (`userId-timestamp`) for `session_id`.
- **Session-Matching**: To find your `actor_id`, iterate `mc.getMyRoomActors()` or `room.actors` and match the `session_id`.
- **Dealer Pattern**: First actor in `mc.getActorList()` initializes the game state.

## 3. Build & Deployment (Grep Gate)

- **Extreme Purge**: `rm -rf dist publish_tmp` before every build.
- **Grep Gate**: `grep -r "YOUR_APP_ID" dist/assets/` MUST match the intended World ID.
- **Traceability**: Log a `VERSION_NAME` (e.g., `1.2.0-zero-fetch`) on startup.

---
**Zero-Fetch Alpha is the terminal resilience standard. Deviations will cause DNS/CORS failure.**
