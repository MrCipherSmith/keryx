# Review — flow 296, keep saved provider keys out of the MCP servers `keryx shell` starts (PR #657)

One review round ran over the flow 296 diff at PR head `b399c79a` (worktree
`/home/altsay/keryx-mcpenv`, branch `fix/shell-mcp-credentials`): `src/mcp-servers/spawn-env.ts`
(`buildMcpChildEnv`, the shared by-name/by-shape strip), `src/acp/session-mcp.ts` (removal of the
duplicate `acpMcpParentEnv`), `src/mcp-servers/runtime.ts` (`defaultConnect`), and the surfaces that
launch MCP servers through them (`keryx shell`'s readline and TUI branches in `src/commands/shell.ts`,
and `keryx mcp doctor` in `src/commands/mcp-servers.ts`). The round raised one finding (F-001, major):
the by-name strip's protection held only where `applySavedApiKeys()` had already run in-process, which
is true for the TUI shell surfaces and `keryx acp`, but NOT for `keryx shell`'s readline surface
(`--no-tui`/`--print`/non-TTY) or for `keryx mcp doctor` — both of which are surfaces AC1 names
explicitly ("keryx shell — or any other surface that starts MCP servers through the shared MCP
runtime"). Three further questions investigated in the same pass were NOT findings — each was checked
against the diff and found not to be a defect, and none is touched by the fix-round commits below, so
they are not re-verified as separate items: (1) removing `acpMcpParentEnv` dropped nothing beyond the
by-name filter it performed, which the centralised `buildMcpChildEnv` now performs identically; (2) a
server's own `env` block reintroducing a saved-credential name via `${VAR}` expansion is the documented,
intentional "explicit configuration wins" escape hatch (AC2), proven by
`spawn-env.test.ts`'s "the server's own env block hands over a saved-credential name deliberately"; (3)
`connectStdioMcpServer` (`src/mcp-client/client.ts`) is the sole MCP child-process spawn point in
production code, reached only through `defaultConnect`, so no other surface bypasses the strip.

A fix round landed after the review, in the PR's second commit ("fix(mcp): strip every key the operator
declared, not only the ones keryx saved", inside squash-merge commit `6b5c7d2c6c6e0658f5cd6f34b4487eddd84f6df7`
on `main`, PR #657). It closes F-001 by reading the saved-credential names straight off `auth.json` on
disk (`declaredCredentialEnvKeys`, independent of whether anything has been loaded into `process.env`
this run) and unioning that with the existing runtime singleton, with `configDir` threaded through every
`defaultConnect` call so the disk read targets the right file on every surface. A new process-level test
(`src/mcp-servers/declared-credentials.process.test.ts`) spawns a real child through both the exact
`keryx shell` runtime path and the exact `keryx mcp doctor` call and proves neither leaks a declared
custom-named key even with an empty runtime singleton. I re-ran the full affected test set on the
worktree at `b399c79a` (identical diff content to the main merge commit): `spawn-env.test.ts`,
`declared-credentials.process.test.ts`, `ac10-child-env.test.ts`, `shell-env.test.ts` — 38 pass, 0 fail;
`session-mcp.test.ts`, `mcp-servers.process.test.ts` (ACP) — 33 pass, 0 fail. `docs/docs/cli-reference.md`
now documents the union and names both previously-uncovered surfaces explicitly, closing AC4 for this
finding too.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (flow 296 PR #657 review)",
    "severity": "major",
    "file": "src/mcp-servers/spawn-env.ts",
    "quote": "savedCredentialEnvKeys()",
    "problem": "buildMcpChildEnv's by-name strip removed only names present in savedCredentialEnvKeys(), a process-lifetime singleton populated exclusively by applySavedApiKeys() (called from resolveTuiStartup in the TUI shell branches, serve-runner.ts, and keryx acp's own resolveTuiStartup call). keryx shell's readline surface (--no-tui/--print/non-TTY, chosen by chooseShellSurface in src/commands/shell.ts) is structurally outside the `if (surface !== \"readline\")` block that calls resolveTuiStartup, and its own createMcpRuntime call never invokes applySavedApiKeys either; keryx mcp doctor (doctorCommand, src/commands/mcp-servers.ts) built its env as `deps.env ?? process.env` with no applySavedApiKeys call anywhere in that file. On both surfaces the singleton stayed empty, so the by-name strip removed nothing.",
    "impact": "AC1 requires the by-name strip to hold on \"keryx shell — or any other surface that starts MCP servers through the shared MCP runtime\", naming keryx shell and keryx mcp doctor as covered surfaces in the accompanying docs/comments. On the readline shell and doctor paths the protection existed only because those paths also happened not to load the custom-named saved key into process.env by any other route — coincidence, not construction. A future change to either surface (or an operator's own environment already carrying the value under that name) would silently defeat the strip with no test catching it, since no flow-296 test exercised either path before this finding.",
    "suggested_fix": "Read the saved-credential names directly off auth.json on disk, independent of whether this process has loaded them into its own env yet, and thread the resolved configDir into every defaultConnect call so the disk read targets the right file on every surface.",
    "evidence": "src/commands/shell.ts wraps resolveTuiStartup (and the lazy createMcpRuntime used by the TUI branches) inside `if (surface !== \"readline\") { ... return; ... return; }`; the readline branch's own eager createMcpRuntime call (around line 3962 at review time) is reached without resolveTuiStartup ever running. src/commands/mcp-servers.ts's doctorCommand built `const env = deps.env ?? process.env;` with zero matches for applySavedApiKeys in that file.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/shell.ts readline surface (chooseShellSurface -> eager createMcpRuntime, no applySavedApiKeys call)",
        "src/commands/mcp-servers.ts doctorCommand (defaultConnect call, no applySavedApiKeys call)"
      ],
      "enumeration_method": "Grepped every call site of applySavedApiKeys across src/ (resolveTuiStartup in shell.ts used by the TUI branches only, serve-runner.ts, and keryx acp's own resolveTuiStartup call) and every call site of connectStdioMcpServer/defaultConnect (the sole MCP child-process spawn path). Of the three surfaces the fix's own doc comment names as funnelling through buildMcpChildEnv (keryx shell, keryx mcp doctor, keryx acp), exactly two never call applySavedApiKeys before spawning: keryx shell's readline surface and keryx mcp doctor. keryx acp does call it (resolveTuiStartup, confirmed by a passing real-process test) and TUI shell does too. No fourth surface starts an MCP server outside defaultConnect in production code."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Fixed in merge commit 6b5c7d2c6c6e0658f5cd6f34b4487eddd84f6df7 on main (PR #657, second commit 'fix(mcp): strip every key the operator declared, not only the ones keryx saved'). declaredCredentialEnvKeys(dir) (src/lib/shell-config.ts:276-282) reads auth.json's declared key names straight off disk via envWithSavedApiKeys({}, dir), independent of process state. buildMcpChildEnv (src/mcp-servers/spawn-env.ts:378-380) now unions savedCredentialEnvKeys() with declaredCredentialEnvKeys(input.configDir). defaultConnect (src/mcp-servers/runtime.ts:609) threads its own configDir parameter into that call; both production callers already passed their resolved configDir through (commands/mcp-servers.ts's doctorCommand passes deps.configDir; commands/shell.ts's createMcpRuntime passes runtime.cacheDir for both its readline and TUI branches, verified by reading both call sites). The new process test src/mcp-servers/declared-credentials.process.test.ts spawns a REAL child MCP server through both the exact keryx shell runtime path (createMcpRuntime) and the exact keryx mcp doctor call (defaultConnect with deps.configDir), with an EMPTY savedCredentialEnvKeys() singleton and a temp auth.json declaring a custom-named key present only in the parent env passed to the runtime/dial call — both assert the spawned child never sees it (reportedVarPresent === false). I ran this test plus spawn-env.test.ts, ac10-child-env.test.ts and shell-env.test.ts on the worktree at b399c79a (identical diff content to the main merge commit): `bun test` — 38 pass, 0 fail, 136 expect() calls. I also ran session-mcp.test.ts and mcp-servers.process.test.ts (ACP): 33 pass, 0 fail, 173 expect() calls, including the flow-296 AC1 real-process test for the ACP path that was already passing before this follow-up fix. docs/docs/cli-reference.md (around lines 3777-3787 in the current worktree) now documents the union and names both previously-uncovered surfaces (keryx mcp doctor and keryx shell --print/--no-tui/non-TTY) explicitly as covered, closing AC4 for this finding.",
      "verifier": "orchestrator (fix-round re-check, this session)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "declaredCredentialEnvKeys() added to src/lib/shell-config.ts, buildMcpChildEnv's strip changed to the union of the runtime singleton and the disk-declared names, and configDir threaded through defaultConnect — all in the fix-round commit inside squash-merge 6b5c7d2c6c6e0658f5cd6f34b4487eddd84f6df7 (PR #657), proved by the new src/mcp-servers/declared-credentials.process.test.ts."
    }
  }
]
```
