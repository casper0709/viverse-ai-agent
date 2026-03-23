import express from 'express';
import path from 'path';
import cors from 'cors';
import logger from './utils/logger.js';
import aiRoutes from './routes/aiRoutes.js';



const app = express();

app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ extended: true, limit: '80mb' }));
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`);
    next();
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'viverse-ai-agent-server'
    });
});

// AI Routes
app.use('/api/ai', aiRoutes);

export default app;
