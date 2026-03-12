import geminiService from './GeminiService.js';
import fileService from './FileService.js';
import logger from '../utils/logger.js';

class OrchestratorService {
    constructor() {
        this.activeProjects = new Map();
    }

    async *processRequest(message, history = []) {
        logger.info(`Orchestrator: Processing request: ${message}`);
        
        // Step 1: Planning
        yield { type: 'status', content: 'Orchestrator is analyzing your request and planning tasks...' };
        
        const planPrompt = `User Request: "${message}"
        
        Decide if this is:
        A. A simple search/question (Simple Task)
        B. A request to build/modify a web application (Project Task)
        
        If it's a Project Task, generate a JSON plan with tasks. If it's a Simple Task, respond directly.
        Return your plan strictly in the JSON format defined in your instructions.`;

        const orchestratorResponse = await geminiService.generateResponse(planPrompt, history, "ORCHESTRATOR");
        
        let plan;
        try {
            // Parse JSON explicitly
            plan = JSON.parse(orchestratorResponse.replace(/```json\n?|\n?```/g, '').trim());
        } catch (e) {
            logger.warn("Orchestrator: Could not parse plan as JSON, treating as simple response.");
        }

        if (!plan || !plan.tasks) {
            // Treat as simple response
            yield { type: 'text', content: orchestratorResponse };
            return;
        }

        // Step 2: Execution Initialization
        yield { type: 'status', content: `Project Task identified. Plan: ${plan.tasks.length} tasks generated.` };
        
        let state = {
            request: message,
            tasks: plan.tasks.map(t => ({ ...t, status: 'pending' })),
            history: []
        };
        await this._saveState(state);

        let projectContextSummary = "Project Initialization started.";

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
                    return dep && dep.status === 'completed';
                });
            });

            if (readyTasks.length === 0) {
                yield { type: 'status', content: 'Execution paused: Cannot proceed due to missing dependencies or previous failures.' };
                break;
            }

            // NOTE: For streaming feedback to the UI, we await sequentially. 
            // The dependency graph allows true concurrency (Promise.all) if stream merging is implemented in the UI layer.
            for (const task of readyTasks) {
                yield { type: 'status', content: `Agent [${task.role}] is working on: ${task.prompt.substring(0, 50)}...` };
                logger.info(`Orchestrator: Dispatching task ${task.id} to ${task.role}`);

                // Context is kept brief to avoid token limits. Agents must rely on file reading.
                const agentPrompt = `Project Summary Context:\n${projectContextSummary}\n\nYour Task: ${task.prompt}`;
                
                const agentStream = geminiService.generateResponseStream(agentPrompt, [], task.role.toUpperCase());
                
                let fullResponse = "";
                for await (const chunk of agentStream) {
                    if (chunk.type === 'text') {
                        fullResponse += chunk.content;
                        yield { type: 'text', content: chunk.content };
                    } else if (chunk.type === 'status') {
                        yield chunk;
                    }
                }

                // Step 4: Reviewer Error Recovery Loop
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
                            projectContextSummary += `\n- Reviewer found issues: ${reviewJson.feedback}. Fix task created.`;
                        } else {
                            projectContextSummary += `\n- Reviewer passed validation.`;
                        }
                    } catch (e) {
                        logger.warn("Could not parse Reviewer output as JSON.");
                        projectContextSummary += `\n- Reviewer completed validation.`;
                    }
                } else {
                    projectContextSummary += `\n- ${task.role} completed: ${task.prompt.substring(0, 100)}...`;
                }

                task.status = 'completed';
                yield { type: 'status', content: `Task ${task.id} completed.` };
                await this._saveState(state);
            }
        }

        yield { type: 'status', content: 'All tasks processed. Finalizing result...' };
        yield { type: 'text', content: "\n\n**Project workflow completed.** State saved to `.agent_state.json`." };
    }

    async _saveState(state) {
        try {
            await fileService.writeFile('.agent_state.json', JSON.stringify(state, null, 2));
        } catch (e) {
            logger.error(`Failed to save agent state: ${e.message}`);
        }
    }
}

export default new OrchestratorService();
