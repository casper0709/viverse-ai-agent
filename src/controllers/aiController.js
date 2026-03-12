import geminiService from '../services/GeminiService.js';
import orchestratorService from '../services/OrchestratorService.js';
import logger from '../utils/logger.js';

export const chat = async (req, res) => {
    try {
        const { message, history, stream } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // If streaming is requested (Dashboard uses streaming)
        if (stream || true) { // Force streaming for orchestrator
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const responseStream = orchestratorService.processRequest(message, history || []);

            for await (const chunk of responseStream) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            res.write('data: [DONE]\n\n');
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
