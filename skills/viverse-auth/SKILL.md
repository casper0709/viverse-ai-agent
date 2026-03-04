---
name: viverse-auth
description: VIVERSE Login SDK integration for user authentication and SSO
prerequisites: [VIVERSE SDK script tag, VIVERSE Studio App ID]
tags: [viverse, authentication, login, sso]
---

# VIVERSE Auth Integration

Add VIVERSE user authentication to any web project. Supports SSO across VIVERSE experiences.

## When To Use This Skill

Use this when a project needs:
- User login/logout via VIVERSE accounts
- Access to user profile data (name, avatar URL, account ID)
- Single Sign-On between multiple VIVERSE experiences

## Prerequisites

1. **VIVERSE SDK** loaded in `index.html`:
```html
<script src="https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs"></script>
```

2. **App ID** from [VIVERSE Studio](https://studio.viverse.com/) — create a World App to get one.

## Quick-Start

### 1. Initialize the Client

```javascript
const vSdk = window.viverse || window.VIVERSE_SDK;

const client = new vSdk.client({
    clientId: 'YOUR_APP_ID',            // From VIVERSE Studio
    domain: 'account.htcvive.com'        // Required
});
```

> [!IMPORTANT]
> The SDK may expose itself as `window.viverse` or `window.VIVERSE_SDK` depending on the version. Always check both.

### 2. Check Existing Session

```javascript
const result = await client.checkAuth();
if (result) {
    // User is already logged in — but this only gives auth tokens!
    console.log('Token:', result.access_token);
    console.log('Account ID:', result.account_id);
    console.log('Expires in:', result.expires_in, 'seconds');
} else {
    // No active session
}
```

> [!CAUTION]
> `checkAuth()` does **NOT** return user profile data (display name, avatar). It only returns `access_token`, `account_id`, and `expires_in`. See step 2b below.

### 2b. Get User Profile (Avatar SDK)

`checkAuth()` only returns auth tokens. To get the user's **display name** and **avatar thumbnail**, you must use the Avatar SDK:

```javascript
const vSdk = window.viverse || window.VIVERSE_SDK;
const avatarClient = new vSdk.avatar({
    baseURL: 'https://sdk-api.viverse.com/',
    accessToken: result.access_token
});

const profile = await avatarClient.getProfile();
// profile.name → display name
// profile.activeAvatar?.headIconUrl → avatar thumbnail URL
// profile.activeAvatar?.avatarUrl → GLB avatar URL (for 3D scenes)

> [!TIP]
> **Production Recommendation**: For robust cross-environment compatibility (especially in VIVERSE iframes), use the [Robust Profile Fetch Pattern](patterns/robust-profile-fetch.md). It implements a multi-strategy fallback approach to ensure you always get the user's data.
```

### 3. Login (Redirect-based SSO)

```javascript
client.loginWithWorlds({ state: 'optional-custom-value' });
// This redirects the page to VIVERSE login
// After login, user is redirected back with a session
```

### 4. Logout

```javascript
await client.logout();
window.location.reload();  // Clear state
```

## SDK Loading Pattern

The SDK loads asynchronously. Poll for it:

```javascript
async function waitForSDK(maxAttempts = 50, interval = 100) {
    return new Promise((resolve) => {
        let attempts = 0;
        const check = () => {
            attempts++;
            const vSdk = window.viverse || window.VIVERSE_SDK;
            if (vSdk?.client) {
                resolve(vSdk);
            } else if (attempts > maxAttempts) {
                console.warn('VIVERSE SDK failed to load');
                resolve(null);
            } else {
                setTimeout(check, interval);
            }
        };
        check();
    });
}
```

## Gotchas

- **Mock mode for local dev**: The SDK requires HTTPS and a registered redirect URI. For local development, create a mock service that simulates checkAuth/login/logout.
- **Token expiry**: `expires_in` is in seconds. Refresh the session before it expires for long-running experiences.
- **Flat namespace**: Some SDK versions don't have a `client` constructor — the namespace itself has methods directly. Handle both cases.
- **checkAuth ≠ profile**: `checkAuth()` only returns auth tokens, NOT user profile data. You MUST use the Avatar SDK `getProfile()` to get display name and avatar.
- **Iframe Auth Hang (`checkAuth:ack`)**: If the application hangs on VIVERSE Studio or logs `unhandled methods: VIVERSE_SDK/checkAuth:ack`, it is almost always caused by an **App ID mismatch**. The VIVERSE parent iframe security model prevents the auth handshake if `clientId` (from your `.env` file) does not exactly match the App ID the iframe was launched with. Double check copied `.env` files.

## Example Files

| Example | Purpose |
|---------|---------|
| [react-login-flow.md](examples/react-login-flow.md) | Complete React login/logout component |
| [robust-profile-fetch.md](patterns/robust-profile-fetch.md) | **Recommended**: Helper for reliable profile data |
