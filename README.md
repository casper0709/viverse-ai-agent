# VIVERSE AI Agent

VIVERSE AI Agent is a specialized, context-aware metaverse assistant designed to bridge the gap between AI discovery and 3D immersive environments. It serves as an intelligent scout for VIVERSE worlds and a helpful collaborator for metaverse development.

## 🚀 Features

- **Discovery Chat**: A natural language interface to search for VIVERSE worlds, spaces, and landmarks.
- **Multi-Tab Dashboard**: Seamlessly explore worlds and manage portals without leaving the dashboard.
- **Smart World Preview**: Instant iframe-based exploration for VIVERSE content.
- **Portal Knowledge Base**: Built-in awareness of official VIVERSE creator tools (Studio, Create, Avatar).
- **Contextual Search**: Leverages the VIVERSE CMS Room Search API for real-time content discovery.
- **External Request Support**: Built to be discoverable and accessible by other AI systems or remote clients.

## 🛠️ Project Structure

- `src/`: Backend server logic (Express, Node.js).
  - `services/`: Core logic for Gemini AI, Content Search, and File Management.
  - `routes/`: API endpoint definitions.
- `public/`: Frontend dashboard (HTML/CSS/JS).
  - `app.js`: Contains the `TabManager` and dynamic UI logic.
- `docs/`: Knowledge base documents (SDK info, Portal URLs).

## 🧠 External Skills Repository

VIVERSE skills are maintained in a separate repository:

- `viverse-sdk-skills`
- Suggested URL format: `https://github.com/<your-username>/viverse-sdk-skills`

This agent loads skills from that repository through environment configuration.

## 🚦 Getting Started

### Prerequisites

- Node.js (v18+)
- Google Gemini credentials (one of):
  - API key (`GOOGLE_API_KEY`)
  - Service account private-key credentials (`GOOGLE_SERVICE_ACCOUNT_JSON`, or `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`)

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory:
   ```env
   PORT=3000
   # Option A: Gemini API key (existing mode)
   GOOGLE_API_KEY=your_gemini_api_key_here

   # Option B: Service account private-key mode (new)
   # GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"}'
   # or:
   # GOOGLE_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
   # GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

   VIVERSE_AGENT_ENDPOINT=http://localhost:3000/api/ai/chat
   API_HUB_BASE_URL=https://api.viverse.com

   # External skills source (recommended)
   VIVERSE_SKILLS_REPO=/absolute/path/to/viverse-sdk-skills
   # Optional alternative:
   # VIVERSE_SKILLS_DIR=/absolute/path/to/viverse-sdk-skills/skills
   ```

### Running the Agent

- **Development Mode**:
  ```bash
  npm run dev
  ```
- **Production Mode**:
  ```bash
  npm start
  ```

## ✅ Simple Usage

1. Start the agent (`npm run dev`).
2. Open the dashboard in your browser.
3. Ask a concrete task, for example:
   - "Integrate VIVERSE login in my app."
   - "Set up matchmaking room create/join flow."
   - "Help publish this world to VIVERSE."
4. For best results, explicitly mention a skill by name in your prompt.
5. If behavior is unclear, check `docs/` in this repo and the corresponding skill docs in `viverse-sdk-skills`.

## 📋 SOP: Use External Skills Repo

1. Clone both repositories side-by-side:
   ```bash
   cd /path/to/workspace
   git clone <agent-repo-url> viverse-ai-agent
   git clone <skills-repo-url> viverse-sdk-skills
   ```
2. Install agent dependencies:
   ```bash
   cd viverse-ai-agent
   npm install
   ```
3. Set skills source:
   ```bash
   export VIVERSE_SKILLS_REPO=/path/to/workspace/viverse-sdk-skills
   ```
4. Start the agent:
   ```bash
   npm run start
   ```
5. Validate skills linkage:
   - Send a task mentioning a known skill domain (for example, auth or matchmaking).
   - Confirm responses do not show "Skill not found" and that skill enforcement references expected skill files.
6. Update skills in day-to-day workflow:
   ```bash
   cd /path/to/workspace/viverse-sdk-skills
   git pull
   ```
   Restart `viverse-ai-agent` after skills updates.

## 📖 Knowledge Base

The agent's intelligence is augmented by the documents in the `docs/` folder. To update its knowledge about VIVERSE portals or SDKs, simply edit the corresponding `.md` file.

## 🔒 Security

- Sensitive keys should always be stored in `.env` (already added to `.gitignore`).
- External access is controlled via environment variable binding (`0.0.0.0`).
