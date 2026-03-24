# fn-1-pi-fleet-multi-agent-terminal.2 Agent templates and interactive setup

## Description
Create the 6 pre-built agent templates and the interactive setup wizard that bootstraps config files when none exist.

**Size:** M
**Files:** templates/agents/architect.md, templates/agents/developer.md, templates/agents/reviewer.md, templates/agents/researcher.md, templates/agents/qa.md, templates/agents/devops.md, templates/teams.yaml, templates/agent-chain.yaml, src/setup/wizard.ts, src/setup/scaffolder.ts, test/setup/wizard.test.ts, test/setup/scaffolder.test.ts
## Approach

- Each agent template: markdown file with YAML front matter (name, model, expertise, skills, thinking) and a system prompt body defining the agent's role, focus areas, and output expectations
- Default models: Architect → opus, Developer → sonnet, Reviewer → opus, Researcher → sonnet, QA → sonnet, DevOps → haiku
- Template teams.yaml: references all 6 agents, sets sensible defaults for constraints using snake_case YAML keys matching task 1's canonical schema (max_usd: 10, max_minutes: 30, task_timeout_ms: 120000, max_concurrency: 4). All YAML templates must use snake_case — camelCase only exists in TypeScript types after Zod transform.
- Template agent-chain.yaml: simple example pipeline (Researcher → Architect → Developer → Reviewer)
<!-- Updated by plan-sync: fn-1-pi-fleet-multi-agent-terminal.1 uses preflightBootstrap({ pi }) not preflight({ mode: "bootstrap" }) -->
- Setup wizard: triggered when /fleet detects no .pi/teams.yaml. Calls `preflightBootstrap({ pi })` (from `src/preflight.ts`) — validates git repo and shallow clone but allows missing config files (the wizard creates them). Uses ctx.ui.select/confirm/input to walk user through team creation
- Scaffolder: copies templates to .pi/teams.yaml and .pi/agents/, creating directories as needed
- Handle partial state: if .pi/agents/ exists but teams.yaml doesn't (or vice versa), detect and fix

## Key context

- Agent templates should instruct specialists to write a structured markdown report as their final output (this is how the dispatcher collects results)
- Each agent template should include instructions to use and update their scratchpad file at .pi/scratchpads/<name>.md
- Specialist agents get context from CLAUDE.md + AGENTS.md injected by prompt-composer (task 6) — templates don't need to reference these
- Front matter uses `skills: string[]` (plural) matching the standardized terminology from task 1

## Acceptance
- [ ] 6 agent templates with valid front matter (using `skills: string[]` plural) and meaningful system prompts
- [ ] Template teams.yaml references all 6 agents with sensible defaults
- [ ] Template agent-chain.yaml demonstrates a valid pipeline
- [ ] Setup wizard detects missing config and walks user through creation via pi UI methods
- [ ] Scaffolder creates .pi/teams.yaml and .pi/agents/ with selected templates
- [ ] Handles partial config state (agents exist but no teams.yaml, etc.)
- [ ] Tests verify template front matter validates against Zod schemas from task 1
## Done summary
Created 6 agent templates (architect/opus, developer/sonnet, reviewer/opus, researcher/sonnet, qa/sonnet, devops/haiku) with validated front matter and scratchpad instructions. Built interactive setup wizard that detects missing config, walks users through team creation via pi UI methods, and scaffolds .pi/teams.yaml + .pi/agents/ + .pi/agent-chain.yaml from templates. Handles partial config state and preserves existing user customizations.
## Evidence
- Commits: f5a19dede22f9fb0774a68dafe826ded9d1e0fa1
- Tests: npx vitest run
- PRs: