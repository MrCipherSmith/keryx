# Context

Collected deterministically by `keryx flow init` at 2026-09-19T15:34:50.451Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.807] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.76] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
3. [1.704] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
4. [1.67] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
5. [1.657] SAC: Anchors: root: /Users/tsaitler.aleksandr/goodea/keryx tre… (task-note/accepted) - task-notes/sac-proposal-b051e66aebd74f37.md
   Flow 188 (count .ts files in src/harness/provider, read-only) completed. Direct child .ts files excluding .test.ts and subfolders: fake-provider.ts, make-provider.ts, provider-port.ts, single-turn.ts, tool-call-linking.ts, types.ts = 6 files. Subfolders (openai/, ollama/, gemini/, anthropic/, compat/, fixtures/) and their contents excluded per the no-subfolders constraint. Task required read-only; rounds T1-T4 (plan/test/PR) are generic placeholders not applicable to this read-only counting task.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-5c74a3f7b3c7414b/session-evidence/4f3b7eb5-a514-476e-8732-6087df8710d6.wrap-up.md (sha256 a12235fc2638f84f9fc1305cc5fff51a0563003ee785b92a1c81a02c961927a3) author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Source: context-collector dispatch `272-context`, run 2026-09-19 against main at ef603f5f. P0 is already merged.

**Spec**
- `docs/requirements/keryx-agent-bus/specification.md` §2.1, §3.2, §4, §5.2 (steps 1–3), §7.3, §7.4, §9, §10.
- D-02, D-06, D-09, D-12 and D-13.
- `artifact-lifecycle.md`.
- `schemas/*.json`.

**Allocation**
- `src/flow/allocation.ts`:
  - `gitCommonDir` :39-54 and `gitToplevel` :56-68 are async and private.
  - `projectKey` :73-79 is keyed on the raw cwd, via `slugify` from `src/flow/store.ts:288`.
  - `resolveAllocationScope` :81-98.
- Callers: `flow/service.ts:174,784`.
- Tests: `allocation.test.ts` :57, :74, :89, :108. The fixture is at :27-55; a worktree is created at :67.

**Marker**
- `resolveShellEnv` is at `src/harness/process/shell-spawn.ts:126-136`. Set `KERYX_TOOL_CALL=1` before the return at :135.
- It is reached from `shell-exec-tool.ts:159` and `background-job-registry.ts:453`.
- The external env sweeps `KERYX_` (`external/env.ts:54,88`), and so does the MCP env (`spawn-env.ts:281,299`).
- No whole-env equality test pins this env.

**CLI**
- `src/cli.ts`: imports at :31-43, `CLI_ROUTES` at :65-108, help at :153-315.
- Template: `src/commands/sessions.ts:16-65`.
- Registry: `CommandDescriptor` at `src/standard/command-registry.ts:27-48`, with one descriptor per subcommand. The retention pair at :843-894 is the example.
  - A descriptor with `read:false` needs `sideEffects`.
  - Do not use module `core`: its listing is pinned at :145-155.
- Coverage tests:
  - `command-registry.coverage.test.ts:78` checks that every route has a descriptor or an exclusion.
  - `cli-reference-coverage.test.ts` requires a `## bus` heading (:43), `keryx bus` in the banner (:63), and every subcommand literal documented (:92-143).
- Docs: `docs/docs/cli-reference.md` top-level table at :53-85; the section format is like `## sessions` at :139-157.

**Validator**
- `src/contracts/validator.ts:354` `validateAgainstSchemaObject` supports `$ref`/`$defs`/`const`/`enum`/`oneOf`/`allOf`/`if-then`/`not`/`pattern`/`uniqueItems`.
- `format: uuid` is not enforced, so a hand-written check is needed.
- Pattern to follow: `src/flow/schema.ts:40`, with an inline schema.
- `docs/` is not in the package `files`, so the runtime cannot read the schema JSON.

**Ids, redaction, CI, version**
- Id sanitising pattern: `src/session/external-slate.ts:82-90`.
- `redactSensitiveText(text): string` at `src/security/redact.ts:128`.
- `detectCi(env)` at `src/capability/external-agents.ts:278`.
- Version comes from importing `package.json` (`commands/shell.ts:108`).

**Tests**
- Each test file defines its own git fixture.
- Multi-process pattern: `src/ctx/artifact-race.e2e.test.ts:77-92`.
- Env sandbox: `shell-lease.process.test.ts:61-82`.
- Test-only knob gating: `session/lease.ts:134`.

**Risks**
- The config-dir guard flags a file that both names `keryxDataDir(` and does fs I/O. Put the path logic in a pure module.
- Importing flow's `slugify` crosses zones. Check `src/lib/import-policy.ts`.
- 800 separate CLI launches would be too slow. Use 8 drivers × 100 appends instead.
