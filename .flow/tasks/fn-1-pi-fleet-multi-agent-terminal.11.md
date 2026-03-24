# fn-1-pi-fleet-multi-agent-terminal.11 README, CLAUDE.md, and project documentation

## Description
Create project documentation: README.md with installation, commands, and workflow guide. CLAUDE.md with development conventions for contributors.

**Size:** S
**Files:** README.md, CLAUDE.md
## Approach

- README.md: follow dorkestrator README pattern for pi extension documentation. Structure: Overview → Install → Quick Start → Commands (/fleet, /fleet-status, /fleet-steer) → Configuration (.pi/teams.yaml schema, .pi/agents/*.md format, agent-chain.yaml format) → Agent Templates → Architecture overview → Chain Mode → Known Limitations → Development. Include:
  - **.pi/scratchpads/ gitignore tradeoff**: Document that `.pi/scratchpads/` is in `.gitignore` because scratchpad files are session-local working memory (not source code). If a team wants to share scratchpad templates or review agent working notes, they should copy relevant scratchpads to a tracked location manually rather than removing the gitignore entry (which would pollute commits with transient agent output).
  - **In-extension spawn validation**: Document the manual integration test: after `npm run build`, run `pi install .` then invoke `/fleet` with a minimal teams.yaml config. This validates that `child_process.spawn("pi", ...)` works from within pi's extension sandbox. The smoke script (`npm run smoke`) validates spawn from a developer terminal but cannot guarantee the same behavior inside the extension runtime.
  - **PRD.md relationship**: Note that PRD.md describes the broader product vision; the extension implements the narrowed v1 scope documented in the epic spec's PRD Reconciliation table.
- CLAUDE.md: development conventions — TypeScript, Zod for config validation, TypeBox for tool params, Vitest for tests, esbuild for build. Module structure overview. Test-before-commit rule. Key patterns: event sourcing, worktree pool, DAG execution. Test file convention: test/ mirrors src/ directory structure.

## Key context

- Follow dorkestrator README at /Users/eric/Development/code/Pi-Harness/dorkestrator/README.md as pattern
- Include YAML examples for teams.yaml and agent front matter
- Document the /fleet interactive setup flow for first-time users
- Keep CLAUDE.md concise — only what can't be inferred from code
## Acceptance
- [ ] README.md covers installation, commands, configuration, and workflow
- [ ] README includes YAML examples for teams.yaml and agent definitions
- [ ] README documents chain mode and interactive setup
- [ ] CLAUDE.md documents development conventions, build/test commands, and key patterns
- [ ] Documentation follows dorkestrator README pattern for consistency
- [ ] README documents .pi/scratchpads/ gitignore tradeoff (local-only vs team-shared)
- [ ] README documents manual in-extension spawn integration test (`pi install . && /fleet`)
- [ ] README notes PRD.md relationship and v1 scope narrowing
- [ ] README documents dependency bundling strategy (esbuild bundles all runtime deps including zod, yaml, typebox; accepts duplication if pi host also provides them)
- [ ] README documents sibling worktree directory lives outside repo and gitignore control; recommend periodic cleanup
- [ ] CLAUDE.md documents test file convention (test/ mirrors src/)
- [ ] README documents that fleet only reads repo-root AGENTS.md (nested AGENTS.md files ignored in v1)
- [ ] README includes "Implemented v1 scope" section referencing PRD Reconciliation decisions
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
