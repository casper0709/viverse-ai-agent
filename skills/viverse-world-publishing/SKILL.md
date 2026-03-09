---
name: viverse-world-publishing
description: Publishing PlayCanvas projects to VIVERSE Worlds via CLI
prerequisites: [Node.js, VIVERSE Studio account, VIVERSE CLI]
tags: [viverse, publishing, cli, deployment]
---

# VIVERSE World Publishing

Publish a web build to VIVERSE Worlds with repeatable CLI workflow.

## When To Use This Skill

Use this when a project needs:
- Deployment to the VIVERSE Worlds platform
- A public URL for sharing immersive 3D experiences
- Integration with the VIVERSE ecosystem (discovery, multiplayer)

## Read Order

1. This file
2. [examples/publish-workflow.md](examples/publish-workflow.md)

## Preflight

- [ ] Logged into `viverse-cli` as correct account
- [ ] Target App ID confirmed
- [ ] `.env` App ID matches target publish app (for auth-enabled projects)
- [ ] Fresh build generated after env/config changes
- [ ] Build output path confirmed (`dist/` or `build/`)

## CLI Workflow

### 1) Install CLI (if needed)

```bash
npm install -g @viverse/cli
```

### 2) Login

```bash
viverse-cli auth login
```

### 3) Build

```bash
npm run build
```

### 4) Verify app list and status

```bash
viverse-cli app list
```

### 5) Publish to existing app

```bash
viverse-cli app publish ./dist --app-id <APP_ID>
```

### 6) (Optional) Auto-create app + publish

```bash
viverse-cli app publish ./dist --auto-create-app --name "<APP_NAME>"
```

## Release Checklist

- [ ] CLI publish returns success URL
- [ ] Preview URL opens and assets load
- [ ] Runtime console confirms latest bundle hash/build tag (avoid stale cached build confusion)
- [ ] Auth flow works in the published target app
- [ ] Studio review/submission step completed if required

## Gotchas

- `import.meta.env` is build-time in Vite; rebuild after env changes.
- Publishing to app A with build configured for app B can break auth and leaderboard.
- Asset paths must be deployment-safe (relative/public).
- Review state in Studio may block full live rollout after upload.
- After publish, browser/app cache can still run old bundle hash; hard refresh or add temporary build-tag log for verification during hotfix debugging.

## References

- [VIVERSE Studio](https://studio.viverse.com/)
- [examples/publish-workflow.md](examples/publish-workflow.md)
