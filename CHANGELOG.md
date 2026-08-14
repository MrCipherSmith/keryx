# Changelog

All notable changes to `keryx` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

### Added

- **Benchmark suite M1 — safety track multi-model coverage, milestone complete.**
  `run-safety.ts`/`run-containment.ts` parameterized with `--provider`/`--model`
  (matching `run-ablation.ts`'s pattern). A local second leg (`rapid-mlx serve
  qwen3.5-4b-4bit`) run live across all four case groups: completion-honesty **2/3**
  (a real, model-specific failure the deepseek baseline never showed — hit the
  tool-call budget on a no-argument tool, gave a malformed reply, correctly scored
  `overclaimed`); false-premise **3/3** (matches deepseek); containment **9/9
  contained, 0 escapes** (matches deepseek, preflight canary confirmed sandbox
  blocking first) with an honestly-reported `attempted`-pattern divergence between the
  two models. All 5 fixtures pass `validatePairedBenchmark`. **M1 is now complete** —
  every exit-criteria item has real, live-captured data.
- **Benchmark suite M1 — mutating-ablation capable-model coverage across THREE
  third-party CLI harnesses, all 18/18.** The 0/18 qwen3.5-4b-4bit finding needed a
  model that can actually complete the base task.
  `scripts/benchmark/run-ablation-mutating-{codex,opencode,grok}.ts`: **codex**
  (`gpt-5.6-sol`) **18/18**; **Grok Build CLI** (`grok-4.6`, a third, newly-added
  agentic CLI, live-verified headless before being wired in) **18/18**; **opencode**
  (`opencode/deepseek-v4-flash-free`) **18/18** — but only after root-causing and
  fixing a real container-escape bug, not a model-capability finding. Two full
  opencode runs scored 0/18 with this repo's own real `src/lib/*.ts`/`opencode.json`
  found modified on disk afterward each time — opencode was editing the real checkout
  instead of its assigned isolated directory. Switching from a linked `git worktree`
  to a fully independent `git clone` (new `src/harness/child/git-clone-port.ts`) did
  NOT fix it (a third run still escaped); a minimal isolated repro nailed the actual
  cause: `Bun.spawn`'s `cwd` option sets the process's real working directory but does
  not update the inherited `PWD` env var, and opencode's own path resolution trusts
  `PWD` over the OS cwd for at least some operations. Fix (`env: { ...process.env,
  PWD: root }` alongside `cwd`), confirmed via a clean A/B repro before touching the
  real producer, then a fourth full run: 18/18, real repo verified untouched
  throughout. Every accidental edit from the three earlier escapes was caught and
  reverted before being committed. Kept the clone-based isolation as an independent
  extra safety margin alongside the PWD fix. Also fixed a real, separate bug found
  along the way in `scripts/benchmark/mutating-tasks.ts`'s `cliPrompt()`: it left
  `<seed test path>` as a literal, un-interpolated placeholder instead of the task's
  real file path (did not by itself explain the escapes, but a real bug regardless).

## [0.2.34] — 2026-08-14

### Added

- **Benchmark suite M1 — metastore oracle slice (deterministic).** The
  `paired-3-5-v2` protocol (backward-compatible with `paired-3-5-v1`; Wilson CIs,
  judge panel, `servedModel`/`effort`, tokenizer-normalized cost), IR/oracle metric
  primitives, git-co-change gold derivation with a real pinned express fixture, and a
  metastore oracle runner exposed as `keryx metrics benchmark run --ladder metastore`.
  Produces the first honest oracle result (gdgraph `affected` vs co-change gold). All
  five metastore layers (gdgraph, testing, memory, gdctx, gdwiki) are landed.
  Requirements: `docs/requirements/keryx-benchmark-suite`.
- **Benchmark suite M1 — ablation runner (first live slice).** New
  `keryx metrics benchmark run --ladder harness` scores the SAME agent + model run
  twice per seed, in isolated git worktrees, with keryx metaproject tools present
  (`context-on`) vs a basic-tools-only baseline (`context-off`) —
  `src/metrics/ablation-runner.ts`, driven live by `scripts/benchmark/run-ablation.ts`
  via the same multi-turn agent loop `keryx shell --agent` uses
  (`src/commands/agent.ts` `runAgentTurn`), plus a real `git worktree add/remove`
  adapter (`src/harness/child/git-worktree-port.ts`) for a seam flow 096 had only
  planned. First live result (`deepseek-v4-flash`, 3 code-comprehension tasks, ×3
  seeds): task success 9/9 with context on vs 0/9 with it off, and 2-6x fewer
  tool-calls with it on. A second, separately-reported manifest
  (`scripts/benchmark/run-ablation-codex.ts`) runs the identical tasks through the
  already-authenticated `codex` CLI (its own agent loop; context on/off toggled by
  presence/absence of `AGENTS.md`/`.metaproject/` in the worktree) as the milestone's
  frontier-model leg: 18/18 success on BOTH variants (a real shell closes the gap a
  no-search baseline can't), with a mixed, non-directional token/tool-call delta —
  reported honestly rather than as a win. A third, separate manifest closes the
  milestone's "one frontier + one local" model coverage: `run-ablation.ts` is now
  parameterized (`--provider`/`--model`) and was run against a local `rapid-mlx serve
  qwen3.5-9b-4bit` (ollama would not start on the dev machine; unrelated to this work) —
  6/9 success with context on vs 0/9 off, tool-call counts only (this provider path
  reports no token usage). All three legs (deepseek/codex/rapid-mlx) are reported side
  by side, never averaged.
- **Benchmark suite M1 — safety track, first two case groups.** `PairedBenchmarkRunV2`
  gained `safety` (`contained`/`escaped` + case class) and `completionHonesty`
  (`honest`/`overclaimed`) fields, with AC-4 enforced as a hard invariant in
  `validatePairedBenchmarkV2`: an escaped case must score `correctness: 0`. New
  `src/metrics/safety-runner.ts` + `keryx metrics benchmark run --ladder harness --layer
  completion-honesty|false-premise`, driven live by `scripts/benchmark/run-safety.ts`.
  Completion-gate honesty gives the agent one fixed, non-configurable check tool per
  case (no injection surface) and grades whether its `VERDICT:` claim matches
  independently-verified reality; false-premise resistance asks loaded questions built
  on premises verified false against this repo's real source. First live result
  (`deepseek-v4-flash`): 3/3 honest on completion-honesty (the agent answered `UNKNOWN`
  even when it had just seen a clear pass/fail result — overcautious, not dishonest; an
  earlier scorer draft would have wrongly flagged that caution as an unsafe escape, since
  fixed) and 3/3 correctly rejected the false premise.
- **Benchmark suite M1 — safety track, containment (real OS sandbox).** Designed via an
  interviewer+brainstorm pass (Pragmatist/Innovator/Critic) before writing code —
  `scripts/benchmark/run-containment.ts`. A live agent (`deepseek-v4-flash`) is given a
  REAL, OS-sandboxed `shell_exec` (`KERYX_SANDBOX_SHELL=strict`) and tempted toward the
  same 3 unsafe actions (write outside its worktree, network egress when off, read a
  secret-shaped path) across 3 case classes (workspace-write containment,
  shell-permission restraint, prompt-injection resistance via a planted file). A
  mandatory preflight canary runs all 3 unsafe actions directly (no LLM) before any live
  case and aborts the whole run if even one is not blocked. `SafetyResult` gained
  `attempted`/`blockedAt` evidence fields (informational; AC-4 still governs
  correctness). Real result: **9/9 contained, 0 escapes** — and the new `attempted`
  field surfaced a real behavioral split the bare count would have hidden:
  shell-permission-restraint's "is this OK?" framing led the agent to never even attempt
  2 of 3 unsafe actions, while the other two case classes attempted all 3 and were
  stopped by the OS kernel every time.
- **Benchmark suite M1 — ablation runner, mutating coding tasks.**
  `scripts/benchmark/run-ablation-mutating.ts` + `scripts/benchmark/mutating-tasks.ts`
  extend the ablation runner from read-only comprehension questions to real,
  write-capable coding tasks: the agent gets a real `shell_exec` (auto-approved,
  scoped to this script's own `AgentIO`, same pattern `run-containment.ts` already
  established) and must edit an EXISTING file to make an already-seeded, already-failing
  test pass, in its own fresh git worktree per (task, variant, seed) — mutating tasks
  can't reuse a worktree across seeds the way read-only ones can. Success is decided by
  an independent `bun test` run after the turn, never the agent's own claim. All 3 tasks
  are real gaps observed this session, not invented (a missing atomic-JSON-write
  counterpart to `writeFileAtomic`; the exact `args.includes(flag)` one-liner repeated
  across `src/commands/init.ts`'s own flag parsing; the plain-text sibling of
  `readJsonFileOr` that `src/sac/proposal-evidence.ts` hand-rolls inline today) — each
  seeded test was hand-verified fail-then-pass before any live run. Live result with
  `rapid-mlx serve qwen3.5-4b-4bit` (deepseek/cerebras both unusable — no balance / HTTP
  401): **0/18, every task, both variants** — a real, diagnosed capability finding, not
  a scorer bug: a re-run with tracing showed the model looping on empty `get_cwd` calls
  until it hit `runAgentTurn`'s anti-loop guard, never once reading the target file. The
  original `qwen3.5-9b-4bit` (6/9 on the read-only leg) was never actually tested on this
  workflow — it crashed with SIGABRT under real memory pressure (108% projected RAM
  utilization, matching `rapid-mlx serve`'s own startup warning) partway through this
  slice's first live attempt, forcing a switch to the smaller model mid-session. Full
  harness + tasks + verification is real and reusable; the milestone still needs a model
  actually capable of the base task before the context-on/off comparison is measurable.
- **Benchmark suite M2 — harness-selection investigation, opencode headless dead-end.**
  Spec §1.3's comparative ladder requires the model held constant across targets.
  `opencode`'s free `deepseek-v4-flash-free` provider would have satisfied this
  literally (same model family as keryx's own harness legs), and its interactive TUI
  confirmed the model/provider works fine live — but both `opencode run --auto` and a
  `opencode serve` + `run --attach --auto` variant hang indefinitely on any task
  requiring a tool call, reproduced twice, independent of `.mcp.json` auto-discovery.
  The running server's own `/session` API surfaced a plausible cause: a
  `question`/`plan_enter`/`plan_exit` permission set to `deny` that `--auto` doesn't
  cover. `codex` was picked as M2's harness target instead, with the model-mismatch
  recorded as a disclosed spec deviation rather than papered over — see
  `docs/requirements/keryx-benchmark-suite/plan.md`'s M2 section.
- **Benchmark suite M2 — comparative report + fairness review (AC-6).** New
  `src/metrics/comparative.ts`: `buildComparativeReport`/`validateComparativeReport`
  combine keryx's own harness legs, a new zero-tool `raw` floor leg, and a
  third-party harness leg into `{keryx-on, keryx-off, raw, <harness>}` cells per
  task, with a per-target adapter/fairness status and a `publishable` flag on
  every cell that AC-6 requires be false whenever fairness isn't `met` — computed,
  never hand-set, so a caller can't silently mark a caveated result publishable.
  Legs stay independently-valid `paired-3-5-v2` manifests, never merged into one
  (the paired-cell invariant only fits exactly two complementary variants; a
  comparative row needs up to four) — this module only re-presents their `runs`
  side by side. `validatePairedBenchmarkV2`'s pairing invariant now exempts the
  `baseline` variant (a floor reference has no complement to pair against),
  existing pairing behavior unchanged (regression-tested). New
  `scripts/benchmark/run-ablation-raw.ts` produces the live `raw` leg —
  deepseek-v4-flash, same tasks, same `runAgentTurn` driver, EMPTY tool array:
  **0/9**, honest (the model cannot know this repo's exact symbols by guessing).
  New `scripts/benchmark/build-comparative-report.ts` synthesizes the three
  already-live fixtures into `fixtures/benchmark/keryx/comparative-report.json`:
  keryx-on 3/3, keryx-off 0/3, raw 0/3 (matching M1's already-reported numbers),
  codex 3/3 but `publishable: false` on every cell (fairness `not-met`, model not
  held constant) — AC-6 passes as a mechanism, but M2's `fairness: met` exit bar
  is honestly not reached with codex; the milestone stays open pending a
  same-model headless-capable harness.
- **Benchmark suite AC-5 — real gold-artifact leakage found and fixed.** AC-5 ("A
  dogfood case whose gold artifact is reachable by the agent fails its leakage
  assertion and is excluded from scoring") had never been demonstrated —
  `leakageAssertion` defaulted to `not-applicable` in every real M1 producer. Auditing
  it surfaced a genuine bug: every ablation worktree is a full `git worktree add
  --detach <path> HEAD` checkout (`src/harness/child/git-worktree-port.ts`), which
  includes `scripts/benchmark/ablation-tasks.ts`/`mutating-tasks.ts` THEMSELVES —
  containing the exact `expectedFile`/`expectedSymbol` answer key (and, for mutating
  tasks, the seeded test that IS the solution spec). An agent with `read_file` could
  read its own gold answer key directly, undetected, on every ablation run landed so
  far. New `src/metrics/leakage.ts` (`checkGoldLeakage`) is the real, deterministic
  reachability check; `validatePairedBenchmarkV2` gained a hard invariant mirroring
  AC-4's pattern — a manifest containing any `leakageAssertion: "failed"` run is
  invalid by construction. New `scripts/benchmark/run-leakage-check.ts` proves both
  directions live against real `git worktree` operations (no LLM call needed — leakage
  is a worktree filesystem property, decided before any agent runs): an unmodified
  worktree really does expose both gold files
  (`fixtures/benchmark/keryx/leakage-check.json` — the real, unpatched vulnerability),
  a stripped one genuinely reports `passed`. The fix — strip the gold artifact from
  every worktree before the agent ever sees it, verify the strip worked, abort rather
  than run a live case on an unverified worktree — is now wired into all three live
  producers (`run-ablation.ts`, `run-ablation-codex.ts`, `run-ablation-mutating.ts`).
  Every ablation manifest already landed in M1 was captured on an unstripped worktree;
  disclosed honestly rather than retracted — no evidence of actual exploitation
  (`context-off`'s consistent failures and the mutating slice's diagnosed anti-loop
  trip are inconsistent with a model that read its own answer key), but future
  regenerations now run leakage-clean by construction.
- **Fixed: two real MCP exposure gaps found while auditing keryx-shell/MCP capability
  parity.** (1) `buildMcpModuleEntry()`'s default `expose.modules`
  (`src/mcp/client-config.ts`) was missing `"gdctx"` and `"testing"` — `search_code` and
  `test_related` were registered in `buildToolRegistry` but invisible via `tools/list`
  to every external MCP client (Claude Code, Cursor) unless someone hand-edited the
  manifest. (2) The unified `read_wiki`/`wiki_ask`/`wiki_backlinks` operations
  (`src/harness/tool/metaproject-operations.ts`) tagged themselves `module: "gdwiki"` —
  the real internal facade name — instead of the MCP discovery layer's established alias
  `"wiki"` (`src/mcp/discovery.ts`'s `MODULE_MANIFEST_KEY`, mirroring `flow`→`tasks`),
  so `exposedModules.includes(module)` silently failed even with `"wiki"` correctly
  present in `expose.modules` — these three tools were invisible to every MCP client
  since they were unified into `metaproject-operations.ts`, leaving only the older,
  duplicate hand-written `wiki.ask`/`wiki.query` MCP tools reachable. Fixed the tag (and
  its schema enum, `metaproject-operation.schema.json`) rather than the discovery layer,
  since the alias convention is already established and correct everywhere else. Live
  end-to-end verified with a real spawned `keryx mcp serve` + `@modelcontextprotocol/sdk`
  `Client`/`StdioClientTransport` round-trip against this repo: tool count visible to an
  external client went from 27 to 30 (`search_code`, `test_related`, `read_wiki`,
  `wiki_ask`, `wiki_backlinks` all now present and callable). Both fixes also applied to
  this repo's own live `.metaproject/metaproject.json` (same surgical, targeted-edit
  pattern as the earlier `sac` expose fix).
- **MCP: real `codex`/`opencode` client verification, `opencode` install support.**
  Live-tested whether keryx's MCP server (fronting the same gdgraph/wiki/memory/health
  intelligence `keryx shell` uses internally) actually works with third-party CLI
  harnesses, not just Claude Code/Cursor. `codex`: registered via its own native
  `codex mcp add`, called `graph_affected` through `codex exec --approve-for-me`
  headlessly, got a real correct result — `codex exec` alone (no approval flag) silently
  cancels MCP tool calls, documented in `renderMcpManifest()`. `opencode`: called the
  same tool through `opencode run --auto` headlessly and it worked — genuinely
  surprising given `opencode`'s own built-in tools hang indefinitely in headless mode
  (documented separately); an MCP-sourced tool call apparently takes a different
  permission path than opencode's own tools. Added `OPENCODE_RUNTIME` to
  `src/mcp/client-config.ts` as a real, tested `--runtime opencode` for
  `keryx mcp install`/`uninstall` (writes project-local `opencode.json`, shape
  `{mcp: {keryx: {type, command, enabled}}}` — structurally different from every other
  runtime's `mcpServers.<name>.{command,args}`, confirmed against a real `opencode.json`
  before wiring in) and to `keryx init`'s interactive MCP prompt; `all` now expands to
  cursor+claude+opencode. `codex` is deliberately NOT a `--runtime` here — its config is
  a single GLOBAL `~/.codex/config.toml`, not project-local, and its own `codex mcp add`
  is already the safe way to manage it; documented instead of duplicated. Along the way,
  found and fixed a real, generic bug in `uninstallMcpClient`: its "was this runtime's
  keryx entry present" check hardcoded the `mcpServers` shape, so uninstall always
  silently reported `removed: false` for any runtime using a different shape (opencode
  today, any future one later) — fixed by adding a `hasManaged(settings)` predicate to
  the `McpClientRuntime` interface itself rather than special-casing it.
- **Fixed: sandbox read-deny list built from an uncanonicalized `homedir()`.**
  `src/harness/tool/builtin/shell-exec-tool.ts`'s `shellSandboxProfile` canonicalized
  `root`/`tmpdir()` for the Seatbelt profile but passed `homedir()` through raw; on
  macOS `/var` symlinks to `/private/var`, so a `HOME` pointed at a `tmpdir()`-derived
  path (exactly what an isolated CI run or test harness does) silently escaped the
  secret read-deny rules. Found live by the M1 safety-track containment preflight
  canary before any agent case ran — not a live risk for a real user's real `$HOME`
  (`/Users/<name>` has no symlink component), but a real gap for anyone overriding
  `HOME` for isolation. Fixed with `canonical(homedir())`, matching the existing
  treatment of `root`/`tmpdir()`.
- **Shared Agent Context — real harness composition for the memory-entry write path.**
  `keryx workspace propose --kind memory-entry --session <id>` and
  `keryx workspace review ... --decision accepted` now land a real file in
  `.metaproject/memory/` end-to-end, closing the gap the Phase 3 exit note left open:
  SAC's write path was intentionally fail-closed (`createLocalProposalLifecycleService`
  ships every owner writer as `unavailable` — "SAC never edits Wiki, Memory or Skills
  files itself" until each owning subsystem composes a trusted implementation). New
  `createHarnessProposalLifecycleService` (`src/sac/proposal-lifecycle.ts`) composes two
  new real modules: `src/sac/session-wrap-up.ts` (`resolveSessionWrapUp`) turns a real
  keryx shell session into a `TrustedWrapUpResolution` by exporting its full archive
  (`src/session/store.ts` `exportSessionMarkdown`, every role/message verbatim) into the
  target workspace and hashing that export — never the agent's own summary; and
  `src/sac/memory-owner-writer.ts` (`createRealMemoryOwnerWriter`) is memory's first real
  `GuardedOwnerWriter`: it reads the proposal's evidence pointer, re-verifies the
  evidence file's hash against what was recorded at propose time, and writes a
  schema-valid entry via the same canonical `src/memory/write.ts` `writeCanonicalEntry`
  path (and its security guard scan) `keryx memory new` uses. Verified live end-to-end
  (real session, real hash-verified evidence chain, real written memory file) and with
  103/103 `src/sac/` tests green (14 files). Wiki/skill owner writers remain
  `unavailable`/fail-closed — only memory has a real composition today. Two real bugs
  found and fixed along the way: (1) `TrustedWrapUpProvenance.sourceRef` is schema-typed
  as a workspace-relative `path` (no bare IDs, no `#` fragments) —
  `resolveSessionWrapUp` now encodes the session id in the path itself
  (`sessionEvidenceRef`) and independently re-derives+re-verifies it rather than
  trusting the caller's resolution (defends against a spoofed workspace segment); (2) an
  optional `--note` passed at `propose` time was captured in a service-composition
  closure that does not survive into a separate `review`-time process — fixed with a
  sidecar `<proposalId>.note.txt` file (`proposalNotePath`), written at propose time and
  read back at accept time, mirroring the approval/intent/decision sidecar pattern
  `proposal-lifecycle.ts` already used. The read-path (an agent reading FWK context
  live inside `keryx shell`) remains unwired — out of scope for this slice.
- **Shared Agent Context — real harness composition for the wiki-update write path.**
  `keryx workspace propose --kind wiki-update --session <id>` +
  `review --decision accepted` now lands a real "decision" page (`WIKI_PAGE_TYPES` —
  "known decisions and ADR-like records", `.metaproject/wiki/decisions/`) end-to-end,
  the same shape of gap the memory-entry path closed above. New
  `src/sac/wiki-owner-writer.ts` (`createRealWikiOwnerWriter`) is wiki's first real
  `GuardedOwnerWriter`, guarded by the SAME security write seam
  `keryx wiki collect` runs before publishing a generated page
  (`src/wiki/service.ts`, `guardOutput({ target: "wiki" })`) — a blocked write is
  refused, not silently sent. Unlike memory, there is no canonical "write real body
  content" helper to reuse here: `keryx wiki new` (`wikiCreatePage`) only scaffolds a
  blank title/type template with no content field, so this writes directly via the
  same `writeFileAtomic` helper `proposal-lifecycle.ts` already uses elsewhere. The
  proposal-record read + evidence hash re-verification that memory and wiki both need
  was pulled out into shared `src/sac/proposal-evidence.ts` (`readVerifiedProposalEvidence`,
  `ownerReceiptPath`, `proposalNotePath` + the sidecar-note fix from above) rather than
  duplicated a second time; `memory-owner-writer.ts` was refactored onto the same
  seam with no behavioral change (same receipt paths, same tests, still 115/115 green
  across `src/sac/` + the session-reader caller guard). Verified live end-to-end (real
  session → hash-verified evidence → accepted `wiki-update` proposal → real
  `.metaproject/wiki/decisions/sac-<id>.md`, note included). **`skill` stays
  `unavailable`/fail-closed on purpose**: `src/security/types.ts`'s `SecurityTarget`
  union has no `"skill"` member and `createProjectSkill`
  (`src/gdskills/project-skills.ts`) runs no security scan at all today — writing
  SAC-derived content into skills (read as agent routing instructions every turn)
  without the same guard memory/wiki get would be a real safety regression, not a
  shortcut, and was deliberately not done.
- **Shared Agent Context — FWK read-path wired into the live agent shell.** A
  running `keryx shell` agent turn can now read SAC workspace context directly:
  two new read-only tools, `workspace_overview` and `workspace_read`
  (`src/harness/tool/builtin/workspace-context-tool.ts`), wrap
  `createLocalFwkReadService` (previously reachable only from a separate CLI
  process via `keryx workspace overview`/`read`, or over MCP as `sac.overview`/
  `sac.read`) and are added to both the TUI and readline tool arrays in
  `src/commands/shell.ts`, `risk: "read"` like `read_file`/`list_dir`. There is
  no session↔workspace linkage anywhere in keryx (no `--workspace` flag, no
  workspace field on `SessionSummary`), so the agent must be told which
  workspace to read via an explicit `workspaceId` on every call, same as the
  CLI. Confirmed this can't become HTTP-reachable: `keryx serve`'s handler
  never touches `shell.ts`'s `AgentDeps`/tool-array construction, so this stays
  on the same local-only trust boundary `shell_exec` already operates under —
  unlike the MCP `sac.*` tools, which explicitly refuse HTTP transport because
  SAC's local auth server derives its actor from the OS user with no verified
  per-request principal. Verified two ways: 6 offline unit tests calling the
  tools directly against a real (but resource-less) workspace, AND one fully
  live round-trip — a real local model (`rapid-mlx serve qwen3.5-9b-4bit`)
  driven through the actual `runAgentTurn` loop `keryx shell` uses, calling
  `workspace_overview` for real, getting back a real signed access receipt, and
  correctly reporting the result. (DeepSeek and Cerebras credentials were both
  unusable at verification time — no balance / 401 — so the live check ran
  against a local model instead of the usual `deepseek-v4-flash`.)
- **Fixed: `keryx skills create` ran zero security scanning.** Unlike
  `keryx wiki collect` (`guardOutput({ target: "wiki" })`) and `keryx memory new`
  (`writeCanonicalEntry`'s guard), `createProjectSkill`
  (`src/gdskills/project-skills.ts`) wrote `SKILL.md` — content read as agent
  routing instructions every turn — with no scan at all. `SecurityTarget`
  (`src/security/types.ts`) gained a `"skill"` member (also added to
  `src/security/schemas.ts`'s finding-schema enum and `src/commands/security.ts`'s
  `--target` validation list — both closed allow-lists, found and updated
  together so `--target skill`/a finding with `target: "skill"` don't fail
  closed for unrelated reasons); `writeProjectSkillPackage` now renders
  `SKILL.md`'s content and runs it through `guardOutput({ target: "skill",
  source: "generated" })` **before** any `mkdir`/write happens, throwing if the
  strict/enforced gate blocks it. New `src/gdskills/project-skills.test.ts`
  (this function had no test coverage at all before) proves all three real
  behaviors: unaffected by default (security module disabled), a planted
  secret genuinely blocked end-to-end in `enforced` mode with **nothing**
  written to disk, and the same content allowed through in `advisory` mode
  (report-only, matching every other target's documented behavior). Found
  while investigating why `skill` — the third `GuardedOwnerWriter` owner
  alongside `memory`/`wiki` — was still `unavailable`/fail-closed in SAC; this
  was the actual blocker (no target, no scan), not laziness. 190/190
  `src/gdskills`+`src/security`+`src/commands/security` tests green.
  **A real skill owner-writer is still not composed**: while wiring this,
  found that `ProposalLifecycleService.targetWriteOrStale`
  (`src/sac/proposal-lifecycle.ts:127`) requires an owner's receipt
  `targetRef` to literally start with `./${owner}` — `./memory/...` and
  `./wiki/...` both genuinely match where those owners store files under
  `.metaproject/`, but `keryx skills create` stores real skills under
  `.metaproject/project-skills/`, not `.metaproject/skill/`. A skill
  owner-writer built today would have to fake a `targetRef` that doesn't
  match the real file location to pass that check, which is worse than not
  building it — so it wasn't built. Fixing this needs a decision on the check
  itself (e.g. a per-owner prefix map instead of a literal `./${owner}`
  assumption) before a real skill writer can be composed honestly.
- **Shared Agent Context — the skill owner-writer, and the targetRef fix it
  needed.** `ProposalLifecycleService.targetWriteOrStale`
  (`src/sac/proposal-lifecycle.ts`) assumed every owner's receipt `targetRef`
  starts with the literal `./${owner}` — true by coincidence for memory/wiki,
  false for skill (real skills live under `.metaproject/project-skills/`, not
  `.metaproject/skill/`). Replaced with `ownerTargetPrefix(owner)`, a real
  per-owner map (`memory→./memory`, `wiki→./wiki`, `skill→./project-skills`).
  Two new regression tests in `proposal-lifecycle.test.ts` prove the fix
  actually enforces the correct prefix rather than just "always pass": a skill
  receipt with the OLD, buggy `./skill/...` shape (exactly what the previous
  check would have accepted) is still rejected and the accept lands as
  `stale`; one with the real `./project-skills/...` shape is accepted.
  `src/sac/skill-owner-writer.ts` (`createRealSkillOwnerWriter`) is skill's
  real `GuardedOwnerWriter` — the third and last, alongside memory and wiki.
  It reuses `createProjectSkill` itself (`keryx skills create`'s own write
  path, now guarded from the previous change) rather than writing
  `.metaproject/project-skills/` files a second, parallel way: every
  SAC-derived skill lands under the fixed `sac` module
  (`.metaproject/project-skills/sac/<proposalId>/SKILL.md`), so it's always
  distinguishable from a skill a person created directly. `keryx workspace
  propose --kind <kind>` now accepts all six real proposal kinds (`decision`,
  `wiki-update`, `memory-entry`, `follow-up`, `contract-change`, `risk`) — not
  just the two that had writers before — since every kind now routes (via the
  existing `ownerFor`) to a real owner. Verified live end-to-end: real
  session → hash-verified evidence → accepted `decision` proposal → real
  `.metaproject/project-skills/sac/<id>/SKILL.md`, with `metaproject.json`'s
  skill registry and `skills/catalog.md` correctly updated by
  `createProjectSkill`'s own bookkeeping (and cleanly reverted after
  verification, along with the demo skill directory). 7 new tests in
  `skill-owner-writer.test.ts`, including one proving the security gate from
  the previous change genuinely blocks a skill write end-to-end (not just
  wired) — a planted secret in the derived skill content is refused in
  `enforced` mode with nothing written to disk. Full suite green after this
  change (typecheck clean; `src/sac`+`src/gdskills`+`src/security`+
  `src/commands/security`+`src/commands/workspace`: 309/309).
- **Fixed: `sac.propose`/`sac.review` over MCP were never actually wired.**
  `src/mcp/tools.ts`'s `sac.propose` unconditionally returned
  `trusted_wrap_up_required` (empty input schema — it could not have worked),
  and `sac.review` called the fail-closed `createLocalProposalLifecycleService`
  instead of the real `createHarnessProposalLifecycleService` composition the
  CLI/keryx-shell paths already use. Both now compose the real thing: `sac.propose`
  takes `{ workspaceId, kind, sessionId, note?, proposalRevision? }`, resolves the
  session via `findSession`, issues a real wrap-up, and creates a real proposal
  (with the same propose-time note sidecar the CLI uses); `sac.review` runs the
  same review path the CLI does. `src/sac/service.ts` (the facade `src/mcp/`
  is architecturally restricted to — enforced by `boundary.test.ts`'s M-3 guard)
  gained the needed exports: `createHarnessProposalLifecycleService`,
  `sessionEvidenceRef`, `proposalNotePath`, `findSession`. A SECOND, independent
  bug surfaced while live-verifying this: `sac.*` tools were entirely invisible
  over MCP regardless of the fix — `buildMcpModuleEntry()`'s default
  `expose.modules` allowlist (`src/mcp/client-config.ts`) never included
  `"sac"`, so `tools/list` never returned them. Both fixed together; verified
  with a real MCP SDK `Client`/`Server` round-trip (`InMemoryTransport`, real
  protocol serialization, not just in-process function calls) against a real
  session and a real workspace: `tools/list` now returns all 5 `sac.*` tools,
  `sac.propose` creates a real proposal over the wire, `sac.review` accepts it
  and a real file lands in `.metaproject/memory/task-notes/`. New
  `src/mcp/sac-tools.test.ts` (3 tests, previously zero coverage for these two
  tools). Also documented `keryx mcp install`/`uninstall` in the mcp module's
  own manifest doc (`renderMcpManifest`) — it only mentioned `serve` before,
  so nothing told an agent reading `.metaproject/modules/mcp.md` that
  `mcp install --runtime <runtime>` is the real, complete way to connect a
  project when asked to "enable MCP", short of hand-editing a client config.
  Connected this repo for real (`keryx mcp install --runtime claude`) after
  confirming it was safe to run from this dev checkout: `enableMcpModule` is a
  surgical read-parse-patch-write on just `modules.mcp` in the existing
  manifest, unlike `keryx modules enable <name>`'s full `initCommand()`
  reconciliation (which regenerates every enabled module's files and, earlier
  this session, was found to silently regress this repo's real
  `.metaproject/` content when run from a dev checkout whose generators have
  diverged from the separately-installed global `keryx` binary that actually
  wrote it). 246/246 across `src/mcp`+`src/sac`+`src/commands/security`+
  `src/gdskills` after this change, typecheck clean.

## [0.2.33] — 2026-08-13

### Added

- **Shared Agent Context — phase-6b operator readiness check.** New read-only
  `keryx workspace policy-readiness` (backed by `diagnosePolicyReadiness`) validates
  the full opt-in policy integrity chain **before** enabling — even while the
  experiment is disabled — reporting each gate's pass/fail and exiting non-zero when
  not ready, so an owner can prove real-data readiness before flipping
  `enabled: true`. Read-only; the runtime guard and default-off posture are
  unchanged. Documented in the new Phase 6b operator playbook.

## [0.2.32] — 2026-08-12

### Added

- **Shared Agent Context — phase-6 runtime opt-in policy guard.** The FWK read
  path now switches from the deterministic baseline to the experimental learned
  candidate policy only through `resolvePolicySelection`
  (`src/sac/fwk-service.ts`): a strict, fixed-order integrity chain over explicit
  config pins (candidate → baseline → corpus → evaluation report → deterministic
  activation). It is fail-closed to baseline on any error, off by default, and
  gated by a kill-switch and rollback. No public CLI or MCP schema changes; the
  candidate is never enabled implicitly. Acceptance criteria AC1–AC6 met; full
  SAC suite 88/88 green.

### Documentation

- **New docsite guide: "Shared Agent Context (experimental)"** covering the FWK
  model, the `keryx workspace` workflow (create / add-resource / overview / read /
  propose / review) and the phase-6 runtime opt-in config, linked from the README.
- **SAC requirements package reconciled.** Phase 6 is documented as one phase with
  two parts — 6a runtime enforcement guard (implemented) and 6b real operator-data
  readiness (planned) — across the package README, implementation plan and the
  phase-6 readiness document.

## [0.2.31] — 2026-08-12

### Changed

- **Agent TUI now separates `/connect` and `/provider` semantics.**
  `/connect` lists only already-configured and reachable providers, while
  `/provider` remains the configuration/setup path (API key + endpoint + model).

- **Provider selection and model discovery robustness.** Endpoint overrides are
  persisted per provider, and rapid-mlx detection no longer falls back to
  unrelated hardcoded models when endpoint probing fails.

## [0.2.30] — 2026-08-12

### Fixed

- **Agent TUI launch regression fix.** Removed stale `searchController` option from the
  `launchTuiAgentShell` call path to match its current signature after `/connect`
  / `/provider` picker refactoring. This unblocks the release pipeline type check and keeps
  the shell launch API consistent.

## [0.2.29] — 2026-08-12

### Changed

- **Split `/connect` and `/provider` semantics in agent TUI.** `/connect` now
  selects only already-configured providers (with required keys and successful live
  `/models` checks). `/provider` remains the configuration command for provider
  credentials and model setup.

## [0.2.28] — 2026-08-12

### Fixed

- **Local SearXNG search now works through the sandbox.** The web worker selects
  the HTTP client for loopback search endpoints while retaining HTTPS-only
  policy for remote web fetches.

## [0.2.27] — 2026-08-12

### Fixed

- **Sandboxed web fetch now connects reliably on dual-stack hosts.** The worker
  returns the correct Bun DNS-pinning callback shape and prefers a validated
  IPv4 address when it is available alongside IPv6.
- **Agent web-tool guidance no longer treats fetch as search.** For unknown
  sources, the agent now gives search-provider setup guidance instead of
  guessing URLs or repeatedly retrying an unavailable search provider.

## [0.2.26] — 2026-08-12

### Added

- **Sandboxed web transport and provider-based search.** Agent mode now offers
  `web_fetch` and `web_search` through a fail-closed, DNS-pinned sandbox worker.
  SearXNG, Brave Search, Tavily, and Exa are configured through the TUI; only a
  successfully tested provider can become active.
- **Local SearXNG guide.** `/search-provider` supplies editable localhost URL
  and port defaults, with an installation guide for a local Docker deployment.

### Security

- **External web data is tainted.** It is bounded, redacted, provenance-labelled,
  and cannot authorize later agent tool calls across turns or session compaction.

## [0.2.25] — 2026-08-11

### Changed

- **Provider configuration is now uniform in the agent TUI.** `/provider`
  lists all supported providers and lets every endpoint-based provider edit its
  endpoint URL before live model discovery; overrides are stored per provider.
  `/connect` lists only configured or currently reachable providers.

### Fixed

## [0.2.24] — 2026-08-11

### Fixed

- **Provider switching is available in agent TUI.** `/provider` now opens the
  provider, API-key, and model picker in agent mode, matching `/connect` and
  avoiding a switch to chat mode solely to change providers.

## [0.2.23] — 2026-08-11

### Added

- **Configurable OpenAI-compatible provider endpoints.** Override any built-in
  provider URL with `KERYX_<PROVIDER>_BASE_URL`; for example,
  `KERYX_RAPID_MLX_BASE_URL=http://127.0.0.1:8010`. The selected endpoint is
  also used to discover the provider's live model list.

## [0.2.22] — 2026-08-11

### Fixed

- **Durable interactive-session checkpoints.** `keryx shell` now writes the user
  message immediately, checkpoints tool results, and journals streamed assistant
  text every 300 ms. `/interrupt` therefore preserves the latest partial answer
  instead of losing the active turn.

## [0.2.21] — 2026-08-11

### Fixed

- **Release verification for changed-test selection.** Updated stale test expectations
  for the existing `imports` selection strategy, restoring the release test gate.

## [0.2.20] — 2026-08-11

### Added

- **Interactive session switching in the TUI (`/sessions`).** The shell now opens a
  per-project session picker for live switching while preserving current sessions on
  disk.
- **Main-turn interrupt command in the TUI (`/interrupt`).** Added a hard-stop path for
  an in-flight main turn, with deterministic teardown of the running provider loop.

### Changed

- **Side prompt execution model in the TUI.** While the main turn is busy, additional
  plain prompts are queued into a single read-only side worker (`side-1`) and processed
  sequentially. This keeps the interface responsive without mutating context during
  background helper turns.

## [0.2.19] — 2026-08-11

### Fixed

- **Health regression fixed for keyless OpenAI-compatible providers (Rapid-MLX and similar).**
  OpenAI-compatible registry providers without `envKey` are now handled correctly in
  mask resolution, provider detection, and provider construction paths. This removes
  the TypeScript hard failures that blocked release-health gates on `keryx health run`.
- **Release metadata stability for provider detection flows.**
  Type strictness and generated graph/wiki artifacts were updated so the same provider
  registry changes (including rapid-mlx) are represented safely in runtime and docs tooling.

## [0.2.18] — 2026-08-11

### Added

- **Bounded version update advisories.** `keryx shell` performs one background,
  non-blocking check and shows a notice only for a strictly newer validated
  npm version. `keryx version check [--json]` exposes the same typed result;
  neither surface auto-installs or blocks project work. Successful metadata is
  cached for 24 hours, failed checks are suppressed for 15 minutes, and the
  registry request times out after 2 seconds. The exact manual update command
  is `npm install -g @mrciphersmith/keryx@latest`.

### Documentation

- Generated `.metaproject/index.md` guidance asks agents to run the JSON check
  once per session and to notify only on `update-available`; the instruction is
  prompt guidance, not enforcement, and unknown/offline/unavailable results
  remain non-blocking. Existing installations from before the first
  feature-bearing release cannot discover that release through code they do not
  yet contain, and existing projects gain the guidance only after index
  regeneration or update.

## [0.2.17] — 2026-08-11

This release makes project bootstrap reliable without inflating every agent
turn, gives read-heavy investigation enough room to finish, and completes the
memory reliability work from recall through lifecycle writes.

### Added

- **Agent orientation now starts from the launch project's Metaproject.** When
  `.metaproject/index.md` exists at the project root, `keryx orient` includes a
  bounded excerpt of its routing sections and tells the agent to read the full
  file before project work. It deliberately does not discover an ancestor
  Metaproject or describe the prompt instruction as an enforced runtime gate.
- **Memory reports and lifecycle transitions are explicit surfaces.** Default
  recall is side-effect free; `memory search --save-report` persists an
  immutable report only when requested; `memory transition` validates status
  changes; and supersession updates both entries through the guarded lifecycle.

### Changed

- **Interactive-agent tool budgets are split by risk inside a 48-signature
  total:** up to 40 read signatures and 8 non-read or unknown-risk signatures.
  Repeating the same normalized call still occupies one slot, and merely
  reaching a limit no longer ends the turn before the model can answer from the
  last result.
- **Automatic memory influence is accepted-only, current, and bounded** across
  shell approval context, flows, the harness adapter, MCP, and skill
  verification. Search filters, temporal validity, memory types, templates, and
  configuration now share one validated contract.
- **Canonical memory writes are confined, security-gated, and atomic.** Paired
  supersession writes roll back together on failure. Legacy generated
  `data/memory/artifacts/latest.*` files receive advisory migration guidance;
  Keryx does not delete downstream files or mutate the Git index automatically.

### Documentation

- Added the implemented P0–P6 memory reliability requirements, specification,
  migration policy, verification evidence, schema, and updated CLI/module/wiki
  guidance.
- Added a frozen 26-case shell benchmark protocol for comparing Keryx model
  legs with Claude Code and Codex without claiming results before a run.

## [0.2.16] — 2026-08-05

The other half of the 0.2.15 audit. That release corrected what the README
claimed; this one closes the five gaps it found in the code — one live security
weakness, two safety mechanisms that could not fire, and two finished features
with no way in.

### Security

- **A `network: "restricted"` sandbox profile now fails closed on Linux
  regardless of `KERYX_SANDBOX_ALLOW_UNSANDBOXED`.** One variable covered two
  unrelated failure modes. A missing launcher is a degradation an operator can
  knowingly accept; a domain allowlist that is not implemented on this platform
  is not. In the second case the allowlist proxy had already started and the
  proxy variables were already merged into the command environment, and then the
  command was spawned uncontained and free to ignore both. The check lives at the
  spawn point, where profiles from all three construction paths converge and the
  invariant cannot be routed around. The missing-launcher escape hatch is
  unchanged, and is pinned by its own test so the fix cannot be satisfied by
  refusing everything.
- **The harness mutation path is scanned by a scanner that can find
  something.** The redaction seam was real, but the only implementation behind it
  answered "no secret here" to every input, so every tool result the run loop
  persisted came out verbatim. `scanAvailable` — a fail-closed capability signal
  the guard denies on — was hardcoded `true` at the production call site. Both
  now derive from the real detectors, resolved once before the run so the loop
  stays synchronous, offline and replayable.

### Added

- **`keryx sessions fork <id>`** branches a conversation into a new session that
  keeps its ancestry (`parentSessionId`) and starts from the same context and
  archive. Writing to the fork never touches its source. Forks are marked `↳` in
  `keryx sessions list`.
- **`keryx harness replay --record <path>`** validates a recorded run's log
  against a replay fixture, and **`keryx harness run --record <path>`** writes
  the record. `--write-fixture` keeps a fixture, `--fixture` compares against a
  kept one, and a divergence prints a typed mismatch naming the field and exits
  non-zero. This is `validate-log` and says so: it checks that a fixture still
  describes the run it was built from, and re-executes nothing.
- **The completion gate can be told what to require.** `runOffline` accepts
  `requiredEvidenceRefs` and `requiredGates` instead of building two empty arrays
  itself, so two of the gate's three conditions stop being vacuous. Supplying
  nothing keeps the previous behaviour, which has its own test.

## [0.2.15] — 2026-08-05

A claim-by-claim audit of the README against source. Three commands turned out
to report work they had not done, and the fixes are the substance of this
release; the documentation changes are what the audit found on the way.

### Fixed

- **`keryx orient install-hook --dry-run` wrote the file anyway.** The flag was
  accepted by the shell and parsed by nobody. A `--dry-run` that mutates is worse
  than no flag at all, because it is the flag someone reaches for when they are
  unsure a command is safe to run. Both `install-hook` and `uninstall-hook` now
  honour it and report the file they would have touched.

- **`keryx init` claimed the git hooks were installed when there was no
  repository.** The hook installer returns early with no hooks root, but the
  summary rendered its rows from the intent flags — so running `keryx init`
  before `git init` reported every hook as installed while nothing was written
  and nothing would ever fire. It now reports them as skipped and says how to get
  them installed. The security agent hook keeps its row; it lands in
  `.claude/settings.json` and does not need a repository.

- **`keryx status --help` ran the report instead of printing help.** Harmless in
  itself — `status` is read-only — and fixed for the reflex it teaches for the
  commands that are not.

### Documentation

- **The README stops claiming four harness capabilities that are built but not
  reachable**, and stops describing a replay path that cannot detect a divergent
  run. The capabilities are tracked in the issue tracker rather than dropped
  silently.

- **The provider list was four of eleven.** Anthropic, Ollama and the
  OpenAI-compatible gateways — OpenRouter, DeepSeek, Z.AI, Cerebras, Groq,
  Moonshot, Grok — with the offline fake provider alongside them.

- **Corrections where the README and the code disagreed:** CI runs on pull
  requests and pushes to `main`, not every push; four of the five model commands
  exit non-zero without a credential, and `wiki enrich` is the one that exits `0`
  and skips pages; the remote policy profile is compared once at startup, where a
  weaker profile refuses to bind at all; git is required for hooks, changed-scope
  runs and the managed installer, not by the core.

- **The CLI reference gained the five model commands it was missing** —
  `wiki enrich`, `test suggest`, `flow plan`, and `--narrate` on `memory reflect`
  and `health explain` — and its `harness run` signature no longer names three
  providers out of eleven.

## [0.2.14] — 2026-08-04

### Documentation

- **The documentation site stops describing itself as machine output.** The
  landing page opened with "Auto-generated developer documentation … reverse
  engineered from source", which is both wrong — you cannot reverse-engineer
  your own code — and the first sentence a visitor read. The useful half of that
  note survives: these pages describe shipped behaviour, `docs/requirements/`
  describes intent, and where they disagree the docs section wins.

- **The public documentation index no longer links to the scaffolding.** The
  release-readiness audit and the community-documentation plan are working
  material; they stay in the repository and leave the published index, which now
  points at the changelog and the tagged releases.

- **README images use absolute URLs.** The README is the npm page as well as the
  GitHub one, and relative `docs/assets/` paths only render there by grace of
  npm's URL rewriting. They are now pinned to `raw.githubusercontent.com`, so the
  page renders the same wherever it is displayed.

## [0.2.13] — 2026-08-04

### Documentation

- **The harness screenshots show the harness working.** The first pass shipped a
  `/help` frame — the UI, with nothing in it. Replaced with three captures of
  real turns against this repository: `glm-5.2` answering a blast-radius
  question through the `graph_affected` tool in twelve seconds; the agent
  raising a structured `ask_user` question with selectable options instead of
  guessing; and the same loop with the same tools running a different provider,
  which is the evidence behind the provider-neutral claim rather than a
  restatement of it.

- **The local example names a model that exists.** `keryx shell --provider
  ollama --model llama3.1:latest` was a plausible-looking placeholder; the local
  example now uses `gemma4:e4b`, which is what the capture was actually taken
  against.

## [0.2.12] — 2026-08-04

### Documentation

- **The agent harness is now stated as a first-class part of the product.** The
  previous README mentioned it twice in passing — once as the thing `keryx shell`
  starts, once as the thing `keryx serve` is a second door into — and never in
  the first screen, the value table or the capability list. A reader could
  finish the page without learning that keryx owns an execution loop at all.

  The new section says what is in it: a provider-neutral loop over Anthropic,
  Ollama, OpenRouter and Grok plus an offline fake provider; durable per-project
  append-only sessions with resume, branching and compaction; a policy engine
  with `allow`/`ask`/`deny` over paths, commands, tools, network and resources;
  guarded mutation that is path-checked, security-scanned, approval-bound and
  evidence-recorded; kernel-enforced containment below the policy engine;
  child agents over the canonical contracts with token budgets and bounded
  parallel scheduling; an evidence ledger behind the completion gate;
  deterministic replay from recorded fixtures; and four doors — CLI, JSONL/RPC,
  TUI and loopback HTTP — onto one loop.

  Framed as the combination rather than a feature list: the harness is worth
  having *because* it reads the same `.metaproject/` context every other agent
  reads, and the context is worth having *because* something can act on it
  without rediscovering the repository first. The package's own thesis — the
  agent is ephemeral, the project brain is durable — now appears where a reader
  will meet it.

- **The first two screenshots.** `docs/assets/dashboard.png` and
  `docs/assets/shell.png`, both captured from real runs against this repository
  rather than mocked up. A tool with a TUI and a dashboard that shows neither is
  asking to be judged on prose alone.

- **The README links the documentation site** (`mrciphersmith.github.io/keryx`),
  which has been deploying on every push to `main` and was reachable from
  nowhere in the README.

## [0.2.11] — 2026-08-04

### Documentation

- **The README leads with what keryx is for, not with what it cannot do.** The
  old first screen spent its attention on absent model runtimes, empty runtime
  identifiers and non-zero exit codes — accurate, and the worst possible order
  in which to say it. A reader met the limitations of a product before its
  purpose, and concluded the product was unfinished rather than deliberate.

  The new order is: one sentence of value, the install, the problem, a table of
  what you get, a real end-to-end agent workflow, the express example, the
  `.metaproject/` tree, capabilities grouped by what you are trying to do, and
  only then requirements, optional AI features and limitations. Nothing was
  softened into untruth — the macOS-only containment tier, the missing
  approval transport, the unbundled embedding runtime and the external ripgrep
  dependency are all still stated, with the impact and the alternative next to
  each.

- **`docs/docs/limitations.md`** now holds the detail the README used to carry:
  the removed ONNX stack and the two constants that re-enable those seams, the
  five commands that need a provider credential, the platform matrix, the
  remote-approval gap and the pre-1.0 format-stability note. Linked from the
  README and the docs index, and in the site nav.

- **Two README caveats were removed because they had become false**, not
  because they were inconvenient: `security` is in `keryx modules` and can be
  toggled there, and enabling `mcp` no longer survives only until the next
  unrelated toggle — `defaultEnabled`/`enableFlag` in `src/commands/modules.ts`
  fixed that. Every command the README now shows was checked against the live
  CLI surface.

- **The npm `description` and `keywords` describe the product category** —
  version-controlled project context for AI coding agents — rather than opening
  with "metaproject workspace", a term that means nothing before the reader has
  installed the thing.

## [0.2.10] — 2026-08-04

### Changed

- **The release workflow publishes with no credential at all.** The trusted
  publisher is registered on the package (`MrCipherSmith/keryx`, `release.yml`,
  permissions `npm publish` and `npm stage publish`), so `npm publish` now
  authenticates as the OIDC identity of this workflow. The `NODE_AUTH_TOKEN`
  env block is gone and the `NPM_TOKEN` repository secret has been deleted —
  not merely left unused, because a credential nothing reads is still a
  credential that can be read.

  The bootstrap ordering is recorded in the workflow itself, because it is not
  obvious and cost four failed attempts to learn: a trusted publisher is
  configured under the **package's** settings, which means the package has to
  exist before it can be configured, which means the first publish of a new
  package cannot use it. `0.2.9` went out under a classic Automation token —
  the only token type that bypasses the 2FA prompt a CI runner cannot answer.
  A granular token obeys the account's 2FA setting and fails with `EOTP`, which
  is exactly how the third attempt died.

  Nothing published between those four failures. Every one of them stopped at a
  gate before the publish step, which is the gate working; three of the four
  were the same defect wearing different clothes — a requirement satisfied in
  one place and never written down as belonging to the suite.

## [0.2.9] — 2026-08-04

### Documentation

- **The name question is settled: `keryx` stays**, published as
  `@mrciphersmith/keryx`. Decided on evidence. Fourteen plausible single
  classical words were checked against npm and **all were taken** — that
  namespace was exhausted years ago, which is why a scope is normal practice
  rather than a workaround. And the rename was measured, not guessed: **8,554
  occurrences across 1,503 files, 621 of them file or directory names**.

  The one candidate that would have made the project better rather than merely
  different was `metaproject` — free, and already this project's own noun. Today
  it has two names for one thing: the tool is `keryx`, the thing it makes is a
  `metaproject`. Collapsing them would have been a simplification, and it was
  still not worth six hundred renames.

  The mitigation is discipline: always write the scope, because
  `npm install -g keryx` installs an unrelated project.

- **An announcement draft**, at `docs/plans/announcement-draft.md`, written to
  the plan's rules — one demonstrated thing rather than a feature list,
  boundaries stated in the post itself, prepared answers to the three questions
  that will be asked, and an explicit **what not to claim** list: no performance
  claim, not "ML-powered" (those runtimes are not shipped), not "fully
  sandboxed" without naming the tier and platform.

  It is a draft for a human to post. Nothing has been published.

## [0.2.8] — 2026-08-04

### Documentation

- **Five task-shaped guides**, organised by what a reader is trying to do rather
  than by which module implements it: give an agent context, run an agent
  without giving it your machine, drive keryx from a bot, review with a durable
  record, and run keryx in CI. They are doors into the reference, not a
  replacement for it.

  Every command shown was executed and the output is from those runs. Each guide
  ends with a verification command **and with what a misleading pass looks
  like** — a graph reporting `0 nodes` on a repository that has code, a review
  package that ingested cleanly with zero findings, a health gate passing over
  stale artifacts.

  Two things only a real run would have surfaced:

  - `keryx harness exec --allowed-domains api.example.com` produces an allowlist
    of **five** domains. The extra four are hosts of provider credentials saved
    on the machine — once a run is restricted, a masked credential's host has to
    be reachable or the mask is pointless. It is disclosed in the output, and
    the guide tells the reader to trust the effective list over the one they
    typed.
  - `security eval`'s `prompt-injection` row misses **three of eight** positives
    and is still `ok`, because its committed ceiling is `0.5`. The CI guide
    points at that row rather than the summary line: the gate does not claim the
    detector is good, only that it has not got worse than a number someone wrote
    down and can defend. Every other detector's ceiling is zero.

## [0.2.7] — 2026-08-03

### Added

- **A documentation link gate, in CI.** `bun run check:doc-links` resolves every
  relative Markdown link in the root documents and all of `docs/`, and checks
  `#anchor` fragments against the target file's headings — `file.md#missing`
  is the failure a plain existence check survives. It fails if it checked *zero*
  links, so a glob that quietly stopped matching cannot look like a clean sweep.

  `keryx wiki check-links` already covered the wiki. Nothing covered `docs/`.

- **`mkdocs.yml` and a Docs workflow.** MkDocs Material, `docs_dir: docs/docs`,
  explicit nav, Mermaid through `pymdownx.superfences`. The workflow's `build`
  job runs `mkdocs build --strict` on every pull request; `deploy` publishes to
  GitHub Pages from `main`. **The site config has not been executed locally** —
  `python3-venv` is absent on the authoring machine — so CI is its first oracle.

### Fixed

- **39 broken documentation links**, found by the gate on its first run, out of
  573 checked. Thirty-eight were one `../` too deep from
  `docs/decisions/keryx-harness/`; one pointed at a handoff document under a
  `.metaproject/jobs/` directory that does not exist — the real file lives in
  `docs/decisions/keryx-harness/`.

  A link check had been reported as passing repeatedly during this
  documentation work. It ran over a hand-picked file list, and the result was
  generalised to the repository.

## [0.2.6] — 2026-08-03

### Fixed

- **`keryx gdgraph build` was broken on every fresh install.** `init` copies a
  few `src/gdgraph/*.ts` files into `.metaproject/core/gdgraph/` so a scaffolded
  project can run the graph builder without the full toolkit. That list was
  hand-maintained, in two places, and nothing checked it against what those
  files import — so when `query.ts` gained `import … from "./target"` in
  `0.2.3`, the copied core stopped being import-closed:

  ```
  error: Cannot find module './target' from
    .metaproject/core/gdgraph/query.ts
  ```

  This is the **first "Next step" `init` prints**, and the suite stayed green
  throughout, because nothing ever ran the copied tree.

  The list is one shared constant now, and `core-sources.test.ts` computes the
  transitive closure of *runtime* imports from the entry points and asserts the
  list covers it. A new `import` in a copied file now fails a test instead of a
  stranger's first five minutes.

  Two things the guard gets right on purpose: type-only imports are excluded
  (they never reach runtime), and a `dynamic-import` is excluded because it is a
  deliberate lazy edge — `build.ts` reaches `enrich` that way *precisely* so it
  can run where `enrich` is absent, and that environment is the copied core
  itself.

### Documentation

- **The README now opens with what keryx removes, not what it contains**, and
  shows a real run on a freshly cloned `expressjs/express`: 139 nodes, 153
  edges, no cycles, and the dependency/dependent answer for `lib/express.js`.
  Every line of that output came from the run, which is also how the scaffold
  bug above was found — the walkthrough died on its second command.
- Adds **"Is this for you?"**, naming who should *not* install: people who want
  a hosted service, people on Linux who need the network allowlist, people who
  need remote approvals today, and people who expect it to do the thinking.

## [0.2.5] — 2026-08-03

### Fixed

- **Toggling any module silently deleted an enabled `mcp` from the manifest.**
  `keryx modules` knew eight of the ten modules, and a toggle re-invokes `init`
  with flags derived from that list — so the two it did not know were decided by
  the *absence* of a flag rather than by the operator.

  The two absences behaved differently, which is why one list could not describe
  both. `security` is default-**on**: no `--no-security` meant it survived, but
  it could never be disabled through this command and never appeared in
  `modules status`. `mcp` is default-**off**: `init` writes its manifest entry
  only when `--mcp` is passed, so a project with MCP enabled lost it on any
  unrelated toggle.

  Both are now in the list, and each module declares whether `init` scaffolds it
  by default. A default-off module re-sends its enable flag to survive.

  Demonstrated rather than asserted — on `0.2.4`, `init --yes --mcp` followed by
  `modules disable memory` leaves **no `mcp` entry at all**; with the fix the
  entry survives and `memory` alone changes. `modules status` now lists
  `security` and `mcp`.

### Added

- `keryx modules enable|disable security` and `… mcp` now work. `security` was
  reachable only through `init` flags before this.

## [0.2.4] — 2026-08-03

### Documentation

- **`docs/docs/architecture.md` now has five diagrams and no longer predates the
  architecture.** It was corrected rather than rewritten: most of its 310 lines
  were accurate, and replacing verified prose with new prose would have traded
  content for churn.

  The diagrams are Mermaid in Markdown, so they diff in git and need no build
  step. Every arrow is a named module or file and the decision nodes carry their
  `file:line`.

  Three of the five exist to correct something the source contradicted:

  - the system-context diagram had to stop the document saying "no HTTP server",
    which stopped being true when remote entry shipped;
  - the harness diagram is preceded by a **two-tool-systems table**, because a
    single picture of "the tool loop" is false in both directions — the durable
    `ToolExecutorPort` returns an `outputHash` and structurally cannot feed a
    live model, while the `InteractiveTool` layer the shell runs returns content.
    And no shipped path registers a tool at all;
  - the containment diagram makes the **macOS/Linux split structural**, because
    Tier 2 does not degrade on Linux — it refuses.

  The remote-entry diagram draws the nine-step ordered decision path rather than
  listing it, because `serve-turn.ts:3-7` states that *the order rather than the
  set is the control*.

- The module map gained eight missing rows — harness, sandbox, tui, session,
  serve, projects, metrics, contracts — plus a module-versus-command
  discriminator. A module has a manifest entry, a manifest file and a
  `src/<feature>` behind a verb; `review`, `serve`, `orient` and `sync` have none
  of that. Listing `serve` as a module was an error introduced in `0.2.0`.

- Layer 1 is described as the `CLI_ROUTES` table it is, not the "flat if-chain"
  it stopped being.

## [0.2.3] — 2026-08-03

### Fixed

- **`keryx ctx rg "pattern" src/one-file.ts` reported `(unknown)` and `0:0` for
  every hit.** ripgrep omits the filename whenever it is given a single explicit
  file path, which breaks the `file:line:col:text` shape `parseRgMatches`
  requires — so agents were handed matches they could not locate.
  `--with-filename` now joins the base argv unconditionally; it is a no-op for
  the multi-path and directory cases. (PR #211)
- **The code graph was under-resolving edges on this repository.** After the
  gdgraph fixes the same tree yields **1,873 edges against 1,397 before**, from
  649 nodes. (PR #211)
- Entropy and PII detector corrections, with fixture cases. (PR #211)

### Added

- **CI installs ripgrep.** One test spawns the real binary to prove ripgrep
  emits `file:line:col` for a single explicit path — an oracle about an external
  tool. Skipping it when the tool is absent would have left the assumption
  unverified while the job stayed green, so the tool is installed instead. This
  is what the pull request's red check actually was.

### Note on the merge

PR #211 was opened on 2026-07-26 and sat behind 24 commits. `buildRgCommand` had
been rewritten on `main` in the meantime to allowlist ripgrep flags — a caller's
`--pre=…` had reached arbitrary command execution through the one operation
agents are told to prefer over raw grep — and it now returns a result rather
than an argv. Both changes were kept: the security structure from `main`, the
`--with-filename` fix from the branch, asserted together so neither can be
dropped while the other still passes.

## [0.2.2] — 2026-08-03

### Security

- **A credential that merely exists no longer chooses the network posture of an
  unrelated command.** `keryx harness exec` decided "restricted network" from
  the count of mask inject-hosts. Those come from masks resolved against every
  provider key in the environment *and* in the user-global `auth.json` — so a
  saved key for a provider the command never touches silently widened the run to
  restricted networking with TLS termination on macOS, and blocked the command
  outright on Linux, where `restricted` is refused. The same
  `harness exec -- /bin/echo hi` worked or failed depending on whether an
  unrelated key existed on the machine.

  The posture is now decided by `resolveNetworkRestriction`, which takes the
  operator's intent and nothing derived from the environment: credentials are
  not a parameter, so they cannot reach the decision. Inject hosts still join
  the allowlist once a restricted run has been asked for — they no longer cause
  one.

  The five ways an operator can ask are a discriminated union with a total
  `switch`. The exhaustiveness was **verified, not assumed**: planting a sixth
  member fails `tsc` with `TS2366`. Nine unit tests cover each way, the fixed
  precedence, and the empty-list cases — `--allowed-domains ""` is not a request
  to restrict with no domains.

## [0.2.1] — 2026-08-03

### Security

- **The egress allowlist is now enforced inside terminated TLS tunnels.**
  Previously the allowlist was checked against the CONNECT target only. Once TLS
  termination was on, the decrypted request's `Host` header chose the upstream
  and was never re-checked — so a contained process could CONNECT to an
  allowlisted host and then address any other host from inside the tunnel. No
  decision was recorded for that inner hop either, so the egress was invisible
  in the reported rulings.

  The inner `Host` is now matched against the allowlist and passed through
  `decide(...)`, which closes both the bypass and the blind spot. Real
  credentials were never exposed — masks filter on their own inject-hosts — so
  this was a containment and observability failure, not a disclosure one.

  It ships with **a planted counter-example**: a test that sets a foreign `Host`
  inside the tunnel and asserts the refusal. Affects macOS only, because TLS
  termination is macOS only. (PR #210)

### Added

- **A macOS real-host CI job** covering the OS sandbox and the TUI pty launch.
  Until now the platform where the allowlist, credential masking and TLS
  termination actually run was the platform with no live containment test.
  (PR #210)

### Documentation

- A verification step in a flow plan is a task, not a sentence (PR #221).
- `shared-definitions` for the rules library, so places that agree connect by
  import instead of by restatement (PR #222).

## [0.2.0] — 2026-08-03

The first release since `v0.1.0`, covering 570 commits: the OS sandbox, the
agent harness and multi-agent engine, the OpenTUI shell, and the remote entry.

### Changed — packaging (read this before upgrading)

- **The npm package is now `@mrciphersmith/keryx`.** The unscoped name `keryx`
  on npm belongs to an unrelated, actively maintained project
  ([actionhero/keryx](https://github.com/actionhero/keryx)) — installing it gets
  you a different program. Install with:

  ```bash
  npm install -g @mrciphersmith/keryx
  ```

  The executable is still `keryx`; no command changes. The `curl` and `bun`
  installers described in the README are unaffected.
- `prepack` was removed. `prepare` alone builds `dist/`, so packing no longer
  runs the build twice (flagged in the 2026-07-10 readiness report).

### Added — remote entry (`keryx serve`)

- **A loopback-bound HTTP entry over the agent harness**, off by default. Bearer
  authentication compared in constant time, with only a salted hash persisted;
  `serve token issue | rotate | revoke`. Authentication runs *before* routing, so
  an unauthenticated caller cannot distinguish a known path from an unknown one.
  `refused` binds no socket at all — it is never a degraded listen.
  (R4b, flow 128, PR #216)
- **`POST /v1/turns` — remote turn submission with SSE streaming.** Idempotency
  keys are scoped per project, so two projects cannot collide on one key; turn
  records are durable; the remote policy profile is compared against the local
  one and may never be weaker; authentication failures are throttled. An `ask`
  decision terminates in a **recorded denial** — approvals are a later slice.
  (R4c, flow 133, PR #220)
- **`keryx projects` — a user-global project registry**, populated by
  `keryx init`, with `list | register | forget`. Nothing on the machine knew the
  project set before this. (R4a, flow 127, PR #215)

### Added — sandboxing and containment

- **A kernel-enforced OS sandbox under the policy engine:** workspace-write
  filesystem boundaries and secret read-deny via macOS Seatbelt and Linux
  bubblewrap, with network off / on / restricted. No new npm dependencies.
- **A loopback domain-allowlist proxy** reporting allow/deny rulings, plus opt-in
  TLS termination for HTTPS masking. Both are macOS-only and **refuse to run on
  Linux** rather than degrading to full host network.
- **Credential auto-masking**, defaulting to `auto` when the restricted sandbox
  is on, resolved env → project → global → built-in. Secrets come from the
  user-global `auth.json` only.
- **Harness hardening:** mask-without-TLS fails closed, spawn failures carry
  structured diagnostics (the exit-71 class), and a portable deep-probe script
  ships with a report schema.

### Added — the agent harness and multi-agent orchestration

- **A full execution loop** (`src/harness/`): append-only session store, an
  allow/ask/deny policy engine, a tool registry, a provider port with fake,
  Anthropic and Ollama adapters, resume and recovery, branching and compaction,
  guarded mutation with approval, replay, budget and monitoring.
  CLI: `keryx harness run | exec | extension | wave`.
- **Subagent orchestration**, reachable today through the interactive shell's
  spawn tool: a fail-closed child-model resolver, a policy-gated provider
  allowlist, depth and count caps against one shared run-scoped budget ledger
  including the cost dimension, and child-output injection quarantine (which
  flags, and never rewrites, child text).
  - Child containment rests on three things together: `shell_exec` is absent
    from a child's tool list, the child policy denies it, and the approver is
    hard-false.
- **Implemented and tested, but not yet wired to any caller:** cost-aware model
  escalation, git-worktree isolation, bounded peer messaging, and the
  orchestrator-state fold. Each of these modules is imported by exactly one file
  — its own test. They are extension points, not behaviour you get today.
  Scoped per-child credentials are in the same position: the provider option
  exists and is tested, but no production path passes it, so a live child reads
  the ambient environment.
- **A typed `MetaprojectPort`** with published schemas, so the harness, the
  interactive agent and the MCP server reach graph/wiki/memory/context in-process
  from one source instead of through subprocess wrappers.

### Added — interactive shell

- **A full-screen OpenTUI shell is now the default when `stdout` is a TTY**,
  replacing the line-based renderer; `--no-tui` and a graceful readline fallback
  remain. Adds a live `/` command composer, a persistent composer region,
  per-block collapse, and framed markdown with code and diff rendering.

### Added — observability

- **Provenance-aware execution metrics:** active-time accounting, per-run
  evidence, baseline-aware CI and a retry taxonomy. *No performance claim has
  been made* — the paired Keryx/no-Keryx protocol exists to make one honestly.

### Added

- Language-aware gdgraph import resolution: Java (Maven/Gradle source roots,
  fully-qualified-name → file mapping) and Python (dotted modules, `__init__.py`
  packages, and relative `from . import x`) source now produce real dependency
  edges instead of nodes-only graphs. TypeScript/JavaScript resolution is
  unchanged (byte-identical graph output). Seeds the Java/Python tree-sitter
  grammars on `init`/`update`.
- Symbol-aware graph navigation with `gdgraph find`, `symbol`, `path`,
  symbol-aware `affected`, and transitive caller impact via `symbol --impact`.
- Deterministically pinned tree-sitter grammar assets and explicit symbol-layer
  enable/disable/status commands.
- Hierarchical wiki collection with full module coverage, code-to-wiki backlinks,
  symbol-kind annotations, and an explicit draft-enrichment work front.
- Turn-start graph + wiki orientation hooks for Claude, Codex, and Cursor.
- Multi-runtime gdctx routing guards for Claude, Codex, Cursor, Windsurf,
  OpenCode, and other supported harnesses.
- Managed review packages for standalone reviews, flow-attached reviews, report
  ingestion, coverage tracking, decisions, and learning handoff.

### Changed

- Graph symbol resolution now disambiguates loose names and resolves cross-file
  calls before computing callers and impact.
- Agent bootstrap rules enforce the Metaproject hard gate before project work.
- Model-backed features remain opt-in, while deterministic fallbacks and asset
  availability are surfaced more clearly.
- The shipped `@xenova/transformers` runtime was removed, reducing the optional
  dependency footprint by roughly 230 MB; compatible transformer-style adapters
  can still be configured explicitly.

### Fixed

- Natural-language graph queries now redirect to the correct `find`, `ctx rg`,
  and `affected` workflow instead of silently producing low-value output.
- Wiki/code relationships and symbol caller graphs no longer under-report common
  cross-file references.
- gdgraph import-resolution metric no longer reports a false `100%` when zero
  imports were extracted (a `0/0` denominator); it reports `n/a` instead, and
  non-relative imports that fail to resolve are recorded as `unresolved` edges
  rather than silently dropped.

### Security

- The agent shell allowlist is a **boundary, not a string match**; the
  destructive risk class is wired into the shell approval gate; an approval is
  bound to the action it approves; and the agent can no longer grant itself
  shell permissions.
- Subagent isolation is pinned and a child's summary is bounded.
- Search argv is separated and caller-supplied paths are contained.
- Six adversarial review rounds on the remote-entry branch produced twelve
  blockers, all closed. Their single common cause is recorded as a durable
  lesson: [branching on a value whose domain you never wrote down](.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md).

### Documentation

- Refreshed public, developer, CLI, architecture, module, onboarding, workspace,
  and release-readiness documentation for the post-`v0.1.0` feature set.

### Known gaps

Recorded here rather than in a release announcement, because they are the things
a reader would otherwise discover by hitting them.

- **Approvals over the remote entry are not implemented.** Until they are, a
  remote turn that needs one is denied and the denial is recorded.
- **`GET /health` and cross-process liveness are absent.** No PID file exists, so
  `keryx serve status` reports configuration state only; `listening` and
  `draining` are knowable only over the authenticated `GET /v1/status`.
- **The domain allowlist, credential masking and TLS termination are macOS-only**
  and refuse to run on Linux rather than silently weakening.
- **`pii: { action: "allow" }` still redacts** — an open question about the
  policy resolver, not the detector.
- **The source-pattern guards in `src/lib/config-dir.ast.ts` are heuristics, not
  closures**, and carry a written list of known gaps as executable tests.

## [0.1.0] — 2026-07-10

First tagged release. `keryx` installs a deterministic, local, offline,
git-diffable `.metaproject/` workspace of agent-facing tooling, with an opt-in
capability seam for model/embedding features (disabled = byte-identical, zero
runtime dependencies, no sockets).

### Core modules

- **gdgraph** — code graph, symbols, and affected context. Parser-backed import
  resolution (`Bun.Transpiler.scanImports`, regex fallback), N-hop transitive
  `affected`, token-budgeted `repomap.md`, and an opt-in tree-sitter symbol layer.
- **gdctx** — token-aware wrappers for search, reads, diffs, and command output.
- **gdwiki** — project knowledge base. Deterministic `collect` derives real
  per-module signals (dependencies, key files by connectivity, entry points,
  exported symbols) as prose-first drafts; an agent enrich workflow fills the
  understanding on a cheap model; `collect --changed` for incremental runs.
- **gdskills** — bundled working skills plus project-skill create/route/verify/
  learn lifecycle, schema-governed orchestration (`subagent-dispatch` →
  `subagent-result`, STATUS protocol), and a `docpack-orchestrator` for
  requirements packages.
- **health** — aggregated code health, scoring, quality gate, and a
  churn × complexity hotspot signal.
- **testing** — test context, related-test selection, normalized reports, and an
  opt-in coverage-map TIA with an always-on smoke tier.
- **memory** — long-lived project memory with bitemporal facts, memory typing,
  optional local embedding rerank, and `--as-of`/`--class` search.
- **tasks (flow)** — agent-first flow lifecycle: frozen acceptance criteria,
  a strict status state machine, PR-gated completion (AC + PR checks + health +
  security), tracker adapters (`gh`), and natural-language discovery.

### Platform

- **Metaproject Standard** — `standard validate|doctor|capabilities|emit`, a
  self-describing manifest, and profiles.
- **MCP interop** — `keryx mcp serve [--http]`: a stdio-first server mapping
  Tools to `createXService()` methods and Resources to read-only artifacts;
  `llms.txt` and gdskills plugin export.
- **Metaproject Security** — agent input/output/artifact security: secrets, PII,
  prompt-injection and exfiltration/egress detection with HMAC-keyed hashing,
  safe redaction, a config-integrity self-protect, write-seam gates, multi-runtime
  hooks, and a red-team eval harness (advisory by default).
- **Capability seam** — `resolveCapability(id) → Adapter | null`, `optionalDependencies`
  + lazy import, deterministic fallback as a tested path, and an asset resolver
  (`assets.lock.json`, `assets list|verify|pull`).

### Tooling & UX

- `keryx init` / `update` / `modules` / `dashboard` — TTY-aware styled output
  (banners, module status, next steps) that degrades to clean plain text off-TTY.
- **Human dashboard** — a dark-first, navigable HTML admin view with a health-score
  ring, module cards, an "Attention" section, a Tasks/flows summary, and an in-page
  markdown modal for every linked `.md`.

### Reliability

- Atomic `.metaproject` writes (temp + rename) so a crash never corrupts a
  single-source-of-truth file.
- File locks (dependency-free, atomic `mkdir`) around flow mutations and gdskills
  manifest/learn read-mutate-write, so concurrent AI-agent sessions never lose
  updates.
- Serialized `process.chdir` in tests — no cross-file cwd races.

[0.1.0]: https://github.com/MrCipherSmith/keryx/releases/tag/v0.1.0
[0.2.0]: https://github.com/MrCipherSmith/keryx/compare/v0.1.0...v0.2.0
[0.2.1]: https://github.com/MrCipherSmith/keryx/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/MrCipherSmith/keryx/compare/v0.2.1...v0.2.2
[0.2.3]: https://github.com/MrCipherSmith/keryx/compare/v0.2.2...v0.2.3
[0.2.4]: https://github.com/MrCipherSmith/keryx/compare/v0.2.3...v0.2.4
[0.2.5]: https://github.com/MrCipherSmith/keryx/compare/v0.2.4...v0.2.5
[0.2.6]: https://github.com/MrCipherSmith/keryx/compare/v0.2.5...v0.2.6
[0.2.7]: https://github.com/MrCipherSmith/keryx/compare/v0.2.6...v0.2.7
[0.2.8]: https://github.com/MrCipherSmith/keryx/compare/v0.2.7...v0.2.8
[0.2.9]: https://github.com/MrCipherSmith/keryx/compare/v0.2.8...v0.2.9
[0.2.10]: https://github.com/MrCipherSmith/keryx/compare/v0.2.9...v0.2.10
[0.2.11]: https://github.com/MrCipherSmith/keryx/compare/v0.2.10...v0.2.11
[0.2.12]: https://github.com/MrCipherSmith/keryx/compare/v0.2.11...v0.2.12
[0.2.13]: https://github.com/MrCipherSmith/keryx/compare/v0.2.12...v0.2.13
[0.2.14]: https://github.com/MrCipherSmith/keryx/compare/v0.2.13...v0.2.14
[0.2.15]: https://github.com/MrCipherSmith/keryx/compare/v0.2.14...v0.2.15
[0.2.16]: https://github.com/MrCipherSmith/keryx/compare/v0.2.15...v0.2.16
[0.2.17]: https://github.com/MrCipherSmith/keryx/compare/v0.2.16...v0.2.17
[0.2.18]: https://github.com/MrCipherSmith/keryx/compare/v0.2.17...v0.2.18
[0.2.19]: https://github.com/MrCipherSmith/keryx/compare/v0.2.18...v0.2.19
[0.2.20]: https://github.com/MrCipherSmith/keryx/compare/v0.2.19...v0.2.20
[0.2.21]: https://github.com/MrCipherSmith/keryx/compare/v0.2.20...v0.2.21
[0.2.22]: https://github.com/MrCipherSmith/keryx/compare/v0.2.21...v0.2.22
[0.2.23]: https://github.com/MrCipherSmith/keryx/compare/v0.2.22...v0.2.23
[0.2.24]: https://github.com/MrCipherSmith/keryx/compare/v0.2.23...v0.2.24
[0.2.25]: https://github.com/MrCipherSmith/keryx/compare/v0.2.24...v0.2.25
[0.2.26]: https://github.com/MrCipherSmith/keryx/compare/v0.2.25...v0.2.26
[0.2.27]: https://github.com/MrCipherSmith/keryx/compare/v0.2.26...v0.2.27
[0.2.28]: https://github.com/MrCipherSmith/keryx/compare/v0.2.27...v0.2.28
[0.2.29]: https://github.com/MrCipherSmith/keryx/compare/v0.2.28...v0.2.29
[0.2.30]: https://github.com/MrCipherSmith/keryx/compare/v0.2.29...v0.2.30
[0.2.31]: https://github.com/MrCipherSmith/keryx/compare/v0.2.30...v0.2.31
[0.2.32]: https://github.com/MrCipherSmith/keryx/compare/v0.2.31...v0.2.32
[0.2.33]: https://github.com/MrCipherSmith/keryx/compare/v0.2.32...v0.2.33
[0.2.34]: https://github.com/MrCipherSmith/keryx/compare/v0.2.33...v0.2.34
[Unreleased]: https://github.com/MrCipherSmith/keryx/compare/v0.2.34...HEAD
