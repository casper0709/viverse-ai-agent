import fs from 'fs/promises';
import path from 'path';
import logger from '../../utils/logger.js';

const DEFAULT_REGISTRY_PATH = path.resolve(process.cwd(), 'templates', 'registry.json');

class TemplateRegistryService {
  constructor() {
    this.registryPath = process.env.TEMPLATE_REGISTRY_PATH
      ? path.resolve(process.env.TEMPLATE_REGISTRY_PATH)
      : DEFAULT_REGISTRY_PATH;
    this.cache = null;
    this.cacheLoadedAt = 0;
  }

  _normalizeTemplateRecord(raw = {}) {
    const id = String(raw.id || '').trim();
    if (!id) return null;

    return {
      id,
      name: String(raw.name || id),
      version: String(raw.version || '0.0.0'),
      genre: String(raw.genre || ''),
      description: String(raw.description || ''),
      tags: Array.isArray(raw.tags) ? raw.tags.map((v) => String(v)) : [],
      capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map((v) => String(v)) : [],
      upstream: String(raw.upstream || ''),
      status: String(raw.status || 'active').toLowerCase(),
      recommendedPrompt: String(raw.recommendedPrompt || ''),
      templatePath: String(raw.templatePath || `templates/${id}`)
    };
  }

  async _loadRegistryFile() {
    const text = await fs.readFile(this.registryPath, 'utf8');
    const parsed = JSON.parse(text);
    const rawTemplates = Array.isArray(parsed?.templates) ? parsed.templates : [];
    const templates = rawTemplates
      .map((item) => this._normalizeTemplateRecord(item))
      .filter(Boolean);

    return {
      version: String(parsed?.version || '1.0.0'),
      updatedAt: String(parsed?.updatedAt || ''),
      templates
    };
  }

  async getRegistry({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.cache) return this.cache;

    try {
      const reg = await this._loadRegistryFile();
      this.cache = reg;
      this.cacheLoadedAt = Date.now();
      return reg;
    } catch (error) {
      logger.warn(`TemplateRegistryService: failed to load registry from ${this.registryPath}: ${error.message}`);
      this.cache = { version: '1.0.0', updatedAt: '', templates: [] };
      return this.cache;
    }
  }

  async listTemplates({ includeInactive = false } = {}) {
    const reg = await this.getRegistry();
    return reg.templates.filter((t) => includeInactive || t.status !== 'inactive');
  }

  async getTemplateById(templateId = '') {
    const id = String(templateId || '').trim().toLowerCase();
    if (!id) return null;
    const templates = await this.listTemplates({ includeInactive: true });
    return templates.find((t) => t.id.toLowerCase() === id) || null;
  }

  getRegistryPath() {
    return this.registryPath;
  }
}

export default new TemplateRegistryService();
