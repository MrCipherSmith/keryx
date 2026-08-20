# Requirements Roadmap
Version: 0.17.0

## Status

This roadmap tracks Metaproject requirements packages and their implementation
state. Runtime claims must be backed by source, tests, or a verification report.

> **Changelog**
> - **0.17.0** — new package `keryx-skills-runtime-tools`, **draft**, nothing
>   implemented. Gives `.metaproject/skills/` a runtime surface: today
>   discovery/loading go entirely through `CLAUDE.md`/`index.md` prose that a
>   connected agent must read and voluntarily obey, then a plain `Read` on a
>   `SKILL.md` — confirmed via direct inspection of `src/mcp/tools.ts`,
>   `dispatch.ts`, `metaproject-tools.ts`, `resources.ts` that zero MCP tool
>   is skill-related today. Proposes two `MetaprojectOperation` descriptors
>   (`skills_catalog`, `skill_load`) extending the existing single-source
>   registry in `src/harness/tool/metaproject-operations.ts` — "one
>   definition → three projections" (agent tool, `ToolRegistry`, MCP), the
>   same mechanism every other Metaproject capability already uses — plus a
>   complementary, Claude-Code-specific step materializing installed
>   gdskills into `.claude/skills/<name>/SKILL.md` so Claude Code's own
>   native `Skill` tool (progressive disclosure, relevance matching, `/name`
>   commands) handles that one assistant without new keryx code. Grounded in
>   a comparative review of Claude Code's documented Skill/WebFetch design
>   and five open-source CLI forks' (opencode, cline, kilocode, continue,
>   oh-my-claudecode) own skill-loading mechanisms — four of five converged
>   independently on a tool-mediated, description-matched, two-tier
>   disclosure design that keryx's prose-only routing does not share.
>   Explicitly defers the verification mechanism (D-03) and slash-command
>   exposure for non-Claude-Code assistants (D-04) to follow-up packages, and
>   does not remove or deprecate prose routing (D-05) — it stays the fallback
>   for any assistant supporting neither path.
> - **0.16.0** — `keryx-external-agent-runtime` **implemented** as a read-only
>   release (flow 176): registry and both codecs, the `runtime` block and its
>   fail-closed validator, child environment, prompt assembly, process
>   supervision and a real spawn port, the orchestrating runtime, the opt-in
>   capability gate — the capability registry's first real entry — with its
>   transport/CI hard disable, `keryx agents external list|probe`, the
>   `spawn_subagent` seam, and the operator surface (live transcript,
>   Work/Meta/Command modal, sidebar marker, per-addressee queue, `/delegate`).
>   Implementation overturned the specification repeatedly and each correction is
>   recorded rather than smoothed over: the execution seam was not where 0.1.0
>   said; `--tools` is an allow-list while the borrowed lesson was about
>   `--allowed-tools`; `--ephemeral` forbids resume; and `claude -p` with
>   `--input-format stream-json` *and* a positional prompt is a silent no-op that
>   three spec versions prescribed. **Two things it does not mean:** no vendor
>   process has ever been spawned by this code (every test uses a fake port and
>   recorded transcripts), and R15's supervision triggers do not exist, so the
>   parent receives a child's result and nothing before it. Off by default,
>   local-only, and claiming no vendor sanction.
> - **0.15.0** — new package `keryx-external-agent-runtime`, **specification
>   ready (future)**, nothing implemented. Hosts the vendors' own coding CLIs
>   (`codex exec`, `claude -p`) as a second **runtime** behind the existing
>   `spawnChild`, so the operator's own subscription performs bounded work while
>   keryx keeps isolation, budget, supervision and completion. Read-only only in
>   this release, held by a disposable detached worktree rather than by a tool
>   deny-list; a `runtime` block on `subagent-dispatch` carries the permission
>   axis from day one so the mutating mode needs no breaking schema change.
>   Records D-01, the credential boundary against `keryx-provider-auth` D-01:
>   running the vendor's already-authenticated client is not consuming its
>   token, keryx never reads a credential store even for a liveness check, and
>   the absence of any published vendor position on headless third-party
>   orchestration is carried as an open risk rather than an implied sanction.
>   Off by default, opt-in, hard disabled under remote transports and CI.
> - **0.14.10** — `structured-file-edit-tools` P2 **implemented**, closing the
>   package: the approval prompt for `apply_patch` (`risk: "write"`) now
>   renders the full patch via the shared `classifyDiffLine` classifier
>   instead of raw JSON tool input — `renderDiff` on the readline shell
>   (`src/commands/shell.ts`), per-line `otui`-native coloring on the TUI
>   (`src/tui/tui-shell.ts`), both branching on `tool === "apply_patch"`
>   before the pre-existing shell-command approval path (which would
>   otherwise have misread a patch's JSON as a shell command). New
>   `extractPatchText` (`src/lib/patch-risk.ts`) mirrors
>   `parseShellExecCommand`'s shape for this tool. All four phases
>   (P0/P1/P2/P3) are now implemented; the only remaining documented
>   non-goal is a "remember this pattern" auto-allow mechanic for edits.
> - **0.14.9** — `structured-file-edit-tools` P0/P1/P3 **implemented**:
>   `GatedToolRisk`/`executeCall` gained a real `write` path (ADR-0010,
>   `permission-mode.ts`/`agent.ts`), a new escalation classifier
>   `src/lib/patch-risk.ts` (delete / `.git` touch / >8 files / credential-path
>   → escalate, never block), and the `apply_patch` tool itself
>   (`src/harness/tool/builtin/apply-patch-tool.ts`: multi-file unified diff,
>   `confineToRoot`-scoped, applied via a constrained argv-only `git apply`
>   subprocess with the patch over stdin). Registered in the interactive
>   agent's tool set; system prompt now steers edits toward `apply_patch`
>   over `shell_exec`. Tests: pure-function coverage for the classifier and
>   parser, mocked-runner coverage for the tool's own logic (path-escape
>   atomicity, structured per-file results), real-`git`-subprocess coverage
>   (apply + reject-wholesale-on-mismatch), and `executeCall`-level gate
>   integration tests mirroring the existing `destructive`/`delegate`
>   coverage. P2 (diff-preview approval UI) not started — `write`-risk
>   approvals still render raw JSON tool input.
> - **0.14.8** — Added `structured-file-edit-tools` as a specification-ready,
>   requirements-only package: an `apply_patch` tool (standard multi-file
>   unified diff, applied in-process via a constrained `git apply` subprocess
>   call) so the interactive agent no longer has to spend its non-read
>   tool-call budget one `shell_exec` heredoc per edit. Depends on extending
>   `GatedToolRisk`/`executeCall`/`resolveApprovalDecision` to a real
>   `risk: "write"` path — today hard-denied unconditionally
>   (`permission-mode.ts`'s own doc comment says so). Recommends that gate
>   extension land first, alone, backed by a real ADR (mirrors ADR-0008/
>   ADR-0009's precedent), before any patch-parsing code exists. No runtime
>   implementation is claimed.
> - **0.14.7** — `keryx-multi-agent-engine` Phase D **implemented** (flow 171,
>   tasks T5–T7; bumped package to 0.4.0): concurrent execution of sibling
>   `spawn_subagent` calls (FR11, SC7) via new `executeWaves` executor in
>   `scheduler.ts` and `runConcurrentSpawnBatch` integration in `agent.ts` with
>   `AgentDeps.maxSubagentConcurrency` (default 3); structured six-value
>   completion status (`Completed|BudgetExhausted|Timeout|Denied|Error|
>   NoProgress`) (FR12, SC8) via new `SubagentCompletionStatus` type in
>   `spawn-subagent-tool.ts`, with `finishReason` threaded out of `runAgentTurn`
>   to map budget and no-progress cases. PRD R8 ledger race verified safe by
>   construction (synchronous grant path); regression test added. Test suite:
>   4153 pass / 0 fail. Two trade-offs documented (T6 findings).
> - **0.14.6** — Added Phase D to `keryx-multi-agent-engine` (bumped
>   0.2.0 → 0.3.0): specification-ready, not implemented. Closes two gaps found
>   by direct code investigation of a live bug report — sibling `spawn_subagent`
>   calls in one interactive turn run strictly sequentially even though the
>   existing `planWaves` scheduler already computes a concurrent wave plan that
>   nothing executes; and a child that exhausts its own internal step budget
>   returns `isError:false`, indistinguishable from a clean finish. Grounded
>   against a three-project reference study (xAI Grok Build, OpenAI Codex CLI,
>   sst/opencode — cloned to `~/forks/` for inspection): Keryx was the only one
>   of the four studied that never runs sibling spawns concurrently (opencode's
>   default dispatch path delegates to the Vercel AI SDK, not directly
>   inspected in this study); 2 of 3 references distinguish budget-exhaustion
>   from success via a typed status,
>   opencode shares Keryx's exact gap for that one specific case. Proposes a
>   richer six-value status (`Completed | BudgetExhausted | Timeout | Denied |
>   Error | NoProgress`) than any single reference studied, since grok-build/
>   codex both collapse budget-exhaustion and no-progress into one bucket.
> - **0.14.5** — Added `shared-agent-context-decision-integrity` (RP-13) as a
>   specification-ready, requirements-only package: closes a real gap found
>   while designing Slate v2 — `workspace review --decision accepted`
>   bypasses the already-working `findDuplicates`/`findConflicts`
>   (`src/memory/dedup.ts`), and nothing ties SAC content back to a deleted
>   code component (`wikiPruneOrphans` only covers `wiki/components/*`).
>   Explicitly does NOT add auto-merge/auto-archive/a new similarity engine;
>   automatic decision versioning is a named, deferred future track with
>   its constraints pre-fixed, not built here. Also bumped `slate` to
>   2.0.0 (SLATE-16..21, still design/not implemented) — see that
>   package's own changelog.
> - **0.14.4** — `sac-workspace-lifecycle` and `slate` (all 5 phases) shipped
>   to `main` and released in v0.2.39: archive/removeResource/rename (PR
>   #296), Slate skeleton + bundled SAC hardening (PR #297), open/close
>   lifecycle + unattended `interactive` gate (PR #301), `/goal` + TerminalState
>   + Anchors auto-inject (PR #304), ephemeral subagent slate + machine
>   wrap-up composer (PR #306), catch-up review + `list-proposals` (PR #308).
>   Both packages moved from spec-ready to implemented and verified.
> - **0.14.3** — Added `sac-workspace-lifecycle` as a specification-ready,
>   requirements-only package: closes a real gap found in the already-shipped
>   `WorkspaceService` (SAC-1) — no archive, no resource removal, no rename.
>   Explicitly does NOT add member management or delete; both are documented
>   non-goals (member management would create ACL entries no actor can
>   verify under today's OS-uid-only identity — owned by future RP-06; delete
>   conflicts with SAC's own AC-9 append-only audit guarantee). Cross-patches
>   `slate`'s SLATE-10/SLATE-13 so archived workspaces never silently drop
>   out of pending-review discovery.
> - **0.14.2** — Added `slate` as a specification-ready, requirements-only
>   package: a task-local harness layer (Anchors/Course/Seeds) sitting in
>   front of the implemented `shared-agent-context` workspace, covering
>   subagent slate handoff, unattended-mode gating, and a catch-up review
>   flow. No runtime implementation is claimed. Explicitly scoped against
>   SAC RP-03/05/06/08 (session-workspace binding, secure evidence, identity/
>   capabilities, worktree collaboration) — slate reuses smaller already-
>   shipped harness primitives as interim measures rather than duplicating
>   any of those four packages' future architecture.
> - **0.14.1** — Reconciled `shared-agent-context` package prose with the
>   shipped `src/sac/` runtime (CLI `keryx workspace`, MCP `sac.*`, harness
>   `workspace_*`, guarded owner-writers, access-receipt integrity). Earlier
>   package text still said CLI/MCP were planned and that the runtime exposed
>   none of those tools. Satellite RP-01…RP-12 stay future / spec-ready.
> - **0.14.0** — Truth-synced the implemented Shared Agent Context core and
>   added twelve future improvement packages plus the SAC Improvements Program.
>   The new packages define dependency-ordered requirements, validation,
>   rollback, phase prompts, and progress statistics; they claim no new runtime
>   implementation. RP-12 is split into pre-runtime truth coverage (12a) and
>   post-RP-09 registry-derived operation documentation (12b).
> - **0.13.2** — Added `shared-agent-context` as a specification-ready,
>   requirements-only package: local-first Facts, Flow-derived Work and reviewed
>   Know-how; trusted identity, append-only proposals, bounded retrieval,
>   semantic-validation contracts and fixtures. No runtime implementation is
>   claimed.
> - **0.13.1** — Memory Reliability P0–P6 is implemented and verified in PR #261.
>   Rebase-time flow ID collisions were resolved through Task Manager by
>   renumbering the package flows from 105–111 to 135–141; all seven flows passed
>   their acceptance, health, and security completion gates.
> - **0.13.0** — Added `keryx-shell-benchmark` (specification ready; no run
>   executed, no result claimed). It supplies the single input
>   `keryx-execution-observability` declared out of scope for itself —
>   *"representative task selection remains a product decision"* — so the paired
>   Keryx/no-Keryx protocol built there can finally be executed. 26 frozen cases
>   in four groups: workspace leverage, ordinary work as a floor check,
>   containment, and session durability. Two keryx legs (DeepSeek and a free
>   local `gemma4-coder`) against Claude Code and Codex, one git worktree per
>   run from one commit, byte-identical prompts, and a rubric that grades
>   *grounding* separately from correctness — a right answer with no cited
>   evidence scores `plausible`, not `grounded`. Records two findings from
>   scoping: the non-interactive `keryx harness run` registers no tools and so
>   cannot host an agentic benchmark at all, and it hardcodes
>   `fake|anthropic|ollama` instead of consulting the provider registry while
>   `cli-reference.md` documents the opposite. Docs-only; no `src/` changes.
> - **0.12.0** — `keryx-remote-entry` **R4c merged** (flow 133, PR #220,
>   `0b54411b`): `POST /v1/turns` with a per-project idempotency key, durable
>   turn records, SSE streaming, and two items R4b had deferred — the
>   non-weakening remote policy profile comparison (AC-04, which now has a
>   `resolveLocalProfile` to compare against) and auth-failure throttling, owed
>   from the first mutating route. An `ask` decision terminates in a recorded
>   denial: approvals remain R4d. Six adversarial review rounds preceded the
>   merge; their root-cause lesson is recorded at
>   `.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md`.
>   Still open on this package: R4d–R4f, plus `GET /health` and cross-process
>   liveness. Docs-only here; the `src/` change is PR #220.
> - **0.11.0** — Truth-sync on `keryx-remote-entry`: the row still read
>   `specification ready (future)` after two slices had shipped to `main`.
>   **R4a** (flow 127, PR #215) landed the user-global project registry
>   (`src/lib/project-registry.ts`, `src/commands/projects.ts`). **R4b** (flow
>   128, PR #216) landed the `keryx serve` skeleton: a loopback-bound listener,
>   bearer authentication with constant-time comparison, the
>   `issue | rotate | revoke` token lifecycle and the two read-only routes
>   `GET /v1/status` and `GET /v1/projects` — deliberately **with nothing behind
>   the door**: no turn, no streaming, no approvals, so the most
>   security-sensitive change in the codebase landed with its refusal paths
>   proven before anything could execute. It also extracted
>   `src/lib/config-dir.ts` and forced 0700/0600 on **every** writer of the
>   shared user-global directory, which closed a group-writable window that
>   predated serve and exposed `auth.json`. The remaining slices R4c–R4f are
>   now named in the row. Docs-only; no `src/` changes in this edit.
> - **0.10.0** — Added `keryx-provider-auth` (specification ready): an
>   authentication-method taxonomy declared per provider-registry entry, the
>   **OAuth 2.0 device authorization grant** (RFC 8628) so a provider can be
>   authorized from a phone with no loopback and no secret in the transport, and
>   an expanded provider list — **OpenAI was absent** from the eight
>   OpenAI-compatible entries, as were Google, Mistral and the major inference
>   hosts. Records D-01: subscription login is adopted **only where the vendor
>   sanctions third-party clients**. Anthropic's Consumer Terms forbid using
>   Claude Free/Pro/Max OAuth tokens in other products and forbid third-party
>   Claude.ai login (enforcement from January 2026, policy from April 2026);
>   OpenAI reserves ChatGPT sign-in for Codex. GitHub Copilot is the sanctioned
>   case and is adopted. Cross-referenced from `keryx-remote-entry` and
>   `keryx-telegram-transport`, whose loopback handoff link cannot reach a
>   phone. Docs-only; no `src/` changes.
> - **0.9.9** — Deployment model made explicit: one operator, one install, many
>   projects, one owned supergroup. `keryx-remote-entry` **1.1.0** adds a
>   user-global project registry (`keryx init` registers; nothing on the machine
>   knew the project set before), maintenance operations projected from
>   `src/standard/command-registry.ts` so a graph rebuild runs the command
>   instead of paying a model to decide to run it, and a one-time expiring
>   loopback-bound credential handoff — **no route accepts a secret**.
>   `keryx-telegram-transport` **2.2.0**: topics follow `keryx init` rather than
>   a bulk setup, a topic becomes an operating surface whose command menu is
>   generated from the registry, and provider setup needs no web UI because the
>   secret never travels through Telegram. Extending the command registry
>   (`gdgraph build` is outside the curated sixteen) is recorded as a dependency
>   of both. Docs-only; no `src/` changes.
> - **0.9.8** — `keryx-telegram-transport` **2.1.0**: multi-project and voice
>   move into Release 0 after studying a production Telegram surface. Forum
>   supergroup with one project per topic, routing by topic identifier with a
>   hard refusal on an unmapped topic (a fallback would run one project's prompt
>   under another project's profile), per-binding queueing, three-state binding
>   validation, and both voice directions local-first and off by default with
>   egress-governed remote services. Individual sender authorization replaces
>   membership-as-authorization. Docs-only; no `src/` changes.
> - **0.9.7** — Added `keryx-remote-entry` (specification ready): `keryx serve`,
>   a loopback-bound HTTP entry over the implemented harness, with asynchronous
>   fail-closed approvals and a non-weakening remote policy profile. Bumped
>   `keryx-telegram-transport` to **2.0.0**: its Release 0 boundary widens from
>   companion-only to include `task.submit`, and it becomes a client of Remote
>   Entry rather than a parallel path into the harness. Corrected the
>   `keryx-metaproject-native` row: the `RunDeps.metaprojectPort` seam (S1),
>   MP-6 escalation wiring and the MP-5 `wikiBacklinks` op shipped in flow 122
>   (PR #207), so only Phase 4 and the legacy-adapter retirements remain open.
>   Docs-only; no `src/` changes.
> - **0.9.6** — `keryx-sandbox-harness-hardening` **implemented** (H1+H2+H3-light):
>   harness mask-without-TLS fail-closed + spawn/exit-71 diagnostics, portable
>   `scripts/sandbox-deep-probe.sh` + REPORT, agent-protocol decisions-over-exitCode.
> - **0.9.5** — Added `keryx-sandbox-harness-hardening` (draft): fail-closed mask/TLS
>   on harness edge, spawn diagnostics, portable deep-probe script, decisions UX.
>   Docs-only package land; builds on OS sandbox + credential auto-mask probe findings.
> - **0.9.4** — Truth-sync after a 12-package audit. Added previously-missing
>   rows for `keryx-opentui-shell` and `keryx-project-agent-harness`; rewrote
>   `keryx-metaproject-native` and `keryx-multi-agent-engine` to reflect that
>   their runtimes have shipped. Bumped stale `Version:` headers inside the
>   affected packages. Docs-only reconciliation; no `src/` changes.

## Packages

| Package | Status | Summary |
|---|---|---|
| [Keryx Memory Reliability](keryx-memory-reliability/README.md) | implemented and verified (PR #261) | P0–P6 implementation and evidence are complete: side-effect-free recall, explicit ignored reports, accepted/current bounded automatic influence, lifecycle transitions, unified guarded atomic writes, coherent temporal/catalog/config semantics, documentation, migration guidance, and full verification. Renumbered flows 135–141 are complete and linked to PR #261. |
| [Keryx Shared Agent Context](shared-agent-context/README.md) | implemented phases 0–5 and 6a; 6b planned | Local-first FWK context, bounded reads, proposals, policy experiment guard, and CLI/MCP surfaces shipped through v0.2.32; synthetic experiment readiness is verified, while operational real-data rollout remains planned. |
| [SAC Workspace Lifecycle Completion](sac-workspace-lifecycle/README.md) | implemented and verified (PR #296) | Archive/resource-removal/rename shipped for `WorkspaceService`, reusing its existing `addResource` write skeleton. Member management and delete remain explicit, reasoned non-goals (RP-06/AC-9), not silent omissions. |
| [Keryx Slate](slate/README.md) | v1 (SLATE-1..15) implemented and verified, all 5 phases (PRs #297, #301, #304, #306, #308); v2 (SLATE-16..21) specification-ready, not implemented | Task-local harness layer (Anchors/Course/Seeds) sitting in front of the SAC workspace: crash-safe execution context, live Flow-projection Course, model-writable Seeds, ephemeral two-channel subagent slate handoff, a machine-evidence wrap-up composer replacing raw-transcript proposals, unattended-mode `accept` gating by session profile (not actor), and a four-category catch-up review flow. Shipped through v0.2.39; explicitly non-duplicative of SAC RP-03/05/06/08. v2 adds automatic workspace resolve-or-create, autonomous `propose` dispatch, and a review confirm-token closing `sac.review`'s known self-accept gap — narrows RP-03's remaining scope; see the package's own v2.0.0 changelog. |
| [SAC RP-01 Runtime Truth](shared-agent-context-runtime-truth/README.md) | future / spec-ready | Make the deterministic retrieval plan independent and output-effective, with stable identities and honest freshness, detail, omissions, and cost. |
| [SAC RP-02 Source-owned Projections](shared-agent-context-source-projections/README.md) | future / spec-ready | Replace raw/heuristic source interpretation with typed Flow, Evidence, Wiki, Memory, and Skills owner ports and canonical guarded writes. |
| [SAC RP-03 Lifecycle Binding](shared-agent-context-lifecycle-binding/README.md) | future / spec-ready | Add explicit Session–workspace–Flow binding, discovery, derivation preview, and receipt-bound owner-accepted-to-accepted link-back. |
| [SAC RP-04 Promotion Integrity](shared-agent-context-promotion-integrity/README.md) | future / spec-ready | Bind preview, independent review, target write, recovery, and SAC link-back to one immutable proposal intent and receipt chain. |
| [SAC RP-05 Secure Minimal Evidence](shared-agent-context-secure-evidence/README.md) | future / spec-ready | Admit only sealed, schema-closed, scanned/minimised evidence with exact pre-commit binding, monotonic sensitivity, retention, and deletion. |
| [SAC RP-06 Identity and Capabilities](shared-agent-context-identity-capabilities/README.md) | future / spec-ready | Define explicit local modes, live strict policy, execution identity, narrow authorize-at-use capabilities, and remote abuse gates without enabling remote mode. |
| [SAC RP-07 Generational Memory](shared-agent-context-generational-memory/README.md) | future / spec-ready | Define explicit observation, TTL working-set, and owner-accepted durable generations with contradiction, abstention, and deletion propagation. |
| [SAC RP-08 Collaboration and Worktrees](shared-agent-context-collaboration-worktrees/README.md) | future / spec-ready | Define causal metadata-only handoffs, advisory reservations, Project/Clone/Checkout identity, private overlays, and portable reference bundles. |
| [SAC RP-09 Unified Operations](shared-agent-context-unified-operations/README.md) | future / spec-ready | Establish one operation registry and parity across CLI, MCP, Harness, help, docs, errors, risk, auth, and transport behavior. |
| [SAC RP-10 Receipts and Provenance](shared-agent-context-receipts-provenance/README.md) | future / spec-ready | Add metadata-only capsules, replay/drift reasons, durability classes, retention/repair/quota controls, and measured read SLOs. |
| [SAC RP-11 Evaluation and Orchestration](shared-agent-context-evaluation-orchestration/README.md) | future / spec-ready | Evaluate deterministic/candidate shadow baselines, causal ablations, topology, outcome/security/overhead, and retain/remove/defer decisions. |
| [SAC RP-12 Documentation Truth](shared-agent-context-documentation-truth/README.md) | future / spec-ready | Enforce source-pinned current-behavior claims, taxonomy, graph/wiki coverage, then registry-derived operation docs/examples after RP-09. |
| [SAC RP-13 Decision Deduplication and Lifecycle Cleanup](shared-agent-context-decision-integrity/README.md) | future / spec-ready | Wire the existing `findDuplicates`/`findConflicts` (`src/memory/dedup.ts`) into `workspace review` as a reviewer-visible hint, plus an optional informational model annotation; extend the graph-diff signal that already drives `wikiPruneOrphans` to a report-only lifecycle flag for workspaces/memory entries/wiki decisions whose component left the graph. Surfaced by Slate v2's autonomous workspace/propose flow; not built by Slate v2 itself. |
| [SAC Improvements Program](shared-agent-context-improvements-program/README.md) | future / spec-ready | Coordinate all twelve packages with dependency waves, integration checkpoints, copy-ready phase prompts, dashboard statistics, evidence, stop, and rollback gates. RP-13 is not yet included in this coordination. |
| [Managed Review Feedback Loop](managed-review-feedback-loop/README.md) | implemented (initial runtime slice) | Low-level managed review persistence supports standalone/attached packages, ingest, coverage, findings, decisions, learning, and structural completion. Target orchestration ownership moves to Flow Reviewer. |
| [Flow Reviewer](flow-reviewer/README.md) | specification ready (future) | Task Manager-aware review orchestrator above stateless Review Orchestrator, with one task and durable history per reviewer, adaptive model routing, compact shared context, resume, schemas, and Gherkin acceptance scenarios. |
| [gdgraph Java/Python Import Resolution](gdgraph-java-import-resolution/README.md) | implemented | Language-aware import resolver so Java (Maven/Gradle) and Python source produce real dependency edges instead of nodes-only graphs; fixes the `0/0 = 100%` resolution-metric bug and seeds Java/Python grammars. Verified on example-backend: 0 → 47,984 edges, 94% in-repo resolution. |
| [Keryx Shell Benchmark](keryx-shell-benchmark/README.md) | specification ready (no run executed) | The task selection `keryx-execution-observability` left as a product decision, made concrete: 26 frozen cases in four groups — workspace leverage (blast radius, call chains, cycles, orphans, wiki architecture and recorded decisions, memory, related tests, budgeted repomap, health, context assembly), ordinary coding work as a floor check, containment, and session durability. Two keryx legs (DeepSeek, and free local `gemma4-coder`) against Claude Code and Codex on the same commit, one git worktree per run, byte-identical prompts, and a rubric that scores **grounding** apart from correctness so a lucky guess cannot pass as retrieval. Fairness is stated where it cuts against keryx: the baselines run frontier models against a 7B local leg, and they may read `.metaproject/` files — what they lack is the query layer. Negative outcomes (`keryx-regression`, `capability-unused`) are reported with the same prominence as wins, and no speed claim is published unless the observability decision rule is satisfied. Results emit into the existing `paired-3-5-v1` manifest and validate with `keryx metrics benchmark validate`. |
| [Keryx Execution Observability](keryx-execution-observability/README.md) | implemented (runtime capability; benchmark harness ready) | Provenance-aware execution metrics, active-time accounting, per-run evidence, baseline-aware CI, lightweight profiles, retry taxonomy, and paired Keryx/no-Keryx validation protocol. No performance claim has been made. |
| [Keryx Context Operations](keryx-context-operations/2026-07-12/README.md) | specification ready (future) | Git-native bounded context assembly with provenance, deterministic-first hybrid retrieval, policy gates, feedback lifecycle and corpus evaluation. It extends existing project sources; no new runtime is implemented yet. |
| [Keryx Provider Auth](keryx-provider-auth/README.md) | specification ready (future) | Expands the **implemented** provider registry (`src/commands/providers.ts` — eight OpenAI-compatible entries plus native Anthropic and Ollama, all Bearer API key today) with a declared authentication method per entry: `none`, `api-key`, `device-code`, `oauth-pkce-loopback`, `cloud-credentials`. Adds the **OAuth 2.0 device authorization grant** (RFC 8628), which needs no loopback listener and no browser on the keryx machine and so closes the gap the credential handoff link cannot — a provider can be authorized by opening a link on a phone, with only a short single-use code and a public verification URL crossing the transport. Expands the list: **OpenAI** (conspicuously absent today), Google Gemini, Mistral, Together/Fireworks/DeepInfra/Perplexity/Nebius, LM Studio and llama.cpp, plus **GitHub Copilot** as the first sanctioned subscription provider. Records D-01 with sources: subscription login only where the vendor permits third-party clients — Anthropic Claude Pro/Max and ChatGPT Plus/Pro are deliberately excluded because the cost of ignoring their terms falls on the operator's own account. The method is registry data, so a vendor's terms changing is a one-line edit and the compliance boundary stays reviewable. |
| [Keryx Remote Entry](keryx-remote-entry/README.md) | implemented (R4a–R4c: registry, listener, turn submission); R4d–R4f open | **Shipped:** R4a — user-global project registry (flow 127, PR #215; `src/lib/project-registry.ts`, `src/commands/projects.ts`). R4b — the `keryx serve` skeleton (flow 128, PR #216; `src/commands/serve.ts`, `src/lib/serve-{config,credential,server}.ts`, `src/lib/config-dir.ts`): off-by-default loopback listener, bearer authentication compared in constant time, `serve token issue \| rotate \| revoke` with only a salted hash persisted, a `stopped -> configured -> listening -> draining -> stopped` state machine where `refused` binds no socket at all, and exactly two authenticated read-only routes, `GET /v1/status` and `GET /v1/projects`, with authentication running **before** routing so an unauthenticated caller cannot distinguish a known path from an unknown one. R4c — turn submission (flow 133, PR #220; `src/lib/serve-{turn,turn-store,runner,throttle}.ts`): `POST /v1/turns` over the harness run loop, an idempotency key scoped per project so two projects cannot collide on one key, durable turn records, SSE streaming, and the two items R4b deferred — the non-weakening remote policy profile comparison (AC-04, which now has a `resolveLocalProfile`) and auth-failure throttling, owed from the first mutating route. An `ask` decision terminates in a **recorded denial**, stated as a boundary in `serve-turn.ts` rather than left to emerge from the absence of an approval store. **Open:** R4d asynchronous fail-closed approvals; R4e maintenance operations projected from the command registry; R4f the one-time expiring credential handoff. Also deferred with them: `GET /health` and cross-process liveness (no PID file yet — `serve status` reports configuration state only). **Specification:** `keryx serve`, a loopback-bound, off-by-default, token-authenticated HTTP entry over the **implemented** Project Agent Harness, so Telegram, a browser workspace and third-party embedding become clients of one surface instead of three integrations. Reuses the existing run loop, append-only session store and policy engine unchanged; adds asynchronous fail-closed approvals (unanswered or undeliverable resolves to deny), identity-first session binding, a remote policy profile that may never be weaker than local, server-stamped unforgeable turn origin, and mandatory redaction. **1.1.0** adds a user-global project registry populated by `keryx init` (the addressing keys a transport routes by — nothing on the machine knew the project set before), maintenance operations projected from `src/standard/command-registry.ts` and run directly rather than through the model with the registry's `read`/`model` flags driving classification and cost disclosure, and a one-time expiring loopback-bound credential handoff: **no route accepts a secret**. No new runtime dependency; no database. Records two decisions with named compensating controls: widening the remote boundary to `task.submit`, and keeping secrets off the remote surface entirely. Extending the command registry is a stated dependency. |
| [Keryx Telegram Transport](keryx-telegram-transport/README.md) | specification ready (future) | Optional transport, from 2.0.0 a **client of Keryx Remote Entry** rather than a parallel path into the harness: local long polling, bounded notifications, policy-constrained approvals, cancellation of own active operation, typed intents, and `task.submit`. **2.1.0 adds multi-project and voice to Release 0**: a forum supergroup with one project per topic, routed by topic identifier where an unmapped topic *refuses* rather than falling back to another project's session; per-binding serialization with parallel projects and queue-position reporting; three-state binding validation where an inconclusive check never clears a mapping; and voice in both directions, local-first, off by default, with every remote transcription or synthesis call passing the egress policy and synthesis accepting post-redaction text only. Supergroup membership authorizes nothing — every sender is authorized individually, before routing. **2.2.0** makes the deployment model explicit (one operator, one install, many projects): topics follow `keryx init` via the project registry instead of a bulk setup, ordering between forum configuration and registration stops mattering, a topic becomes an operating surface whose command menu is *generated* from the command registry so a new keryx command appears without a bot change, and provider setup works without a web UI because the transport renders a one-time handoff link rather than ever accepting a secret as a message. Authentication, session addressing, approval semantics, the remote policy profile and redaction remain delegated to Remote Entry. No remote control plane in Release 0. |
| [Keryx Metaproject-Native Harness](keryx-metaproject-native/README.md) | implemented (Phases 1–3 + S1/MP-6/MP-5a; Phase 4 and legacy-adapter retirement pending) | A single typed `MetaprojectPort` + schemas so the harness, interactive agent, and MCP server reach graph/wiki/memory/context in-process from one source (replacing subprocess wrappers and hardcoded MCP adapters), plus a universal, schema-published Task Manager (`flow-state.schema.json` + `ManagedFlowPort`) any runtime can drive while preserving the D-02 invariant. **Phases 1–3 shipped** (`src/harness/tool/metaproject-{port,adapter,operations}.ts`, `src/mcp/metaproject-tools.ts`, `flow-state` schema + `keryx flow schema` CLI; flows 037/038/040). **Flow 122 (PR #207) closed the harness-core `RunDeps.metaprojectPort` seam (S1), the MP-6 blast-radius escalation wiring, and the MP-5 `wikiBacklinks` operation.** Genuinely open: Phase 4 policy-context enrichment, legacy MCP adapter retirement, and subprocess-wrapper retirement. |
| [Keryx Skills Runtime Tools](keryx-skills-runtime-tools/README.md) | draft, nothing implemented | Two new `MetaprojectOperation` descriptors, `skills_catalog` and `skill_load`, extending the Metaproject-Native Harness's single-source operation registry so `.metaproject/skills/` gains a structured discovery/load path in all three existing projections (agent tool, `ToolRegistry`, MCP) instead of relying solely on `CLAUDE.md`/`index.md` prose a connected agent must voluntarily read and obey. Complementary Claude-Code-specific step materializes installed gdskills into `.claude/skills/<name>/SKILL.md` so that assistant's own native `Skill` tool handles discovery/disclosure without new keryx code. Grounded in a comparative review of Claude Code's own Skill/WebFetch design and five CLI forks (opencode, cline, kilocode, continue, oh-my-claudecode). Verification mechanism and non-Claude-Code slash-command exposure explicitly deferred (D-03/D-04); prose routing stays as fallback, not removed (D-05). |
| [Keryx Multi-Agent Engine](keryx-multi-agent-engine/README.md) | implemented (A→B→C→D, flows 088–101, 171) | Subagent orchestration over the Project Agent Harness: a fail-closed `resolveChildModel` resolver adding explicit-or-inherit model/provider selection, a policy-gated provider allowlist with scoped credentials, subagent depth/count caps and a single shared budget ledger (including the previously-deferred `maxCostUnits` cost dimension landed in flow 101), a deterministic monitoring fold (`keryx agents monitor <events-file>`), child-output injection quarantine, adaptive cost-aware model escalation, git-worktree isolation, and bounded peer messaging. **All of A→B→C shipped** as flows 088–101 with AC1–AC8 tests green. **Phase D (added 2026-08-18, shipped flow 171):** bounded concurrent execution of sibling `spawn_subagent` calls in one turn via new `executeWaves` executor in `scheduler.ts` (AC9/SC7, with `AgentDeps.maxSubagentConcurrency` default 3 and concurrent grant safety verified) and a structured six-value completion status (`Completed|BudgetExhausted|Timeout|Denied|Error|NoProgress`) via new `SubagentCompletionStatus` type and `finishReason` threading (AC11/SC8), closing a silent-false-success gap — both found via direct code investigation plus reference study against xAI Grok Build, OpenAI Codex CLI, and sst/opencode. Genuinely remaining: a live `keryx agents` snapshot against a running run and a dedicated `orchestrator-state` fold. |
| [Keryx External Agent Runtime](keryx-external-agent-runtime/README.md) | **implemented (read-only release, flow 176); never run against a real process** | A second child **runtime** behind the already-shipped `spawnChild`: instead of an in-process agent loop, an external child spawns the vendor's own coding CLI (`codex exec`, `claude -p`) and its event stream is folded onto the existing `agent-event` contract, so `reduceAgents`, the shared `RemainingBudgetLedger`, `maxTreeDepth`, `quarantineChildSummary` and `SubagentCompletionStatus` all apply unchanged. Motivation: the operator's paid subscriptions drive capable agents keryx cannot otherwise reach, because `keryx-provider-auth` D-01 rightly refuses to consume subscription OAuth tokens. **D-01 here draws the boundary narrowly** — keryx runs the vendor's already-authenticated client and never obtains, reads, stores or proxies a credential, *not even to check whether a login exists*; the consequence accepted deliberately is that there is no cheap liveness probe, so availability has a third state, `not probed`. **Read-only only in this release**, held by three mechanisms of which only one is a guarantee: the CLI's sandbox flag, a tool deny-list naming delegation routes (which cannot be shown complete — escape routes in the reference implementation were found only by interrogating the agent), and a **disposable detached worktree**, which is the load-bearing layer. The `runtime` block on `subagent-dispatch` carries `sandbox: read-only \| worktree-write` from the first version, and `worktree-write` is schema-valid but refused at runtime, so the mutating worker needs no breaking change later. A **metadata registry plus one codec module per CLI** (`codex-cli`, `claude-cli`), because the two differ structurally rather than parametrically — `codex exec` narrates itself on stderr and prints the files it reads, while `claude -p` prints its login refusal to *stdout with exit 0*, so "exit 0 and non-empty means success" is true for one and false for the other. Headless is **not** fire-and-forget: `--input-format stream-json` makes the channel bidirectional, so the operator steers a running agent through the existing `src/tui/main-queue.ts` helpers (`force` becomes kill-plus-resume against a keryx-assigned session id) while the parent agent reads only a folded, trigger-driven view — a parent reading the raw stream would spend more of its own budget than the subscription saves. External output is **input, never evidence**; failure returns a named status with no fallback of any kind. Off by default, opt-in via `src/capability/`, hard disabled under remote transports and CI. |
| [Keryx OS Sandbox](keryx-os-sandbox/README.md) | implemented (macOS full; Linux filesystem + network-off only) | Kernel-enforced containment under the policy engine: workspace-write filesystem boundaries and secret read-deny via macOS Seatbelt / Linux bubblewrap, network off/on/restricted, a loopback domain-allowlist proxy with reported allow/deny rulings, credential masking behind a per-run sentinel, and opt-in TLS termination for HTTPS masking. Zero new npm dependencies. Fails closed when a launcher is missing or a posture is unsupported — the domain allowlist, credential masking and TLS termination are macOS-only and refuse to run on Linux rather than degrading to full host network. Includes human and agent guides plus a manual verification runbook. |
| [Keryx Sandbox Credential Auto-Mask](keryx-sandbox-credential-auto-mask/README.md) | implemented (P0–P0.b; PR #175–179) | Auto-derive HTTPS credential masks when restricted OS sandbox is on; fail-closed TLS (ADR-0007). **P0** resolver. **Verify** dual-axis. **P1** global `sandbox.json`. **P2** project `.keryx/sandbox-policy.json` + init skeleton. **P0.b** flipped the built-in unset-`maskMode` default from `manual` to **`auto`** and added a flag-gated live dual-axis smoke test (flow 108). Order: env → project → global → built-in (`auto`). Secrets: user-global `auth.json` only. |
| [Keryx Sandbox Harness Hardening](keryx-sandbox-harness-hardening/README.md) | implemented (H1+H2+H3-light) | Operator/security edge after live deep probe: harness **mask-without-TLS fail-closed**, structured spawn diagnostics (exit-71 class), portable **deep-probe** script + REPORT schema, agent rules for **network.decisions** over curl exitCode. Does not re-architect OS sandbox. H0 docs were already on main. Related already-landed UX: tool budget 48 (PR #180), multiline shell allow (PR #181). |
| [Keryx Project Agent Harness](keryx-project-agent-harness/README.md) | implemented (Release 0 + most of Release 1/2) | The execution loop that lets a model operate on a project through controlled tools while keeping the project brain local, durable, auditable, and reproducible. `src/harness/` is a substantial runtime (~175 files across 30 subdirectories): append-only session, allow/ask/deny policy engine, tool registry, provider port (fake + Anthropic + Ollama adapters), resume/recovery, branch/compaction, guarded mutation + approval, child-agent isolation (see Multi-Agent Engine), bounded parallel scheduling, extensions, OS sandbox integration, replay, completion, budget, and monitor. CLI: `keryx harness run|exec|extension|wave`. Release 2+ still open: harness TUI, network broker-mediated tools, full-strength executable extensions, provider-side session storage, external compatibility adapters. |
| [Keryx OpenTUI Shell](keryx-opentui-shell/README.md) | implemented (default shell; flows 059–066) | Full-screen OpenTUI (`@opentui/core`) interactive shell replacing the line-based `node:readline` renderer: live `/` command composer, persistent composer region, component-based rendering, with the deterministic agent driver and pure render helpers unchanged. The TUI is **the default shell when `stdout.isTTY`**; `--tui`/`--no-tui` flags and a graceful readline fallback remain. ADR-0005 Accepted. Additive features shipped beyond the original Phase 0–5 spec: side-workers, multi-agent spawn wiring, dual-store session persistence. Shared interactive tools + approval across TUI and readline (`web_fetch` is not TUI-only). |
| [Keryx OpenTUI Modal and Tabs](keryx-opentui-modal-tabs/README.md) | implemented (flow 154) | Reusable `openModal` host in `src/tui/modal-host.ts`: dimmed backdrop, titled panel, tab strip, Esc dismiss, `shell-chrome` overlay registration. No slash command of its own. |
| [Keryx OpenTUI Session Info](keryx-opentui-session-info/README.md) | implemented (flows 155; 0.2.36–0.2.37) | `/status` inspector on the shared host (Status + Context; Workspaces / Flow only when the session referenced them). `/session-info` and `/info` are not aliases. Sibling `/flows` lists project flows on the same host. |
| [Structured File-Edit Tools](structured-file-edit-tools/README.md) | implemented (P0–P3, package complete) | `apply_patch`: a `risk: "write"` tool taking a standard multi-file unified diff, applied via a constrained `git apply` argv call (stdin, no shell string) and confined by the existing `confineToRoot`. Collapses N `shell_exec`-per-edit calls into 1 non-read budget slot. The approval gate (`GatedToolRisk`/`executeCall`/`resolveApprovalDecision`) was extended to a real `write` path — previously hard-denied unconditionally — backed by **ADR-0010**, with a new escalation classifier (`src/lib/patch-risk.ts`: delete / `.git` touch / many-files / credential-path). System prompt steers edits toward `apply_patch` over `shell_exec`. The approval prompt (readline and TUI) renders the full patch via `classifyDiffLine` instead of raw JSON. Documented non-goal: a "remember this pattern" auto-allow mechanic for edits. |
