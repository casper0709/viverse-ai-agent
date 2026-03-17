import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import fileService from './FileService.js';
import searchService from './SearchService.js';
import AgentRegistry from './AgentRegistry.js';

// --- FETCH INTERCEPTOR FOR SDK BUG ---
// The Google Gen AI SDK v0.24.1 strips 'thoughtSignature' from functionCall parts.
// We strictly parse SSE responses and cache them globally to re-inject later.
global.geminiThoughtSignaturesCache = {};
const originalFetch = global.fetch;
global.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const cloned = response.clone();
    try {
        const text = await cloned.text();
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ') && line.length > 6) {
                try {
                    const data = JSON.parse(line.substring(6));
                    const parts = data.candidates?.[0]?.content?.parts || [];
                    for (const p of parts) {
                        const sig = p.thoughtSignature || p.thought_signature;
                        if (p.functionCall && p.functionCall.id && sig) {
                            global.geminiThoughtSignaturesCache[p.functionCall.id] = sig;
                            logger.info(`GeminiService: Captured thoughtSignature for tool call ${p.functionCall.id}`);
                        }
                    }
                } catch(e) {}
            } else if (line.trim().startsWith('{')) {
                // Non-streaming response fallback
                try {
                    const data = JSON.parse(line);
                    const parts = data.candidates?.[0]?.content?.parts || [];
                    for (const p of parts) {
                        const sig = p.thoughtSignature || p.thought_signature;
                        if (p.functionCall && p.functionCall.id && sig) {
                            global.geminiThoughtSignaturesCache[p.functionCall.id] = sig;
                            logger.info(`GeminiService: Captured thoughtSignature for tool call ${p.functionCall.id}`);
                        }
                    }
                } catch(e) {}
            }
        }
    } catch(e) {}
    return response;
};
// -------------------------------------

class GeminiService {
    constructor() {
        this.apiKey = process.env.GOOGLE_API_KEY;
        if (!this.apiKey) {
            logger.error('GOOGLE_API_KEY is not defined in environment variables');
        }
        this.genAI = new GoogleGenerativeAI(this.apiKey);

        // Load VIVERSE SDK knowledge base (Deep Summary Index to save tokens)
        this.viverseKnowledge = `VIVERSE PLATFORM CONTEXT:
- SDK Pattern: The VIVERSE SDK is UMD-based and resides in 'window.viverse' or 'window.VIVERSE_SDK'. It is NOT in npm.
- Docs: Use 'readDoc' to fetch technical details if you are unsure of an API signature.

Available Documentation (Use 'readDoc' to read):
- viverse_sdk_docs.md: Comprehensive guide to the UMD namespace, featuring API blueprints for Auth, Avatar, Matchmaking, and Leaderboards.
- developer_tools.md: High-level map of SDK components and their corresponding roles in a project.
- skills-guide.md: Instructions for leveraging pre-built patterns and custom knowledge modules.
- usage.md: Server-level documentation for running and prompts for the Antigravity agent.`;
        logger.info(`Indexed documentation with Deep Summaries.`);

        // Initialize Knowledge (Will be refreshed dynamically)
        this.skillsSummary = "";
        this.refreshKnowledge();

        // Available tools declarations
        this.allToolDeclarations = {
            readFile: {
                name: "readFile",
                description: "Read the content of a file from the workspace.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        filePath: { type: "STRING", description: "Path to the file relative to the project root (e.g., 'voxel_landmark/src/App.jsx')" }
                    },
                    required: ["filePath"]
                }
            },
            writeFile: {
                name: "writeFile",
                description: "Write content to a file in the workspace.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        filePath: { type: "STRING", description: "Path to the file relative to the project root" },
                        content: { type: "STRING", description: "The content to write to the file" }
                    },
                    required: ["filePath", "content"]
                }
            },
            listFiles: {
                name: "listFiles",
                description: "List files and directories in a given path.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        dirPath: { type: "STRING", description: "Directory path relative to project root (default: '.')" }
                    }
                }
            },
            discoverProject: {
                name: "discoverProject",
                description: "Search for important project files (like App.jsx, package.json) to understand project type.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        projectName: { type: "STRING", description: "The name of the project folder to search in (e.g., 'voxel_landmark')" }
                    },
                    required: ["projectName"]
                }
            },
            runCommand: {
                name: "runCommand",
                description: "Execute a shell command in the project workspace.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        command: { type: "STRING", description: "The shell command to execute." },
                        cwd: { type: "STRING", description: "The directory to run the command in (relative to project root)." }
                    },
                    required: ["command"]
                }
            },
            searchRooms: {
                name: "searchRooms",
                description: "Search for rooms, worlds, or spaces in VIVERSE by keyword, tags, or popularity.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        q: { type: "STRING", description: "The search keyword (Optional: defaults to 'world' if omitted or empty)." },
                        sort: { type: "STRING", description: "Sort criteria: 'most_viewed', 'most_liked', 'create_date', 'first_public_date'." },
                        tag: { type: "STRING", description: "Filter by tags (comma-separated, e.g., 'art,hangout')." },
                        device: { type: "STRING", description: "Filter by device: 'desktop', 'mobile', or 'vr'." },
                        limit: { type: "NUMBER", description: "Number of results to return (default: 10)." }
                    }
                }
            },
            readDoc: {
                name: "readDoc",
                description: "Read a documentation file from the VIVERSE knowledge base.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        fileName: { type: "STRING", description: "Name of the markdown file (e.g., 'viverse_sdk_docs.md')" }
                    },
                    required: ["fileName"]
                }
            },
            loadSkill: {
                name: "loadSkill",
                description: "Load a specific pattern or example file from a VIVERSE skill.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        skillName: { type: "STRING", description: "Name of the skill folder" },
                        fileName: { type: "STRING", description: "Relative path within the skill" }
                    },
                    required: ["skillName", "fileName"]
                }
            },
            addLesson: {
                name: "addLesson",
                description: "Record a learned lesson (e.g., a bug fix, correct SDK URL, or bundling rule) into the project's persistent memory to avoid repeating mistakes.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        lesson: { type: "STRING", description: "The concise lesson describing the fix or best practice (max 200 chars)." }
                    },
                    required: ["lesson"]
                }
            }
        };

        this.models = {};
    }

    async refreshKnowledge() {
        logger.info('GeminiService: Refreshing dynamic knowledge base...');
        try {
            const skillsDir = path.resolve(process.cwd(), 'skills');
            const items = await fs.promises.readdir(skillsDir, { withFileTypes: true });
            
            let summary = "Available Skills (Use 'loadSkill' to read full details):\n";
            
            // 1. Scan Skills Directory
            for (const item of items) {
                if (item.isDirectory()) {
                    const skillName = item.name;
                    const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
                    if (fs.existsSync(skillPath)) {
                        // Extract title/description from frontmatter if possible, or use name
                        summary += `- ${skillName}\n`;
                    }
                }
            }

            // 2. Load the Hardened Resilience Guide (MANDATORY RELEASE BLOCKERS)
            const guidePath = path.join(skillsDir, 'viverse-resilience-guide.md');
            if (fs.existsSync(guidePath)) {
                const guideContent = fs.readFileSync(guidePath, 'utf8');
                summary += `\n[MANDATORY RESILIENCE GATES - v2.0 Hardened]\n${guideContent}\n`;
            }

            this.skillsSummary = summary;
            
            // Clear model cache to force re-injection of updated system instructions
            this.models = {};
            logger.info('GeminiService: Knowledge refreshed and model cache cleared.');
        } catch (e) {
            logger.error(`Failed to refresh knowledge: ${e.message}`);
        }
    }

    /**
     * Get or create a specialized model for a role
     */
    getModelForRole(roleKey = "ORCHESTRATOR") {
        if (this.models[roleKey]) return this.models[roleKey];

        const config = AgentRegistry[roleKey] || AgentRegistry.ORCHESTRATOR;
        const roleTools = config.tools.map(toolName => this.allToolDeclarations[toolName]).filter(Boolean);

        const modelConfig = {
            model: "gemini-3-flash-preview",
            tools: [{ functionDeclarations: roleTools }],
            systemInstruction: `${config.systemInstruction}\n\n[RESILIENCE_GATES]\n${this.skillsSummary}`
        };

        // Enforce JSON output for the Orchestrator to ensure reliable plan parsing
        if (roleKey === "ORCHESTRATOR") {
            modelConfig.generationConfig = { responseMimeType: "application/json" };
        }

        const model = this.genAI.getGenerativeModel(modelConfig);

        this.models[roleKey] = model;
        return model;
    }

    async generateResponse(message, history = [], roleKey = "ORCHESTRATOR", workspacePath = null) {
        const model = this.getModelForRole(roleKey);
        const contents = this._normalizeHistory(history);
        contents.push({ role: 'user', parts: [{ text: message }] });
        
        let result = await model.generateContent({ contents });
        let response = await result.response;

        // Tool calling loop
        let toolIterations = 0;
        const MAX_TOOL_ITERATIONS = 40;
        
        while (response.functionCalls()) {
            toolIterations++;
            if (toolIterations > MAX_TOOL_ITERATIONS) {
                logger.error(`GeminiService: MAX_TOOL_ITERATIONS reached in generateResponse.`);
                break;
            }
            const modelParts = response.candidates[0].content.parts;
            
            // Re-hydrate thoughtSignatures
            for (const part of modelParts) {
                if (part.functionCall && part.functionCall.id) {
                    const sig = global.geminiThoughtSignaturesCache[part.functionCall.id];
                    if (sig) {
                        part.thoughtSignature = sig;
                        part.thought_signature = sig; // In case the SDK strictly requires snake_case over the wire
                    }
                }
            }
            
            contents.push({ role: 'model', parts: modelParts });

            const toolResponses = await this._handleFunctionCalls(response.functionCalls(), workspacePath);
            contents.push({ role: 'user', parts: toolResponses });

            result = await model.generateContent({ contents });
            response = await result.response;
        }

        return response.text();
    }

    async *generateResponseStream(message, history = [], roleKey = "ORCHESTRATOR", workspacePath = null) {
        let model = this.getModelForRole(roleKey);
        const contents = this._normalizeHistory(history);

        // --- SYSTEM 1: PERSISTENT LESSONS (MEMORY) ---
        if (workspacePath) {
            try {
                const lessonsPath = path.join(workspacePath, '.viverse_lessons.json');
                if (fs.existsSync(lessonsPath)) {
                    const lessons = JSON.parse(fs.readFileSync(lessonsPath, 'utf8'));
                    if (lessons && lessons.length > 0) {
                        const lessonsContext = `MANDATORY WORKSPACE LESSONS (DO NOT REPEAT THESE ERRORS):\n${lessons.map((l, i) => `${i+1}. ${l}`).join('\n')}`;
                        contents.unshift({ role: 'user', parts: [{ text: lessonsContext }] }, { role: 'model', parts: [{ text: "Understood. I have loaded the workspace history and will strictly adhere to these previously learned lessons to avoid regressions." }] });
                        logger.info(`GeminiService: Injected ${lessons.length} lessons from ${lessonsPath}`);
                    }
                }
            } catch (e) {
                logger.warn(`GeminiService: Failed to load lessons: ${e.message}`);
            }
        }

        contents.push({ role: 'user', parts: [{ text: message }] });

        let result = await model.generateContentStream({ contents });

        for await (const chunk of result.stream) {
            try {
                const text = chunk.text();
                if (text) yield { type: 'text', content: text };
            } catch (e) {
                logger.warn(`GeminiService: Safety filter potentially blocked chunk. Continuing...`);
            }
        }

        let response = await result.response;

        let toolIterationsCount = 0;
        const MAX_TOOL_ITERATIONS_COUNT = 40;

        while (response.functionCalls()) {
            toolIterationsCount++;
            if (toolIterationsCount > MAX_TOOL_ITERATIONS_COUNT) {
                logger.error(`GeminiService: MAX_TOOL_ITERATIONS reached in generateResponseStream.`);
                yield { type: 'text', content: "\n\n[SYSTEM ERROR]: Periodic maintenance loop detected. Automatically stabilizing agent..." };
                break;
            }
            const modelParts = response.candidates[0].content.parts;
            
            // Re-hydrate thoughtSignatures
            for (const part of modelParts) {
                if (part.functionCall && part.functionCall.id) {
                    const sig = global.geminiThoughtSignaturesCache[part.functionCall.id];
                    if (sig) {
                        part.thoughtSignature = sig;
                        part.thought_signature = sig;
                    }
                }
            }
            
            contents.push({ role: 'model', parts: modelParts });

            // Execute tools with live status feedback
            const toolResponses = [];
            const calls = response.functionCalls();
            
            for (const call of calls) {
                const toolName = call.name;
                yield { type: 'status', content: `[TOOL] Executing ${toolName}...` };
                
                // Use the existing _handleFunctionCalls but for a single call at a time to keep it simple
                const singleResult = await this._handleFunctionCalls([call], workspacePath);
                toolResponses.push(singleResult[0]);
                
                yield { type: 'status', content: `[TOOL] ${toolName} finished.` };
            }
            
            contents.push({ role: 'user', parts: toolResponses });

            result = await model.generateContentStream({ contents });

            for await (const chunk of result.stream) {
                try {
                    const text = chunk.text();
                    if (text) yield { type: 'text', content: text };
                } catch (e) {
                    logger.warn(`GeminiService: Safety filter potentially blocked chunk during tool loop. Continuing...`);
                }
            }
            response = await result.response;
        }
    }

    async _handleFunctionCalls(calls, workspacePath) {
        const toolResponses = [];
        // LOGGING FOR DEBUGGING GEMINI 3 PROTOCOL
        const debugInfo = {
            modelCalls: calls.map(c => ({ name: c.name, args: c.args, id: c.id })),
            toolResponses: []
        };

        for (const call of calls) {
            const { name, args } = call;
            const callId = call.id; // Extract the call ID (required for Gemini 3)
            
            logger.info(`GeminiService: Executing tool ${name} (ID: ${callId})`);
            try {
                let toolResult;
                if (name === "readFile") toolResult = await fileService.readFile(args.filePath, workspacePath);
                else if (name === "writeFile") toolResult = await fileService.writeFile(args.filePath, args.content, workspacePath);
                else if (name === "listFiles") toolResult = await fileService.listFiles(args.dirPath, workspacePath);
                else if (name === "runCommand") toolResult = await fileService.runCommand(args.command, args.cwd, workspacePath);
                else if (name === "runBackgroundCommand") toolResult = await fileService.runBackgroundCommand(args.command, args.cwd, workspacePath);
                else if (name === "checkCommandStatus") toolResult = await fileService.checkCommandStatus(args.jobId, args.cwd, workspacePath);
                else if (name === "discoverProject") {
                    const files = await fileService.listFiles(args.projectName, workspacePath);
                    toolResult = { root: files };
                } 
                else if (name === "searchRooms") toolResult = await searchService.searchRooms(args);
                else if (name === "readDoc") {
                    const docPath = path.resolve(process.cwd(), 'docs', args.fileName);
                    toolResult = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : { error: "Doc not found" };
                }
                else if (name === "loadSkill") {
                    const skillPath = path.resolve(process.cwd(), 'skills', args.skillName, args.fileName);
                    toolResult = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf8') : { error: "Skill not found" };
                }
                else if (name === "addLesson") {
                    toolResult = await fileService.addLesson(args.lesson, workspacePath);
                }

                // Preserving ID in functionResponse for Gemini 3 compatibility
                const responsePart = {
                    functionResponse: { 
                        name, 
                        response: { result: toolResult }
                    }
                };
                if (callId) responsePart.functionResponse.id = callId;
                
                toolResponses.push(responsePart);
                debugInfo.toolResponses.push(responsePart);
            } catch (error) {
                const responsePart = {
                    functionResponse: { 
                        name, 
                        response: { error: error.message }
                    }
                };
                if (callId) responsePart.functionResponse.id = callId;
                
                toolResponses.push(responsePart);
                debugInfo.toolResponses.push(responsePart);
            }
        }

        // Write to log file
        fs.appendFileSync('/tmp/gemini_debug.log', JSON.stringify(debugInfo, null, 2) + '\n');
        
        return toolResponses;
    }


    async startChat(history = [], roleKey = "ORCHESTRATOR") {
        const model = this.getModelForRole(roleKey);
        return model.startChat({
            history: this._normalizeHistory(history),
            generationConfig: { maxOutputTokens: 2048 }
        });
    }

    /**
     * Normalizes history to the format required by Google Generative AI SDK:
     * { role: 'user'|'model', parts: [{ text: '...' }] }
     */
    /**
     * Normalizes history to the format required by Google Generative AI SDK:
     * { role: 'user'|'model', parts: [{ text: '...' } | { functionCall: ... } | { functionResponse: ... }] }
     */
    _normalizeHistory(history) {
        if (!Array.isArray(history)) return [];
        
        // Token Optimization: If history is too long, we only keep the most recent turns.
        // A typical turn (user + model) can be 1k-5k tokens. 
        // We cap at the last 15 turns to balance context and token usage.
        const MAX_HISTORY_TURNS = 50;
        const recentHistory = history.length > MAX_HISTORY_TURNS 
            ? history.slice(-MAX_HISTORY_TURNS) 
            : history;

        const normalized = [];
        for (let i = 0; i < recentHistory.length; i++) {
            const turn = recentHistory[i];
            let role = 'user';
            
            if (['model', 'assistant', 'system'].includes(turn.role)) {
                role = 'model';
            } else if (['user', 'function'].includes(turn.role)) {
                role = 'user';
            }

            const parts = turn.parts || (turn.content ? [{ text: turn.content }] : turn.text ? [{ text: turn.text }] : []);
            if (parts.length > 0) {
                normalized.push({ role, parts });
            }
        }
        
        // Ensure strictly alternating user/model roles for Gemini
        const cleaned = [];
        for (let i = 0; i < normalized.length; i++) {
            if (i > 0 && normalized[i].role === normalized[i-1].role) {
                // Merge consecutive turns of same role
                cleaned[cleaned.length-1].parts.push(...normalized[i].parts);
            } else {
                cleaned.push(normalized[i]);
            }
        }

        while (cleaned.length > 0) {
            const lastTurn = cleaned[cleaned.length - 1];
            const hasFunctionCalls = lastTurn.parts.some(p => p.functionCall);
            
            if (lastTurn.role === 'model' && hasFunctionCalls) {
                cleaned.pop();
            } else {
                break;
            }
        }

        return cleaned;
    }
}

export default new GeminiService();

