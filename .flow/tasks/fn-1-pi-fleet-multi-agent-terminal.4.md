# fn-1-pi-fleet-multi-agent-terminal.4 Interview engine and team selector

## Description
Implement the interview engine that conducts 8-12 questions via pi UI to understand the user's task, and the team selector that automatically picks agents and constructs a task DAG.

**Size:** M
**Files:** src/interview/interviewer.ts, src/interview/team-selector.ts, src/interview/questions.ts, test/interview/interviewer.test.ts, test/interview/team-selector.test.ts
## Approach

- interviewer.ts: orchestrates question flow using ctx.ui.input(), ctx.ui.select(), ctx.ui.confirm(). Questions adapt based on: available agents in roster (from config), detected project type (file extensions in cwd), task complexity signals
- questions.ts: question bank organized by category — task understanding, scope, agent selection, constraints, priorities. Each question has a condition function determining whether to ask it
- team-selector.ts: takes interview answers + agent roster → produces TaskAssignment[]. Each assignment maps an agent to a task description with dependencies and `expectedPaths: string[]` (approximate file paths the agent will touch, even coarse-grained like `["src/**"]` or `[".pi/**"]`). Uses a scoring heuristic to match agent expertise to task requirements. The expectedPaths are derived from the interview answers and agent expertise — they don't need to be exact, just sufficient for conservative overlap detection by task 6's DAG builder.
- Build the task DAG from assignments: identify which tasks can run in parallel (no overlapping expectedPaths) and which must be sequential (data dependencies or path overlap). Tasks with empty/absent expectedPaths default to sequential.
- Handle interview cancellation: if user cancels (ctx.ui returns undefined), emit session_aborted event and clean up gracefully
- Emit interview_complete and team_selected events to session log

## Key context

- ctx.ui.select() returns string | undefined (undefined = cancelled)
- ctx.ui.input() returns string | undefined
- ctx.ui.confirm() returns boolean
- The team selector does NOT need user approval — fully automatic per spec
- Task descriptions should be specific enough for a specialist to execute independently in a worktree
- Consider that the dispatcher may need to override agent models for complex tasks (agent default with dispatcher override)
## Acceptance
- [ ] Interview asks 8-12 adaptive questions via pi UI methods
- [ ] Questions adapt based on available agents and project context
- [ ] Graceful handling of interview cancellation (undefined returns)
- [ ] Team selector produces TaskAssignment[] with agent, task, dependency info, and `expectedPaths: string[]`
- [ ] Task DAG constructed with parallel-safe (non-overlapping expectedPaths) and sequential tasks identified
- [ ] Tasks with empty/absent expectedPaths default to sequential execution
- [ ] interview_complete and team_selected events emitted to session log
- [ ] Tests verify team selection logic with various interview answer combinations
- [ ] Tests verify cancellation handling
## Done summary
Implemented interview engine with adaptive 8-12 question flow via pi UI methods (input/select/confirm), question bank with condition-based filtering, graceful cancellation handling with session_aborted events, team selector that generates TaskAssignment[] with expectedPaths from interview answers, and DAG wave builder using topological sort with path-overlap analysis for parallel-safe execution scheduling.
## Evidence
- Commits: 0034dcce8fe044bf4ddfe1dc3d525ac99b682dfa
- Tests: npx vitest run
- PRs: