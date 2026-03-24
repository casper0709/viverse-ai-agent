import geminiService from '../services/GeminiService.js';
import orchestratorService from '../services/OrchestratorService.js';
import fileService from '../services/FileService.js';
import templateRegistryService from '../services/templates/TemplateRegistryService.js';
import templateContractService from '../services/templates/TemplateContractService.js';
import logger from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const APP_HISTORY_FILE = path.resolve(process.cwd(), '.viverse_app_history.json');
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_SIZE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENTS_BYTES = 48 * 1024 * 1024;
const EXTRA_DOC_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'application/json',
    'text/csv'
]);
const TEMPLATE_CATALOG_FALLBACK = [
    {
        id: 'battletanks-v1',
        name: 'BattleTanks Base Template',
        version: '1.0.0',
        genre: 'Action Shooter',
        description: 'Tank-combat starter template with protected engine core and customizable gameplay surface.',
        tags: ['game', 'tank', 'action', 'threejs', 'multiplayer-ready'],
        capabilities: ['auth', 'matchmaking', 'leaderboard', 'publish'],
        recommendedPrompt: "Create a new tank battle game using template 'battletanks-v1'. Keep core architecture stable and customize gameplay rules and UI."
    },
    {
        id: 'blank-webapp-v1',
        name: 'Blank Web App',
        version: '1.0.0',
        genre: 'Utility',
        description: 'Lightweight baseline for non-game app generation with VIVERSE integration hooks.',
        tags: ['app', 'blank', 'utility'],
        capabilities: ['auth', 'publish'],
        recommendedPrompt: "Create a new web app from template 'blank-webapp-v1' and implement the requested feature set."
    }
];

const isExecutionIntent = (message = '') => {
    const text = String(message || '').toLowerCase();
    return /(resume|continue|proceed|fix|debug|error|bug|issue|retest|test|build|publish|run|req_\d+)/.test(text);
};

const isLatestAppQuery = (message = '') => {
    const text = String(message || '').toLowerCase().trim();
    if (!text) return false;
    if (isExecutionIntent(text)) return false;
    return (
        /\b(show|list|get)\s+(my\s+)?(latest\s+)?app ids?\b/.test(text) ||
        /\blatest\s+app\s+id\b/.test(text) ||
        /\bother\s+recent\s+app\s+ids?\b/.test(text)
    );
};

const emailKey = (email = '') =>
    crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

const maskEmail = (email = '') => {
    const [name, domain] = String(email).split('@');
    if (!name || !domain) return 'unknown';
    const head = name.slice(0, 2);
    return `${head}***@${domain}`;
};

const upsertUserAppHistory = async (email, apps = []) => {
    if (!email) return;
    const key = emailKey(email);
    let existing = {};
    try {
        const content = await fs.readFile(APP_HISTORY_FILE, 'utf8');
        existing = JSON.parse(content);
    } catch (_) {
        existing = {};
    }

    existing[key] = {
        updatedAt: new Date().toISOString(),
        latestAppId: apps?.[0]?.appId || null,
        apps: apps.slice(0, 50)
    };

    await fs.writeFile(APP_HISTORY_FILE, JSON.stringify(existing, null, 2), 'utf8');
};

const normalizeAttachments = (items = []) => {
    if (!Array.isArray(items)) return [];
    let totalBytes = 0;
    return items
        .slice(0, MAX_ATTACHMENTS)
        .map((item) => {
            const mimeType = String(item?.mimeType || item?.type || '').toLowerCase().trim();
            const dataBase64 = typeof item?.dataBase64 === 'string' ? item.dataBase64.trim() : '';
            if (!mimeType || !dataBase64) return null;
            const isMedia = mimeType.startsWith('image/') || mimeType.startsWith('video/');
            const isDoc = EXTRA_DOC_MIME_TYPES.has(mimeType);
            if (!isMedia && !isDoc) return null;

            const bytes = Math.floor((dataBase64.length * 3) / 4);
            if (bytes > MAX_ATTACHMENT_SIZE_BYTES) {
                throw new Error(`Attachment too large: ${item?.name || 'file'} (${Math.round(bytes / (1024 * 1024))}MB)`);
            }
            totalBytes += bytes;
            if (totalBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
                throw new Error(`Attachments total size exceeded (${Math.round(totalBytes / (1024 * 1024))}MB). Max total is ${Math.round(MAX_TOTAL_ATTACHMENTS_BYTES / (1024 * 1024))}MB.`);
            }

            return {
                name: item?.name || 'attachment',
                mimeType,
                dataBase64
            };
        })
        .filter(Boolean);
};

const buildAttachmentSummary = (attachments = []) => {
    if (!attachments.length) return '';
    const lines = attachments.map((a, idx) => `- ${idx + 1}. ${a.name} (${a.mimeType})`);
    return `\n\nAttached files:\n${lines.join('\n')}\nUse attached media/spec context when answering.`;
};

const isAttachmentValidationError = (message = '') => {
    const m = String(message || '').toLowerCase();
    return (
        m.includes('attachment too large') ||
        m.includes('attachments total size exceeded') ||
        m.includes('unsupported attachment') ||
        m.includes('invalid attachment') ||
        m.includes('malformed attachment')
    );
};

const classifyIntentLocally = (message = '') => {
    const text = String(message || '').trim().toLowerCase();
    if (!text) return 'GENERAL';

    // Explicit execution / project continuation always routes to orchestrator.
    if (isExecutionIntent(text)) return 'PROJECT';

    // Capability/skills introspection should stay in conversational path.
    if (/\b(share|list|show|what are|which are)\b.*\b(skill|skills|capability|capabilities)\b/.test(text)) {
        return 'GENERAL';
    }

    const projectSignals = [
        /\b(build|create|generate|implement|code|publish|deploy|fix|debug|bug|error|stack trace|exception)\b/,
        /\b(app|project|repo|workspace|template|viverse|sdk|playwright|leaderboard|matchmaking|auth)\b/,
        /\b(req_\d{8,})\b/
    ];
    if (projectSignals.some((re) => re.test(text))) return 'PROJECT';

    const generalSignals = [
        /^(hi|hello|hey|thanks|thank you|good morning|good night)\b/,
        /\b(what is|how are you|who are you|tell me about)\b/
    ];
    if (generalSignals.some((re) => re.test(text))) return 'GENERAL';

    // Default to PROJECT to avoid dropping actionable engineering requests.
    return 'PROJECT';
};

export const chat = async (req, res) => {
    let heartbeatTimer = null;
    const stopHeartbeat = () => {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    };

    try {
        const { message, history, stream, credentials, attachments } = req.body;
        const media = normalizeAttachments(attachments || []);

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // If streaming is requested (Dashboard uses streaming)
        const useStream = stream !== false;
        if (useStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let lastActivityAt = Date.now();
            heartbeatTimer = setInterval(() => {
                if (res.writableEnded || res.destroyed) return;
                const idleSec = Math.floor((Date.now() - lastActivityAt) / 1000);
                let content = 'Agent is still working...';
                if (idleSec >= 45) content = `Still working... no new output for ${idleSec}s`;
                if (idleSec >= 180) content = `Long-running task in progress (${idleSec}s). I will continue and report if stalled.`;
                res.write(`data: ${JSON.stringify({ type: 'status', content })}\n\n`);
            }, 8000);

            if (isLatestAppQuery(message)) {
                if (!credentials?.email || !credentials?.password) {
                    res.write(`data: ${JSON.stringify({ type: 'action', action: 'require_credentials' })}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        type: 'text',
                        content: 'I need your VIVERSE account credentials to verify and list only your own app IDs.'
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    stopHeartbeat();
                    return res.end();
                }

                res.write(`data: ${JSON.stringify({ type: 'status', content: 'Verifying account and listing your apps...' })}\n\n`);
                lastActivityAt = Date.now();
                const result = await fileService.listUserApps(credentials, 50);
                await upsertUserAppHistory(credentials.email, result.apps);
                lastActivityAt = Date.now();

                if (!result.latest) {
                    res.write(`data: ${JSON.stringify({
                        type: 'text',
                        content: `No apps found for ${maskEmail(credentials.email)}.`
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    stopHeartbeat();
                    return res.end();
                }

                const lines = [
                    `Latest app for ${maskEmail(credentials.email)}:`,
                    `- App ID: \`${result.latest.appId}\``,
                    `- Title: ${result.latest.title}`,
                    `- State: ${result.latest.state}`,
                    `- URL: ${result.latest.url}`
                ];

                if (result.apps.length > 1) {
                    lines.push('', 'Other recent app IDs:');
                    for (const app of result.apps.slice(1, 6)) {
                        lines.push(`- \`${app.appId}\` (${app.title})`);
                    }
                }

                res.write(`data: ${JSON.stringify({ type: 'text', content: lines.join('\n') })}\n\n`);
                res.write('data: [DONE]\n\n');
                stopHeartbeat();
                return res.end();
            }

            // Intent classification must be deterministic and local:
            // avoid model/tool loops blocking the request pipeline.
            const localIntent = classifyIntentLocally(message);
            const isGeneral = localIntent === 'GENERAL';

            let responseStream;
            if (isGeneral) {
                res.write(`data: ${JSON.stringify({ type: 'status', content: 'Answering general question...' })}\n\n`);
                responseStream = geminiService.generateResponseStream(message, history || [], "GENERAL", null, media);
            } else {
                const enrichedMessage = `${message}${buildAttachmentSummary(media)}`;
                responseStream = orchestratorService.processRequest(enrichedMessage, history || [], credentials, media);
            }

            for await (const chunk of responseStream) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                lastActivityAt = Date.now();
            }

            res.write('data: [DONE]\n\n');
            stopHeartbeat();
            return res.end();
        }

        const localIntent = classifyIntentLocally(message);
        const roleKey = localIntent === 'GENERAL' ? 'GENERAL' : 'ORCHESTRATOR';
        const response = await geminiService.generateResponse(message, history || [], roleKey, null, media);

        res.status(200).json({
            success: true,
            reply: response,
            response: response
        });
    } catch (error) {
        stopHeartbeat();
        logger.error(`AI Controller Error: ${error.message}`);
        const msg = String(error?.message || '');
        const isAttachmentError = isAttachmentValidationError(msg);
        const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota exceeded') || msg.toLowerCase().includes('too many requests');
        const retryHint = msg.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s?/i);
        const waitText = retryHint ? ` Please retry in about ${Math.ceil(Number(retryHint[1]))} seconds.` : '';
        const friendlyAttachmentError = msg || 'Invalid attachments payload.';
        
        if (!res.headersSent) {
            res.status(isAttachmentError ? 400 : 500).json({
                success: false,
                error: isAttachmentError
                    ? friendlyAttachmentError
                    : isRateLimit
                    ? `Gemini API quota/rate limit reached.${waitText}`
                    : 'An error occurred while processing your request'
            });
        } else {
            const content = isAttachmentError
                ? friendlyAttachmentError
                : isRateLimit
                ? `Gemini API quota/rate limit reached.${waitText}`
                : error.message;
            res.write(`data: ${JSON.stringify({ type: 'error', content })}\n\n`);
            res.end();
        }
    } finally {
        stopHeartbeat();
    }
};

export const healthCheck = (req, res) => {
    res.status(200).json({ status: 'AI Service is online' });
};

export const listTemplates = async (req, res) => {
    try {
        let templates = await templateRegistryService.listTemplates();
        if (!templates.length) {
            templates = TEMPLATE_CATALOG_FALLBACK;
        }
        const normalized = templates.map((item) => ({
            id: item.id,
            name: item.name,
            version: item.version,
            genre: item.genre,
            description: item.description,
            tags: item.tags,
            capabilities: item.capabilities,
            status: item.status || 'active'
        }));

        res.status(200).json({
            success: true,
            count: normalized.length,
            templates: normalized,
            source: templates === TEMPLATE_CATALOG_FALLBACK ? 'fallback' : 'registry'
        });
    } catch (error) {
        logger.error(`listTemplates failed: ${error.message}`);
        res.status(500).json({ success: false, error: 'Failed to load templates' });
    }
};

export const getTemplateById = async (req, res) => {
    const templateId = String(req.params?.templateId || '').trim().toLowerCase();
    if (!templateId) {
        return res.status(400).json({ success: false, error: 'templateId is required' });
    }
    let found = await templateRegistryService.getTemplateById(templateId);
    if (!found) {
        found = TEMPLATE_CATALOG_FALLBACK.find((item) => item.id.toLowerCase() === templateId) || null;
    }
    if (!found) {
        return res.status(404).json({ success: false, error: `Template not found: ${templateId}` });
    }

    let contractSummary = null;
    if (found?.templatePath) {
        const absoluteTemplatePath = path.resolve(process.cwd(), found.templatePath);
        const loaded = await templateContractService.loadTemplateContract(absoluteTemplatePath);
        if (loaded?.contract) {
            const c = loaded.contract;
            contractSummary = {
                id: c.id,
                version: c.version,
                immutablePathsCount: c.immutablePaths.length,
                editablePathsCount: c.editablePaths.length,
                requiredGates: c.requiredGates
            };
        }
    }
    return res.status(200).json({ success: true, template: found, contractSummary });
};
