import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import fileService from './FileService.js';
import searchService from './SearchService.js';

class GeminiService {
    constructor() {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            logger.error('GOOGLE_API_KEY is not defined in environment variables');
        }
        this.genAI = new GoogleGenerativeAI(apiKey);

        // Load VIVERSE SDK knowledge base
        let viverseKnowledge = "";
        try {
            const docsDir = path.resolve(process.cwd(), 'docs');
            const files = fs.readdirSync(docsDir);
            const markdownFiles = files.filter(file => file.endsWith('.md'));

            markdownFiles.forEach(file => {
                const content = fs.readFileSync(path.join(docsDir, file), 'utf8');
                viverseKnowledge += `\n--- DOCUMENT: ${file} ---\n${content}\n`;
            });
            logger.info(`Loaded knowledge from ${markdownFiles.length} documentation files.`);
        } catch (error) {
            logger.warn('Error loading VIVERSE SDK docs, continuing with limited knowledge.', error);
        }

        // Define tools for the agent
        this.tools = [
            {
                functionDeclarations: [
                    {
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
                    {
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
                    {
                        name: "listFiles",
                        description: "List files and directories in a given path.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                dirPath: { type: "STRING", description: "Directory path relative to project root (default: '.')" }
                            }
                        }
                    },
                    {
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
                    {
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
                    {
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
                    }
                ]
            }
        ];

        this.model = this.genAI.getGenerativeModel({
            model: "gemini-2.0-flash",
            tools: this.tools,
            systemInstruction: `You are VIVERSE Discovery, an intelligent scout designed to help users find and explore worlds, spaces, and landmarks within the VIVERSE ecosystem. 
            
            Your primary goal is to help users discover immersive content.
            1. Use 'searchRooms' as your primary tool to find worlds, spaces, or landmarks.
            2. When 'searchRooms' returns results, you MUST construct the public URL for a room using the 'hub_sid' property.
               URL Format: https://worlds.viverse.com/[hub_sid]?full3d=
               Always provide these clickable links and present results in a Markdown table.
            
            Secondary Capability (Code & Project): You can also help with technical tasks if specifically asked.
            3. Use 'discoverProject', 'listFiles', and 'readFile' to understand code.
            4. Use 'writeFile' and 'runCommand' to apply fixes or deploy projects (e.g., 'viverse publish').
            
            RAW DATA: If the user explicitly asks for "raw response," "raw data," or "JSON," print the exact JSON object you received from the tool.
            
            GENERAL SEARCHES: If the user asks for a general list (e.g., "most popular worlds") without any specific keyword or theme, use a broad keyword like "world" or "space" automatically. If they provide a theme (e.g., "art"), use that as the keyword.
            
            ITERATIVE DISCOVERY: If a specific search (e.g., "mortgage calculator") returns 0 results, DO NOT GIVE UP. Use your understanding of context to try at least 2-3 broader or related keywords in sequence (e.g., "loan", "finance", "calculator", "bank") before reporting that nothing was found.
            
            USER INTERFACE: Your web interface supports FULL MARKDOWN (Tables, Bold, Lists, Code blocks). Use them to provide a premium and readable experience.
            
            Use the following VIVERSE SDK reference if technical help is needed:
            
            ${viverseKnowledge}`
        });
    }


    async generateResponse(message, chatHistory = []) {
        const stream = this.generateResponseStream(message, chatHistory);
        let finalOutput = "";
        for await (const chunk of stream) {
            if (chunk.type === 'text') {
                finalOutput += chunk.content;
            }
        }
        return finalOutput;
    }

    async *generateResponseStream(message, chatHistory = []) {
        try {
            logger.info(`Starting stream for: ${message.substring(0, 50)}...`);
            const normalizedHistory = this._normalizeHistory(chatHistory);

            const chat = this.model.startChat({
                history: normalizedHistory,
                generationConfig: {
                    maxOutputTokens: 2048,
                }
            });

            let result = await chat.sendMessageStream(message);

            for await (const chunk of result.stream) {
                const text = chunk.text();
                if (text) yield { type: 'text', content: text };
            }

            let response = await result.response;

            // Handle function calls loop
            while (response.functionCalls()) {
                const calls = response.functionCalls();
                const toolResponses = [];

                for (const call of calls) {
                    const { name, args } = call;
                    yield { type: 'status', content: `Executing tool: ${name}...` };
                    logger.info(`Agent calling tool: ${name}`);

                    try {
                        let toolResult;
                        if (name === "readFile") {
                            toolResult = await fileService.readFile(args.filePath);
                        } else if (name === "writeFile") {
                            toolResult = await fileService.writeFile(args.filePath, args.content);
                        } else if (name === "listFiles") {
                            toolResult = await fileService.listFiles(args.dirPath);
                        } else if (name === "runCommand") {
                            toolResult = await fileService.runCommand(args.command, args.cwd);
                        } else if (name === "discoverProject") {
                            // Simple discovery logic: list files in common paths
                            const files = await fileService.listFiles(args.projectName);
                            const srcDir = path.join(args.projectName, 'src');
                            let srcFiles = [];
                            try {
                                srcFiles = await fileService.listFiles(srcDir);
                            } catch (e) {
                                // src might not exist
                            }
                            toolResult = { root: files, src: srcFiles };
                        } else if (name === "searchRooms") {
                            toolResult = await searchService.searchRooms(args);
                        }

                        toolResponses.push({
                            functionResponse: {
                                name: name,
                                response: { result: toolResult }
                            }
                        });
                    } catch (toolError) {
                        logger.error(`Tool execution error [${name}]: ${toolError.message}`);
                        toolResponses.push({
                            functionResponse: {
                                name: name,
                                response: { error: toolError.message }
                            }
                        });
                    }
                }

                // Send tool responses back to continue the generation
                result = await chat.sendMessageStream(toolResponses);

                for await (const chunk of result.stream) {
                    const text = chunk.text();
                    if (text) yield { type: 'text', content: text };
                }

                response = await result.response;
            }
        } catch (error) {
            logger.error(`Gemini Streaming Error: ${error.message}`);
            yield { type: 'error', content: error.message };
        }
    }


    async startChat(history = []) {
        try {
            return this.model.startChat({
                history: history,
                generationConfig: {
                    maxOutputTokens: 2048,
                },
            });
        } catch (error) {
            logger.error(`Gemini Chat Error: ${error.message}`);
            throw new Error(`Failed to start chat: ${error.message}`);
        }
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

