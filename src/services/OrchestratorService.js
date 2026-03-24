import geminiService from './GeminiService.js';
import fileService from './FileService.js';
import complianceService from './ComplianceService.js';
import previewAutoTestService from './PreviewAutoTestService.js';
import logger from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import sanitizer from '../utils/sanitizer.js';

class OrchestratorService {
    constructor() {
        this.activeProjects = new Map();
        this.complianceRuntimeCache = new Map();
        const serviceDir = path.dirname(fileURLToPath(import.meta.url));
        this.skillsDir = path.resolve(serviceDir, '../../skills');
        this.maxComplianceFixAttemptsPerSignature = 2;
        this.maxAutoTestFixAttemptsPerSignature = 2;
        this.maxAuthPreflightFixAttemptsPerSignature = 2;
    }

    _hasComplianceSuccessClaim(text = "") {
        const t = String(text || '');
        return /(fully compliant|compliance gate passed|ready for deployment|all compliance checks passed|all checks passed)/i.test(t);
    }

    _maskComplianceSuccessClaims(text = "") {
        return String(text || '').replace(
            /(fully compliant|compliance gate passed|ready for deployment|all compliance checks passed|all checks passed)/ig,
            '[pending gate verification]'
        );
    }

    async _finalizeWorkflowState(state, outcome = 'paused_or_failed') {
        if (!state || typeof state !== 'object') return;
        const normalized = outcome === 'completed' ? 'completed' : 'paused_or_failed';
        state.status = normalized;
        if (!state.runReport || typeof state.runReport !== 'object') {
            state.runReport = { startedAt: new Date().toISOString(), events: [] };
        }
        state.runReport.endedAt = new Date().toISOString();
        state.runReport.outcome = normalized;
        await this._saveState(state);
    }

    _beginRunReport(state) {
        if (!state || typeof state !== 'object') return;
        state.runHistory = Array.isArray(state.runHistory) ? state.runHistory : [];
        const prev = state.runReport && typeof state.runReport === 'object' ? state.runReport : null;
        if (prev && (prev.endedAt || prev.outcome || (Array.isArray(prev.events) && prev.events.length))) {
            state.runHistory.push({
                startedAt: prev.startedAt || null,
                endedAt: prev.endedAt || null,
                outcome: prev.outcome || null,
                eventCount: Array.isArray(prev.events) ? prev.events.length : 0
            });
            if (state.runHistory.length > 30) {
                state.runHistory = state.runHistory.slice(-30);
            }
        }
        state.runReport = {
            startedAt: new Date().toISOString(),
            endedAt: null,
            outcome: null,
            events: []
        };
    }

    _hasBlockingPreviewProbeFailure(state) {
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        return events.some((e) => {
            const type = String(e?.type || '').toLowerCase();
            if (type === 'preview_probe') {
                return String(e?.status || '').toLowerCase() === 'fail';
            }
            return type === 'preview_probe_error';
        });
    }

    _hasAnyPreviewProbeEvent(state) {
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        return events.some((e) => {
            const type = String(e?.type || '').toLowerCase();
            return type === 'preview_probe' || type === 'preview_probe_error';
        });
    }

    _requiresPreviewProbeEvidence(state) {
        const request = String(state?.request || '').toLowerCase();
        const tasksText = Array.isArray(state?.tasks)
            ? state.tasks.map((t) => String(t?.prompt || '').toLowerCase()).join('\n')
            : '';
        const haystack = `${request}\n${tasksText}`;
        return /(preview auto-test|preview probe|playwright|runtime preview probe|browser test|auth_profile|matchmaking statuses are healthy)/.test(haystack);
    }

    _scheduleAutoTestFixTask({ state, task, probe = null, projectContextSummary = '' }) {
        const checks = Array.isArray(probe?.runtime_checks) ? probe.runtime_checks : [];
        const failedChecks = checks.filter((c) => String(c?.status || '').toLowerCase() === 'fail');
        if (!failedChecks.length) return { scheduled: false, reason: 'no_failed_runtime_checks' };

        const signature = failedChecks
            .map((c) => String(c?.name || 'unknown'))
            .sort()
            .join('||');
        if (!signature) return { scheduled: false, reason: 'empty_signature' };

        state.runtimeFlags = state.runtimeFlags || {};
        state.runtimeFlags.autoTestFixTracker = state.runtimeFlags.autoTestFixTracker || {};
        const attempts = Number(state.runtimeFlags.autoTestFixTracker[signature] || 0);
        if (attempts >= this.maxAutoTestFixAttemptsPerSignature) {
            return {
                scheduled: false,
                reason: `retry_cap_reached:${signature}`,
                signature,
                attempts
            };
        }

        const existingPending = state.tasks.find((t) =>
            t.status === 'pending' &&
            t.role === 'Coder' &&
            String(t.prompt || '').includes('AUTO_TEST_RUNTIME_FIX REQUIRED') &&
            String(t.prompt || '').includes(signature)
        );
        if (existingPending) {
            return { scheduled: false, reason: 'existing_fix_task', signature, attempts };
        }

        const fixTaskId = `autotest_fix_${Date.now()}`;
        const artifacts = Array.isArray(probe?.artifact_paths) ? probe.artifact_paths : [];
        const previewUrl = String(probe?.preview_url_tested || '');
        const lines = failedChecks.map((c) => `- ${c.name}: ${c.proof || 'failed'}`).join('\n');
        state.tasks.push({
            id: fixTaskId,
            role: 'Coder',
            prompt: `AUTO_TEST_RUNTIME_FIX REQUIRED. Signature: ${signature}
Playwright/runtime auto-test reported blocking failures:
${lines}

Preview URL: ${previewUrl || 'unknown'}
Artifacts:
${artifacts.length ? artifacts.map((p) => `- ${p}`).join('\n') : '- (none)'}

Task context: ${String(task?.prompt || '').slice(0, 600)}
Requirements:
1) Fix runtime causes for failed checks (auth_profile and/or matchmaking).
2) Keep App ID/SDK wiring deterministic and compliant.
3) Rebuild if source/env changed.
4) If publish flow is part of this task, ensure next pass can regenerate preview evidence.`,
            dependsOn: [],
            status: 'pending'
        });

        for (let i = 0; i < state.tasks.length; i++) {
            const t = state.tasks[i];
            if (t.status === 'pending' && Array.isArray(t.dependsOn) && t.dependsOn.includes(task.id)) {
                t.dependsOn = t.dependsOn.filter((depId) => depId !== task.id);
                if (!t.dependsOn.includes(fixTaskId)) t.dependsOn.push(fixTaskId);
            }
        }

        state.runtimeFlags.autoTestFixTracker[signature] = attempts + 1;
        return { scheduled: true, fixTaskId, signature, attempts: attempts + 1 };
    }

    _inferRequiredSkills(text = "", role = "") {
        const t = String(text).toLowerCase();
        const picked = new Set();
        const add = (skillName, fileName = "SKILL.md") => picked.add(`${skillName}/${fileName}`);

        // Strict scope override for auth preflight and its deterministic fix loops.
        // Prevent unrelated publish/multiplayer gates from polluting preflight tasks.
        const authPreflightScope = /auth preflight only/.test(t);

        // Always enforce resilience baseline for technical agents.
        if (["CODER", "ARCHITECT", "VERIFIER", "REVIEWER"].includes(String(role).toUpperCase())) {
            add(".", "viverse-resilience-guide.md");
        }

        if (/(auth|sso|checkauth|profile|avatar|login|logout|identity)/.test(t)) {
            add("viverse-auth", "SKILL.md");
            add("viverse-auth", "patterns/robust-profile-fetch.md");
        }

        if (!authPreflightScope && /(multiplayer|matchmaking|room|join|create room|start game|session_id|actor)/.test(t)) {
            add("viverse-multiplayer", "SKILL.md");
            add("viverse-multiplayer", "patterns/matchmaking-flow.md");
            add("viverse-multiplayer", "patterns/move-sync-reliability.md");
        }

        if (!authPreflightScope && /(leaderboard|score|ranking)/.test(t)) {
            add("viverse-leaderboard", "SKILL.md");
        }

        if (!authPreflightScope && /(publish|deploy|app id|world id|viverse-cli)/.test(t)) {
            add("viverse-world-publishing", "SKILL.md");
        }

        return [...picked].map((entry) => {
            const idx = entry.indexOf('/');
            return { skillName: entry.slice(0, idx), fileName: entry.slice(idx + 1) };
        });
    }

    _extractMustLines(content = "", max = 18) {
        const lines = String(content)
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.includes('**MUST**') || l.includes('MUST NOT') || l.includes('MANDATORY'));
        return lines.slice(0, max);
    }

    async _buildSkillEnforcementBlock(taskPrompt = "", projectContextSummary = "", role = "") {
        const query = `${taskPrompt}\n${projectContextSummary}`;
        const required = this._inferRequiredSkills(query, role);
        if (!required.length) return "";

        const snippets = [];
        for (const req of required) {
            const absPath = req.skillName === "."
                ? path.resolve(this.skillsDir, req.fileName)
                : path.resolve(this.skillsDir, req.skillName, req.fileName);
            try {
                const raw = await fs.readFile(absPath, 'utf8');
                const mustLines = this._extractMustLines(raw, 12);
                snippets.push({
                    ref: req.skillName === "." ? req.fileName : `${req.skillName}/${req.fileName}`,
                    mustLines
                });
            } catch (_) {
                snippets.push({
                    ref: req.skillName === "." ? req.fileName : `${req.skillName}/${req.fileName}`,
                    mustLines: ["[MISSING SKILL FILE - treat as blocker and report]"]
                });
            }
        }

        const bulletLines = snippets
            .map(s => {
                const lines = s.mustLines.length ? s.mustLines.map(x => `  - ${x}`).join('\n') : '  - [No MUST lines extracted]';
                return `- ${s.ref}\n${lines}`;
            })
            .join('\n');

        return `\n\n[STRICT_SKILL_ENFORCEMENT]\nYou MUST implement according to these skill gates. If code conflicts with these gates, update code to match gates.\nRequired skill sources:\n${snippets.map(s => `- ${s.ref}`).join('\n')}\n\nExtracted mandatory gates:\n${bulletLines}\n\nBefore finishing, self-check your output against EVERY required gate above and explicitly mention any gate you could not satisfy.\n`;
    }

    _extractAppIdCandidates(text = "") {
        const matches = String(text).match(/\b[a-z0-9]{10}\b/gi) || [];
        return [...new Set(matches.map(m => m.toLowerCase()))];
    }

    _extractCanonicalAppId(text = "") {
        const raw = String(text || "");
        const contextualPatterns = [
            /(?:^|\b)(?:app[\s_-]?id|app_id|VITE_VIVERSE_CLIENT_ID)\s*[:=]\s*["']?([a-z0-9]{10})\b/i,
            /\bviverse-cli\s+app\s+publish\b[\s\S]{0,200}--app-id\s+([a-z0-9]{10})\b/i,
            /"app_id"\s*:\s*"([a-z0-9]{10})"/i
        ];
        for (const re of contextualPatterns) {
            const match = raw.match(re);
            const candidate = String(match?.[1] || "").toLowerCase();
            if (candidate && /\d/.test(candidate)) return candidate;
        }

        // Conservative fallback: require at least one digit to avoid false positives like plain words.
        const appIds = this._extractAppIdCandidates(raw).filter((id) => /\d/.test(id));
        return appIds.length ? appIds[0] : "";
    }

    _isValidAppId(appId = "") {
        const v = String(appId || "").trim().toLowerCase();
        return /^[a-z0-9]{10}$/.test(v) && /\d/.test(v);
    }

    _setAppIdAuthority(state, appId = "", source = "") {
        const normalized = String(appId || "").trim().toLowerCase();
        if (!this._isValidAppId(normalized)) return false;
        state.runtimeFlags = state.runtimeFlags || {};
        state.runtimeFlags.appIdAuthority = {
            value: normalized,
            source: String(source || "unknown"),
            updatedAt: new Date().toISOString()
        };
        return true;
    }

    async _resolveAppIdAuthority(state, workspacePath, contextText = "") {
        const fromState = String(state?.runtimeFlags?.appIdAuthority?.value || "").toLowerCase();
        if (this._isValidAppId(fromState)) return fromState;

        const fromContext = this._extractCanonicalAppId(contextText);
        if (this._setAppIdAuthority(state, fromContext, "context")) return fromContext;

        try {
            const envText = await fs.readFile(path.join(workspacePath, '.env'), 'utf8');
            const envMatch = envText.match(/(^|\n)\s*VITE_VIVERSE_CLIENT_ID\s*=\s*([a-z0-9]{10})\s*($|\n)/i);
            const envId = String(envMatch?.[2] || "").toLowerCase();
            if (this._setAppIdAuthority(state, envId, "env")) return envId;
        } catch {
            // ignore
        }

        return "";
    }

    _extractPreviewUrl(text = "") {
        return previewAutoTestService.extractPreviewUrl(text);
    }

    _resolveLatestPreviewUrl(state = {}) {
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            const candidate = this._extractPreviewUrl(String(ev?.previewUrl || ""));
            if (candidate) return candidate;
        }
        const fromSummary = this._extractPreviewUrl(String(state?.projectContextSummary || ""));
        if (fromSummary) return fromSummary;
        return "";
    }

    _buildOutcomeNotice(state = {}, { completed = false, reason = "" } = {}) {
        const previewUrl = this._resolveLatestPreviewUrl(state);
        const appId = String(state?.runtimeFlags?.appIdAuthority?.value || "");
        const headline = completed
            ? "✅ App Generation/Fix Flow Completed"
            : "⚠️ App Generation/Fix Flow Paused";
        const lines = [headline];
        if (reason) lines.push(`Reason: ${reason}`);
        if (appId) lines.push(`App ID: ${appId}`);
        lines.push(`Preview URL: ${previewUrl || "not available yet"}`);
        lines.push(completed ? "Next: open the preview URL to test." : "Next: open the preview URL (if available) and continue fix/retest.");
        return lines.join('\n');
    }

    async _pickWorkspace(workSpaceDir, { appIds = [], preferredWorkspace = null } = {}) {
        const files = await fs.readdir(workSpaceDir, { withFileTypes: true });
        const dirs = files
            .filter(f => f.isDirectory() && f.name.startsWith('req_'))
            .map(f => f.name)
            .sort((a, b) => b.localeCompare(a));

        let best = null;
        for (const name of dirs) {
            const candidate = path.join(workSpaceDir, name);
            const statePath = path.join(candidate, '.agent_state.json');
            try {
                const content = await fs.readFile(statePath, 'utf8');
                const parsed = JSON.parse(content);
                const summary = String(parsed?.projectContextSummary || "");
                let score = 0;

                if (preferredWorkspace && preferredWorkspace === candidate) score += 1000;
                for (const id of appIds) {
                    if (summary.includes(id)) score += 200;
                }
                if (Array.isArray(parsed?.tasks) && parsed.tasks.some(t => t.status === 'pending')) score += 20;
                if ((await fs.stat(candidate).catch(() => null))?.isDirectory()) score += 1;

                if (!best || score > best.score) {
                    best = { path: candidate, state: parsed, score };
                }
            } catch (_) {
                // ignore invalid workspace
            }
        }

        return best;
    }

    _inferIsNewProjectFallback(message = "", isResumeCommand = false) {
        if (isResumeCommand) return false;
        const t = String(message).toLowerCase();
        if (/(continue|proceed|follow-up|follow up|fix|bug|regression|update|improve|enhance)/.test(t)) return false;
        return true;
    }

    _normalizeTasks(tasks = []) {
        if (!Array.isArray(tasks) || tasks.length === 0) return [];
        return tasks
            .filter((t) => t && typeof t === 'object')
            .map((t, idx) => {
                const id = String(t.id || `task_${idx + 1}`);
                const role = String(t.role || '').trim();
                const prompt = String(t.prompt || '').trim();
                const dependsOnRaw = Array.isArray(t.dependsOn) ? t.dependsOn : [];
                const dependsOn = dependsOnRaw.map((x) => String(x)).filter(Boolean);
                return {
                    id,
                    role,
                    prompt,
                    dependsOn,
                    status: 'pending'
                };
            })
            .filter((t) => t.role && t.prompt);
    }

    _isAuthRelevant(message = "") {
        return /(auth|sso|login|checkauth|profile|avatar|identity)/i.test(String(message));
    }

    _firstTaskByRole(tasks = [], role = "") {
        const want = String(role).toLowerCase();
        return tasks.find((t) => String(t.role || "").toLowerCase() === want) || null;
    }

    _lastTaskByRole(tasks = [], role = "") {
        const want = String(role).toLowerCase();
        for (let i = tasks.length - 1; i >= 0; i--) {
            if (String(tasks[i].role || "").toLowerCase() === want) return tasks[i];
        }
        return null;
    }

    _enforceWorkflowTasks(tasks = [], { message = "" } = {}) {
        let out = [...tasks];
        const ids = new Set(out.map((t) => t.id));

        // Phase 1.6: Inject auth preflight before full coder flow when auth is relevant.
        if (this._isAuthRelevant(message)) {
            const hasPreflight = out.some((t) => t.id === "auth_preflight" || /\bauth preflight\b/i.test(String(t.prompt || "")));
            if (!hasPreflight) {
                const architect = this._firstTaskByRole(out, "Architect");
                const preflightTask = {
                    id: "auth_preflight",
                    role: "Coder",
                    prompt: "AUTH PREFLIGHT ONLY: Implement and verify minimal VIVERSE auth bootstrap before any gameplay/publish work. Mandatory checks: SDK global resolution path, handshake delay, checkAuth call, getUserInfo fallback, and forbidden 'accesstoken' header absence. Stop after preflight evidence is added.",
                    dependsOn: architect ? [architect.id] : [],
                    status: "pending"
                };
                out.push(preflightTask);
                ids.add(preflightTask.id);
            }

            // All non-preflight coder tasks must depend on auth_preflight.
            out = out.map((t) => {
                if (String(t.role || "").toLowerCase() !== "coder") return t;
                if (t.id === "auth_preflight") return t;
                const deps = Array.isArray(t.dependsOn) ? [...t.dependsOn] : [];
                if (!deps.includes("auth_preflight")) deps.push("auth_preflight");
                return { ...t, dependsOn: deps };
            });
        }

        // Phase 1.5: Ensure reviewer exists before verifier.
        let reviewer = this._firstTaskByRole(out, "Reviewer");
        const verifier = this._firstTaskByRole(out, "Verifier");
        const lastCoder = this._lastTaskByRole(out, "Coder");
        if (!reviewer) {
            const reviewerId = "task_reviewer";
            let n = 1;
            let rid = reviewerId;
            while (ids.has(rid)) {
                n += 1;
                rid = `${reviewerId}_${n}`;
            }
            reviewer = {
                id: rid,
                role: "Reviewer",
                prompt: "Review the latest coder changes for runtime correctness, SDK compliance, and missing logic. Output STRICT JSON with status, feedback, severity, blocking_items, evidence, runtime_checks, artifact_paths, and preview_url_tested. runtime_checks MUST include both auth_profile and matchmaking.",
                dependsOn: lastCoder ? [lastCoder.id] : [],
                status: "pending"
            };
            out.push(reviewer);
            ids.add(rid);
        } else if (lastCoder) {
            const deps = Array.isArray(reviewer.dependsOn) ? [...reviewer.dependsOn] : [];
            if (!deps.includes(lastCoder.id)) reviewer.dependsOn = deps.concat(lastCoder.id);
        }

        // Ensure verifier depends on reviewer. If no verifier, inject one.
        if (!verifier) {
            let vid = "task_verifier";
            let n = 1;
            while (ids.has(vid)) {
                n += 1;
                vid = `task_verifier_${n}`;
            }
            out.push({
                id: vid,
                role: "Verifier",
                prompt: "Run deterministic release verification: App ID bundling gate, SDK URL checks, auth gate compliance, and publish-readiness checks.",
                dependsOn: reviewer ? [reviewer.id] : [],
                status: "pending"
            });
            ids.add(vid);
        } else if (reviewer) {
            out = out.map((t) => {
                if (t.id !== verifier.id) return t;
                const deps = Array.isArray(t.dependsOn) ? [...t.dependsOn] : [];
                if (!deps.includes(reviewer.id)) deps.push(reviewer.id);
                return { ...t, dependsOn: deps };
            });
        }

        // Guardrail: break accidental dependency cycles from planner output.
        const taskById = new Map(out.map((t) => [t.id, t]));
        const dependsOnTransitively = (fromId, targetId, seen = new Set()) => {
            if (!fromId || !targetId || seen.has(fromId)) return false;
            if (fromId === targetId) return true;
            seen.add(fromId);
            const node = taskById.get(fromId);
            const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
            for (const depId of deps) {
                if (dependsOnTransitively(depId, targetId, seen)) return true;
            }
            return false;
        };

        out = out.map((t) => {
            const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
            const pruned = deps.filter((depId) => !dependsOnTransitively(depId, t.id));
            return pruned.length === deps.length ? t : { ...t, dependsOn: pruned };
        });

        return out;
    }

    async _runAuthAcceptanceGate(workspacePath) {
        const files = await complianceService._listFilesRecursive(workspacePath);
        const scanFiles = files.filter((f) => {
            const rel = path.relative(workspacePath, f).replace(/\\/g, '/');
            if (
                rel.startsWith('node_modules/') ||
                rel.startsWith('dist/') ||
                rel.startsWith('.git/')
            ) {
                return false;
            }
            return true;
        });
        const authFiles = scanFiles.filter((f) => /auth|viverse|context|sdk|app\.(jsx?|tsx?)$/i.test(path.basename(f)));
        const readList = authFiles.length ? authFiles : scanFiles.slice(0, 20);
        const texts = [];
        for (const f of readList) {
            try {
                const txt = await fs.readFile(f, 'utf8');
                texts.push(`\n//FILE:${path.relative(workspacePath, f)}\n${txt}`);
            } catch {
                // ignore unreadable
            }
        }
        const corpus = texts.join('\n');
        const forbiddenAccessTokenHeader = /(?:["'`]\s*accesstoken\s*["'`]\s*:|setRequestHeader\s*\(\s*["'`]accesstoken["'`]|headers?\s*[:=][\s\S]{0,120}["'`]accesstoken["'`])/i.test(corpus);
        const unsafeAuthResultPropertyAccess =
            /\b([A-Za-z_$][\w$]*)\.is_authenticated\b/.test(corpus) &&
            !/\?\.\s*is_authenticated\b/.test(corpus) &&
            !/if\s*\(\s*([A-Za-z_$][\w$]*)\s*&&\s*\1\.is_authenticated\s*\)/.test(corpus);
        const unsafeDirectLoginCall =
            /\bclient\.login\s*\(/.test(corpus) &&
            !/loginWithWorlds\s*\(/.test(corpus) &&
            !/loginWithAuthPage\s*\(/.test(corpus);
        const missingTokenBasedAuthFallback =
            /checkAuth\s*\(/.test(corpus) &&
            !/(access_token|accessToken|account_id|accountId)/.test(corpus);
        const checks = [
            { id: 'sdk-global-resolution', ok: /window\.vSdk\s*\|\|\s*window\.viverse\s*\|\|\s*window\.VIVERSE_SDK/.test(corpus), msg: 'Missing SDK global resolution chain.' },
            { id: 'handshake-delay', ok: /1200/.test(corpus) && /(setTimeout|delay|sleep)/i.test(corpus), msg: 'Missing explicit handshake delay guard.' },
            { id: 'checkauth-call', ok: /checkAuth\s*\(/.test(corpus), msg: 'Missing checkAuth() call in auth flow.' },
            { id: 'getuserinfo-fallback', ok: /getUserInfo\s*\(/.test(corpus), msg: 'Missing getUserInfo() recovery path.' },
            { id: 'no-accesstoken-header', ok: !forbiddenAccessTokenHeader, msg: "Forbidden 'accesstoken' token/header detected." },
            { id: 'checkauth-null-safe-access', ok: !unsafeAuthResultPropertyAccess, msg: "Unsafe direct 'authResult.is_authenticated' access detected. Use null-safe normalization." },
            { id: 'safe-login-method', ok: !unsafeDirectLoginCall, msg: "Unsafe direct 'client.login()' call detected. Use loginWithWorlds()/loginWithAuthPage() fallback flow." },
            { id: 'checkauth-token-fallback', ok: !missingTokenBasedAuthFallback, msg: "checkAuth() auth gate must include token/account fallback (access_token/account_id) for SDK variants without boolean auth flags." }
        ];
        const failed = checks.filter((c) => !c.ok);
        return {
            ok: failed.length === 0,
            failed
        };
    }

    _appendRunEvent(state, event = {}) {
        if (!state.runReport || typeof state.runReport !== 'object') {
            state.runReport = {
                startedAt: new Date().toISOString(),
                events: []
            };
        }
        state.runReport.events.push({
            at: new Date().toISOString(),
            ...event
        });
    }

    async _collectLatestPreviewArtifactFiles(workspacePath) {
        const out = [];
        if (!workspacePath) return out;
        const previewRoot = path.join(workspacePath, 'artifacts', 'preview-tests');
        try {
            const entries = await fs.readdir(previewRoot, { withFileTypes: true });
            const browserDirs = entries
                .filter((e) => e.isDirectory() && e.name.startsWith('browser-'))
                .map((e) => e.name)
                .sort()
                .reverse();
            const latest = browserDirs[0];
            if (!latest) return out;
            const latestDir = path.join(previewRoot, latest);
            for (const name of ['browser-report.json', 'host.log', 'joiner.log']) {
                out.push(path.join(latestDir, name));
            }
        } catch {
            // ignore
        }
        return out;
    }

    async _detectRuntimeBlockerSignatures(workspacePath, artifactPaths = []) {
        const candidates = new Set();
        const addIfFileLike = (p) => {
            const v = String(p || '').trim();
            if (!v) return;
            if (!/\.(json|log|txt)$/i.test(v)) return;
            const abs = path.isAbsolute(v) ? v : path.join(workspacePath, v);
            candidates.add(abs);
        };

        for (const p of artifactPaths) addIfFileLike(p);
        const latest = await this._collectLatestPreviewArtifactFiles(workspacePath);
        for (const p of latest) addIfFileLike(p);

        const issues = [];
        const patterns = [
            {
                id: 'runtime-app-id-placeholder',
                re: /app id authority:\s*your_app_id/i,
                message: "Runtime blocker: app still reports placeholder App ID authority ('YOUR_APP_ID')."
            },
            {
                id: 'runtime-checkauth-ack-unhandled',
                re: /unhandled methods:\s*viverse_sdk\/checkauth:ack/i,
                message: "Runtime blocker: SDK bridge reports unhandled 'VIVERSE_SDK/checkAuth:ack'."
            },
            {
                id: 'runtime-setactor-missing-method',
                re: /setactor is not a function/i,
                message: "Runtime blocker: matchmaking client API mismatch ('setActor' unavailable at runtime)."
            },
            {
                id: 'runtime-roomid-missing',
                re: /roomid is required|initializing multiplayerclient for room:\s*undefined/i,
                message: "Runtime blocker: MultiplayerClient initialized without a valid roomId."
            }
        ];

        for (const absPath of candidates) {
            let txt = '';
            try {
                txt = await fs.readFile(absPath, 'utf8');
            } catch {
                continue;
            }
            for (const p of patterns) {
                if (!p.re.test(txt)) continue;
                const rel = path.relative(workspacePath, absPath).replace(/\\/g, '/');
                const exists = issues.find((i) => i.id === p.id);
                if (exists) {
                    if (!exists.artifacts.includes(rel)) exists.artifacts.push(rel);
                } else {
                    issues.push({
                        id: p.id,
                        message: p.message,
                        artifacts: [rel]
                    });
                }
            }
        }

        return issues;
    }

    _sanitizeSummaryForAgent(summary = "", state = {}, role = "") {
        let out = String(summary || "");
        // Remove historical noisy App ID lines and re-inject a single canonical authority line.
        out = out
            .split('\n')
            .filter((line) => !/IMPORTANT:\s*The VIVERSE App ID for this project is:/i.test(String(line)))
            .join('\n');

        const appId = String(state?.runtimeFlags?.appIdAuthority?.value || "").toLowerCase();
        const appIdLine = this._isValidAppId(appId)
            ? `AUTHORITATIVE_APP_ID: ${appId}`
            : `AUTHORITATIVE_APP_ID: unresolved (DO NOT INVENT. Extract from .env or viverse-cli output).`;

        // Keep this explicit for coding and verification roles that act on app ID.
        const roleUpper = String(role || "").toUpperCase();
        if (["CODER", "REVIEWER", "VERIFIER"].includes(roleUpper)) {
            out += `\n- ${appIdLine}`;
        }
        return out;
    }

    _deriveComplianceProfiles(task, projectContextSummary = '') {
        const id = String(task?.id || '');
        const prompt = String(task?.prompt || '');

        if (id === 'auth_preflight' || /auth preflight only/i.test(prompt)) {
            return ['auth'];
        }

        if (/^c_fix_/i.test(id)) {
            const ctxMatch = prompt.match(/Task context:\s*([\s\S]*)$/i);
            const ctx = String(ctxMatch?.[1] || '');
            if (/auth preflight only/i.test(ctx)) return ['auth'];
            const fromContext = complianceService.inferProfiles(ctx);
            if (fromContext.length) return fromContext;
        }

        const fromPrompt = complianceService.inferProfiles(prompt);
        if (fromPrompt.length) return fromPrompt;

        // Last fallback only when task prompt has no detectable profile.
        return complianceService.inferProfiles(projectContextSummary);
    }

    _deriveCompliancePhase(task) {
        const id = String(task?.id || '');
        const prompt = String(task?.prompt || '').toLowerCase();

        if (id === 'auth_preflight' || /auth preflight only/.test(prompt)) return 'auth_preflight';
        if (/^fix_|^c_fix_|^v_fix_/i.test(id)) return 'fix';
        if (/publish|deploy|viverse-cli\s+app\s+publish/.test(prompt)) return 'publish';
        return 'gameplay';
    }

    _normalizePlan(rawPlan, { message = "", isResumeCommand = false } = {}) {
        if (!rawPlan || typeof rawPlan !== 'object') return null;
        const tasks = this._normalizeTasks(rawPlan.tasks || []);
        if (!tasks.length) return null;
        const enforcedTasks = this._enforceWorkflowTasks(tasks, { message });

        const normalized = {
            ...rawPlan,
            isNewProject: typeof rawPlan.isNewProject === 'boolean'
                ? rawPlan.isNewProject
                : this._inferIsNewProjectFallback(message, isResumeCommand),
            tasks: enforcedTasks
        };
        return normalized;
    }

    _isPublishTask(task = {}) {
        if (String(task.id || '') === 'auth_preflight') return false;
        const role = String(task.role || '').toUpperCase();
        const prompt = String(task.prompt || '').toLowerCase();
        if (role !== 'CODER') return false;
        const mentionsPublish = /(publish|viverse-cli\s+app\s+publish|deploy)/i.test(prompt);
        if (!mentionsPublish) return false;

        // Do not pre-block hybrid implementation tasks that include setup steps.
        const setupSignals = /(create|scaffold|generate|implement|build|write|npm\s+install|viverse-cli\s+app\s+create)/i.test(prompt);
        const publishLeading = /^(publish|deploy|run\s+viverse-cli\s+app\s+publish)\b/i.test(prompt.trim());
        const idLooksPublish = /\bpublish\b/i.test(String(task.id || ''));
        return publishLeading || idLooksPublish || !setupSignals;
    }

    async _checkPublishPreconditions(task, state, workspacePath, contextText = "") {
        if (!this._isPublishTask(task)) return { ok: true };
        if (state?.runtimeFlags?.authInvalid) {
            return { ok: false, reason: 'Publish blocked: previous authentication failure detected. Please update credentials and retry.' };
        }
        const expectedAppId = await this._resolveAppIdAuthority(state, workspacePath, contextText);
        if (!expectedAppId) {
            return { ok: false, reason: 'Publish blocked: App ID authority is missing. Cannot verify propagation safely.' };
        }

        const propagation = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId
        });
        if (propagation.status !== 'pass') {
            const reason = `Publish blocked: deterministic App ID propagation check failed. ${propagation.reasons.join(' | ')}`;
            state.runtimeFlags = state.runtimeFlags || {};
            state.runtimeFlags.lastPropagationCheck = {
                at: new Date().toISOString(),
                expectedAppId,
                status: propagation.status,
                reasons: propagation.reasons
            };
            return { ok: false, reason, details: propagation };
        }

        state.runtimeFlags = state.runtimeFlags || {};
        state.runtimeFlags.lastPropagationCheck = {
            at: new Date().toISOString(),
            expectedAppId,
            status: propagation.status,
            reasons: []
        };

        return { ok: true, details: propagation };
    }

    async _checkVerifierPreconditions(state, workspacePath) {
        if (state?.runtimeFlags?.authInvalid) {
            return { ok: false, reason: 'Verifier blocked: authentication is invalid in this run.' };
        }
        try {
            const distPath = path.join(workspacePath, 'dist');
            const distStat = await fs.stat(distPath);
            if (!distStat.isDirectory()) {
                return { ok: false, reason: 'Verifier blocked: dist folder is missing.' };
            }
        } catch {
            return { ok: false, reason: 'Verifier blocked: dist folder is missing.' };
        }
        return { ok: true };
    }

    async *processRequest(message, history = [], credentials = null, attachments = []) {
        logger.info(`Orchestrator: Processing request: ${message}`);
        
        // Ensure agents have the latest dynamic knowledge (skills/resilience guide)
        await geminiService.refreshKnowledge();
        const workSpaceDir = path.resolve(process.cwd(), '.viverse_workspaces');
        const lowerMsg = message.toLowerCase().trim();
        const isResumeCommand =
            ["proceed", "continue", "go on", "ok", "yes", "next"].includes(lowerMsg) ||
            /^(resume|continue|proceed)\b/.test(lowerMsg);
        const hasExplicitResumeInstruction =
            /^(resume|continue|proceed)\b/.test(lowerMsg) &&
            /\b(and|then|run|publish|probe|fix|build|test|verify|implement)\b/.test(lowerMsg);
        
        let workspacePath;
        let state;
        let plan;

        const appIdsFromMsg = this._extractAppIdCandidates(message);
        const appIdsFromHistory = this._extractAppIdCandidates(JSON.stringify(history || []));
        const appIds = [...new Set([...appIdsFromMsg, ...appIdsFromHistory])];
        const userKey = credentials?.email ? String(credentials.email).toLowerCase() : "";
        const reqHint = String(message || '').match(/\b(req_\d{8,})\b/i)?.[1] || "";
        const explicitWorkspaceHint = reqHint ? path.join(workSpaceDir, reqHint) : null;
        const preferredWorkspace = explicitWorkspaceHint || (userKey ? this.activeProjects.get(userKey) : null);

        // PRE-SCAN: choose best workspace candidate instead of blindly picking latest.
        try {
            const best = await this._pickWorkspace(workSpaceDir, { appIds, preferredWorkspace });
            if (best && isResumeCommand) {
                workspacePath = best.path;
                state = best.state;
                yield { type: 'status', content: sanitizer.sanitize(`Resuming work in existing sandbox: ${workspacePath}`, credentials) };
                yield { type: 'status', content: sanitizer.sanitize(`Current Task: ${state.tasks.find(t => t.status === 'pending')?.prompt.substring(0, 50) || "none"}...`, credentials) };
            }
        } catch (e) {
            logger.debug("No workspaces found.");
        }

        // If user asks for additional action but the resumed state has no pending tasks,
        // force a fresh planning pass so follow-up instructions are not ignored.
        if (state && isResumeCommand) {
            const pendingCount = Array.isArray(state.tasks)
                ? state.tasks.filter((t) => t.status === 'pending').length
                : 0;
            if (pendingCount === 0 && hasExplicitResumeInstruction) {
                yield {
                    type: 'status',
                    content: 'No pending tasks in saved state. Re-planning follow-up tasks from your instruction...'
                };
                state = null;
            }
        }

        // Step 1: Planning (Skip if strictly resuming)
        if (!state) {
            yield { type: 'status', content: 'Orchestrator is analyzing your request and planning tasks...' };
            
            const credString = credentials ? `\n\nUSER VIVERSE CREDENTIALS PROVIDED:\nEmail: ${credentials.email}\nPassword: ${credentials.password}\n` : "";

            const planPrompt = `User Request: "${message}"${credString}
            
            CRITICAL: Analyze the conversation history provided below. 
            - If the history shows an ongoing project development and the user is asking for changes, updates, fixes, or to "proceed" / "continue", you MUST set "isNewProject": false.
            - Only set "isNewProject": true if the user is fundamentally starting a DIFFERENT app.
            
            VERIFIED-LOOP MANDATE:
            1. Every plan MUST start with an Architect task to generate 'CONTRACT.json'.
            2. Every plan MUST include a 'Verifier' task AFTER any Coder 'build' or 'publish' task.
            3. The Verifier MUST check for App ID bundling (grep gate) and SDK URL correctness.
            
            Decide if this is:
            A. A simple search/question (Simple Task)
            B. A request to build/modify a web application (Project Task)
            
            If it's a Project Task, generate a JSON plan with tasks. If it's a Simple Task, respond directly.
            Return your plan strictly in the JSON format defined in your instructions. Include the boolean "isNewProject" as described above.`;

            const orchestratorResponse = await geminiService.generateResponse(planPrompt, history, "ORCHESTRATOR", null, attachments);
            
            try {
                const parsedPlan = JSON.parse(orchestratorResponse.replace(/```json\n?|\n?```/g, '').trim());
                plan = this._normalizePlan(parsedPlan, { message, isResumeCommand });
                logger.info(`Orchestrator: Plan generated. isNewProject: ${plan?.isNewProject}`);
                
                if (parsedPlan?.error === "CREDENTIALS_REQUIRED") {
                    yield { type: 'action', action: 'require_credentials' };
                    yield { type: 'text', content: parsedPlan.message };
                    return;
                }
            } catch (e) {
                logger.warn("Orchestrator did not output JSON. Response: " + orchestratorResponse.substring(0, 100));
                plan = null;
            }

            if (!plan || !plan.tasks) {
                yield { type: 'status', content: 'Orchestrator responded conversationally.' };
                yield { type: 'text', content: orchestratorResponse };
                return;
            }

            // Step 2: Workspace Selection & State Restoration for Follow-ups
            if (plan.isNewProject === false) {
                try {
                    const best = await this._pickWorkspace(workSpaceDir, { appIds, preferredWorkspace });
                    if (best) {
                        workspacePath = best.path;
                        const oldState = best.state;

                        // RESTORE but UPDATE: Keep the workspace and context, but use the NEW tasks
                        state = {
                            ...oldState,
                            request: message,
                            tasks: plan.tasks.map(t => ({ ...t, status: 'pending' })),
                        };
                        
                        // Append the new request to the summary context so agents know what changed
                        state.projectContextSummary += `\n\nFOLLOW-UP REQUEST: "${message}"\nNew tasks scheduled for improvement...`;
                        
                        yield { type: 'status', content: sanitizer.sanitize(`Resuming work for iterative improvement in: ${workspacePath}`, credentials) };
                        if (userKey) this.activeProjects.set(userKey, workspacePath);
                    }
                } catch (e) {
                    logger.warn("Could not restore previous state for follow-up. Falling back to new workspace.");
                }
            }

            if (!state) {
                if (!workspacePath) {
                    workspacePath = path.join(workSpaceDir, `req_${Date.now()}`);
                    await fs.mkdir(workspacePath, { recursive: true });
                    yield { type: 'status', content: `Created new sandboxed workspace: ${workspacePath}` };
                }

                // Create initial state for new plan
                state = {
                    request: message,
                    workspacePath: workspacePath,
                    tasks: plan.tasks.map(t => ({ ...t })),
                    history: [],
                    projectContextSummary: `ORIGINAL USER PROJECT REQUEST: "${message}"\n\nProject Initialization started.`,
                    runtimeFlags: {
                        authInvalid: false,
                        appIdAuthority: {
                            value: "",
                            source: "",
                            updatedAt: ""
                        }
                    },
                    runReport: {
                        startedAt: new Date().toISOString(),
                        events: []
                    }
                };
                if (Array.isArray(attachments) && attachments.length) {
                    const specs = attachments.map((a, i) => `${i + 1}. ${a.name} (${a.mimeType})`).join('\n');
                    state.projectContextSummary += `\n\nSPEC ATTACHMENTS PROVIDED:\n${specs}`;
                }
                if (userKey) this.activeProjects.set(userKey, workspacePath);
            }
        }

        // Programmatic UI Trigger Enforcement
        if (!credentials) {
            yield { type: 'action', action: 'require_credentials' };
            yield { type: 'text', content: 'I need your VIVERSE Account credentials to build and publish this app for you. Please fill out the VIVERSE Account panel on the left to proceed!' };
            return;
        }

        let projectContextSummary = state.projectContextSummary || "";
        state.runtimeFlags = state.runtimeFlags || { authInvalid: false };
        state.projectContextSummary = projectContextSummary;
        this._beginRunReport(state);
        this._appendRunEvent(state, {
            type: 'run_started',
            request: String(message || '').slice(0, 400),
            workspacePath
        });
        state.status = 'running';
        if (userKey && state.workspacePath) this.activeProjects.set(userKey, state.workspacePath);
        await this._saveState(state);

        // Step 3: Execution Loop
        while (true) {
            // Find tasks that are pending
            const pendingTasks = state.tasks.filter(t => t.status === 'pending');
            if (pendingTasks.length === 0) break;

            // Find tasks whose dependencies are met
            const readyTasks = pendingTasks.filter(t => {
                if (!t.dependsOn || t.dependsOn.length === 0) return true;
                return t.dependsOn.every(depId => {
                    const dep = state.tasks.find(x => x.id === depId);
                    const isDone = dep && dep.status === 'completed';
                    return isDone;
                });
            });

            logger.info(`Orchestrator: Tasks pending: ${pendingTasks.length}, Tasks ready: ${readyTasks.length}`);

            if (readyTasks.length === 0) {
                const failedTasks = state.tasks.filter(t => t.status === 'failed' || t.status === 'blocked').map(t => t.id);
                logger.warn(`Orchestrator: Deadlock or finished. Remaining pending tasks: ${pendingTasks.map(t => t.id).join(', ')}. Failed/Blocked: ${failedTasks.join(', ')}`);
                const reason = failedTasks.length
                    ? `Execution paused: blocked by failed tasks (${failedTasks.join(', ')}).`
                    : 'Execution paused: Cannot proceed due to missing dependencies or previous failures.';
                yield { type: 'status', content: reason };
                break;
            }

            // NOTE: For streaming feedback to the UI, we await sequentially. 
            // The dependency graph allows true concurrency (Promise.all) if stream merging is implemented in the UI layer.
            for (const task of readyTasks) {
                let haltExecutionReason = null;
                const taskStartedAt = Date.now();
                this._appendRunEvent(state, {
                    type: 'task_started',
                    taskId: task.id,
                    role: task.role,
                    prompt: String(task.prompt || '').slice(0, 200)
                });
                const isFixLoopTask = /^(?:fix_|v_fix_|c_fix_)/i.test(String(task.id || ""));

                // Auto-resolve stale deterministic compliance-fix tasks if current code no longer violates
                // the task's signature. This prevents deadlocks from outdated fix prompts.
                if (/^c_fix_/i.test(String(task.id || "")) && /DETERMINISTIC COMPLIANCE FIX REQUIRED/i.test(String(task.prompt || ""))) {
                    try {
                        const sigText = String(task.prompt || '').match(/Signature:\s*([^\n]+)/i)?.[1] || '';
                        const expectedRuleIds = sigText
                            .split('||')
                            .map((s) => String(s || '').trim())
                            .filter(Boolean);
                        if (expectedRuleIds.length > 0) {
                            const profileHints = this._deriveComplianceProfiles(task, projectContextSummary);
                            const gate = await complianceService.runFastGate({
                                workspacePath,
                                taskPrompt: task.prompt,
                                profileHints,
                                gatePhase: 'fix',
                                cache: this.complianceRuntimeCache.get(workspacePath) || state.complianceFastCache || {}
                            });
                            const activeRuleIds = new Set((gate.findings || []).map((f) => String(f.ruleId || '').trim()));
                            const unresolved = expectedRuleIds.filter((id) => activeRuleIds.has(id));
                            if (unresolved.length === 0) {
                                task.status = 'completed';
                                this._appendRunEvent(state, {
                                    type: 'task_auto_resolved',
                                    taskId: task.id,
                                    role: task.role,
                                    durationMs: Date.now() - taskStartedAt,
                                    note: `Compliance fix signature already resolved: ${expectedRuleIds.join(', ')}`
                                });
                                projectContextSummary += `\n- Auto-resolved stale compliance fix task ${task.id}; signature no longer present.`;
                                state.projectContextSummary = projectContextSummary;
                                yield {
                                    type: 'status',
                                    content: `Auto-resolved stale compliance fix task (${task.id}). Continuing workflow.`
                                };
                                await this._saveState(state);
                                continue;
                            }
                        }
                    } catch (autoResolveErr) {
                        logger.warn(`Orchestrator: c_fix auto-resolve precheck failed: ${autoResolveErr?.message || autoResolveErr}`);
                    }
                }

                if (isFixLoopTask) {
                    yield {
                        type: 'status',
                        content: sanitizer.sanitize(
                            `Review gate requested fixes. Running extended fix loop with ${task.role}... this can take longer than normal.`,
                            credentials
                        )
                    };
                }

                yield { type: 'status', content: sanitizer.sanitize(`Agent [${task.role}] is working on: ${task.prompt.substring(0, 50)}...`, credentials) };
                yield { type: 'text', content: sanitizer.sanitize(`\n\n> **Agent [${task.role}]** is starting task: *${task.prompt}*`, credentials) };
                logger.info(`Orchestrator: Dispatching task ${task.id} to ${task.role}`);

                const publishPrecheck = await this._checkPublishPreconditions(
                    task,
                    state,
                    workspacePath,
                    `${projectContextSummary}\n${String(task.prompt || "")}`
                );
                if (!publishPrecheck.ok) {
                    task.status = 'blocked';
                    const reason = publishPrecheck.reason || 'Publish preconditions not met.';
                    projectContextSummary += `\n- ${task.role} BLOCKED: ${reason}`;
                    state.projectContextSummary = projectContextSummary;
                    await this._saveState(state);
                    yield { type: 'status', content: sanitizer.sanitize(reason, credentials) };
                    yield { type: 'text', content: sanitizer.sanitize(`\n\n⚠️ **${task.role} task blocked**\nReason: ${reason}`, credentials) };
                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                    return;
                }

                if (String(task.role || '').toUpperCase() === 'VERIFIER') {
                    const verifierPrecheck = await this._checkVerifierPreconditions(state, workspacePath);
                    if (!verifierPrecheck.ok) {
                        task.status = 'blocked';
                        const reason = verifierPrecheck.reason || 'Verifier preconditions not met.';
                        this._appendRunEvent(state, {
                            type: 'task_blocked',
                            taskId: task.id,
                            role: task.role,
                            reason
                        });
                        projectContextSummary += `\n- ${task.role} BLOCKED: ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: sanitizer.sanitize(reason, credentials) };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                }

                // Context is kept brief to avoid token limits. Agents must rely on file reading.
                const skillEnforcement = await this._buildSkillEnforcementBlock(
                    task.prompt,
                    projectContextSummary,
                    task.role
                );
                const credentialsBlock = task.role?.toUpperCase() === 'CODER' && credentials
                    ? `\n\nUSER VIVERSE CREDENTIALS FOR THIS RUN ONLY:\nEmail: ${credentials.email}\nPassword: ${credentials.password}\n(Do not persist credentials into files or state summaries.)`
                    : '';
                const authPreflightScopeBlock =
                    task.id === 'auth_preflight'
                        ? `\n\n[AUTH_PREFLIGHT_SCOPE]\nThis task is AUTH PREFLIGHT ONLY.\n- Do NOT run viverse-cli app create/publish.\n- Do NOT run App-ID bundling grep checks.\n- Focus only on SDK detection, handshake delay, checkAuth/getUserInfo recovery, forbidden header compliance, and minimal build sanity.\n`
                        : '';
                const appSetupScopeBlock =
                    task.role?.toUpperCase() === 'CODER' &&
                    /viverse-cli\s+app\s+create|VITE_VIVERSE_CLIENT_ID/i.test(String(task.prompt || ""))
                        ? `\n\n[APP_SETUP_SCOPE]\nThis task is App setup/app-id wiring.\n- Extract one authoritative App ID (10-char alnum with at least one digit).\n- Write .env with that exact ID.\n- Build once, verify once with exact ID.\n- Do NOT probe dist with random/partial tokens.\n`
                        : '';
                const sanitizedSummary = this._sanitizeSummaryForAgent(projectContextSummary, state, task.role);
                const compactSummary = (task.role?.toUpperCase() === 'VERIFIER' || task.role?.toUpperCase() === 'REVIEWER')
                    ? sanitizedSummary.slice(-4000)
                    : sanitizedSummary;
                const agentPrompt = `Project Summary Context:\n${compactSummary}${credentialsBlock}${authPreflightScopeBlock}${appSetupScopeBlock}\n\nYour Sandboxed Workspace: ${workspacePath}\n\nYour Task: ${task.prompt}${skillEnforcement}`;
                
                const taskAttachments = task.role?.toUpperCase() === 'ARCHITECT' ? attachments : [];
                const agentStream = geminiService.generateResponseStream(
                    agentPrompt,
                    [],
                    task.role.toUpperCase(),
                    workspacePath,
                    taskAttachments
                );
                const taskIdleTimeoutMs = Math.max(
                    60000,
                    Number(process.env.ORCHESTRATOR_TASK_IDLE_TIMEOUT_MS || 180000)
                );
                const taskDurationTimeoutMs = Math.max(
                    120000,
                    Number(process.env.ORCHESTRATOR_TASK_DURATION_TIMEOUT_MS || 420000)
                );
                
                let fullResponse = "";
                let emittedComplianceClaimNotice = false;
                try {
                    const iterator = agentStream[Symbol.asyncIterator]();
                    const streamStartedAt = Date.now();
                    let lastAgentChunkAt = streamStartedAt;
                    const taskHeartbeatMs = Math.max(
                        1500,
                        Number(process.env.ORCHESTRATOR_TASK_HEARTBEAT_MS || 7000)
                    );
                    while (true) {
                        const pendingNext = iterator.next();
                        let nextResult = null;
                        while (true) {
                            const now = Date.now();
                            const idleElapsed = now - lastAgentChunkAt;
                            const durationElapsed = now - streamStartedAt;
                            if (idleElapsed > taskIdleTimeoutMs) {
                                throw new Error(`AGENT_TASK_IDLE_TIMEOUT:${taskIdleTimeoutMs}`);
                            }
                            if (durationElapsed > taskDurationTimeoutMs) {
                                throw new Error(`AGENT_TASK_DURATION_TIMEOUT:${taskDurationTimeoutMs}`);
                            }

                            const waitMs = Math.max(
                                250,
                                Math.min(
                                    taskHeartbeatMs,
                                    taskIdleTimeoutMs - idleElapsed,
                                    taskDurationTimeoutMs - durationElapsed
                                )
                            );

                            const raceResult = await Promise.race([
                                pendingNext.then((value) => ({ kind: 'next', value })),
                                new Promise((resolve) => setTimeout(() => resolve({ kind: 'tick' }), waitMs))
                            ]);

                            if (raceResult?.kind === 'tick') {
                                yield { type: 'status', content: '·' };
                                continue;
                            }

                            nextResult = raceResult?.value;
                            break;
                        }

                        if (nextResult?.done) break;
                        lastAgentChunkAt = Date.now();
                        const chunk = nextResult?.value;
                        if (!chunk) continue;
                        if (chunk.type === 'text') {
                            fullResponse += chunk.content;
                            // Avoid leaking technical JSON from Reviewer/Orchestrator-Planner to the user
                            if (!fullResponse.trim().startsWith('{')) {
                                const roleUpper = String(task.role || '').toUpperCase();
                                if (roleUpper === 'CODER' && this._hasComplianceSuccessClaim(chunk.content)) {
                                    const masked = this._maskComplianceSuccessClaims(chunk.content);
                                    yield { type: 'text', content: sanitizer.sanitize(masked, credentials) };
                                    if (!emittedComplianceClaimNotice) {
                                        emittedComplianceClaimNotice = true;
                                        yield { type: 'status', content: 'Coder compliance claims are provisional until deterministic gate verification finishes.' };
                                    }
                                } else {
                                    yield { type: 'text', content: sanitizer.sanitize(chunk.content, credentials) };
                                }
                            }
                        } else if (chunk.type === 'status') {
                            yield { ...chunk, content: sanitizer.sanitize(chunk.content, credentials) };
                        }
                    }
                } catch (streamErr) {
                    const reason = String(streamErr?.message || streamErr || 'Unknown stream failure');
                    logger.error(`Orchestrator: Task ${task.id} failed during agent stream: ${reason}`);
                    if (/INVALID_CREDENTIALS/i.test(reason)) {
                        state.runtimeFlags.authInvalid = true;
                    }

                    const roleUpper = String(task.role || '').toUpperCase();
                    const isCoder = roleUpper === 'CODER';
                    const isVerifier = roleUpper === 'VERIFIER';
                    const isToolLoop = /MAX_TOOL_ITERATIONS_REACHED|CONVERGENCE_GUARD|AGENT_TASK_IDLE_TIMEOUT|AGENT_TASK_DURATION_TIMEOUT/i.test(reason);
                    state.runtimeFlags = state.runtimeFlags || {};
                    state.runtimeFlags.loopRecovery = state.runtimeFlags.loopRecovery || {};
                    const recoveryKey = `${task.id}`;
                    const prevRecoveryCount = Number(state.runtimeFlags.loopRecovery[recoveryKey] || 0);

                    if (isCoder && isToolLoop && prevRecoveryCount < 1) {
                        const retryId = `loop_recover_${Date.now()}`;
                        state.runtimeFlags.loopRecovery[recoveryKey] = prevRecoveryCount + 1;
                        state.tasks.push({
                            id: retryId,
                            role: 'Coder',
                            prompt: `LOOP RECOVERY TASK (deterministic): Previous coder task '${task.id}' failed due to tool loop (${reason}).
1) Determine authoritative App ID (10-char alnum with at least one digit) from .env or viverse-cli output.
2) Ensure .env has exactly VITE_VIVERSE_CLIENT_ID=<authoritative_app_id>.
3) Ensure source references VITE_VIVERSE_CLIENT_ID (no placeholder tokens).
4) Run ONE build.
5) Run ONE dist verification using the exact authoritative app id; do NOT run token-hunting grep loops.
6) If verification fails, fix source/env and rebuild once. Then stop and summarize exact mismatch.`,
                            dependsOn: [],
                            status: 'pending'
                        });
                        for (const t of state.tasks) {
                            if (t.status === 'pending' && Array.isArray(t.dependsOn) && t.dependsOn.includes(task.id)) {
                                t.dependsOn = t.dependsOn.filter((d) => d !== task.id);
                                if (!t.dependsOn.includes(retryId)) t.dependsOn.push(retryId);
                            }
                        }
                        task.status = 'failed';
                        this._appendRunEvent(state, {
                            type: 'task_failed_recovered',
                            taskId: task.id,
                            role: task.role,
                            durationMs: Date.now() - taskStartedAt,
                            reason
                        });
                        projectContextSummary += `\n- ${task.role} LOOP RECOVERY scheduled from ${task.id}: ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield {
                            type: 'status',
                            content: sanitizer.sanitize(
                                `Task ${task.id} entered a tool loop. Scheduling deterministic recovery task ${retryId}.`,
                                credentials
                            )
                        };
                        continue;
                    }

                    if (isVerifier && isToolLoop && prevRecoveryCount < 1) {
                        const retryId = `loop_recover_verifier_${Date.now()}`;
                        state.runtimeFlags.loopRecovery[recoveryKey] = prevRecoveryCount + 1;
                        state.tasks.push({
                            id: retryId,
                            role: 'Verifier',
                            prompt: `LOOP RECOVERY TASK (deterministic): Previous verifier task '${task.id}' failed due to tool loop (${reason}).
Use existing workspace artifacts only; do NOT run broad recursive scans or repeated token-hunting loops.
1) Read latest preview probe report under artifacts/preview-tests (most recent preview-*.json and linked browser-report.json).
2) Return STRICT JSON with:
   - status (pass/fail)
   - runtime_checks.auth_profile.status/proof
   - runtime_checks.matchmaking.status/proof
   - preview_url_tested
   - artifact_paths (exact files used)
3) If evidence is stale/missing, run at most ONE targeted preview probe and then report once.`,
                            dependsOn: [],
                            status: 'pending'
                        });
                        for (const t of state.tasks) {
                            if (t.status === 'pending' && Array.isArray(t.dependsOn) && t.dependsOn.includes(task.id)) {
                                t.dependsOn = t.dependsOn.filter((d) => d !== task.id);
                                if (!t.dependsOn.includes(retryId)) t.dependsOn.push(retryId);
                            }
                        }
                        task.status = 'failed';
                        this._appendRunEvent(state, {
                            type: 'task_failed_recovered',
                            taskId: task.id,
                            role: task.role,
                            durationMs: Date.now() - taskStartedAt,
                            reason
                        });
                        projectContextSummary += `\n- ${task.role} LOOP RECOVERY scheduled from ${task.id}: ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield {
                            type: 'status',
                            content: sanitizer.sanitize(
                                `Task ${task.id} entered a verifier tool loop. Scheduling deterministic recovery task ${retryId}.`,
                                credentials
                            )
                        };
                        continue;
                    }

                    task.status = 'failed';
                    this._appendRunEvent(state, {
                        type: 'task_failed',
                        taskId: task.id,
                        role: task.role,
                        durationMs: Date.now() - taskStartedAt,
                        reason
                    });
                    projectContextSummary += `\n- ${task.role} FAILED: ${reason}`;
                    state.projectContextSummary = projectContextSummary;
                    await this._saveState(state);
                    yield {
                        type: 'status',
                        content: sanitizer.sanitize(
                            `Task ${task.id} failed: ${reason}. Workflow paused for manual intervention.`,
                            credentials
                        )
                    };
                    yield {
                        type: 'text',
                        content: sanitizer.sanitize(
                            `\n\n⚠️ **${task.role} task failed**\nReason: ${reason}`,
                            credentials
                        )
                    };
                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                    return;
                }
                
                logger.info(`Orchestrator: Agent [${task.role}] stream finished. Response length: ${fullResponse.length}`);
                if (String(task.role || '').toUpperCase() === 'CODER') {
                    state.runtimeFlags = state.runtimeFlags || {};
                    state.runtimeFlags.lastCoderComplianceClaim = {
                        taskId: String(task.id || ''),
                        claimed: this._hasComplianceSuccessClaim(fullResponse),
                        at: new Date().toISOString()
                    };
                }

                // Auth preflight deterministic gate (Phase 1.6)
                if (task.id === 'auth_preflight' && task.role.toUpperCase() === 'CODER') {
                    try {
                        const gate = await this._runAuthAcceptanceGate(workspacePath);
                        if (!gate.ok) {
                            const reasons = gate.failed.map((f) => `${f.id}: ${f.msg}`).join(' | ');
                            const signature = gate.failed
                                .map((f) => String(f.id || 'unknown-auth-rule'))
                                .sort()
                                .join(' || ');
                            const tracker = state.authPreflightFixTracker || {};
                            const attempts = Number(tracker[signature] || 0);

                            if (attempts >= this.maxAuthPreflightFixAttemptsPerSignature) {
                                task.status = 'failed';
                                this._appendRunEvent(state, {
                                    type: 'task_failed',
                                    taskId: task.id,
                                    role: task.role,
                                    durationMs: Date.now() - taskStartedAt,
                                    reason: `AUTH_PREFLIGHT_GATE_FAILED: ${reasons}`
                                });
                                projectContextSummary += `\n- AUTH PREFLIGHT FAILED (retry cap): ${reasons}`;
                                state.projectContextSummary = projectContextSummary;
                                await this._saveState(state);
                                yield { type: 'status', content: `Auth preflight failed: ${reasons}` };
                                yield { type: 'text', content: `\n\n⚠️ **Auth preflight failed**\n${reasons}` };
                                await this._finalizeWorkflowState(state, 'paused_or_failed');
                                return;
                            }

                            const existingPending = state.tasks.find((t) =>
                                t.status === 'pending' &&
                                t.role === 'Coder' &&
                                String(t.id || '').startsWith('ap_fix_') &&
                                String(t.prompt || '').includes(signature)
                            );

                            let fixTaskId = existingPending?.id;
                            if (!fixTaskId) {
                                fixTaskId = `ap_fix_${Date.now()}`;
                                state.tasks.push({
                                    id: fixTaskId,
                                    role: 'Coder',
                                    prompt: `AUTH_PREFLIGHT_FIX REQUIRED. Signature: ${signature}
Resolve all auth preflight acceptance failures:
${reasons}

Requirements:
1) Ensure SDK global resolution chain exists: window.vSdk || window.viverse || window.VIVERSE_SDK.
2) Add explicit handshake delay guard before auth checks.
3) Ensure checkAuth() call exists in auth bootstrap.
4) Ensure getUserInfo() recovery path exists.
5) Do not use forbidden lowercase 'accesstoken' header key.
6) Run one build sanity check if source changed and summarize exact fixes.`,
                                    dependsOn: [],
                                    status: 'pending'
                                });
                            }

                            // Reroute pending work to wait on the auth preflight fix task.
                            for (const t of state.tasks) {
                                if (t.status !== 'pending' || !Array.isArray(t.dependsOn)) continue;
                                if (!t.dependsOn.includes('auth_preflight')) continue;
                                t.dependsOn = t.dependsOn.filter((d) => d !== 'auth_preflight');
                                if (!t.dependsOn.includes(fixTaskId)) t.dependsOn.push(fixTaskId);
                            }

                            tracker[signature] = attempts + 1;
                            state.authPreflightFixTracker = tracker;
                            task.status = 'completed';
                            this._appendRunEvent(state, {
                                type: 'task_completed',
                                taskId: task.id,
                                role: task.role,
                                durationMs: Date.now() - taskStartedAt
                            });
                            projectContextSummary += `\n- AUTH PREFLIGHT FAILED: ${reasons}. Scheduled ${fixTaskId} (attempt ${attempts + 1}).`;
                            state.projectContextSummary = projectContextSummary;
                            await this._saveState(state);
                            yield { type: 'status', content: `Auth preflight failed: ${reasons}` };
                            yield { type: 'status', content: `Scheduled mandatory auth preflight fix task ${fixTaskId}. Continuing workflow.` };
                            continue;
                        }
                        projectContextSummary += `\n- Auth preflight gate passed.`;
                    } catch (authGateErr) {
                        const reason = String(authGateErr?.message || authGateErr || 'Unknown auth preflight error');
                        task.status = 'failed';
                        this._appendRunEvent(state, {
                            type: 'task_failed',
                            taskId: task.id,
                            role: task.role,
                            durationMs: Date.now() - taskStartedAt,
                            reason
                        });
                        projectContextSummary += `\n- AUTH PREFLIGHT ERROR: ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: `Auth preflight errored: ${reason}` };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                }

                // Step 3.5: Deterministic fast compliance gate for coder outputs
                if (task.role.toUpperCase() === 'CODER') {
                    try {
                        yield { type: 'status', content: 'Running deterministic fast compliance gate...' };
                        const profileHints = this._deriveComplianceProfiles(task, projectContextSummary);
                        const persistedCache = state.complianceFastCache || {};
                        const runtimeCache = this.complianceRuntimeCache.get(workspacePath) || {};
                        const cache = {
                            ...persistedCache,
                            ...runtimeCache,
                            fileIndex: runtimeCache.fileIndex || persistedCache.fileIndex
                        };
                        const gate = await complianceService.runFastGate({
                            workspacePath,
                            taskPrompt: task.prompt,
                            profileHints,
                            gatePhase: this._deriveCompliancePhase(task),
                            cache
                        });
                        if (gate._nextCache) {
                            this.complianceRuntimeCache.set(workspacePath, gate._nextCache);
                            // Keep persisted state lightweight for easier debugging/state diffs.
                            state.complianceFastCache = {
                                lastSnapshotKey: gate._nextCache.lastSnapshotKey,
                                lastResult: gate._nextCache.lastResult
                            };
                        }

                        if (gate.status === 'pass') {
                            state.runtimeFlags = state.runtimeFlags || {};
                            state.runtimeFlags.lastCoderGate = {
                                taskId: String(task.id || ''),
                                status: 'pass',
                                findings: []
                            };
                            const cacheSuffix = gate.cacheHit ? ' (cached)' : '';
                            yield {
                                type: 'status',
                                content: `Fast compliance gate passed${cacheSuffix}. Rules checked: ${gate.checkedRules}, files scanned: ${gate.scannedFiles}.`
                            };
                        } else if (gate.status === 'fail') {
                            state.runtimeFlags = state.runtimeFlags || {};
                            state.runtimeFlags.lastCoderGate = {
                                taskId: String(task.id || ''),
                                status: 'fail',
                                findings: Array.isArray(gate.findings) ? gate.findings : []
                            };
                            const phase = this._deriveCompliancePhase(task);
                            const severityRank = (s = '') => {
                                const v = String(s || '').toLowerCase();
                                if (v === 'critical') return 4;
                                if (v === 'high') return 3;
                                if (v === 'medium') return 2;
                                return 1;
                            };
                            const minBlockingRank = phase === 'auth_preflight' ? 3 : 2;
                            const blockingFindings = gate.findings.filter((f) => severityRank(f.severity) >= minBlockingRank);
                            const reasons = blockingFindings.map((f) => `${f.ruleId}: ${f.message}`);
                            const advisoryFindings = gate.findings.filter((f) => severityRank(f.severity) < minBlockingRank);

                            if (blockingFindings.length === 0) {
                                const advisory = advisoryFindings.map((f) => `${f.ruleId}: ${f.message}`).join(' | ');
                                yield {
                                    type: 'status',
                                    content: advisory
                                        ? `Fast compliance advisory (non-blocking in ${phase}): ${advisory}`
                                        : `Fast compliance gate has non-blocking findings in ${phase}.`
                                };
                                projectContextSummary += advisory
                                    ? `\n- Fast compliance advisory (${phase}): ${advisory}`
                                    : `\n- Fast compliance advisory (${phase}).`;
                                // Non-blocking advisories should not skip task completion.
                            }

                            const reasonText = reasons.join(' | ');
                            const short = reasonText.length > 260 ? `${reasonText.slice(0, 260)}...` : reasonText;
                            const signature = blockingFindings
                                .map((f) => String(f.ruleId || 'unknown-rule'))
                                .sort()
                                .join(' || ');
                            const tracker = state.complianceFixTracker || {};
                            const attempts = Number(tracker[signature] || 0);

                            if (attempts >= this.maxComplianceFixAttemptsPerSignature) {
                                yield {
                                    type: 'status',
                                    content: 'Fast compliance gate still failing after max fix attempts for same rule set. Stopping auto-fix loop for this signature.'
                                };
                                projectContextSummary += `\n- Fast compliance gate exceeded retry cap for signature: ${signature}`;
                                haltExecutionReason = `Compliance gate unresolved after ${attempts} attempts for signature: ${signature}`;
                            } else {
                                yield { type: 'status', content: 'Fast compliance gate failed. Creating mandatory fix task.' };
                                yield {
                                    type: 'status',
                                    content: sanitizer.sanitize(
                                        `Compliance issues: ${short}`,
                                        credentials
                                    )
                                };
                                yield { type: 'status', content: 'Applying compliance fixes now. This may take longer than a normal coding pass.' };

                                const existingPending = state.tasks.find((t) =>
                                    t.status === 'pending' &&
                                    t.role === 'Coder' &&
                                    String(t.prompt || '').includes('DETERMINISTIC COMPLIANCE FIX REQUIRED') &&
                                    String(t.prompt || '').includes(signature)
                                );

                                if (!existingPending) {
                                    const fixTaskId = `c_fix_${Date.now()}`;
                                    state.tasks.push({
                                        id: fixTaskId,
                                        role: 'Coder',
                                        prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: ${signature}\nResolve all failed rules from fast gate:\n${reasons.join('\n')}\n\nTask context: ${task.prompt}`,
                                        dependsOn: [],
                                        status: 'pending'
                                    });

                                    for (let i = 0; i < state.tasks.length; i++) {
                                        let t = state.tasks[i];
                                        if (t.status === 'pending' && t.dependsOn && t.dependsOn.includes(task.id)) {
                                            t.dependsOn = t.dependsOn.filter(depId => depId !== task.id);
                                            t.dependsOn.push(fixTaskId);
                                        }
                                    }

                                    tracker[signature] = attempts + 1;
                                    state.complianceFixTracker = tracker;
                                    projectContextSummary += `\n- Fast compliance gate failed: ${reasons.join(', ')}. Compliance fix task created (attempt ${attempts + 1}).`;
                                } else {
                                    projectContextSummary += `\n- Fast compliance gate failed: ${reasons.join(', ')}. Existing compliance fix task already pending.`;
                                }
                            }
                        } else {
                            yield { type: 'status', content: 'Fast compliance gate skipped (no matching profile/rules).' };
                        }
                    } catch (e) {
                        logger.warn(`Orchestrator: fast compliance gate error: ${e.message}`);
                        yield { type: 'status', content: 'Fast compliance gate encountered an internal error; continuing with standard review flow.' };
                    }
                }

                if (haltExecutionReason) {
                    task.status = 'pending';
                    state.projectContextSummary = `${projectContextSummary}\n- WORKFLOW HALTED: ${haltExecutionReason}`;
                    await this._saveState(state);
                    yield { type: 'status', content: 'Workflow paused due to unresolved compliance gate. Manual intervention required before continuing.' };
                    yield { type: 'text', content: sanitizer.sanitize(`\n\n⚠️ Compliance gate is still failing after retry cap.\nReason: ${haltExecutionReason}`, credentials) };
                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                    return;
                }

                // Step 4: Agent Review/Verification Recovery Loop
                if (task.role.toUpperCase() === 'REVIEWER') {
                    try {
                        const reviewJson = JSON.parse(fullResponse.replace(/```json\n?|\n?```/g, '').trim());
                        const validStatus = reviewJson && (reviewJson.status === 'pass' || reviewJson.status === 'fail');
                        if (!validStatus) {
                            throw new Error('INVALID_REVIEWER_SCHEMA: missing status');
                        }
                        const blockingItems = Array.isArray(reviewJson.blocking_items)
                            ? reviewJson.blocking_items
                            : [];
                        const evidence = Array.isArray(reviewJson.evidence) ? reviewJson.evidence : [];
                        const runtimeChecks = Array.isArray(reviewJson.runtime_checks) ? reviewJson.runtime_checks : [];
                        const artifactPaths = Array.isArray(reviewJson.artifact_paths) ? reviewJson.artifact_paths : [];
                        const previewUrlTested = String(reviewJson.preview_url_tested || "").trim();
                        const lastClaim = state?.runtimeFlags?.lastCoderComplianceClaim;
                        const lastGate = state?.runtimeFlags?.lastCoderGate;
                        const conflictingClaim =
                            !!lastClaim?.claimed &&
                            String(lastGate?.status || '').toLowerCase() === 'fail' &&
                            Array.isArray(lastGate?.findings) &&
                            lastGate.findings.length > 0;
                        if (conflictingClaim) {
                            const findingLines = lastGate.findings
                                .slice(0, 8)
                                .map((f) => `${f.ruleId || 'unknown-rule'}: ${f.message || 'failed'}`);
                            reviewJson.status = 'fail';
                            reviewJson.feedback = `${String(reviewJson.feedback || '')}\nGate conflict: coder claimed compliance but deterministic gate still has findings.`;
                            for (const line of findingLines) {
                                if (!blockingItems.includes(line)) blockingItems.push(line);
                            }
                            if (!evidence.includes('deterministic fast gate reported unresolved findings after coder compliance claim')) {
                                evidence.push('deterministic fast gate reported unresolved findings after coder compliance claim');
                            }
                        }
                        const runtimeBlockers = await this._detectRuntimeBlockerSignatures(workspacePath, artifactPaths);
                        if (runtimeBlockers.length > 0) {
                            for (const b of runtimeBlockers) {
                                const line = `${b.message} Evidence: ${b.artifacts.join(', ')}`;
                                if (!blockingItems.includes(line)) blockingItems.push(line);
                            }
                        }
                        const requiredChecks = ['auth_profile', 'matchmaking'];
                        const checkMap = new Map(
                            runtimeChecks
                                .filter((c) => c && typeof c === 'object')
                                .map((c) => [String(c.name || '').trim().toLowerCase(), String(c.status || '').trim().toLowerCase()])
                        );
                        const missingChecks = requiredChecks.filter((k) => !checkMap.has(k));
                        if (reviewJson.status === 'fail') {
                            if (blockingItems.length === 0) {
                                throw new Error('INVALID_REVIEWER_SCHEMA: blocking_items required when status=fail');
                            }
                            const blockerSignature = runtimeBlockers.map((b) => b.id).sort().join('||');
                            if (blockerSignature) {
                                state.runtimeFlags = state.runtimeFlags || {};
                                state.runtimeFlags.runtimeSignatureTracker = state.runtimeFlags.runtimeSignatureTracker || {};
                                const seen = Number(state.runtimeFlags.runtimeSignatureTracker[blockerSignature] || 0) + 1;
                                state.runtimeFlags.runtimeSignatureTracker[blockerSignature] = seen;
                                if (seen > 3) {
                                    const reason = `RUNTIME_BLOCKED_NONCODE: repeated runtime blocker signature '${blockerSignature}' persisted after ${seen} review cycles.`;
                                    task.status = 'failed';
                                    projectContextSummary += `\n- ${reason}`;
                                    state.projectContextSummary = projectContextSummary;
                                    await this._saveState(state);
                                    yield { type: 'status', content: reason };
                                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                                    return;
                                }
                            }
                            yield { type: 'status', content: `Reviewer found issues. Creating a fix task.` };
                            const feedbackText = String(reviewJson.feedback || "");
                            const shortReason = feedbackText.length > 220 ? `${feedbackText.slice(0, 220)}...` : feedbackText;
                            yield {
                                type: 'status',
                                content: sanitizer.sanitize(
                                    `Reviewer blocked this round. Fix loop required${shortReason ? `: ${shortReason}` : ''}`,
                                    credentials
                                )
                            };
                            yield {
                                type: 'status',
                                content: 'Applying fixes now. This recovery pass may take longer; progress updates will continue.'
                            };
                            const fixTaskId = `fix_${Date.now()}`;
                            const runtimeBlockerLines = runtimeBlockers.map((b) => `- ${b.id}: ${b.message} (artifacts: ${b.artifacts.join(', ')})`);
                            state.tasks.push({
                                id: fixTaskId,
                                role: 'Coder',
                                prompt: `Fix the following blocking issues raised by the Reviewer:\n${blockingItems.join('\n')}\n\n` +
                                    (runtimeBlockerLines.length
                                        ? `Mandatory runtime signature blockers (fix these first):\n${runtimeBlockerLines.join('\n')}\n\n`
                                        : '') +
                                    `Reviewer feedback: ${reviewJson.feedback}\nEvidence:\n${evidence.join('\n')}`,
                                dependsOn: [],
                                status: 'pending'
                            });
                            
                            // Splice the fix task into the dependency chain
                            for (let i = 0; i < state.tasks.length; i++) {
                                let t = state.tasks[i];
                                if (t.status === 'pending' && t.dependsOn && t.dependsOn.includes(task.id)) {
                                    t.dependsOn = t.dependsOn.filter(depId => depId !== task.id);
                                    t.dependsOn.push(fixTaskId);
                                }
                            }

                            projectContextSummary += `\n- Reviewer found issues: ${reviewJson.feedback}. Fix task created.`;
                        } else {
                            if (runtimeBlockers.length > 0) {
                                throw new Error(`INVALID_REVIEWER_SCHEMA: pass status cannot include runtime blocker signatures (${runtimeBlockers.map((b) => b.id).join(', ')})`);
                            }
                            if (missingChecks.length > 0) {
                                throw new Error(`INVALID_REVIEWER_SCHEMA: missing runtime_checks: ${missingChecks.join(', ')}`);
                            }
                            if (requiredChecks.some((k) => checkMap.get(k) !== 'pass')) {
                                throw new Error('INVALID_REVIEWER_SCHEMA: pass status requires auth_profile+matchmaking runtime_checks=pass');
                            }
                            if (evidence.length < 2) {
                                throw new Error('INVALID_REVIEWER_SCHEMA: pass status requires at least 2 evidence entries');
                            }
                            if (artifactPaths.length < 1) {
                                throw new Error('INVALID_REVIEWER_SCHEMA: pass status requires at least 1 artifact path');
                            }
                            if (!previewUrlTested) {
                                throw new Error('INVALID_REVIEWER_SCHEMA: pass status requires preview_url_tested');
                            }
                            projectContextSummary += `\n- Reviewer passed validation.`;
                        }
                    } catch (e) {
                        const reason = String(e?.message || e || 'Reviewer schema parse error');
                        logger.warn(`Reviewer output schema error: ${reason}`);
                        const existingRetry = state.tasks.find((t) =>
                            t.status === 'pending' &&
                            t.role === 'Reviewer' &&
                            String(t.prompt || '').includes('REVIEWER_SCHEMA_RETRY')
                        );
                        if (!existingRetry) {
                            const retryId = `reviewer_retry_${Date.now()}`;
                            state.tasks.push({
                                id: retryId,
                                role: 'Reviewer',
                                prompt: `REVIEWER_SCHEMA_RETRY: Re-run the review and output STRICT JSON with status, feedback, severity, blocking_items, evidence, runtime_checks, artifact_paths, and preview_url_tested. runtime_checks MUST include auth_profile and matchmaking.`,
                                dependsOn: [],
                                status: 'pending'
                            });
                        }
                        projectContextSummary += `\n- Reviewer schema error: ${reason}. Reviewer retry scheduled.`;
                    }
                } else if (task.role.toUpperCase() === 'VERIFIER') {
                    if (state?.runtimeFlags?.authInvalid) {
                        task.status = 'blocked';
                        const reason = 'Verifier skipped: blocked by prior authentication failure.';
                        this._appendRunEvent(state, {
                            type: 'task_blocked',
                            taskId: task.id,
                            role: task.role,
                            durationMs: Date.now() - taskStartedAt,
                            reason
                        });
                        projectContextSummary += `\n- ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: reason };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                    try {
                        const verifierJson = JSON.parse(fullResponse.replace(/```json\n?|\n?```/g, '').trim());
                        if (verifierJson.status === 'fail') {
                            yield { type: 'status', content: `Verifier BLOCKED the release. Creating a priority fix task.` };
                            const reasonsArr = Array.isArray(verifierJson.reasons)
                                ? verifierJson.reasons
                                : [String(verifierJson.reasons || 'Unknown verifier reason')];
                            const reasonsText = reasonsArr.join(', ');
                            const shortReasons = reasonsText.length > 240 ? `${reasonsText.slice(0, 240)}...` : reasonsText;
                            yield {
                                type: 'status',
                                content: sanitizer.sanitize(
                                    `Compliance gate failed${shortReasons ? `: ${shortReasons}` : ''}`,
                                    credentials
                                )
                            };
                            yield {
                                type: 'status',
                                content: 'Running priority compliance fix loop now. This can take longer than a normal pass.'
                            };
                            const fixTaskId = `v_fix_${Date.now()}`;
                            state.tasks.push({
                                id: fixTaskId,
                                role: 'Coder',
                                prompt: `CRITICAL COMPLIANCE FIX: The Verifier blocked the release for the following reasons: ${reasonsText}. Fix these issues immediately according to CONTRACT.json.`,
                                dependsOn: [],
                                status: 'pending'
                            });
                            
                            // Re-insert into the chain
                            for (let i = 0; i < state.tasks.length; i++) {
                                let t = state.tasks[i];
                                if (t.status === 'pending' && t.dependsOn && t.dependsOn.includes(task.id)) {
                                    t.dependsOn = t.dependsOn.filter(depId => depId !== task.id);
                                    t.dependsOn.push(fixTaskId);
                                }
                            }
                            projectContextSummary += `\n- !!! VERIFIER BLOCKED RELEASE !!! Reasons: ${reasonsText}. Priority fix task created.`;
                        } else {
                            projectContextSummary += `\n- Verifier passed all compliance gates.`;
                        }
                    } catch (e) {
                        logger.warn("Could not parse Verifier output as JSON.");
                    }
                } else {
                    projectContextSummary += `\n- ${task.role} completed: ${task.prompt.substring(0, 100)}...`;

                    // App ID authority extraction (strict 10-char IDs only).
                    const extractedId = this._extractCanonicalAppId(fullResponse) || this._extractCanonicalAppId(task.prompt);
                    if (extractedId) {
                        logger.info(`Orchestrator: Extracted App ID from agent response: ${extractedId}`);
                        this._setAppIdAuthority(state, extractedId, `task:${task.id}`);
                        projectContextSummary += `\n- IMPORTANT: The VIVERSE App ID for this project is: ${extractedId}`;
                    }

                    // Leaderboard API Name Extraction
                    const expectedLbFromTask =
                        String(task.prompt || '').match(/api\s+name\s+['"]([a-z0-9-]{3,30})['"]/i)?.[1] || '';
                    const extractedLb =
                        fullResponse.match(/(?:Leaderboard API Name|leaderboard-name|VITE_VIVERSE_LEADERBOARD_NAME)[^\w]*([a-z0-9-]{3,30})\b/i)?.[1] || '';
                    const chosenLb = expectedLbFromTask || extractedLb;
                    if (chosenLb) {
                        if (expectedLbFromTask && extractedLb && expectedLbFromTask !== extractedLb) {
                            logger.warn(
                                `Orchestrator: Leaderboard name mismatch (task=${expectedLbFromTask}, response=${extractedLb}). Using task authority.`
                            );
                            projectContextSummary += `\n- NOTE: Leaderboard API name mismatch detected (response=${extractedLb}, expected=${expectedLbFromTask}). Using expected value.`;
                        } else {
                            logger.info(`Orchestrator: Extracted Leaderboard Name from agent response/task: ${chosenLb}`);
                        }
                        projectContextSummary += `\n- IMPORTANT: The Leaderboard API Name for this project is: ${chosenLb}`;
                    }

                    // Preview URL Extraction (supports worlds.viverse.com links)
                    const extractedUrl = this._extractPreviewUrl(fullResponse) || this._extractPreviewUrl(projectContextSummary);
                    if (extractedUrl) {
                        logger.info(`Orchestrator: Extracted Preview URL from agent response/context: ${extractedUrl}`);
                        projectContextSummary += `\n- IMPORTANT: The VIVERSE Preview URL for this project is: ${extractedUrl}`;

                        // Auto-test hook: run deterministic preview probe after publish-like operations.
                        const promptText = String(task.prompt || "");
                        const hasPublishCommandEvidence = /viverse-cli\s+app\s+publish/i.test(`${fullResponse}\n${promptText}`);
                        const shouldProbe =
                            this._isPublishTask(task) ||
                            hasPublishCommandEvidence;
                        if (shouldProbe) {
                            yield { type: 'status', content: 'Running preview auto-test probe on worlds.viverse.com...' };
                            try {
                                const appIdHints = this._extractAppIdCandidates(`${projectContextSummary}\n${fullResponse}`);
                                const probe = await previewAutoTestService.runPreviewProbe({
                                    workspacePath,
                                    previewUrl: extractedUrl,
                                    appId: appIdHints[0] || '',
                                    credentials
                                });
                                const artifacts = Array.isArray(probe.artifact_paths) ? probe.artifact_paths : [];
                                const checks = Array.isArray(probe.runtime_checks) ? probe.runtime_checks : [];
                                const checkSummary = checks.map((c) => `${c.name}:${c.status}`).join(', ');
                                projectContextSummary += `\n- AUTO_TEST preview probe: ${probe.status}. checks=[${checkSummary}]`;
                                if (artifacts.length) {
                                    projectContextSummary += `\n- AUTO_TEST artifacts:\n${artifacts.map((p) => `  - ${p}`).join('\n')}`;
                                }
                                this._appendRunEvent(state, {
                                    type: 'preview_probe',
                                    taskId: task.id,
                                    role: task.role,
                                    status: probe.status,
                                    previewUrl: probe.preview_url_tested || extractedUrl,
                                    artifacts
                                });
                                yield {
                                    type: 'status',
                                    content: sanitizer.sanitize(
                                        `Preview probe ${probe.status}. Artifacts: ${artifacts.length}`,
                                        credentials
                                    )
                                };

                                if (String(probe.status || '').toLowerCase() === 'fail') {
                                    const autoFix = this._scheduleAutoTestFixTask({
                                        state,
                                        task,
                                        probe,
                                        projectContextSummary
                                    });
                                    if (autoFix.scheduled) {
                                        projectContextSummary += `\n- AUTO_TEST runtime failures triggered fix task ${autoFix.fixTaskId} (signature: ${autoFix.signature}).`;
                                        yield {
                                            type: 'status',
                                            content: sanitizer.sanitize(
                                                `Auto-test found runtime failures. Scheduled self-fix task ${autoFix.fixTaskId}.`,
                                                credentials
                                            )
                                        };
                                    } else if (String(autoFix.reason || '').startsWith('retry_cap_reached:')) {
                                        const haltReason = `Auto-test failures unresolved after retry cap for signature ${autoFix.signature}.`;
                                        projectContextSummary += `\n- ${haltReason}`;
                                        haltExecutionReason = haltReason;
                                    }
                                }
                            } catch (probeErr) {
                                const reason = String(probeErr?.message || probeErr || 'unknown preview probe error');
                                logger.warn(`Orchestrator: preview auto-test probe failed: ${reason}`);
                                projectContextSummary += `\n- AUTO_TEST preview probe error: ${reason}`;
                                this._appendRunEvent(state, {
                                    type: 'preview_probe_error',
                                    taskId: task.id,
                                    role: task.role,
                                    reason
                                });
                                yield { type: 'status', content: `Preview probe error: ${reason}` };
                            }
                        }
                    }
                }

                task.status = 'completed';
                this._appendRunEvent(state, {
                    type: 'task_completed',
                    taskId: task.id,
                    role: task.role,
                    durationMs: Date.now() - taskStartedAt
                });
                state.projectContextSummary = projectContextSummary;
                
                // APPEND ACTUAL RESULT TO CONTEXT
                const truncatedResult = fullResponse.length > 500 ? fullResponse.substring(0, 500) + "..." : fullResponse;
                projectContextSummary += `\n- [${task.role} RESULT]: ${truncatedResult}`;
                state.projectContextSummary = projectContextSummary;
                
                yield { type: 'status', content: `Task ${task.id} completed.` };
                yield { type: 'text', content: `\n\n✅ **${task.role}** has completed the task.` };
                await this._saveState(state);
            }
        }

        const runEvents = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        const recoveredFailedTaskIds = new Set(
            runEvents
                .filter((e) => e && e.type === 'task_failed_recovered' && e.taskId)
                .map((e) => String(e.taskId))
        );
        const hasPendingTasks = state.tasks.some((t) => t.status === 'pending');
        const hasBlockingTaskStates = state.tasks.some((t) => {
            const id = String(t?.id || '');
            if (t.status === 'blocked') return true;
            if (t.status === 'failed' && !recoveredFailedTaskIds.has(id)) return true;
            return false;
        });
        const workflowTasksSettled = !hasPendingTasks && !hasBlockingTaskStates;

        if (workflowTasksSettled) {
            if (this._hasBlockingPreviewProbeFailure(state)) {
                projectContextSummary += `\n- WORKFLOW HALTED: Preview probe failed in this run; completion is blocked until runtime checks pass.`;
                state.projectContextSummary = projectContextSummary;
                yield {
                    type: 'status',
                    content: 'Workflow paused: preview probe failed. Completion is blocked until runtime checks pass.'
                };
                yield {
                    type: 'text',
                    content: this._buildOutcomeNotice(state, {
                        completed: false,
                        reason: 'Preview runtime checks failed'
                    })
                };
                await this._finalizeWorkflowState(state, 'paused_or_failed');
                return;
            }
            if (this._requiresPreviewProbeEvidence(state) && !this._hasAnyPreviewProbeEvent(state)) {
                projectContextSummary += `\n- WORKFLOW HALTED: Runtime/browser verification was requested but no preview probe evidence was recorded in this run.`;
                state.projectContextSummary = projectContextSummary;
                yield {
                    type: 'status',
                    content: 'Workflow paused: preview probe evidence missing for a runtime-verification run.'
                };
                yield {
                    type: 'text',
                    content: this._buildOutcomeNotice(state, {
                        completed: false,
                        reason: 'Runtime/browser evidence missing'
                    })
                };
                await this._finalizeWorkflowState(state, 'paused_or_failed');
                return;
            }

            if (state.runReport && !state.runReport.endedAt) {
                state.runReport.endedAt = new Date().toISOString();
                state.runReport.outcome = 'completed';
            }
            yield { type: 'status', content: 'All tasks processed. Initiating Knowledge Evolution Loop...' };
            
            const evolutionPrompt = `PROJECT SUCCESSFUL.
            1. Use 'readFile' to inspect '${path.join(state.workspacePath, '.viverse_lessons.json')}'.
            2. If there are valuable technical lessons, promote them to 'skills/viverse-resilience-guide.md' or create a new skill in the 'skills/' folder.
            3. Then, provide a final wrap-up message to the user including the Live URL and a summary of the 'New Knowledge' acquired.
            
            Project Context:
            ${projectContextSummary}`;

            // Summarizer doesn't need full history as projectContextSummary carries the state.
            const summarizedHistory = history.length > 2 ? history.slice(-2) : history;
            const finalResponse = await geminiService.generateResponse(evolutionPrompt, summarizedHistory, "SUMMARIZER");
            yield { type: 'text', content: sanitizer.sanitize(`\n\n${finalResponse}`, credentials) };
            yield { type: 'text', content: sanitizer.sanitize(`\n\n${this._buildOutcomeNotice(state, { completed: true })}`, credentials) };
            yield { type: 'text', content: "\n\n**Project workflow completed.** State saved to `.agent_state.json`." };
            await this._finalizeWorkflowState(state, 'completed');
        } else {
            if (state.runReport && !state.runReport.endedAt) {
                state.runReport.endedAt = new Date().toISOString();
                state.runReport.outcome = 'paused_or_failed';
            }
            yield { type: 'status', content: 'Workflow paused or interrupted.' };
            yield {
                type: 'text',
                content: this._buildOutcomeNotice(state, {
                    completed: false,
                    reason: 'Pending/blocked tasks remain'
                })
            };
            await this._finalizeWorkflowState(state, 'paused_or_failed');
        }
    }

    async _saveState(state) {
        try {
            const redactString = (text = "") =>
                String(text)
                    .replace(/USER VIVERSE CREDENTIALS[\s\S]*?(?=\n[A-Z_-]+:|\n- |\n\n|$)/gi, '[REDACTED_CREDENTIAL_BLOCK]\n')
                    .replace(/Password:\s*.+/gi, 'Password: [REDACTED]')
                    .replace(/password["']?\s*:\s*["'][^"']+["']/gi, 'password: "[REDACTED]"')
                    .replace(/-p\s+\S+/gi, '-p [REDACTED]');

            const deepRedact = (value) => {
                if (typeof value === 'string') return redactString(value);
                if (Array.isArray(value)) return value.map((item) => deepRedact(item));
                if (value && typeof value === 'object') {
                    const out = {};
                    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v);
                    return out;
                }
                return value;
            };

            const clone = JSON.parse(JSON.stringify(state || {}));
            const redacted = deepRedact(clone);
            if (redacted?.complianceFastCache?.fileIndex) {
                delete redacted.complianceFastCache.fileIndex;
            }
            await fileService.writeFile(`${state.workspacePath}/.agent_state.json`, JSON.stringify(redacted, null, 2));
            if (redacted?.runReport) {
                await fileService.writeFile(`${state.workspacePath}/run_report.json`, JSON.stringify(redacted.runReport, null, 2));
            }
        } catch (e) {
            logger.error(`Failed to save agent state: ${e.message}`);
        }
    }
}

export default new OrchestratorService();
