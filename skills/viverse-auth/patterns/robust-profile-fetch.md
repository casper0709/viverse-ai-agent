# Robust Profile Fetch Pattern

In production VIVERSE applications, especially those running inside iframes (like VIVERSE Worlds), the standard Avatar SDK method for fetching user profiles might not always work due to SDK version differences or environmental constraints.

This pattern provides a **"try everything" strategy** to ensure you get the user's display name and avatar thumbnail reliably.

## The Helper Function

Copy this helper into your project (e.g., `utils/viverseHelper.js`):

```javascript
/**
 * Robustly fetches the VIVERSE user profile using multiple strategies.
 * @param {Object} vSdk - The loaded VIVERSE SDK object (window.viverse or window.VIVERSE_SDK)
 * @param {Object} client - The initialized VIVERSE Auth Client
 * @param {string} accessToken - The access token from checkAuth()
 * @param {string} accountId - The account ID from checkAuth()
 * @returns {Promise<Object>} The profile object { displayName, avatarUrl, headIconUrl }
 */
export async function fetchViverseProfile(vSdk, client, accessToken, accountId) {
    let profile = null;

    // Helper to check if we have what we need (avatar)
    const hasAvatar = (p) => p && (p.activeAvatar?.avatarUrl || p.avatarUrl || p.avatar_url || p.profilePicUrl);

    // Strategy 1: Avatar SDK (Modern Standard)
    if (vSdk?.avatar && accessToken) {
        try {
            const appId = import.meta.env.VITE_VIVERSE_CLIENT_ID;
            const avatarClient = new vSdk.avatar({
                baseURL: 'https://sdk-api.viverse.com/',
                accessToken: accessToken, 
                token: accessToken,
                authorization: accessToken,
                appId: appId,
                clientId: appId
            });
            const p = await avatarClient.getProfile();
            // ACCUMULATE: Merge results, don't just overwrite
            if (p) profile = { ...profile, ...p };
        } catch (e) {}
    }

    // Strategy 2: client.getUserInfo() (Standard SDK)
    // Continue if we don't have a profile OR if the profile we have is missing an avatar
    if (!profile || !hasAvatar(profile)) {
        if (client?.getUserInfo) {
            try { 
                const p = await client.getUserInfo();
                if (p) profile = profile ? { ...profile, ...p } : p;
            } catch (e) {}
        }
    }

    // Strategy 3: client.getUser() (Legacy/Iframe)
    if (!profile || !hasAvatar(profile)) {
        if (client?.getUser) {
            try { 
                const p = await client.getUser(); 
                if (p) profile = profile ? { ...profile, ...p } : p;
            } catch (e) {}
        }
    }

    // Strategy 4: client.getProfileByToken() (Alternative)
    if (!profile || !hasAvatar(profile)) {
        if (client?.getProfileByToken) {
            try { 
                const p = await client.getProfileByToken(accessToken); 
                if (p) profile = profile ? { ...profile, ...p } : p;
            } catch (e) {}
        }
    }

    // Strategy 5: Direct API Call (Last Resort)
    if ((!profile || !hasAvatar(profile)) && accessToken) {
        try {
            const resp = await fetch('https://account-profile.htcvive.com/SS/Profiles/v3/Me', {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (resp.ok) {
                const p = await resp.json();
                if (p) profile = profile ? { ...profile, ...p } : p;
            }
        } catch (e) {}
    }

    // Normalize the result
    return {
        displayName: profile?.name || profile?.displayName || profile?.display_name || profile?.userName || accountId || 'VIVERSE User',
        avatarUrl: profile?.activeAvatar?.avatarUrl || profile?.avatarUrl || profile?.avatar_url || profile?.profilePicUrl || null,
        headIconUrl: profile?.activeAvatar?.headIconUrl || profile?.headIconUrl || profile?.head_icon_url || profile?.headIcon || null,
    };
}
```

## Usage Example

```javascript
import { fetchViverseProfile } from './utils/viverseHelper';

async function checkAuth() {
    // ... initialize client ...
    
    // 1. Get Auth Token
    const authResult = await client.checkAuth();
    if (!authResult) return null;

    // 2. Fetch Profile Robustly
    const vSdk = window.viverse || window.VIVERSE_SDK;
    const profile = await fetchViverseProfile(
        vSdk, 
        client, 
        authResult.access_token, 
        authResult.account_id
    );

    return {
        ...profile,
        userId: authResult.account_id,
        accessToken: authResult.access_token
    };
}
```
