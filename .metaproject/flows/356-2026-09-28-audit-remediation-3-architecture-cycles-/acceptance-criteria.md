# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: (A-1, A-2, A-3, A-5) four import cycles are cut by moving one symbol each — `security/service.ts` stops re-exporting `./impact-evidence` and its one caller `commands/security-impact-evidence.ts` imports `security/impact-evidence` directly (import-zone entry added); `CLI_ROUTES`/`printCommandHelp` move to `src/cli-registry.ts` imported by `cli.ts` and `commands/help.ts`; `keyFilesForPage` moves to `src/wiki/key-files.ts`; `parseJsonTolerant` moves to `src/mcp-servers/json-utils.ts`. `keryx gdgraph query cycles` (after `keryx gdgraph build`) lists no cycle through those files; the remaining listed cycles are exactly the A-4 facade loops, recorded as accepted in the ledger. The flat `--help` fixture tests and `src/shell-source-audits.test.ts` pass without new source-text tests.
- AC2: (A-6) `retryableFor` exists once, exported from `src/harness/provider/provider-port.ts`; the four adapter copies are deleted; every adapter's retry tests pass unchanged. `mergeUsage` is left per-adapter unless a shared helper removes duplication without changing any adapter's usage output (decide and record).
- AC3: (A-8) `keryx gdgraph query orphans` treats `bunfig.toml` `preload` entries as roots — `src/lib/test-preload.ts` is not reported; test with a fixture project.
- AC4: (G-2) `keryx security scan .` skips paths excluded by the repository's own ignore rules (`.gitignore`, and `.claude/worktrees`), lists them under `coverage.skipped`, and on the keryx repository reports `coverage.status: "complete"` at the default limits; `--no-ignore` restores the old behaviour. Test with a fixture tree containing an ignored large file.
- AC5: (G-4, G-5) `keryx standard validate` on a fresh `keryx init` tree reports zero warnings (the `tasks` and `mcp` modules stop declaring data directories they do not create, or `init`/`update` creates them); `keryx update` lists agent worktrees under `.claude/worktrees` older than 7 days with no commits ahead of `main` and prunes them only after confirmation (`--yes` skips the prompt). Tests for both.
- AC6: (doctor follow-ups, backlog 12–13) `keryx doctor` outside a keryx project prints one `warn` line "not a keryx project — run `keryx init`", skips project-scoped checks and exits 0; the stale-worktree check resolves the main checkout via `git rev-parse --git-common-dir` so it gives the same answer from a linked worktree. Tests for both.
- AC7: (L-16, S-11) the OpenAI-compatible adapter turns an in-band `{"error":…}` envelope with no pending tool call into a `provider_error` classified like its pre-2xx errors (the `stream-contract.test.ts` row B compat case flips from the documented gap to the fixed behaviour); `parseGrokToml` (`src/mcp-servers/compat.ts`) never echoes a raw value into a problem message — it names the key and the unsupported form only. Tests for both.
- AC8: typecheck, lint, every touched test file, `src/lib/import-policy.live.test.ts`, `src/shell-source-audits.test.ts`, the provider tests and the help-fixture tests pass; ledger rows A-1…A-8, G-2…G-5, L-16, S-11 in `docs/requirements/keryx-audit-remediation/findings.md` carry fixed/accepted with the test name; the package README status updated; CHANGELOG entry and package.json bump.
