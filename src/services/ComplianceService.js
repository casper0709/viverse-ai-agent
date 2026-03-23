import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const TEXT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.css', '.json']);
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  'build',
  'coverage',
  '.viverse_workspaces',
  'artifacts'
]);
const IGNORE_FILES = [
  /^\.agent_state\.json$/i,
  /^\.viverse_lessons\.json$/i,
  /^run_report\.json$/i
];
const DIST_SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css']);

function safeRegex(pattern, flags = 'm') {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function normalizeText(v) {
  return String(v || '').toLowerCase();
}

function isDotEnvFileName(name = '') {
  const base = String(name || '').toLowerCase();
  return base === '.env' || base.startsWith('.env.');
}

class ComplianceService {
  constructor() {
    const serviceDir = path.dirname(fileURLToPath(import.meta.url));
    this.skillsDir = path.resolve(serviceDir, '../../skills');
    this.ruleCache = null;
    this.ruleCacheLoadedAt = 0;
  }

  inferProfiles(text = '') {
    const t = normalizeText(text);
    const profiles = new Set();

    if (/(auth|sso|checkauth|login|logout|profile|avatar|identity)/.test(t)) profiles.add('auth');
    if (/(multiplayer|matchmaking|room|join|create room|start game|session_id|actor)/.test(t)) profiles.add('multiplayer');
    if (/(publish|deploy|app id|viverse-cli)/.test(t)) profiles.add('publishing');

    return [...profiles];
  }

  async _loadRules(force = false) {
    const now = Date.now();
    if (!force && this.ruleCache && now - this.ruleCacheLoadedAt < 30000) {
      return this.ruleCache;
    }

    const candidates = [
      path.join(this.skillsDir, 'viverse-auth', 'rules.json'),
      path.join(this.skillsDir, 'viverse-multiplayer', 'rules.json'),
      path.join(this.skillsDir, 'viverse-world-publishing', 'rules.json')
    ];

    const all = [];
    for (const p of candidates) {
      try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        const rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
        for (const rule of rules) {
          all.push({
            ...rule,
            _source: p
          });
        }
      } catch (err) {
        logger.warn(`ComplianceService: unable to load rules from ${p}: ${err.message}`);
      }
    }

    this.ruleCache = all;
    this.ruleCacheLoadedAt = now;
    return all;
  }

  async _listFilesRecursive(rootDir) {
    const out = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name)) continue;
          await walk(abs);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        const isTextExt = TEXT_EXT.has(ext);
        const isDotEnv = isDotEnvFileName(e.name);
        if (!isTextExt && !isDotEnv) continue;
        if (IGNORE_FILES.some((re) => re.test(e.name))) continue;
        out.push(abs);
      }
    };
    await walk(rootDir);
    return out;
  }

  async _listDistFilesRecursive(rootDir) {
    const out = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!DIST_SCAN_EXT.has(ext)) continue;
        out.push(abs);
      }
    };
    await walk(rootDir);
    return out;
  }

  async _collectFileMetas(workspacePath) {
    const files = await this._listFilesRecursive(workspacePath);
    const metas = [];
    for (const f of files) {
      try {
        const st = await fs.stat(f);
        if (st.size > 512000) continue;
        metas.push({
          absPath: f,
          relPath: path.relative(workspacePath, f),
          size: st.size,
          mtimeMs: Number(st.mtimeMs || 0)
        });
      } catch {
        // skip unreadable file
      }
    }
    return metas;
  }

  async _readTextFilesIncremental(workspacePath, cache = {}) {
    const metas = await this._collectFileMetas(workspacePath);
    const prevIndex = cache?.fileIndex && typeof cache.fileIndex === 'object' ? cache.fileIndex : {};
    const nextIndex = {};
    const payloads = [];

    for (const m of metas) {
      const prev = prevIndex[m.relPath];
      if (prev && prev.size === m.size && prev.mtimeMs === m.mtimeMs && typeof prev.text === 'string') {
        const reused = { ...m, text: prev.text };
        payloads.push(reused);
        nextIndex[m.relPath] = reused;
        continue;
      }

      try {
        const text = await fs.readFile(m.absPath, 'utf8');
        const next = { ...m, text };
        payloads.push(next);
        nextIndex[m.relPath] = next;
      } catch {
        // skip unreadable file
      }
    }

    return { files: payloads, nextIndex };
  }

  _buildSnapshotKey(files = [], profiles = []) {
    const fileSig = files
      .map((f) => `${f.relPath}:${f.size}:${Math.floor(f.mtimeMs)}`)
      .sort()
      .join('|');
    return `${profiles.sort().join(',')}::${fileSig}`;
  }

  _checkRule(rule, files, corpus) {
    const kind = String(rule?.type || '');
    const pattern = String(rule?.pattern || '');
    const patterns = Array.isArray(rule?.patterns) ? rule.patterns.map((p) => String(p)) : [];

    if (kind === 'required_any') {
      const re = safeRegex(pattern, rule?.flags || 'm');
      if (!re) return { pass: false, detail: 'Invalid regex pattern' };
      const hit = files.find((f) => re.test(f.text));
      return hit
        ? { pass: true, detail: `Matched in ${hit.relPath}` }
        : { pass: false, detail: `Missing required pattern: ${pattern}` };
    }

    if (kind === 'forbidden_any') {
      const re = safeRegex(pattern, rule?.flags || 'm');
      if (!re) return { pass: false, detail: 'Invalid regex pattern' };
      const hit = files.find((f) => re.test(f.text));
      return hit
        ? { pass: false, detail: `Forbidden pattern found in ${hit.relPath}` }
        : { pass: true, detail: 'Forbidden pattern not found' };
    }

    if (kind === 'required_sequence_anyfile') {
      const perFile = files.some((f) => {
        let cursor = 0;
        for (const p of patterns) {
          const re = safeRegex(p, 'm');
          if (!re) return false;
          const slice = f.text.slice(cursor);
          const m = slice.match(re);
          if (!m || typeof m.index !== 'number') return false;
          cursor += m.index + m[0].length;
        }
        return true;
      });
      return perFile
        ? { pass: true, detail: 'Sequence matched in a single file' }
        : { pass: false, detail: 'Sequence not found in any single file' };
    }

    return { pass: true, detail: `Unknown rule type: ${kind} (ignored)` };
  }

  async runFastGate({
    workspacePath,
    taskPrompt = '',
    profileHints = [],
    gatePhase = '',
    cache = {}
  }) {
    if (!workspacePath) {
      return { status: 'skip', reason: 'no workspacePath', findings: [], profiles: [] };
    }

    const profiles = profileHints.length ? [...new Set(profileHints)] : this.inferProfiles(taskPrompt);
    if (!profiles.length) {
      return { status: 'skip', reason: 'no matching profile', findings: [], profiles: [] };
    }

    const allRules = await this._loadRules();
    const activeRules = allRules.filter((r) => {
      const tags = Array.isArray(r?.profiles) ? r.profiles : [];
      const profilePass = tags.some((p) => profiles.includes(String(p)));
      if (!profilePass) return false;

      const phases = Array.isArray(r?.phases) ? r.phases.map((p) => String(p)) : [];
      if (!gatePhase || !phases.length) return true;
      return phases.includes(String(gatePhase));
    });

    if (!activeRules.length) {
      return { status: 'skip', reason: 'no active rules', findings: [], profiles };
    }

    const { files, nextIndex } = await this._readTextFilesIncremental(workspacePath, cache);
    const snapshotKey = this._buildSnapshotKey(files, profiles);
    if (cache?.lastSnapshotKey === snapshotKey && cache?.lastResult) {
      return { ...cache.lastResult, cacheHit: true };
    }

    const corpus = files.map((f) => `\n// FILE:${f.relPath}\n${f.text}`).join('\n');
    const findings = [];

    for (const rule of activeRules) {
      const check = this._checkRule(rule, files, corpus);
      if (!check.pass) {
        findings.push({
          ruleId: rule.id || 'unnamed-rule',
          severity: rule.severity || 'high',
          message: rule.message || check.detail,
          detail: check.detail
        });
      }
    }

    const status = findings.length ? 'fail' : 'pass';
    const result = {
      status,
      findings,
      profiles,
      checkedRules: activeRules.length,
      scannedFiles: files.length,
      cacheHit: false
    };

    return {
      ...result,
      _snapshotKey: snapshotKey,
      _nextCache: {
        lastSnapshotKey: snapshotKey,
        lastResult: {
          status: result.status,
          findings: result.findings,
          profiles: result.profiles,
          checkedRules: result.checkedRules,
          scannedFiles: result.scannedFiles
        },
        fileIndex: nextIndex
      }
    };
  }

  async verifyAppIdPropagation({
    workspacePath,
    expectedAppId = '',
    sourceFiles = []
  }) {
    const result = {
      status: 'fail',
      expected_app_id: String(expectedAppId || '').trim().toLowerCase(),
      env_app_id: '',
      source_mentions_expected: false,
      dist_mentions_expected: false,
      source_match_files: [],
      dist_match_files: [],
      reasons: []
    };

    if (!workspacePath) {
      result.reasons.push('workspace path missing');
      return result;
    }

    const expected = result.expected_app_id;
    if (!/^[a-z0-9]{10}$/i.test(expected)) {
      result.reasons.push('expected app id is missing or invalid (must be 10 lowercase alnum chars)');
      return result;
    }

    const envPath = path.join(workspacePath, '.env');
    let envText = '';
    try {
      envText = await fs.readFile(envPath, 'utf8');
    } catch {
      result.reasons.push('.env missing');
    }

    if (envText) {
      const match = envText.match(/(^|\n)\s*VITE_VIVERSE_CLIENT_ID\s*=\s*([a-z0-9]{10})\s*($|\n)/i);
      if (match && match[2]) {
        result.env_app_id = String(match[2]).toLowerCase();
      } else {
        result.reasons.push('.env missing valid VITE_VIVERSE_CLIENT_ID');
      }
    }

    if (result.env_app_id && result.env_app_id !== expected) {
      result.reasons.push(`.env app id mismatch (expected ${expected}, got ${result.env_app_id})`);
    }

    const allSourceFiles = sourceFiles.length
      ? sourceFiles
      : await this._listFilesRecursive(workspacePath);

    for (const file of allSourceFiles) {
      const rel = path.relative(workspacePath, file).replace(/\\/g, '/');
      if (rel.startsWith('node_modules/') || rel.startsWith('dist/') || rel.startsWith('.git/')) continue;
      try {
        const txt = await fs.readFile(file, 'utf8');
        if (txt.includes(expected)) {
          result.source_match_files.push(rel);
        }
      } catch {
        // ignore unreadable source files
      }
    }

    result.source_mentions_expected = result.source_match_files.length > 0;
    if (!result.source_mentions_expected) {
      result.reasons.push('expected app id not found in source/config fallback path');
    }

    const distPath = path.join(workspacePath, 'dist');
    let distFiles = [];
    try {
      const distStat = await fs.stat(distPath);
      if (!distStat.isDirectory()) {
        result.reasons.push('dist missing');
      } else {
        distFiles = await this._listDistFilesRecursive(distPath);
      }
    } catch {
      result.reasons.push('dist missing');
    }

    for (const file of distFiles) {
      try {
        const txt = await fs.readFile(file, 'utf8');
        if (txt.includes(expected)) {
          result.dist_match_files.push(path.relative(workspacePath, file).replace(/\\/g, '/'));
        }
      } catch {
        // ignore unreadable dist files
      }
    }

    result.dist_mentions_expected = result.dist_match_files.length > 0;
    if (!result.dist_mentions_expected) {
      result.reasons.push('expected app id not found in dist artifacts');
    }

    if (result.reasons.length === 0) {
      result.status = 'pass';
    }

    return result;
  }
}

export default new ComplianceService();
