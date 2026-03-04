# Running and Tasking the VIVERSE AI Agent

This guide explains how to run the local AI agent server and how to assign tasks to it using Gemini or other tools.

> **New to the system?** See [skills-guide.md](./skills-guide.md) for all the ways to use the agent and skills — including using skills without running the server.

## 1. Prerequisites
- Node.js installed.
- A valid `GOOGLE_API_KEY` in your `.env` file.

## 2. Running the Agent
Navigate to the `viverse_ai_agent` directory and run:

```bash
# Install dependencies (only required once)
npm install

# Start the server in development mode (with auto-reload)
npm run dev
```

The server will start at `http://localhost:3000`.

## 3. Assigning Tasks via Gemini (Antigravity)
If you are using an agentic environment (like this one), you can "delegate" tasks to the local agent by sending a POST request to its endpoint.

### Example Task: Integrate VIVERSE into voxel-landmark
You can send a command to the local agent using `curl`:

```bash
curl -X POST http://localhost:3000/api/ai/chat \
-H "Content-Type: application/json" \
-d '{"message": "Add VIVERSE login functionality to the project at /Users/casper_wang/Projects/AI/voxel_landmark"}'
```

The local agent will then use its embedded VIVERSE knowledge base to provide the necessary code snippets and instructions.

## 4. official Gemini Integration (Public Mode)

To use this agent with the official Gemini chatbot:

### Step 1: Deploy and Expose
- Deploy your server to a cloud provider (e.g., Google Cloud Run).
- Ensure your server has a public HTTPS URL.

### Step 2: Gemini Extensions/AI Studio
- Go to [Google AI Studio](https://aistudio.google.com/).
- Create a new Prompt or "Gem".
- Under **Tools**, look for **OpenAPI** or **Function Calling**.
- Upload/Paste the contents of `docs/openapi.yaml`.

### Step 3: Connect
Gemini will now understand how to "talk" to your server. When you ask it a question in the official UI, it will trigger your local/deployed agent to get the specific VIVERSE expertise.

## 5. Seamless Workflows
You can also use the following workflows:
- Run `/viverse-agent-start` to launch the server.
- Run `/viverse-agent-task` to send a prompt to the local agent.
