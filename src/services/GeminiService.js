import { GoogleGenerativeAI } from "@google/generative-ai";
import { JWT } from 'google-auth-library';
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

function _extractTextFromCandidates(candidates = []) {
    if (!Array.isArray(candidates)) return '';
    let out = '';
    for (const c of candidates) {
        const parts = c?.content?.parts || [];
        for (const p of parts) {
            if (typeof p?.text === 'string') out += p.text;
        }
    }
    return out;
}

function _extractFunctionCalls(candidates = []) {
    if (!Array.isArray(candidates)) return null;
    const calls = [];
    for (const c of candidates) {
        const parts = c?.content?.parts || [];
        for (const p of parts) {
            const call = p?.functionCall || p?.function_call;
            if (call) calls.push(call);
        }
    }
    return calls.length ? calls : null;
}

function _decorateGeminiResponse(raw = {}) {
    const candidates = Array.isArray(raw?.candidates) ? raw.candidates : [];
    return {
        ...raw,
        candidates,
        text() {
            return _extractTextFromCandidates(candidates);
        },
        functionCalls() {
            return _extractFunctionCalls(candidates);
        }
    };
}

class OAuthGeminiTransport {
    constructor({ authClient, model }) {
        this.authClient = authClient;
        this.model = model;
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    }

    async _headers() {
        const tokenResp = await this.authClient.getAccessToken();
        const accessToken = typeof tokenResp === 'string' ? tokenResp : tokenResp?.token;
        if (!accessToken) {
            const e = new Error('Failed to acquire Google OAuth access token');
            e.code = 'OAUTH_TOKEN_MISSING';
            throw e;
        }
        return {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };
    }

    async request(payload) {
        const headers = await this._headers();
        const url = `${this.baseUrl}/${encodeURIComponent(this.model)}:generateContent`;
        const resp = await originalFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        const text = await resp.text();
        let json = {};
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            json = {};
        }
        if (!resp.ok) {
            const e = new Error(`Gemini REST error ${resp.status}: ${text || resp.statusText}`);
            e.status = resp.status;
            e.code = resp.status;
            throw e;
        }
        return json;
    }

    async requestStream(payload) {
        const headers = await this._headers();
        const url = `${this.baseUrl}/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
        const resp = await originalFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            const text = await resp.text();
            const e = new Error(`Gemini REST stream error ${resp.status}: ${text || resp.statusText}`);
            e.status = resp.status;
            e.code = resp.status;
            throw e;
        }
        if (!resp.body) {
            const e = new Error('Gemini REST stream returned empty body');
            e.code = 'EMPTY_STREAM_BODY';
            throw e;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastJson = { candidates: [] };
        const merged = { candidates: [] };
        let resolveFinal;
        const finalResponse = new Promise((resolve) => {
            resolveFinal = resolve;
        });

        const parseSseEvent = (rawEvent = '') => {
            const lines = String(rawEvent || '').split(/\r?\n/);
            const dataLines = [];
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                dataLines.push(line.slice(5).trimStart());
            }
            if (!dataLines.length) return null;
            const data = dataLines.join('\n').trim();
            if (!data || data === '[DONE]') return null;
            try {
                return JSON.parse(data);
            } catch {
                return null;
            }
        };

        const stream = (async function* () {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });

                    while (true) {
                        const idxLf = buffer.indexOf('\n\n');
                        const idxCrLf = buffer.indexOf('\r\n\r\n');
                        const hasLf = idxLf >= 0;
                        const hasCrLf = idxCrLf >= 0;
                        if (!hasLf && !hasCrLf) break;
                        const useCrLf = hasCrLf && (!hasLf || idxCrLf < idxLf);
                        const splitIdx = useCrLf ? idxCrLf : idxLf;
                        const sepLen = useCrLf ? 4 : 2;
                        const rawEvent = buffer.slice(0, splitIdx);
                        buffer = buffer.slice(splitIdx + sepLen);
                        const json = parseSseEvent(rawEvent);
                        if (!json) continue;
                        lastJson = json;
                        const chunkCandidates = Array.isArray(json?.candidates) ? json.candidates : [];
                        for (let i = 0; i < chunkCandidates.length; i++) {
                            const src = chunkCandidates[i] || {};
                            if (!merged.candidates[i]) merged.candidates[i] = { content: { parts: [] } };
                            const srcParts = src?.content?.parts || [];
                            if (!Array.isArray(merged.candidates[i].content?.parts)) {
                                merged.candidates[i].content = { parts: [] };
                            }
                            merged.candidates[i].content.parts.push(...srcParts);
                            if (src.finishReason && !merged.candidates[i].finishReason) {
                                merged.candidates[i].finishReason = src.finishReason;
                            }
                        }
                        yield json;
                    }
                }

                // Flush any trailing event block without blank-line terminator.
                const trailing = parseSseEvent(buffer);
                if (trailing) {
                    lastJson = trailing;
                    const trailingCandidates = Array.isArray(trailing?.candidates) ? trailing.candidates : [];
                    for (let i = 0; i < trailingCandidates.length; i++) {
                        const src = trailingCandidates[i] || {};
                        if (!merged.candidates[i]) merged.candidates[i] = { content: { parts: [] } };
                        const srcParts = src?.content?.parts || [];
                        if (!Array.isArray(merged.candidates[i].content?.parts)) {
                            merged.candidates[i].content = { parts: [] };
                        }
                        merged.candidates[i].content.parts.push(...srcParts);
                        if (src.finishReason && !merged.candidates[i].finishReason) {
                            merged.candidates[i].finishReason = src.finishReason;
                        }
                    }
                    yield trailing;
                }
            } finally {
                const hasMergedParts = merged.candidates.some((c) => Array.isArray(c?.content?.parts) && c.content.parts.length > 0);
                resolveFinal(hasMergedParts ? merged : lastJson);
            }
        })();

        return { stream, finalResponse };
    }
}

class OAuthGenerativeModel {
    constructor(modelConfig, authClient) {
        this.modelConfig = modelConfig;
        this.transport = new OAuthGeminiTransport({
            authClient,
            model: modelConfig.model || 'gemini-3-flash-preview'
        });
    }

    _buildPayload(contents = []) {
        const payload = {
            contents,
            tools: this.modelConfig.tools || []
        };

        if (this.modelConfig.systemInstruction) {
            payload.systemInstruction = {
                role: 'system',
                parts: [{ text: this.modelConfig.systemInstruction }]
            };
        }
        if (this.modelConfig.generationConfig) {
            payload.generationConfig = this.modelConfig.generationConfig;
        }
        return payload;
    }

    async generateContent({ contents }) {
        const json = await this.transport.request(this._buildPayload(contents));
        return { response: Promise.resolve(_decorateGeminiResponse(json)) };
    }

    async generateContentStream({ contents }) {
        const { stream, finalResponse } = await this.transport.requestStream(this._buildPayload(contents));
        const wrappedStream = (async function* () {
            for await (const chunk of stream) {
                yield {
                    text() {
                        return _extractTextFromCandidates(chunk?.candidates || []);
                    }
                };
            }
        })();
        return {
            stream: wrappedStream,
            response: finalResponse.then((raw) => _decorateGeminiResponse(raw))
        };
    }

    startChat() {
        throw new Error('startChat is not implemented for private_key mode');
    }
}

class GeminiService {
    constructor() {
        this.apiKey = process.env.GOOGLE_API_KEY;
        this.authMode = 'api_key';
        this.oauthClient = null;

        const svcFromJson = this._loadServiceAccountJson();
        const clientEmail = process.env.GOOGLE_CLIENT_EMAIL || svcFromJson?.client_email || '';
        const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || svcFromJson?.private_key || '';
        const privateKey = String(privateKeyRaw || '').replace(/\\n/g, '\n').trim();

        if (clientEmail && privateKey) {
            this.authMode = 'private_key';
            this.oauthClient = new JWT({
                email: clientEmail,
                key: privateKey,
                scopes: [
                    'https://www.googleapis.com/auth/generative-language',
                    'https://www.googleapis.com/auth/cloud-platform'
                ]
            });
            this.genAI = null;
            logger.info('GeminiService: Initialized in private_key auth mode (service account).');
        } else {
            if (!this.apiKey) {
                logger.error('GOOGLE_API_KEY is not defined in environment variables');
            }
            this.genAI = new GoogleGenerativeAI(this.apiKey);
            logger.info('GeminiService: Initialized in api_key auth mode.');
        }

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
        this.commandConvergence = new Map();
    }

    _loadServiceAccountJson() {
        const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            try {
                const decoded = Buffer.from(raw, 'base64').toString('utf8');
                return JSON.parse(decoded);
            } catch {
                logger.warn('GeminiService: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON/base64 JSON.');
                return null;
            }
        }
    }

    _workspaceConvergenceState(workspacePath = null) {
        const key = workspacePath || '__global__';
        if (!this.commandConvergence.has(key)) {
            this.commandConvergence.set(key, {
                mutationVersion: 0,
                byClass: {},
                addLessonCount: 0,
                runCommandCount: 0,
                distGrepCount: 0,
                lastDistGrepMutationVersion: -1
            });
        }
        return this.commandConvergence.get(key);
    }

    _resetTurnCounters(workspacePath = null) {
        const state = this._workspaceConvergenceState(workspacePath);
        state.addLessonCount = 0;
        state.runCommandCount = 0;
        state.distGrepCount = 0;
    }

    _bumpMutationVersion(workspacePath = null) {
        const state = this._workspaceConvergenceState(workspacePath);
        state.mutationVersion += 1;
    }

    _classifyCommand(command = '') {
        const cmd = String(command || '').toLowerCase();
        if (!cmd.trim()) return '';
        if (/(^|\s)grep(\s|$)/.test(cmd) && /\bdist\b/.test(cmd)) {
            return 'dist_appid_check';
        }
        if (/npm\s+run\s+build/.test(cmd)) return 'build';
        return '';
    }

    _outputSignature(toolResult) {
        if (!toolResult || typeof toolResult !== 'object') return String(toolResult || '');
        const reduced = {
            error: String(toolResult.error || ''),
            stdout: String(toolResult.stdout || '').slice(0, 400),
            stderr: String(toolResult.stderr || '').slice(0, 400)
        };
        return JSON.stringify(reduced);
    }

    _truncateText(value = '', maxChars = 16000) {
        const text = String(value ?? '');
        if (text.length <= maxChars) return text;
        const head = text.slice(0, maxChars);
        return `${head}\n...[truncated ${text.length - maxChars} chars]`;
    }

    _sanitizeToolResultForModel(toolName = '', toolResult = null) {
        const name = String(toolName || '');
        const MAX_TEXT = 16000;
        const MAX_JSON = 120000;

        let out = toolResult;

        if (typeof out === 'string') {
            out = this._truncateText(out, MAX_TEXT);
        } else if (Array.isArray(out)) {
            out = out.slice(0, 200);
        } else if (out && typeof out === 'object') {
            const copy = { ...out };
            if (typeof copy.stdout === 'string') copy.stdout = this._truncateText(copy.stdout, MAX_TEXT);
            if (typeof copy.stderr === 'string') copy.stderr = this._truncateText(copy.stderr, MAX_TEXT);
            if (typeof copy.error === 'string') copy.error = this._truncateText(copy.error, 4000);
            out = copy;
        }

        // readFile/readDoc/loadSkill can easily blow the tool-loop context window.
        if (name === 'readFile' || name === 'readDoc' || name === 'loadSkill') {
            if (typeof out === 'string') {
                out = this._truncateText(out, 24000);
            } else if (out && typeof out === 'object') {
                for (const k of Object.keys(out)) {
                    if (typeof out[k] === 'string') out[k] = this._truncateText(out[k], 24000);
                }
            }
        }

        try {
            const encoded = JSON.stringify(out);
            if (encoded && encoded.length > MAX_JSON) {
                return {
                    truncated: true,
                    tool: name,
                    note: `Tool result exceeded ${MAX_JSON} chars and was compacted.`,
                    preview: this._truncateText(encoded, 24000)
                };
            }
        } catch (_) {
            return this._truncateText(String(out ?? ''), 24000);
        }

        return out;
    }

    _isRateLimitError(error) {
        const msg = String(error?.message || error || '');
        const code = error?.status || error?.code;
        return code === 429 || msg.includes('429') || msg.toLowerCase().includes('quota exceeded') || msg.toLowerCase().includes('too many requests');
    }

    _extractRetryDelayMs(error, attempt = 1) {
        const msg = String(error?.message || error || '');
        const secFromRetryIn = msg.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s?/i);
        if (secFromRetryIn) return Math.ceil(Number(secFromRetryIn[1]) * 1000) + 250;

        const secFromRpc = msg.match(/"retryDelay":"([0-9]+)s"/i);
        if (secFromRpc) return Math.ceil(Number(secFromRpc[1]) * 1000) + 250;

        const base = Math.min(120000, 15000 * attempt);
        return base + Math.floor(Math.random() * 500);
    }

    async _withRateLimitRetry(fn, label = 'gemini_call', maxRetries = 5) {
        let attempt = 0;
        // total attempts = 1 + maxRetries
        while (true) {
            attempt += 1;
            try {
                return await fn();
            } catch (error) {
                const canRetry = this._isRateLimitError(error) && attempt <= maxRetries;
                if (!canRetry) throw error;

                const delayMs = this._extractRetryDelayMs(error, attempt);
                logger.warn(`GeminiService: ${label} hit rate limit (attempt ${attempt}). Retrying in ${delayMs}ms`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }

    _normalizeAttachments(attachments = []) {
        if (!Array.isArray(attachments)) return [];
        const docMimes = new Set([
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
            'text/markdown',
            'application/json',
            'text/csv'
        ]);
        return attachments
            .map((item) => {
                const mimeType = String(item?.mimeType || item?.type || '').toLowerCase();
                const data = typeof item?.dataBase64 === 'string' ? item.dataBase64.trim() : '';
                if (!mimeType || !data) return null;
                const isMedia = mimeType.startsWith('image/') || mimeType.startsWith('video/');
                const isDoc = docMimes.has(mimeType);
                if (!isMedia && !isDoc) return null;
                return {
                    name: item?.name || 'attachment',
                    mimeType,
                    dataBase64: data
                };
            })
            .filter(Boolean);
    }

    _isTextSpecMime(mimeType = '') {
        const m = String(mimeType).toLowerCase();
        return (
            m === 'text/plain' ||
            m === 'text/markdown' ||
            m === 'application/json' ||
            m === 'text/csv'
        );
    }

    _buildUserParts(message, attachments = []) {
        const parts = [{ text: String(message || '') }];
        const media = this._normalizeAttachments(attachments);
        for (const file of media) {
            if (this._isTextSpecMime(file.mimeType)) {
                try {
                    const text = Buffer.from(file.dataBase64, 'base64').toString('utf8');
                    const trimmed = text.length > 50000 ? `${text.slice(0, 50000)}\n...[truncated]` : text;
                    parts.push({
                        text: `\n[ATTACHED SPEC FILE: ${file.name} | ${file.mimeType}]\n${trimmed}\n[END SPEC FILE]\n`
                    });
                    continue;
                } catch (_) {
                    // Fallback to inlineData when decode fails.
                }
            }
            parts.push({
                inlineData: {
                    mimeType: file.mimeType,
                    data: file.dataBase64
                }
            });
        }
        return parts;
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

        const model = this.authMode === 'private_key'
            ? new OAuthGenerativeModel(modelConfig, this.oauthClient)
            : this.genAI.getGenerativeModel(modelConfig);

        this.models[roleKey] = model;
        return model;
    }

    async generateResponse(message, history = [], roleKey = "ORCHESTRATOR", workspacePath = null, attachments = []) {
        this._resetTurnCounters(workspacePath);
        const model = this.getModelForRole(roleKey);
        const contents = this._normalizeHistory(history);
        contents.push({ role: 'user', parts: this._buildUserParts(message, attachments) });
        
        let result = await this._withRateLimitRetry(
            () => model.generateContent({ contents }),
            'generateContent'
        );
        let response = await result.response;

        // Tool calling loop
        let toolIterations = 0;
        const MAX_TOOL_ITERATIONS = 40;
        
        while (response.functionCalls()) {
            toolIterations++;
            if (toolIterations > MAX_TOOL_ITERATIONS) {
                logger.error(`GeminiService: MAX_TOOL_ITERATIONS reached in generateResponse.`);
                throw new Error('MAX_TOOL_ITERATIONS_REACHED');
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

            result = await this._withRateLimitRetry(
                () => model.generateContent({ contents }),
                'generateContent(toolLoop)'
            );
            response = await result.response;
        }

        return response.text();
    }

    async *generateResponseStream(message, history = [], roleKey = "ORCHESTRATOR", workspacePath = null, attachments = []) {
        this._resetTurnCounters(workspacePath);
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

        contents.push({ role: 'user', parts: this._buildUserParts(message, attachments) });

        let result = await this._withRateLimitRetry(
            () => model.generateContentStream({ contents }),
            'generateContentStream'
        );

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
                throw new Error('MAX_TOOL_ITERATIONS_REACHED');
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

            result = await this._withRateLimitRetry(
                () => model.generateContentStream({ contents }),
                'generateContentStream(toolLoop)'
            );

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
                else if (name === "writeFile") {
                    toolResult = await fileService.writeFile(args.filePath, args.content, workspacePath);
                    this._bumpMutationVersion(workspacePath);
                }
                else if (name === "listFiles") toolResult = await fileService.listFiles(args.dirPath, workspacePath);
                else if (name === "runCommand") {
                    const wsState = this._workspaceConvergenceState(workspacePath);
                    wsState.runCommandCount = Number(wsState.runCommandCount || 0) + 1;
                    toolResult = await fileService.runCommand(args.command, args.cwd, workspacePath);
                    const commandClass = this._classifyCommand(args.command);
                    if (commandClass === 'build') {
                        this._bumpMutationVersion(workspacePath);
                    } else if (commandClass) {
                        const state = this._workspaceConvergenceState(workspacePath);
                        const byClass = state.byClass || {};
                        const record = byClass[commandClass] || {
                            repeatCount: 0,
                            lastMutationVersion: -1,
                            lastOutputSig: ''
                        };
                        const outputSig = this._outputSignature(toolResult);
                        const sameOutput = record.lastOutputSig === outputSig;
                        const sameMutation = record.lastMutationVersion === state.mutationVersion;
                        if (sameOutput && sameMutation) {
                            record.repeatCount += 1;
                        } else {
                            record.repeatCount = 1;
                            record.lastOutputSig = outputSig;
                            record.lastMutationVersion = state.mutationVersion;
                        }
                        byClass[commandClass] = record;
                        state.byClass = byClass;

                        const sameBuildMutation = state.lastDistGrepMutationVersion === state.mutationVersion;
                        if (!sameBuildMutation) {
                            state.distGrepCount = 0;
                            state.lastDistGrepMutationVersion = state.mutationVersion;
                        }
                        state.distGrepCount = Number(state.distGrepCount || 0) + 1;

                        if (record.repeatCount >= 3 || state.distGrepCount >= 8) {
                            toolResult = {
                                ...toolResult,
                                error: `CONVERGENCE_GUARD: excessive dist grep probing without meaningful state change. Stop free-form token hunting and perform deterministic App ID propagation verification (.env -> source -> dist) with the authoritative 10-char app id.`,
                                retriable: false,
                                convergenceGuard: true
                            };
                        }
                    }
                }
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
                    const wsState = this._workspaceConvergenceState(workspacePath);
                    wsState.addLessonCount = Number(wsState.addLessonCount || 0) + 1;
                    if (wsState.addLessonCount > 3) {
                        toolResult = {
                            error: "CONVERGENCE_GUARD: addLesson call cap reached for this turn (max 3). Continue implementation/review without adding more lessons.",
                            retriable: false,
                            convergenceGuard: true
                        };
                    } else {
                        toolResult = await fileService.addLesson(args.lesson, workspacePath);
                    }
                }

                toolResult = this._sanitizeToolResultForModel(name, toolResult);

                if (toolResult && typeof toolResult === 'object' && toolResult.fatal === true) {
                    const fatalToolError = new Error(`FATAL_TOOL_ERROR:${toolResult.errorCode || 'UNKNOWN'}:${toolResult.error || 'Unknown fatal tool error'}`);
                    fatalToolError.fatalTool = true;
                    fatalToolError.toolName = name;
                    fatalToolError.toolResult = toolResult;
                    throw fatalToolError;
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
                if (error && error.fatalTool) {
                    logger.error(`GeminiService: Fatal tool error in ${error.toolName}: ${error.message}`);
                    throw error;
                }
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
