# Mutation pass

Command: `env GIT_CONFIG_GLOBAL=/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/t4fix/gitconfig bun test src/review/replay.test.ts` (baseline exit 0, 1166 ms). Run in a scratch copy; the worktree was not written.

Killed 1, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| T1-global-config-pin-removed | src/review/replay.test.ts:11 | `, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"` → `` | survived |
| T2-excludesfile-pin-removed | src/review/replay.test.ts:15 | `"-c", "core.excludesFile=/dev/null", ` → `` | survived |
| T3-both-pins-removed | src/review/replay.test.ts:11 | `const gitEnv = { ...withoutGitDiscoveryOverrides(process.env), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }; const git = (dir: string, ...args: string[]) => {   const run = spawnSync(     "git",     ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.excludesFile=/dev/null", ` → `const gitEnv = { ...withoutGitDiscoveryOverrides(process.env) }; const git = (dir: string, ...args: string[]) => {   const run = spawnSync(     "git",     ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ` | killed |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
