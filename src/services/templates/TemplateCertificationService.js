import fs from 'fs/promises';
import path from 'path';

class TemplateCertificationService {
  async runStaticGates({ templateRoot, contract }) {
    const results = [];

    results.push({
      gate: 'contract.id',
      status: contract?.id ? 'pass' : 'fail',
      reason: contract?.id ? '' : 'template.json missing id'
    });
    results.push({
      gate: 'contract.immutablePaths',
      status: Array.isArray(contract?.immutablePaths) && contract.immutablePaths.length > 0 ? 'pass' : 'fail',
      reason: Array.isArray(contract?.immutablePaths) && contract.immutablePaths.length > 0 ? '' : 'immutablePaths missing'
    });
    results.push({
      gate: 'contract.editablePaths',
      status: Array.isArray(contract?.editablePaths) && contract.editablePaths.length > 0 ? 'pass' : 'fail',
      reason: Array.isArray(contract?.editablePaths) && contract.editablePaths.length > 0 ? '' : 'editablePaths missing'
    });

    const rulesetsDir = path.join(templateRoot, 'rulesets');
    const rulesetFiles = await fs.readdir(rulesetsDir).catch(() => []);
    results.push({
      gate: 'rulesets.exists',
      status: rulesetFiles.length > 0 ? 'pass' : 'fail',
      reason: rulesetFiles.length > 0 ? '' : 'no ruleset files found'
    });

    return results;
  }

  summarize(gates = []) {
    const failed = gates.filter((g) => g.status !== 'pass');
    return {
      pass: failed.length === 0,
      failed,
      gates
    };
  }
}

export default new TemplateCertificationService();
