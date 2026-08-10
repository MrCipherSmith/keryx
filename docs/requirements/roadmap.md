# Requirements Roadmap
Version: 0.13.1

## Status

This roadmap tracks Metaproject requirements packages and their implementation
state. Runtime claims must be backed by source, tests, or a verification report.

> **Changelog**
> - **0.13.1** — Memory Reliability P0–P6 is implemented in draft PR #261.
>   Rebase-time flow ID collisions were resolved through Task Manager by
>   renumbering the package flows from 105–111 to 135–141; CI/merge remains the
>   release-completion gate.
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
| [Keryx Memory Reliability](keryx-memory-reliability/README.md) | implemented (draft PR #261; CI/merge pending) | P0–P6 implementation and evidence are complete: side-effect-free recall, explicit ignored reports, accepted/current bounded automatic influence, lifecycle transitions, unified guarded atomic writes, coherent temporal/catalog/config semantics, documentation, migration guidance, and full verification. Renumbered flows 135–141 are linked to PR #261. |
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
| [Keryx Multi-Agent Engine](keryx-multi-agent-engine/README.md) | implemented (A→B→C, flows 088–101) | Subagent orchestration over the Project Agent Harness: a fail-closed `resolveChildModel` resolver adding explicit-or-inherit model/provider selection, a policy-gated provider allowlist with scoped credentials, subagent depth/count caps and a single shared budget ledger (including the previously-deferred `maxCostUnits` cost dimension landed in flow 101), a deterministic monitoring fold (`keryx agents monitor <events-file>`), child-output injection quarantine, adaptive cost-aware model escalation, git-worktree isolation, and bounded peer messaging. **All of A→B→C shipped** as flows 088–101 with AC1–AC8 tests green. Genuinely remaining: a live `keryx agents` snapshot against a running run and a dedicated `orchestrator-state` fold. |
| [Keryx OS Sandbox](keryx-os-sandbox/README.md) | implemented (macOS full; Linux filesystem + network-off only) | Kernel-enforced containment under the policy engine: workspace-write filesystem boundaries and secret read-deny via macOS Seatbelt / Linux bubblewrap, network off/on/restricted, a loopback domain-allowlist proxy with reported allow/deny rulings, credential masking behind a per-run sentinel, and opt-in TLS termination for HTTPS masking. Zero new npm dependencies. Fails closed when a launcher is missing or a posture is unsupported — the domain allowlist, credential masking and TLS termination are macOS-only and refuse to run on Linux rather than degrading to full host network. Includes human and agent guides plus a manual verification runbook. |
| [Keryx Sandbox Credential Auto-Mask](keryx-sandbox-credential-auto-mask/README.md) | implemented (P0–P0.b; PR #175–179) | Auto-derive HTTPS credential masks when restricted OS sandbox is on; fail-closed TLS (ADR-0007). **P0** resolver. **Verify** dual-axis. **P1** global `sandbox.json`. **P2** project `.keryx/sandbox-policy.json` + init skeleton. **P0.b** flipped the built-in unset-`maskMode` default from `manual` to **`auto`** and added a flag-gated live dual-axis smoke test (flow 108). Order: env → project → global → built-in (`auto`). Secrets: user-global `auth.json` only. |
| [Keryx Sandbox Harness Hardening](keryx-sandbox-harness-hardening/README.md) | implemented (H1+H2+H3-light) | Operator/security edge after live deep probe: harness **mask-without-TLS fail-closed**, structured spawn diagnostics (exit-71 class), portable **deep-probe** script + REPORT schema, agent rules for **network.decisions** over curl exitCode. Does not re-architect OS sandbox. H0 docs were already on main. Related already-landed UX: tool budget 48 (PR #180), multiline shell allow (PR #181). |
| [Keryx Project Agent Harness](keryx-project-agent-harness/README.md) | implemented (Release 0 + most of Release 1/2) | The execution loop that lets a model operate on a project through controlled tools while keeping the project brain local, durable, auditable, and reproducible. `src/harness/` is a substantial runtime (~175 files across 30 subdirectories): append-only session, allow/ask/deny policy engine, tool registry, provider port (fake + Anthropic + Ollama adapters), resume/recovery, branch/compaction, guarded mutation + approval, child-agent isolation (see Multi-Agent Engine), bounded parallel scheduling, extensions, OS sandbox integration, replay, completion, budget, and monitor. CLI: `keryx harness run|exec|extension|wave`. Release 2+ still open: harness TUI, network broker-mediated tools, full-strength executable extensions, provider-side session storage, external compatibility adapters. |
| [Keryx OpenTUI Shell](keryx-opentui-shell/README.md) | implemented (default shell; flows 059–066) | Full-screen OpenTUI (`@opentui/core`) interactive shell replacing the line-based `node:readline` renderer: live `/` command composer, persistent composer region, component-based rendering, with the deterministic agent driver and pure render helpers unchanged. The TUI is **the default shell when `stdout.isTTY`**; `--tui`/`--no-tui` flags and a graceful readline fallback remain. ADR-0005 Accepted. Additive features shipped beyond the original Phase 0–5 spec: side-workers, multi-agent spawn wiring, dual-store session persistence. |
