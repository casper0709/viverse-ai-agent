import geminiService from '../services/GeminiService.js';
import orchestratorService from '../services/OrchestratorService.js';
import fileService from '../services/FileService.js';
import logger from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const APP_HISTORY_FILE = path.resolve(process.cwd(), '.viverse_app_history.json');

const isLatestAppQuery = (message = '') => {
    const text = String(message).toLowerCase();
    return (
        (text.includes('latest') && text.includes('app') && text.includes('id')) ||
        (text.includes('show') && text.includes('app id')) ||
        (text.includes('list') && text.includes('app id')) ||
        (text.includes('latest apps app id'))
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

export const chat = async (req, res) => {
    try {
        const { message, history, stream, credentials } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // If streaming is requested (Dashboard uses streaming)
        if (stream || true) { // Force streaming for orchestrator
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let lastActivityAt = Date.now();
            const heartbeatTimer = setInterval(() => {
                if (res.writableEnded || res.destroyed) return;
                const idleSec = Math.floor((Date.now() - lastActivityAt) / 1000);
                let content = 'Agent is still working...';
                if (idleSec >= 45) content = `Still working... no new output for ${idleSec}s`;
                if (idleSec >= 180) content = `Long-running task in progress (${idleSec}s). I will continue and report if stalled.`;
                res.write(`data: ${JSON.stringify({ type: 'status', content })}\n\n`);
            }, 8000);

            const streamDone = () => {
                clearInterval(heartbeatTimer);
            };

            if (isLatestAppQuery(message)) {
                if (!credentials?.email || !credentials?.password) {
                    res.write(`data: ${JSON.stringify({ type: 'action', action: 'require_credentials' })}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        type: 'text',
                        content: 'I need your VIVERSE account credentials to verify and list only your own app IDs.'
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    streamDone();
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
                    streamDone();
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
                streamDone();
                return res.end();
            }

            // Intent Classification
            const intentPrompt = `Classify the user intent AS EXACTLY ONE WORD, either 'PROJECT' or 'GENERAL':
            'PROJECT': requesting to build, code, create, publish, modify, FIX BUGS, DEBUG, or ANALYZE ERROR LOGS. Also includes CONTINUATION commands like 'proceed', 'continue', 'ok', or 'next' if they relate to an ongoing project.
            'GENERAL': asking general questions, greeting, or chatting naturally.
            User Message: "${message}"
            Reply strictly with 'PROJECT' or 'GENERAL'.`;
            const intentText = await geminiService.generateResponse(intentPrompt, history || []);
            const isGeneral = intentText.includes('GENERAL');

            let responseStream;
            if (isGeneral) {
                res.write(`data: ${JSON.stringify({ type: 'status', content: 'Answering general question...' })}\n\n`);
                responseStream = geminiService.generateResponseStream(message, history || [], "ORCHESTRATOR");
            } else {
                responseStream = orchestratorService.processRequest(message, history || [], credentials);
            }

            for await (const chunk of responseStream) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                lastActivityAt = Date.now();
            }

            res.write('data: [DONE]\n\n');
            streamDone();
            return res.end();
        }

        const response = await geminiService.generateResponse(message, history || []);

        res.status(200).json({
            success: true,
            reply: response,
            response: response
        });
    } catch (error) {

        logger.error(`AI Controller Error: ${error.message}`);
        
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: 'An error occurred while processing your request'
            });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', content: error.message })}\n\n`);
            res.end();
        }
    }
};

export const healthCheck = (req, res) => {
    res.status(200).json({ status: 'AI Service is online' });
};
