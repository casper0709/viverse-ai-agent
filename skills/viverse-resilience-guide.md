# VIVERSE Integration Resilience Guide (v2.0 - Hardened)

This guide contains mandatory patterns and safety checks to prevent common runtime failures in VIVERSE World projects. These are release blockers.

## 1. AUTH Resilience (The "Triple-Lock" Pattern)
SSO failure is most commonly caused by iframe race conditions or environment variable stripping. Follow this pattern exactly:

- **Lock 1: App ID Safeguard**: ALWAYS provide a hardcoded fallback for the App ID in the code.
  - `const CLIENT_ID = import.meta.env.VITE_VIVERSE_CLIENT_ID || 'actual_id_here';`
- **Lock 2: Handshake Stability**:
    - Wait for `document.readyState === 'complete'` before starting detection.
    - Wait exactly **1200ms** (not 500ms) after SDK detection before the first `checkAuth()`.
- **Lock 3: Domain Fallback**:
    - Always try `domain: 'account.viverse.com'` first.
    - If `checkAuth()` returns `null`, wait 1000ms and try `domain: 'account.htcvive.com'` as a fallback.
- **Robust Profile Fetch**: Use the verified 3-strategy fallback (Avatar SDK -> getUserInfo -> getUser) documented in the auth skill.

## 2. Build & Deploy Resilience (The "Grep Gate")
To prevent stale bundles being published:
- **CLEAN BUILD**: ALWAYS run `rm -rf dist && npm run build` before publishing.
- **GREP GATE**: You MUST run `grep -r "YOUR_APP_ID" dist/assets/` to confirm the App ID is successfully bundled. If not found, DO NOT PUBLISH.

## 3. Multiplayer Resilience (Initialization & Sync)
- **Matchmaking Connect**: NEVER call `.init()` on the `MatchmakingClient`. Connection starts automatically or via handlers. Calling `.init()` on the matchmaking client is the #1 cause of "Connecting..." hangs in production.
- **Multiplayer Init**: You MUST still call `.init()` on the `MultiplayerClient` (after room join).
- **Actor ID Guard**: ALWAYS use `const actorId = res?.actor_session_id || mc.actor_session_id` in `onConnect`.
- **Cleanup**: ALWAYS call `multiplayer.disconnect()` and `matchmaking.leaveRoom()` on unmount to prevent zombie sessions.

## 4. Leaderboard Resilience
- **Method Signatures**: ALWAYS pass the `clientId` (App ID) as the FIRST argument to all Leaderboard methods.
- **Dash-Separated Names**: Leaderboard API names MUST use dashes (`-`). Underscores and spaces ARE FORBIDDEN.

## 5. UI/UX & Platform Resilience
- **Diagnostic UX**: For complex projects, include the `ViverseDiagnostic.jsx` overlay (Shift+D) to track handshake status in real-time.
- **SVG Click-Through**: ALWAYS add `pointer-events: none;` to SVG icons inside buttons.
- **Identity**: You ARE Gemini 3 Flash. Maintain this identity in all system interactions.

---
*Reference these rules in every VIVERSE task. A single violation is a release failure.*
