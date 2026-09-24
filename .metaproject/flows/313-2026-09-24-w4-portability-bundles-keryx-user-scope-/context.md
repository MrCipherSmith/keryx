# Context

Collected deterministically by `keryx flow init` at 2026-09-24T07:18:33.485Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.874] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.612] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
3. [1.591] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.588] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
5. [1.583] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 304 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`

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

_(flow-init skill appends here)_

### Orchestrator findings (T1, 2026-09-24)

- Base branch: `feat/agent-platform-expansion`; worktree `/Users/Goodea/goodea/keryx-ape-313-w4`, branch `flow/313-w4`.
- Import zones (`src/lib/import-zones.ts`): new `src/bundle/` must be registered as `core`; `src/harness/**` is `client` (core may not import it) — hence a shared `src/lib/keryx-home.ts` instead of importing W6's `resolveHookHomeDir`.
- W6 `resolveHookHomeDir(env, homeDir?)` (`src/harness/hooks/config.ts:65`): home = explicit arg > `KERYX_HOME` > `os.homedir()`; store = `<home>/.keryx/`. `validateHookConfigDocument(doc, scope, label)` (config.ts:139) validates a hook-config entry.
- Memory: `src/memory/store.ts` `collectEntries`/`parseEntry` are fully tolerant (never throw; defaults on bad fields); `write.ts` `writeCanonicalEntry` validates + security-guards + atomic write; `templates.ts` `renderMemoryEntry`. Entries are markdown with `Name: value` header fields.
- MCP: only `memory.search` exists (read-only, `src/mcp/tools.ts:779`, `invoke(cwd, params)`); `serveMcp(ServeOptions{cwd,http?,readOnly?})` (`src/mcp/server.ts:141`); no harness identity concept exists.
- CLI: custom sub-dispatch (`memoryCommand(args)` in `src/commands/memory.ts`); top-level `CLI_ROUTES` + help map in `src/cli.ts`; `src/cli-reference-coverage.test.ts` requires a `## <verb>` section, the verb in `USAGE_BODY`, and every routed subcommand literal in that section.
- W8: `runHarnessAudit(root, RunAuditOptions)` discovers fixed relative paths only; `imported-bundles` is a placeholder surface (`index.ts:394`); `auditGate(report)` fails on unsuppressed high/critical or tampered baseline; `CheckId` mirrors `harness-audit-report.schema.json` (enum must be extended for `bundle-*`).
- W1 scout: `scoutImports()` stub returns `{searched:false}` (`scout.ts:438`); `scoutSkill(query, catalog, options)` → use/fork/create; `scoutVetCandidate(dir)` stages under temp `.claude/skills/<name>/` + audit (precedent for W4 staging).
- W2: `origin.kind` already allows `imported`; `sourceRef` not enforced as required; `loadAgentCatalog` reads bundled + `.metaproject/agents` only (no user source).
- W3: `learned-pattern.schema.json` requires `scope` (project|user), `status` (candidate|accepted|rejected|superseded|expired); `candidate` requires `ttl`; no src code yet (flow 312 in flight). Project store `.metaproject/data/learning/candidates/<id>.json`.
- Schema validation: hand-rolled `validateAgainstSchemaObject` (`src/contracts/validator.ts:354`); `src/integrations/matrix.ts` imports its schema straight from `docs/requirements/.../schemas/`.
- No tar/gzip support in the repo and no runtime dependencies → a small in-repo ustar reader/writer over `node:zlib`.
- W5: only gemini-cli/kiro/github-copilot-agent have installable `instructions` surfaces (`markdown-block.ts`, fixed body, marker `keryx:instructions`); zed's is probe-only on AGENTS.md; claude/codex/cursor/windsurf have none. Opt-in surface precedent: `surfaces-agents.ts` (`optIn: true`).
