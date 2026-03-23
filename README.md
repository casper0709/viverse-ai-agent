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
- `skills/`: Reusable AI skill modules for VIVERSE integrations (auth, multiplayer, avatars, publishing, etc.).

## 🧠 Skills (Knowledge Modules)

Skills are task-focused guides that help AI assistants produce higher-quality implementation steps for common VIVERSE workflows.

Each skill typically includes:
- `SKILL.md`: when to use the skill, prerequisites, and step-by-step workflow
- `patterns/`: reusable implementation patterns and troubleshooting notes
- `examples/`: copyable usage examples

Current skills:
- `playcanvas-avatar-navigation`
- `playcanvas-googlemaps-3dtiles`
- `viverse-auth`
- `viverse-avatar-sdk`
- `viverse-leaderboard`
- `viverse-multiplayer`
- `viverse-world-publishing`
- `vrma-animation-retargeting`

For the full catalog and structure, see `skills/README.md`.

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
4. For best results, tell the assistant to load a specific skill first, e.g.:
   - `Read skills/viverse-multiplayer/SKILL.md and implement move sync.`
5. If behavior is unclear, check the matching document in `docs/` and related `skills/*/patterns`.

## 📖 Knowledge Base

The agent's intelligence is augmented by the documents in the `docs/` folder. To update its knowledge about VIVERSE portals or SDKs, simply edit the corresponding `.md` file.

## 🔒 Security

- Sensitive keys should always be stored in `.env` (already added to `.gitignore`).
- External access is controlled via environment variable binding (`0.0.0.0`).
