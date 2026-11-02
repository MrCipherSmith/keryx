# Runtime cache test gaps

Test file: `scripts/hub-runtime-cache.security.test.ts`. Five baseline tests pass. No production changes.

- **W1-007**: `prepared cache rejects a matching entry whose symlink escapes the private cache` supplies valid matching outside metadata and asserts the precise confinement error; `prepared cache rejects matching entry names with wrong package identity` separately checks wrong name and wrong version, asserting the pinned-dependency error. Exact mutants `w1-cache-path-confinement` and `w1-cache-identity` each killed.
- **W1-008**: actual preparation CLI under Bun with a preload that intercepts only `Bun.spawn` and runs an isolated child exiting 37, never a real installer. `preparation CLI requires explicit network permission before installer invocation` uses a three-argument invocation with an incorrect permission flag and an empty absolute cache; `preparation CLI refuses a populated private cache before installer invocation` provides permission and asserts its precise error plus unchanged cache; `preparation CLI reports a failed installer and never reports success` supplies valid arguments and empty cache, asserting fake installer invocation, failure 37, and absence of success output. Exact mutants `w1-prepare-network-permission`, `w1-prepare-private-empty`, and `w1-supplement-prepare-install-failure` each killed.

Mutation method: archive `HEAD` into a fresh scratch directory with `git archive HEAD | tar`, copy only the new test into it, load the five exact `anchor`/`replacement` records from the read-only R03 `research-evidence/mutants.json`, replace one matching anchor at a time, run `bun test scripts/hub-runtime-cache.security.test.ts`, then restore the original scratch file before the next mutant. All five runs exit 1 with their corresponding named test failing. No original review runner, inputs, host cache, registry or installation was touched.

Verification:
- `keryx ctx run -- bun test scripts/hub-runtime-cache.security.test.ts` — 5 pass, 14 assertions.
- `keryx ctx run -- bunx eslint scripts/hub-runtime-cache.security.test.ts` — pass.
- `keryx ctx run -- bun run typecheck:scripts` — pass.
- `keryx ctx run -- bun test scripts/hub-runtime-cache.security.test.ts scripts/package-team-hub.test.ts` — 13 pass, 1 skip, 1 fail; existing archive closure test fails because frontend freshness gate detects stale generated assets after current worktree UI changes. `keryx ctx run -- bun scripts/package-team-hub.ts --out /tmp/hub-package-diagnostic-r03` confirmed that exact reason. No asset rebuild was performed in this worker's scope.

Routing: graph_used yes (graph reported stale due to untracked dependency link and current changes; advisory only), wiki_used no (focused test gaps), ctx_used yes, raw_rg_used no.
