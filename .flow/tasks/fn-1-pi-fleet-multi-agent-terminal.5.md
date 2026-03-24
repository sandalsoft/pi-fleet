# fn-1-pi-fleet-multi-agent-terminal.5 Worktree manager with pool pattern

## Description
Implement git worktree lifecycle management with an acquire/release pool pattern, mutex-protected creation, and robust cleanup.

**Size:** M
**Files:** src/worktree/manager.ts, src/worktree/pool.ts, src/worktree/cleanup.ts, test/worktree/manager.test.ts, test/worktree/pool.test.ts, test/worktree/cleanup.test.ts
## Approach

- pool.ts: WorktreePool class with acquire(agentName) and release(worktreePath) methods. Pre-creates worktrees on init if pool size is specified. Tracks in-use state. Reuses released worktrees by checking out a fresh branch from the base commit
- manager.ts: higher-level API. createWorktree(agentName, baseBranch) creates a worktree with branch name `fleet/<agentName>-<sessionId>`. Uses `pi.exec("git", [...args])` for all git commands — array args, no shell injection. **Worktree root is always outside the repo** to avoid git's rejection of nested worktrees. Default location: `path.join(repoRoot, "..", "<project>-fleet-worktrees")`. If sibling directory creation fails at runtime (permissions), fall back to `path.join(os.tmpdir(), "<project>-fleet-worktrees")`. Never place worktrees inside the repo (`.pi/worktrees/` is not used). Mutex around worktree creation to prevent branch name races
- cleanup.ts: removeWorktree(path) via git worktree remove. pruneStaleWorktrees() runs git worktree prune on startup and shutdown. Detects stale worktrees from prior crashed sessions
- Pre-flight checks: validate git repo, check for clean working tree (or warn), detect shallow clone (worktree add can fail)
- Emit worktree_created events to session log
- Register session_shutdown handler to clean up all active worktrees
- Progress indication: use ctx.ui.setWorkingMessage() during worktree creation

## Key context

- Use pi.exec("git", [...]) for git commands — no simple-git dependency needed
- pi.exec returns { stdout, stderr, code, killed }
- Worktree placement outside project dir prevents pi/agent tools from scanning worktree contents
- git worktree add requires unique branch names per worktree
- git worktree list --porcelain is machine-parseable for detecting existing worktrees
- Each worktree needs its own node_modules if agents run npm scripts
## Acceptance
- [ ] WorktreePool with acquire/release/reuse semantics
- [ ] Mutex-protected worktree creation prevents branch name races
- [ ] Worktree root always outside repo (sibling dir default, OS tmpdir fallback); no nested worktrees
- [ ] pi.exec("git", [...args]) pattern (array args) prevents shell injection
- [ ] Stale worktree pruning on startup and shutdown
- [ ] Pre-flight validation: git repo check, shallow clone detection
- [ ] Progress indication via ctx.ui.setWorkingMessage()
- [ ] worktree_created events emitted to session log
- [ ] session_shutdown handler cleans up all active worktrees
- [ ] Tests verify worktree creation, release, reuse, and cleanup using real git repos in tmpdir
- [ ] Git test isolation: set local config (user.name, user.email) in temp repos, use `git init -b main` (don't assume default branch name)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
