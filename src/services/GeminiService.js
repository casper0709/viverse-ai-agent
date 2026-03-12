import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import fileService from './FileService.js';
import searchService from './SearchService.js';
import AgentRegistry from './AgentRegistry.js';

class GeminiService {
    constructor() {
        this.apiKey = process.env.GOOGLE_API_KEY;
        if (!this.apiKey) {
            logger.error('GOOGLE_API_KEY is not defined in environment variables');
        }
        this.genAI = new GoogleGenerativeAI(this.apiKey);

        // Load VIVERSE SDK knowledge base
        this.viverseKnowledge = "";
        try {
            const docsDir = path.resolve(process.cwd(), 'docs');
            const files = fs.readdirSync(docsDir);
            const markdownFiles = files.filter(file => file.endsWith('.md'));

            markdownFiles.forEach(file => {
                const content = fs.readFileSync(path.join(docsDir, file), 'utf8');
                this.viverseKnowledge += `\n--- DOCUMENT: ${file} ---\n${content}\n`;
            });
            logger.info(`Loaded knowledge from ${markdownFiles.length} documentation files.`);
        } catch (error) {
            logger.warn('Error loading VIVERSE SDK docs, continuing with limited knowledge.', error);
        }

        // Load Skills (SKILL.md summaries for each skill)
        this.skillsSummary = "";
        try {
            const skillsDir = path.resolve(process.cwd(), 'skills');
            if (fs.existsSync(skillsDir)) {
                const skillFolders = fs.readdirSync(skillsDir, { withFileTypes: true })
                    .filter(d => d.isDirectory());

                skillFolders.forEach(folder => {
                    const skillFile = path.join(skillsDir, folder.name, 'SKILL.md');
                    if (fs.existsSync(skillFile)) {
                        const content = fs.readFileSync(skillFile, 'utf8');
                        this.skillsSummary += `\n--- SKILL: ${folder.name} ---\n${content}\n`;
                    }
                });
                logger.info(`Loaded ${skillFolders.length} skills.`);
            }
        } catch (error) {
            logger.warn('Error loading skills, continuing without them.', error);
        }

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
            }
        };

        this.models = {};
    }

    /**
     * Get or create a specialized model for a role
     */
    getModelForRole(roleKey = "ORCHESTRATOR") {
        if (this.models[roleKey]) return this.models[roleKey];

        const config = AgentRegistry[roleKey] || AgentRegistry.ORCHESTRATOR;
        const roleTools = config.tools.map(toolName => this.allToolDeclarations[toolName]).filter(Boolean);

        const modelConfig = {
            model: "gemini-2.0-flash",
            tools: [{ functionDeclarations: roleTools }],
            systemInstruction: `${config.systemInstruction}\n\nVIVERSE Knowledge Base:\n${this.viverseKnowledge}\n\nAvailable Skills:\n${this.skillsSummary}`
        };

        // Enforce JSON output for the Orchestrator to ensure reliable plan parsing
        if (roleKey === "ORCHESTRATOR") {
            modelConfig.generationConfig = { responseMimeType: "application/json" };
        }

        const model = this.genAI.getGenerativeModel(modelConfig);

        this.models[roleKey] = model;
        return model;
    }

    async generateResponse(message, history = [], roleKey = "ORCHESTRATOR") {
        const model = this.getModelForRole(roleKey);
        const normalizedHistory = this._normalizeHistory(history);
        const chat = model.startChat({ history: normalizedHistory });
        
        let result = await chat.sendMessage(message);
        let response = await result.response;

        // Tool calling loop
        while (response.functionCalls()) {
            const toolResponses = await this._handleFunctionCalls(response.functionCalls());
            result = await chat.sendMessage(toolResponses);
            response = await result.response;
        }

        return response.text();
    }

    async *generateResponseStream(message, history = [], roleKey = "ORCHESTRATOR") {
        const model = this.getModelForRole(roleKey);
        const normalizedHistory = this._normalizeHistory(history);
        const chat = model.startChat({ history: normalizedHistory });

        let result = await chat.sendMessageStream(message);

        for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) yield { type: 'text', content: text };
        }

        let response = await result.response;

        while (response.functionCalls()) {
            const toolResponses = await this._handleFunctionCalls(response.functionCalls());
            result = await chat.sendMessageStream(toolResponses);

            for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) yield { type: 'text', content: text };
            }
            response = await result.response;
        }
    }

    async _handleFunctionCalls(calls) {
        const toolResponses = [];
        for (const call of calls) {
            const { name, args } = call;
            logger.info(`GeminiService: Executing tool ${name}`);
            try {
                let toolResult;
                if (name === "readFile") toolResult = await fileService.readFile(args.filePath);
                else if (name === "writeFile") toolResult = await fileService.writeFile(args.filePath, args.content);
                else if (name === "listFiles") toolResult = await fileService.listFiles(args.dirPath);
                else if (name === "runCommand") toolResult = await fileService.runCommand(args.command, args.cwd);
                else if (name === "discoverProject") {
                    const files = await fileService.listFiles(args.projectName);
                    toolResult = { root: files };
                } 
                else if (name === "searchRooms") toolResult = await searchService.searchRooms(args);
                else if (name === "loadSkill") {
                    const skillPath = path.resolve(process.cwd(), 'skills', args.skillName, args.fileName);
                    toolResult = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf8') : { error: "Skill not found" };
                }

                toolResponses.push({
                    functionResponse: { name, response: { result: toolResult } }
                });
            } catch (error) {
                toolResponses.push({
                    functionResponse: { name, response: { error: error.message } }
                });
            }
        }
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
    _normalizeHistory(history) {
        if (!Array.isArray(history)) return [];
        return history.map(turn => {
            const role = turn.role === 'model' || turn.role === 'assistant' ? 'model' : 'user';

            // If already correct format
            if (turn.parts && Array.isArray(turn.parts)) {
                return { role, parts: turn.parts };
            }

            // If using 'content' or 'text' directly
            const text = turn.content || turn.text || (turn.parts && turn.parts[0]?.text) || "";
            return { role, parts: [{ text }] };
        });
    }
}

export default new GeminiService();

