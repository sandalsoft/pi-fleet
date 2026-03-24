# fn-1-pi-fleet-multi-agent-terminal.8 Merge engine with three-way conflict resolution

## Description
Implement the merge engine that combines specialist worktree branches back to the main branch using git's three-way merge with programmatic conflict resolution. Includes drift detection, failure recovery, and clean conflict input extraction.

**Size:** M
**Files:** src/merge/merger.ts, src/merge/conflict-resolver.ts, src/merge/integration.ts, test/merge/merger.test.ts, test/merge/conflict-resolver.test.ts, test/merge/integration.test.ts
## Approach

- integration.ts: create integration branch from base commit SHA (from dispatcher). Merge specialists sequentially. Before fast-forward: check for drift (HEAD vs base SHA). If drifted: rebase integration onto current HEAD. If rebase fails: leave integration branch for manual resolution.
- merger.ts: for each specialist branch, run git merge --no-commit. Check conflicts via git diff --name-only --diff-filter=U. If clean: commit and proceed. If conflicts: hand off to conflict-resolver. On any failure: git merge --abort to restore clean state.
- conflict-resolver.ts: **Three-way input extraction**: during an in-progress merge, retrieve clean file versions from git index stages — `git show :1:<path>` (base/common ancestor), `git show :2:<path>` (ours/integration), `git show :3:<path>` (theirs/specialist). Feed these three versions as line arrays to node-diff3's diff3Merge(). If diff3 produces clean merge: write resolved content, git add. For remaining conflicts: spawn dispatcher subprocess with both versions. For binary files: detect via git diff --numstat (binary shows "-"), default to later specialist's version (git checkout --theirs). Emit merge_conflict events.
- Handle "nothing to merge" case: specialist with no code changes — skip merge, collect report.
- Emit merge_started, merge_completed events.
- **Bounded merge safe window**: if shutdown triggers during merge, allow 30 seconds for current merge to complete, then stop and leave integration branch.

## Key context

- `git show :1:path` / `:2:path` / `:3:path` extracts base, ours, theirs during an active merge — this is the standard way to get clean inputs for three-way diff
- git merge --abort reverts a failed merge to pre-merge state
- node-diff3 operates on text line arrays: diff3Merge(theirs, base, ours) returns ok/conflict blocks
- Binary files can't be merged with node-diff3 — detect via git diff --numstat
- Integration branch prevents half-merged state on user's branch
- Base SHA drift detection from task 6's recorded SHA
- Integration tests use real git repos in tmpdir. **Git test isolation**: each test creates a fresh tmpdir, runs `git init -b main`, sets local config (`git config user.name "Test"`, `git config user.email "test@test.com"`) so tests don't depend on global git config or default branch name. Clean up tmpdir in afterEach.

## Acceptance
- [ ] Integration branch created from base commit SHA
- [ ] Sequential merge via git merge --no-commit
- [ ] git merge --abort on failure paths
- [ ] Conflict input extraction via git show :1:/:2:/:3: (base/ours/theirs index stages)
- [ ] Text conflicts resolved via node-diff3 with correct three-way inputs
- [ ] Residual conflicts dispatched to dispatcher for resolution
- [ ] Binary file conflicts detected (git diff --numstat) and handled (checkout --theirs)
- [ ] "Nothing to merge" handled gracefully
- [ ] Base SHA drift detection; rebase if drifted
- [ ] Bounded 30s merge safe window for shutdown
- [ ] merge_started, merge_completed, merge_conflict events emitted
- [ ] Integration tests using real git repos in tmpdir with isolated git config (user.name/email, `git init -b main`)
## Done summary
Implemented merge engine with three-way conflict resolution: conflict-resolver.ts extracts base/ours/theirs from git index stages and resolves text conflicts via node-diff3, merger.ts performs sequential branch merging with --no-commit and automatic abort on failure, and integration.ts orchestrates the full flow with integration branch creation, drift detection with rebase, bounded 30s shutdown window, and merge event emission. Added 26 integration tests using real git repos in tmpdir with isolated config.
## Evidence
- Commits: fba7aa45d6a94bc8a234c8d9eda61fdd66a494af
- Tests: npm run test (307 passed), npm run typecheck (no new errors)
- PRs: