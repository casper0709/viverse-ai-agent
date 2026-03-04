---
name: viverse-world-publishing
description: Publishing PlayCanvas projects to VIVERSE Worlds via CLI
prerequisites: [Node.js, VIVERSE Studio account, VIVERSE CLI]
tags: [viverse, publishing, cli, deployment]
---

# VIVERSE World Publishing

Publish a web or PlayCanvas project to VIVERSE Worlds so users can discover and enter it.

## When To Use This Skill

Use this when a project needs:
- Deployment to the VIVERSE Worlds platform
- A public URL for sharing immersive 3D experiences
- Integration with the VIVERSE ecosystem (discovery, multiplayer)

## Prerequisites

1. A [VIVERSE Studio](https://studio.viverse.com/) account
2. A World App created in Studio (provides the App ID)
3. Node.js installed

## Quick-Start

### 1. Install VIVERSE CLI

```bash
npm install -g @viverse/cli
```

### 2. Authenticate

```bash
viverse-cli auth login
```
This opens a browser for VIVERSE account authentication.

### 3. Build Your Project

```bash
npm run build
# Output directory is typically: dist/ or build/
```

### 4. Publish

Before publishing, you must know your App ID. You can find it in VIVERSE Studio or by running:
```bash
viverse-cli app list
```

Once you have the App ID, publish the build directory:
```bash
viverse-cli app publish ./dist --app-id YOUR_APP_ID
```

The CLI uploads the build directory and prints the live VIVERSE Worlds URL.

## PlayCanvas Extension (Alternative)

For PlayCanvas Editor projects:

1. Install the **VIVERSE PlayCanvas Extension** from Chrome Web Store
2. Open your PlayCanvas project in the Editor
3. Go to the "VIVERSE" tab added by the extension
4. Link your App ID from VIVERSE Studio
5. Click "Publish to VIVERSE"

## App ID Setup

1. Go to [VIVERSE Studio](https://studio.viverse.com/)
2. Create a new World
3. Copy the App ID
4. Add to your project:

```javascript
// PlayCanvas init
new vSdk.client({ clientId: 'YOUR_APP_ID', domain: 'account.htcvive.com' });
```

Or in `.env`:
```env
VITE_VIVERSE_CLIENT_ID=your-app-id
```

## Published World URLs

After publishing, your world is accessible at:
```
https://worlds.viverse.com/[hub_sid]
```

Browse existing worlds at [worlds.viverse.com](https://worlds.viverse.com/).

## SDK Version

Always use the latest SDK version:
- **Latest**: `https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs`
- **Pinned**: `https://www.viverse.com/static-assets/viverse-sdk/1.3.3/index.umd.cjs`

## Gotchas

- **HTTPS required**: VIVERSE auth requires HTTPS. Use `localhost` exemptions during dev.
- **Redirect URI**: Register your app's redirect URI in VIVERSE Studio for auth to work post-publish.
- **Asset paths**: Ensure all asset paths are relative, not absolute, for deployment portability.

## Example Files

| Example | Purpose |
|---------|---------|
| [publish-workflow.md](examples/publish-workflow.md) | Step-by-step publish checklist |
