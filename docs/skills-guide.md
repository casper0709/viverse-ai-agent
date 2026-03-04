# Using the VIVERSE AI Agent & Skills for a New Webapp

## Three Ways to Use the System

Your setup supports three approaches, from lightest to heaviest:

---

### Approach 1: Skills Only (No Agent Server Needed) ⭐ Recommended for New Projects

Skills are **standalone markdown documents** — any AI assistant can consume them directly.

**How:** Point your AI assistant at the relevant `SKILL.md` file:

```
Read skills/viverse-auth/SKILL.md and add VIVERSE login to my React app.
```

**What you get:**
- Step-by-step integration guides with code patterns
- Gotchas and edge cases documented from real experience
- Example files (e.g., `examples/react-login-flow.md`)

**Available skills:**

| Skill | What it does |
|-------|-------------|
| `viverse-auth` | Login/SSO via VIVERSE accounts |
| `viverse-avatar-sdk` | Load user avatars (GLB/VRM) into 3D scenes |
| `playcanvas-avatar-navigation` | Physics-based avatar movement (Ammo.js) |
| `viverse-world-publishing` | Publish to VIVERSE Worlds |

> **Tip:** This is the fastest path. You don't need to install or run anything — just reference the skill files from your AI coding assistant.

---

### Approach 2: Run the Agent Server (Chat UI + API)

Use this when you want the dedicated **VIVERSE Discovery** chat interface, which auto-loads all skills and docs.

**Setup:**
```bash
cd ~/Projects/AI/viverse_ai_agent
cp .env.example .env        # Add your GOOGLE_API_KEY
npm install
npm run dev                  # Runs on http://localhost:3000
```

**What you get:**
- Web chat UI at `http://localhost:3000`
- All skills and docs pre-loaded into the Gemini system prompt
- Agent tools: `readFile`, `writeFile`, `runCommand`, `listFiles`, `loadSkill`, `searchRooms`
- The agent can read/write files in your project and run shell commands

**Chat with it:**
```
Add VIVERSE login to my new webapp at ~/Projects/AI/my-new-app
```

The agent will use `loadSkill('viverse-auth', 'SKILL.md')` automatically, read your project files, and write the integration code.

> See [usage.md](./usage.md) for full server setup and deployment details.

---

### Approach 3: Delegate from Another AI

Send tasks to the running agent via API from any other tool or script:

```bash
curl -X POST http://localhost:3000/api/ai/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Add a VIVERSE login button to my-new-app/src/App.jsx"}'
```

---

## Recommended Workflow for a New Webapp Experiment

### Step-by-step

1. **Scaffold your webapp** (Vite, Next.js, plain HTML — whatever you prefer)

2. **Add the VIVERSE SDK** to your `index.html`:
   ```html
   <script src="https://www.viverse.com/static-assets/viverse-sdk/index.umd.cjs"></script>
   ```

3. **Pick the skills you need** and ask your AI assistant to read them:
   ```
   Read skills/viverse-auth/SKILL.md and skills/viverse-avatar-sdk/SKILL.md,
   then integrate VIVERSE login and avatar loading into my new Vite project.
   ```

4. **For deeper patterns**, reference the `patterns/` and `examples/` subdirectories:
   ```
   Also read skills/viverse-auth/examples/react-login-flow.md for a complete example.
   ```

---

## When to Start the Agent Server

| Scenario | Need Agent Server? |
|----------|-------------------|
| Adding VIVERSE features to a new app | ❌ Just use skills directly |
| Want the agent to autonomously read/write your project files | ✅ Start server |
| Using the web chat UI to explore VIVERSE worlds | ✅ Start server |
| Delegating tasks from scripts or other AI tools | ✅ Start server |
| Reading skill docs for reference | ❌ No server needed |
