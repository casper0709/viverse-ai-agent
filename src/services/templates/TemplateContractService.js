import fs from 'fs/promises';
import path from 'path';
import logger from '../../utils/logger.js';

class TemplateContractService {
  _normalizeContract(raw = {}, templateRoot = '') {
    return {
      id: String(raw.id || ''),
      version: String(raw.version || '0.0.0'),
      upstream: String(raw.upstream || ''),
      capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map((v) => String(v)) : [],
      immutablePaths: Array.isArray(raw.immutablePaths) ? raw.immutablePaths.map((v) => String(v)) : [],
      editablePaths: Array.isArray(raw.editablePaths) ? raw.editablePaths.map((v) => String(v)) : [],
      injectionHooks: Array.isArray(raw.injectionHooks) ? raw.injectionHooks : [],
      requiredGates: Array.isArray(raw.requiredGates) ? raw.requiredGates.map((v) => String(v)) : [],
      rulesetSchemaRef: String(raw.rulesetSchemaRef || ''),
      scenarioSchemaRef: String(raw.scenarioSchemaRef || ''),
      templateRoot,
      raw
    };
  }

  async loadTemplateContract(templatePath) {
    const root = path.resolve(String(templatePath || '').trim());
    const jsonPath = path.join(root, 'template.json');
    const mdPath = path.join(root, 'TEMPLATE.md');

    try {
      const [jsonText, mdText] = await Promise.all([
        fs.readFile(jsonPath, 'utf8'),
        fs.readFile(mdPath, 'utf8').catch(() => '')
      ]);
      const parsed = JSON.parse(jsonText);
      return {
        contract: this._normalizeContract(parsed, root),
        templateMarkdown: mdText,
        files: { jsonPath, mdPath }
      };
    } catch (error) {
      logger.warn(`TemplateContractService: failed to load contract from ${root}: ${error.message}`);
      return null;
    }
  }
}

export default new TemplateContractService();
