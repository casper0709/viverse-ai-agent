# VIVERSE Hub Resilience Guide (v5.0 - Canonical Auth/Profile)

> [!IMPORTANT]
> **MANDATORY RELEASE BLOCKER CHECKLIST**
> Before any VIVERSE publish:
> 1. [ ] **Auth Domain**: `new vSdk.client({ clientId, domain: "account.htcvive.com" })`.
> 2. [ ] **Handshake Delay**: wait 1200ms after SDK detection before first `checkAuth()`.
> 3. [ ] **Canonical Profile Chain**: `avatar.getProfile` -> `getUserInfo` -> `getUser` -> `getProfileByToken` -> direct API fallback.
> 4. [ ] **Avatar Constructor**: base URL `https://sdk-api.viverse.com/`; provide `accessToken`, `token`, `authorization`.
> 5. [ ] **CORS Safety**: never use `accesstoken` header/key.
> 6. [ ] **UI Fallback Safety**: do not derive display names from `account_id` fragments.
> 7. [ ] **Matchmaking v4.2**: `playClient.newMatchmakingClient(appId)` + manual `session_id`.
> 8. [ ] **Session Match**: local `actor_id` is resolved by matching `session_id` in actor list.

## 1. Auth Resilience (Canonical)

- `checkAuth()` is token/account only. It is not profile data.
- Primary profile path: `new vSdk.avatar({ baseURL: "https://sdk-api.viverse.com/", ... }).getProfile()`.
- Fallback path: `client.getUserInfo()` -> `client.getUser()` -> `client.getProfileByToken(token)`.
- Last resort only: direct profile API fetch (may be blocked by iframe/CORS policy).
- Normalize display fields from `displayName/display_name/name/nickname/userName/email`.
- Avatar normalization should prefer `activeAvatar.headIconUrl` and similar aliases.

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
**Canonical rule**: keep one auth/profile recipe across all projects to prevent agent drift and repeated regression loops.
