import express from 'express';
import * as aiController from '../controllers/aiController.js';

const router = express.Router();

router.post('/chat', aiController.chat);
router.get('/health', aiController.healthCheck);
router.get('/templates', aiController.listTemplates);
router.get('/templates/:templateId', aiController.getTemplateById);

export default router;
