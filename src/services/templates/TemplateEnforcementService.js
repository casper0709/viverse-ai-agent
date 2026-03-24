import path from 'path';

class TemplateEnforcementService {
  _normalizeRelPath(relPath = '') {
    return String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  }

  _matchesRule(relPath, rule) {
    const p = this._normalizeRelPath(relPath);
    const r = this._normalizeRelPath(rule);
    if (!r) return false;

    if (r.endsWith('/**')) {
      const prefix = r.slice(0, -3);
      return p === prefix || p.startsWith(`${prefix}/`);
    }
    return p === r || p.startsWith(`${r}/`);
  }

  evaluateWrite({ contract, absolutePath, workspacePath }) {
    if (!contract || !absolutePath || !workspacePath) {
      return { allowed: true, reason: 'template_contract_not_bound' };
    }

    const rel = this._normalizeRelPath(path.relative(workspacePath, absolutePath));
    if (!rel || rel.startsWith('..')) {
      return { allowed: false, reason: 'path_outside_workspace', relPath: rel };
    }

    const immutableHit = (contract.immutablePaths || []).some((rule) => this._matchesRule(rel, rule));
    if (immutableHit) {
      return { allowed: false, reason: 'immutable_path_violation', relPath: rel };
    }

    const editablePaths = contract.editablePaths || [];
    if (editablePaths.length === 0) {
      return { allowed: true, reason: 'no_editable_constraints', relPath: rel };
    }

    const allowed = editablePaths.some((rule) => this._matchesRule(rel, rule));
    return {
      allowed,
      reason: allowed ? 'editable_path_allowed' : 'editable_path_violation',
      relPath: rel
    };
  }
}

export default new TemplateEnforcementService();
