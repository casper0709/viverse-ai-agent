# VIVERSE AI Agent Usage

Use this guide to run the local agent server and send tasks to it.

## Quick Start

### Prerequisites

- Node.js installed
- Gemini credentials configured in `.env`:
  - API key mode: `GOOGLE_API_KEY`
  - Private-key mode: `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`

### Start server

```bash
npm install
npm run dev
```

Server URL: `http://localhost:3000`

## Task the Agent via API

```bash
curl -X POST http://localhost:3000/api/ai/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Add VIVERSE login to /path/to/project"}'
```

## Recommended Prompt Pattern

When sending a task, include:

1. Project path
2. Requested feature
3. Required skills to read first
4. Verification step (build/test/publish)

Example:

```text
Read skills/viverse-auth/SKILL.md and skills/viverse-multiplayer/SKILL.md.
Integrate auth + online room flow into /Users/me/my-app.
Run build and report blockers.
```

## Cloud / Public Integration

1. Deploy server to HTTPS host
2. Register OpenAPI/tool schema in Gemini or other tool-calling UI
3. Route user prompts to `/api/ai/chat`

## Operational Checklist

- [ ] Server running locally or deployed
- [ ] API key loaded
- [ ] Skill paths readable
- [ ] Prompt includes explicit scope and verification requirements

## Related Docs

- [skills-guide.md](./skills-guide.md)
- [viverse_sdk_docs.md](./viverse_sdk_docs.md)
