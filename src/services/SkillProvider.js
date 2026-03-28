import fs from 'fs/promises';
import path from 'path';

const DEFAULT_ROUTES = [
    { intent: ['auth', 'login', 'sso', 'checkauth', 'profile', 'identity'], skills: ['viverse-auth'] },
    { intent: ['avatar', 'glb', 'vrm', 'character'], skills: ['viverse-avatar-sdk'] },
    { intent: ['matchmaking', 'room', 'rooms', 'multiplayer', 'session', 'setactor'], skills: ['viverse-multiplayer'] },
    { intent: ['leaderboard', 'score', 'ranking', 'rank'], skills: ['viverse-leaderboard'] },
    { intent: ['publish', 'deployment', 'deploy', 'app id', 'viverse-cli'], skills: ['viverse-world-publishing'] },
    { intent: ['lambda', 'secret', 'apikey', 'proxy', 'backend boundary'], skills: ['viverse-key-protection-lambda'] },
    { intent: ['template', 'contract', 'certification', 'template generation'], skills: ['viverse-template-generation'] },
    { intent: ['r3f', 'react three fiber', 'three fiber', '@react-three/viverse'], skills: ['viverse-r3f-foundation'] },
    { intent: ['profile ui', 'nametag', 'hud', 'profile badge'], skills: ['viverse-r3f-profile-ui'] },
    { intent: ['threejs', 'vanilla three', 'non-react three'], skills: ['viverse-threejs-vanilla-foundation'] },
    { intent: ['playcanvas', 'navigation', 'ammo', 'character controller'], skills: ['playcanvas-avatar-navigation'] },
    { intent: ['googlemaps', '3dtiles', 'map tiles'], skills: ['playcanvas-googlemaps-3dtiles'] },
    { intent: ['vrma', 'animation retargeting', 'retarget'], skills: ['vrma-animation-retargeting'] },
    { intent: ['ui', 'design system', 'visual polish', 'premium dashboard'], skills: ['viverse-design-system'] }
];

class SkillProvider {
    constructor() {
        const cwd = process.cwd();
        const fromSkillsDir = String(process.env.VIVERSE_SKILLS_DIR || '').trim();
        const fromSkillsRepo = String(process.env.VIVERSE_SKILLS_REPO || '').trim();
        const siblingRepo = path.resolve(cwd, '../viverse-sdk-skills');

        if (fromSkillsDir) {
            this.skillsDir = path.isAbsolute(fromSkillsDir)
                ? fromSkillsDir
                : path.resolve(cwd, fromSkillsDir);
            this.repoRoot = path.dirname(this.skillsDir);
        } else if (fromSkillsRepo) {
            this.repoRoot = path.isAbsolute(fromSkillsRepo)
                ? fromSkillsRepo
                : path.resolve(cwd, fromSkillsRepo);
            this.skillsDir = path.join(this.repoRoot, 'skills');
        } else {
            // Default to a side-by-side external skills repository.
            this.repoRoot = siblingRepo;
            this.skillsDir = path.join(this.repoRoot, 'skills');
        }
    }

    getSkillsDir() {
        return this.skillsDir;
    }

    getRepoRoot() {
        return this.repoRoot;
    }

    _resolveUnderSkills(...parts) {
        const abs = path.resolve(this.skillsDir, ...parts);
        if (!abs.startsWith(this.skillsDir)) {
            throw new Error('Invalid skill path: outside skills directory');
        }
        return abs;
    }

    _resolveUnderRepo(...parts) {
        const abs = path.resolve(this.repoRoot, ...parts);
        if (!abs.startsWith(this.repoRoot)) {
            throw new Error('Invalid repo path: outside repo root');
        }
        return abs;
    }

    async listSkillFolders() {
        const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillMd = this._resolveUnderSkills(entry.name, 'SKILL.md');
            try {
                await fs.access(skillMd);
                out.push(entry.name);
            } catch {
                // ignore non-skill folders
            }
        }
        return out.sort((a, b) => a.localeCompare(b));
    }

    async readSkillFile(skillName, fileName) {
        const s = String(skillName || '').trim();
        const f = String(fileName || '').trim();
        if (!f) throw new Error('fileName is required');

        const absPath = s === '.'
            ? this._resolveUnderSkills(f)
            : this._resolveUnderSkills(s, f);
        return fs.readFile(absPath, 'utf8');
    }

    async readRoutes() {
        const p = this._resolveUnderRepo('catalog', 'routes.json');
        try {
            const raw = await fs.readFile(p, 'utf8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed?.routes) ? parsed.routes : [];
        } catch {
            return DEFAULT_ROUTES;
        }
    }

    async readSkillMetadata(skillId) {
        const id = String(skillId || '').trim();
        if (!id) return null;
        try {
            const raw = await this.readSkillFile(id, 'skill.json');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    async resolveSkillReadOrder(skillId) {
        const meta = await this.readSkillMetadata(skillId);
        if (!meta) {
            if (skillId === 'viverse-auth') {
                return ['SKILL.md', 'patterns/robust-profile-fetch.md'];
            }
            if (skillId === 'viverse-multiplayer') {
                return ['SKILL.md', 'patterns/matchmaking-flow.md', 'patterns/move-sync-reliability.md'];
            }
            return ['SKILL.md'];
        }
        const readOrder = Array.isArray(meta?.read_order)
            ? meta.read_order.filter((x) => typeof x === 'string' && x.trim())
            : [];
        const entrypoint = String(meta?.entrypoint || 'SKILL.md').trim();

        const ordered = [];
        if (entrypoint) ordered.push(entrypoint);
        for (const item of readOrder) {
            if (!ordered.includes(item)) ordered.push(item);
        }
        return ordered.length ? ordered : ['SKILL.md'];
    }
}

export default new SkillProvider();
