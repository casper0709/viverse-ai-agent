import geminiService from './GeminiService.js';
import fileService from './FileService.js';
import logger from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import sanitizer from '../utils/sanitizer.js';

class OrchestratorService {
    constructor() {
        this.activeProjects = new Map();
    }

    async *processRequest(message, history = [], credentials = null) {
        logger.info(`Orchestrator: Processing request: ${message}`);
        
        const workSpaceDir = path.resolve(process.cwd(), '.viverse_workspaces');
        const lowerMsg = message.toLowerCase().trim();
        const isResumeCommand = ["proceed", "continue", "go on", "ok", "yes", "next"].includes(lowerMsg);
        
        let workspacePath;
        let state;
        let plan;

        // PRE-SCAN: Always check for recent workspace if it's not a resume command,
        // we might still want to resume if the intent classifier says isNewProject: false
        try {
            const files = await fs.readdir(workSpaceDir, { withFileTypes: true });
            const dirs = files.filter(f => f.isDirectory() && f.name.startsWith('req_'))
                              .map(f => f.name)
                              .sort((a, b) => b.localeCompare(a));
            
            if (dirs.length > 0) {
                const latestDir = path.join(workSpaceDir, dirs[0]);
                try {
                    const stateContent = await fs.readFile(path.join(latestDir, '.agent_state.json'), 'utf8');
                    const latestState = JSON.parse(stateContent);
                    
                    if (isResumeCommand) {
                        workspacePath = latestDir;
                        state = latestState;
                        yield { type: 'status', content: sanitizer.sanitize(`Resuming work in existing sandbox: ${workspacePath}`, credentials) };
                        yield { type: 'status', content: sanitizer.sanitize(`Current Task: ${state.tasks.find(t => t.status === 'pending')?.prompt.substring(0, 50) || "none"}...`, credentials) };
                    }
                } catch (e) {
                    logger.debug("No valid state found in latest workspace.");
                }
            }
        } catch (e) {
            logger.debug("No workspaces found.");
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

            const orchestratorResponse = await geminiService.generateResponse(planPrompt, history, "ORCHESTRATOR");
            
            try {
                plan = JSON.parse(orchestratorResponse.replace(/```json\n?|\n?```/g, '').trim());
                logger.info(`Orchestrator: Plan generated. isNewProject: ${plan.isNewProject}`);
                
                if (plan.error === "CREDENTIALS_REQUIRED") {
                    yield { type: 'action', action: 'require_credentials' };
                    yield { type: 'text', content: plan.message };
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
                    const files = await fs.readdir(workSpaceDir, { withFileTypes: true });
                    const dirs = files.filter(f => f.isDirectory() && f.name.startsWith('req_'))
                                      .map(f => f.name)
                                      .sort((a, b) => b.localeCompare(a));
                    if (dirs.length > 0) {
                        workspacePath = path.join(workSpaceDir, dirs[0]);
                        const stateContent = await fs.readFile(path.join(workspacePath, '.agent_state.json'), 'utf8');
                        const oldState = JSON.parse(stateContent);
                        
                        // RESTORE but UPDATE: Keep the workspace and context, but use the NEW tasks
                        state = {
                            ...oldState,
                            request: message,
                            tasks: plan.tasks.map(t => ({ ...t, status: 'pending' })),
                        };
                        
                        // Append the new request to the summary context so agents know what changed
                        state.projectContextSummary += `\n\nFOLLOW-UP REQUEST: "${message}"\nNew tasks scheduled for improvement...`;
                        
                        yield { type: 'status', content: sanitizer.sanitize(`Resuming work for iterative improvement in: ${workspacePath}`, credentials) };
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
                    tasks: plan.tasks.map(t => ({ ...t, status: 'pending' })),
                    history: [],
                    projectContextSummary: `ORIGINAL USER PROJECT REQUEST: "${message}"\n\nProject Initialization started.`
                };
            }
        }

        // Programmatic UI Trigger Enforcement
        if (!credentials) {
            yield { type: 'action', action: 'require_credentials' };
            yield { type: 'text', content: 'I need your VIVERSE Account credentials to build and publish this app for you. Please fill out the VIVERSE Account panel on the left to proceed!' };
            return;
        }

        let projectContextSummary = state.projectContextSummary || "";
        if (credentials && !projectContextSummary.includes(credentials.email)) {
            projectContextSummary += `\nUSER VIVERSE CREDENTIALS FOR PUBLISHING:\nEmail: ${credentials.email}\nPassword: ${credentials.password}`;
        }
        state.projectContextSummary = projectContextSummary;
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
                logger.warn(`Orchestrator: Deadlock or finished. Remaining pending tasks: ${pendingTasks.map(t => t.id).join(', ')}`);
                yield { type: 'status', content: 'Execution paused: Cannot proceed due to missing dependencies or previous failures.' };
                break;
            }

            // NOTE: For streaming feedback to the UI, we await sequentially. 
            // The dependency graph allows true concurrency (Promise.all) if stream merging is implemented in the UI layer.
            for (const task of readyTasks) {
                yield { type: 'status', content: sanitizer.sanitize(`Agent [${task.role}] is working on: ${task.prompt.substring(0, 50)}...`, credentials) };
                yield { type: 'text', content: sanitizer.sanitize(`\n\n> **Agent [${task.role}]** is starting task: *${task.prompt}*`, credentials) };
                logger.info(`Orchestrator: Dispatching task ${task.id} to ${task.role}`);

                // Context is kept brief to avoid token limits. Agents must rely on file reading.
                const agentPrompt = `Project Summary Context:\n${projectContextSummary}\n\nYour Sandboxed Workspace: ${workspacePath}\n\nYour Task: ${task.prompt}`;
                
                const agentStream = geminiService.generateResponseStream(agentPrompt, [], task.role.toUpperCase(), workspacePath);
                
                let fullResponse = "";
                for await (const chunk of agentStream) {
                    if (chunk.type === 'text') {
                        fullResponse += chunk.content;
                        // Avoid leaking technical JSON from Reviewer/Orchestrator-Planner to the user
                        if (!fullResponse.trim().startsWith('{')) {
                            yield { type: 'text', content: sanitizer.sanitize(chunk.content, credentials) };
                        }
                    } else if (chunk.type === 'status') {
                        yield { ...chunk, content: sanitizer.sanitize(chunk.content, credentials) };
                    }
                }
                
                logger.info(`Orchestrator: Agent [${task.role}] stream finished. Response length: ${fullResponse.length}`);

                // Step 4: Agent Review/Verification Recovery Loop
                if (task.role.toUpperCase() === 'REVIEWER') {
                    try {
                        const reviewJson = JSON.parse(fullResponse.replace(/```json\n?|\n?```/g, '').trim());
                        if (reviewJson.status === 'fail') {
                            yield { type: 'status', content: `Reviewer found issues. Creating a fix task.` };
                            const fixTaskId = `fix_${Date.now()}`;
                            state.tasks.push({
                                id: fixTaskId,
                                role: 'Coder',
                                prompt: `Fix the following issues raised by the Reviewer: ${reviewJson.feedback}`,
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
                            projectContextSummary += `\n- Reviewer passed validation.`;
                        }
                    } catch (e) {
                        logger.warn("Could not parse Reviewer output as JSON.");
                        projectContextSummary += `\n- Reviewer completed validation.`;
                    }
                } else if (task.role.toUpperCase() === 'VERIFIER') {
                    try {
                        const verifierJson = JSON.parse(fullResponse.replace(/```json\n?|\n?```/g, '').trim());
                        if (verifierJson.status === 'fail') {
                            yield { type: 'status', content: `Verifier BLOCKED the release. Creating a priority fix task.` };
                            const fixTaskId = `v_fix_${Date.now()}`;
                            state.tasks.push({
                                id: fixTaskId,
                                role: 'Coder',
                                prompt: `CRITICAL COMPLIANCE FIX: The Verifier blocked the release for the following reasons: ${verifierJson.reasons.join(', ')}. Fix these issues immediately according to CONTRACT.json.`,
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
                            projectContextSummary += `\n- !!! VERIFIER BLOCKED RELEASE !!! Reasons: ${verifierJson.reasons.join(', ')}. Priority fix task created.`;
                        } else {
                            projectContextSummary += `\n- Verifier passed all compliance gates.`;
                        }
                    } catch (e) {
                        logger.warn("Could not parse Verifier output as JSON.");
                    }
                } else {
                    projectContextSummary += `\n- ${task.role} completed: ${task.prompt.substring(0, 100)}...`;

                    // App ID Extraction Fix
                    const appIdMatch = fullResponse.match(/(?:App ID|app-id|VITE_VIVERSE_CLIENT_ID)[^\w]*([a-z0-9]{8,15})\b/i);
                    if (appIdMatch && appIdMatch[1]) {
                        const extractedId = appIdMatch[1];
                        logger.info(`Orchestrator: Extracted App ID from agent response: ${extractedId}`);
                        projectContextSummary += `\n- IMPORTANT: The VIVERSE App ID for this project is: ${extractedId}`;
                    }

                    // Leaderboard API Name Extraction
                    const lbMatch = fullResponse.match(/(?:Leaderboard API Name|leaderboard-name|VITE_VIVERSE_LEADERBOARD_NAME)[^\w]*([a-z0-9-]{3,30})\b/i);
                    if (lbMatch && lbMatch[1]) {
                        const extractedLb = lbMatch[1];
                        logger.info(`Orchestrator: Extracted Leaderboard Name from agent response: ${extractedLb}`);
                        projectContextSummary += `\n- IMPORTANT: The Leaderboard API Name for this project is: ${extractedLb}`;
                    }

                    // Preview URL Extraction
                    const previewMatch = fullResponse.match(/https:\/\/world\.viverse\.com\/preview\/[a-z0-9-]+\b/i);
                    if (previewMatch) {
                        const extractedUrl = previewMatch[0];
                        logger.info(`Orchestrator: Extracted Preview URL from agent response: ${extractedUrl}`);
                        projectContextSummary += `\n- IMPORTANT: The VIVERSE Preview URL for this project is: ${extractedUrl}`;
                    }
                }

                task.status = 'completed';
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

        if (state.tasks.every(t => t.status === 'completed')) {
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
            yield { type: 'text', content: "\n\n**Project workflow completed.** State saved to `.agent_state.json`." };
        } else {
            yield { type: 'status', content: 'Workflow paused or interrupted.' };
        }
    }

    async _saveState(state) {
        try {
            await fileService.writeFile(`${state.workspacePath}/.agent_state.json`, JSON.stringify(state, null, 2));
        } catch (e) {
            logger.error(`Failed to save agent state: ${e.message}`);
        }
    }
}

export default new OrchestratorService();
