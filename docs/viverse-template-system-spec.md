# VIVERSE Agent Template System

Standalone System Architecture Spec (Integrated with Existing VIVERSE AI Agent Server)

## 1. Purpose and Scope

This spec defines a Template System for VIVERSE AI Agent as a feature module, not a separate product.
It must integrate with the current server stack (`aiController` -> `OrchestratorService` -> role agents/tools) and enforce deterministic generation/edit boundaries for game projects.

### In scope
- Template registry and loader
- Template contracts (`TEMPLATE.md` + machine schema)
- Template-aware orchestration and coder guardrails
- Variant/ruleset customization within safe boundaries
- Certification gates (static/build/runtime)
- First template: `battletanks-v1` (from `EGalahad/BattleTanks`)

### Out of scope
- Full redesign of existing chat API protocol
- Replacing current multi-agent orchestration model
- Standalone microservice split (this remains in current Node server)

## 2. Current System Integration Points

### Existing components (must remain)
- `src/controllers/aiController.js`
- `src/services/OrchestratorService.js`
- `src/services/GeminiService.js`
- `src/services/FileService.js`
- `src/services/ComplianceService.js`
- `src/services/PreviewAutoTestService.js`
- `src/services/AgentRegistry.js`

### New feature integration
- Template routing and enforcement hooks live in `OrchestratorService`
- Template validation extends `ComplianceService`
- Runtime evidence remains in `PreviewAutoTestService` + run report events
- No breaking API changes to `/api/ai/chat`

## 3. High-Level Architecture

### 3.1 Modules

#### Template Registry Service
- Discovers available templates
- Exposes metadata for planner/orchestrator selection

#### Template Contract Service
- Parses `template.json` and `TEMPLATE.md`
- Produces normalized contract:
- immutable paths
- allowed edit paths
- injection hooks
- required gates
- customizable parameters/rulesets

#### Template Enforcement Layer
- Integrated into orchestration and file-write execution
- Rejects writes outside contract
- Rejects run completion when contract-required evidence is missing

#### Template Certification Pipeline
- Static, build, and runtime checks
- Generates pass/fail report for enabling template

## 4. Directory and Artifact Specification

```text
viverse_ai_agent/
├── templates/
│   ├── registry.json
│   └── battletanks-v1/
│       ├── TEMPLATE.md
│       ├── template.json
│       ├── rulesets/
│       │   ├── default.json
│       │   └── fast-rounds.json
│       ├── scenario.schema.json
│       ├── assets/
│       ├── core-engine/
│       ├── gameplay/
│       ├── adapters/
│       │   ├── auth/
│       │   ├── multiplayer/
│       │   └── leaderboard/
│       ├── bootstrap/
│       └── tests/
│           ├── static-gates/
│           └── runtime-gates/
└── src/services/templates/
    ├── TemplateRegistryService.js
    ├── TemplateContractService.js
    ├── TemplateEnforcementService.js
    └── TemplateCertificationService.js
```

## 5. Contract Model (`template.json`)

### 5.1 Required fields
- `id`, `version`, `upstream`
- `capabilities` (auth, multiplayer, leaderboard, r3f, etc.)
- `immutablePaths[]`
- `editablePaths[]`
- `injectionHooks[]`
- `requiredGates[]`
- `rulesetSchemaRef`
- `scenarioSchemaRef`

### 5.2 Injection hook definition
Each hook includes:
- `hookId`
- `file`
- `functionOrRegion`
- `purpose`
- `required` (bool)

## 6. Orchestrator Behavior Changes

### 6.1 Planning phase
If task is game generation/update and template is selected:
- Planner receives template metadata
- Task prompts must reference template hooks and editable surface

### 6.2 Execution phase
Before any write:
- enforce `editablePaths`
- If write touches immutable path:
- block task and emit explicit violation event

### 6.3 Completion phase
`completed` allowed only when:
- all tasks complete
- required template gates pass
- runtime evidence requirements met (if requested)
- no blocking `preview_probe` failure/error

## 7. aiController Behavior Requirements
- App-list shortcut must not hijack execution intents (`resume/fix/debug/req_*`)
- Template runs remain on orchestrator path
- No endpoint change required

## 8. Ruleset and Scenario Customization

### 8.1 Ruleset
Ruleset files define gameplay variance only:
- scoring logic
- win condition
- respawn policy
- powerup behavior
- round timing

### 8.2 Scenario
Per-run `scenario.json` selects:
- template id
- ruleset id
- mode params
- leaderboard metric
- optional UI labels/theme tokens

### 8.3 Compatibility checking
- Validate scenario against template schema
- Reject invalid combos before code generation

## 9. BattleTanks v1 Template Mapping

### Source repo
`EGalahad/BattleTanks` (three.js, TypeScript, Vite)

### Proposed split
#### Immutable:
- asset bundles
- rendering/camera/scene/loop primitives
- low-level collision utilities

#### Editable:
- world gameplay orchestration
- tank/bullet/powerup behavior
- VIVERSE adapters
- startup wrapper

### Mandatory hooks
- `GameManager.start()` auth-gated bootstrap
- `IPlayerInput` abstraction point
- `SyncManager.tick()` called from loop

## 10. Validation and Certification Gates

### 10.1 Static gates
- immutable path write violations
- required hooks present
- no placeholder app IDs in source
- no direct SDK usage outside adapters

### 10.2 Build/publish gates
- app id propagation source+dist
- SDK URL/auth domain checks

### 10.3 Runtime gates
- preview probe event present (when runtime verification requested)
- `auth_profile` and `matchmaking` checks pass
- no critical console signatures (e.g. invalid listener API usage)

## 11. Data and State Model Extensions

### In `.agent_state.json`
Add `templateContext`:
- `templateId`
- `templateVersion`
- `rulesetId`
- `scenarioHash`
- `contractViolations[]`
- `requiredEvidence[]`

### In `run_report.json` events
Add event types:
- `template_selected`
- `template_contract_violation`
- `template_gate_result`

## 12. Rollout Plan
- Phase 1: Core services + registry + contract parser
- Phase 2: Orchestrator enforcement + completion semantics
- Phase 3: BattleTanks template conversion and baseline certification
- Phase 4: Ruleset/scenario customization and compatibility validator
- Phase 5: Template onboarding toolkit for additional games

## 13. Non-Functional Requirements
- Deterministic behavior for template runs
- Backward-compatible with non-template flows
- Clear failure reasons and artifact evidence
- Minimal overhead in normal chat latency

## 14. Risks and Mitigations

### Over-constraining edits
Mitigation: explicit customization surface and controlled override flow

### False `completed`
Mitigation: strict evidence-based completion gate

### Template drift from upstream
Mitigation: store upstream commit hash and re-certification command

### Prompt-level inconsistency
Mitigation: task-authoritative metadata (e.g., leaderboard API name)

## 15. Acceptance Criteria
- Template run cannot modify immutable paths.
- BattleTanks template can produce publishable VIVERSE build with auth+multiplayer integration.
- Runtime verification requests cannot finish without probe evidence.
- Existing chat/orchestrator API remains functional for non-template requests.
