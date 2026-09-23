# Review — flow 298, ACP client stderr budget / agent guidance (PR #660)

Follow-up review of PR #660 (flow 298, squash-merged into `main` as `7cd96cbe`),
scoped to `git diff origin/main...HEAD` in the `fix/post-release-hardening`
worktree at PR head `cca2d5d1c227a8eae9db0804a8d4a2e8c4f66732`. Two findings
were raised against the PR's stderr-budget and agent-guidance changes:
(F-001) the new "Unattended dispatch" guidance in `src/flow/templates.ts`
described the ACP-only permission bridge and never-applied patch capture as if
they applied generically to `keryx agents external run` for any registered
agent, including the line-stream agents (`codex-cli`, `claude-cli`); (F-002)
the new shared 16 MiB stderr-READ budget in `src/harness/external/bounded.ts`
had no per-agent override and no evidence it fit `codex exec`'s documented
self-narration on stderr, which could plausibly end a legitimate read-heavy
run.

Both findings were checked against commit `cca2d5d1c227a8eae9db0804a8d4a2e8c4f66732`
("fix(agents): say what keryx controls per transport, and let codex narrate"),
which is folded into the squash-merge commit `7cd96cbe3df6be503dea1f07dccc8d0b375d68ca`
on `main` (`git diff 6b5c7d2c..7cd96cbe -- <path>` shows the same changes).
Both are refuted: the guidance now states the per-transport split accurately
against the code, and the stderr budget now has a documented, tested,
overridable per-transport default. `bun test src/harness/external/bounded.test.ts`
(10 pass), `bun test src/harness/external/dispatch.test.ts
src/commands/agents-external.test.ts src/commands/agents-external-run.test.ts
src/lib/templates.test.ts` (78 pass) and `bun run src/cli.ts skills verify
--bundled` (0 findings) all pass on `main` at this head.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow-298-post-release-review",
    "severity": "major",
    "file": "src/flow/templates.ts",
    "problem": "The \"Unattended dispatch (triggers, and `agents external run`)\" guidance added in the PR's first commit described `keryx agents external run <id> --task ... --write` as driving \"one third-party ACP/CLI agent\" and stated that keryx controls, for that command generically, \"the permission bridge (clamped to `ask`)\" and a `--write` run's patch, \"captured but never applied\". Both mechanisms (`clampForeignMode`, `captureWorktreePatch`/`patchArtifact`) exist only in `src/harness/external/acp-run.ts`, reachable only via the ACP branch of `runExternalChild` (`src/harness/external/runtime.ts`); the line-stream codecs (`src/harness/external/codec/claude-cli.ts`, `codec/codex-cli.ts`) and the shared line-stream supervisor (`src/harness/external/supervise.ts`) have no permission-bridge concept and no patch-capture step, and `src/harness/child/git-worktree-port.ts`'s `remove()` is a bare `git worktree remove --force` with no diff/snapshot step.",
    "impact": "An operator or a future keryx agent reading the guidance could believe a `codex-cli`/`claude-cli` `--write` run's changes are safely captured as an inspectable, never-applied patch, when in fact (as later confirmed) `agents external run` never reaches that agent's write path at all for a line-stream agent — it is refused up front. The guidance's generic phrasing did not say so, and did not distinguish the two transports anywhere in the paragraph.",
    "suggested_fix": "State the permission bridge and patch-capture behaviour as ACP-transport-only, and describe explicitly what happens when `run`/a dispatch targets a line-stream agent instead of leaving it implied.",
    "evidence": "src/flow/templates.ts (PR head cca2d5d1, pre-fix): \"drives one third-party ACP/CLI agent as a subprocess ... keryx controls: the permission bridge (clamped to `ask` for a foreign agent) ... and a `--write` run's patch, which is captured but never applied.\" No per-transport qualifier anywhere in the paragraph. Cross-checked: `keryx ctx rg permission` across `src/harness/external/runtime.ts`, `codec/claude-cli.ts`, `codec/codex-cli.ts` matches only unrelated comments; `keryx ctx rg captureWorktreePatch|patchArtifact` matches only `src/harness/external/acp-run.ts`.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/external/acp-run.ts (clampForeignMode, captureWorktreePatch, patchArtifact — the only site implementing either mechanism)",
        "src/harness/external/runtime.ts:417 (runAcpBranch — the only call path that reaches acp-run.ts)",
        "src/harness/external/supervise.ts (superviseExternalRun — the line-stream path, no permission or patch concept)",
        "src/harness/child/git-worktree-port.ts:47-55 (remove() — git worktree remove --force, no diff capture)",
        "src/commands/agents-external.ts:369-375 (the actual run-command gate: refuses any non-ACP agent id outright, before sandbox/--write is even read)"
      ],
      "enumeration_method": "keryx ctx rg for clampForeignMode|captureWorktreePatch|patchArtifact across src/harness/external/*.ts (one file, acp-run.ts); keryx ctx rg for permission across the line-stream codecs and runtime.ts and supervise.ts (no hits); read src/harness/child/git-worktree-port.ts and src/commands/agents-external.ts in full to confirm no alternate capture or refusal path exists outside the two sites named."
    }
  },
  {
    "id": "F-002",
    "reviewer": "flow-298-post-release-review",
    "severity": "minor",
    "file": "src/harness/external/bounded.ts",
    "problem": "The new stderr-READ budget added in the PR's first commit used one shared 16 MiB default (`DEFAULT_MAX_STDERR_BYTES`) for both `superviseAcpRun` (ACP) and `superviseExternalRun` (line-stream, used by `codex-cli` and `claude-cli`), with no per-agent override and no CLI flag to raise it. `src/harness/external/codec/codex-cli.ts` (header, lines 12-13, unchanged by the fix) documents as a measured fact that `codex exec` \"NARRATES ITSELF on stderr and prints the contents of files it reads\" during normal, successful operation — volume that scales with what the agent reads, not with a fixed per-turn cost.",
    "impact": "A legitimate, read-heavy `codex-cli` run (reviewing a large diff or several sizeable files, which is representative of this harness's own workloads) could plausibly accumulate more than 16 MiB of normal narration on stderr before producing a result, ending an otherwise-successful run with \"the agent wrote more than 16777216 bytes to stderr\". No fixture or test in the PR's first commit demonstrated realistic stderr volume for a legitimate large task — the only codex-cli fixtures on disk are all under 400 bytes.",
    "suggested_fix": "Give the line-stream path a separate, larger default sized for narrating codecs, and/or an explicit per-agent override on `ExternalAgentEntry`, so `codex-cli`'s documented behaviour cannot be mistaken for a hostile flood.",
    "evidence": "src/harness/external/bounded.ts (PR head cca2d5d1, pre-fix): a single `DEFAULT_MAX_STDERR_BYTES = 16 * 1024 * 1024` used by both `acp-client.ts` and `supervise.ts`; `src/harness/external/types.ts`'s `ExternalAgentEntry` carried no `maxStderrBytes` field; `src/commands/agents-external.ts`'s production call path threaded only `seams.acp` (test-only), never a CLI flag.",
    "confidence": "medium"
  }
]
```
