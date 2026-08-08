# Requirements Roadmap
Version: 0.18.0

## Status

This roadmap tracks Metaproject requirements packages and their implementation
state. Runtime claims must be backed by source, tests, or a verification report.

> **Changelog**
> - **0.18.0** — Added `keryx-linux-containment` (specification ready; nothing
>   implemented) after the third benchmark run installed `bubblewrap` to unblock
>   case C4 and found that installing it changes nothing on a current Ubuntu.
>   bubblewrap builds its boundary from unprivileged user namespaces, withdrawn
>   by default since 23.10, so every contained run fails `bwrap: setting up uid
>   map: Permission denied` — while launcher detection (a `PATH` lookup) and the
>   static capability matrix compose into "Filesystem containment and
>   network-off are available". The false green is the finding: `keryx sandbox
>   status`, added by flow 142 to stop keryx claiming untested capability, was
>   making exactly that claim. Measured on kernel 6.8: Landlock ABI 4, needing
>   no privilege, no namespace and no LSM profile. [ADR-0010] adopts three
>   layers — Landlock default, bubblewrap fallback, container deferred as the
>   only path to a Linux domain allowlist (~409 ms/command; `docker` group
>   membership equals root on the host being protected). Sequenced so the probe
>   lands **first and alone**, because it removes a false statement from a
>   shipped product and does not depend on Landlock existing. States where
>   Landlock is *weaker* than bubblewrap rather than rounding up: its network
>   restriction is TCP-only, so `network: "off"` keeps selecting bubblewrap
>   until a seccomp filter exists. Docs-only.
> - **0.17.0** — Added `keryx-shell-remediation-v2` (specification ready; no
>   implementation started) from the **second** benchmark run — 42 runs, group C
>   plus all of group A. v1 made keryx able to *finish* a task; v2 is about
>   whether the answer it finishes with is *right*, and whether a user can tell
>   what protection they actually have. Four defects. **P1**: `gdgraph` counts
>   `await import()` as an ordinary import edge, so five of the eight cycles it
>   reports on the target are not load-order cycles at all — the kind is
>   available from `scanImports` and thrown away one line later
>   (`build.ts:230`). **P3**: the shell prompt's "give the shortest correct
>   answer" is applied by the model to its *tool-call budget*, so it accepts its
>   own tool's output unchecked — on A3 **and** A4 the same model under
>   `opencode` gave the better answer by verifying. P1 and P3 compound, which is
>   why P1 lands first: it is also P3's regression fixture. **P2**: the approval
>   menu offers a prefix grant the metacharacter barrier will never honour,
>   breaking an invariant stated three lines above the code that breaks it.
>   **P4**: a Linux install has no OS containment and nothing says so — the two
>   capabilities that *are* implemented there need `bubblewrap`, which the
>   installer never mentions and no command reports on. The Linux domain
>   allowlist is explicitly **not** in scope: it is unimplemented by design
>   (`bwrap --unshare-net` gives the process its own loopback, not the proxy's)
>   and fails closed, which is correct. Also records the counterweight the fix
>   must respect: on the A1 re-run the leg that *did* verify invented a
>   correction, so the target is "check when the tool's answer is the
>   deliverable", not "distrust the tool". Docs-only.
> - **0.16.0** — Added `keryx-unattended-posture` (specification ready) and
>   narrowed `keryx-shell-remediation` P1 accordingly. The unattended half was
>   descoped out of PR #253 after **three** review rounds, each of which ran the
>   code rather than reading it and each of which found a hole the previous
>   fix had not closed: the destructive-command classifier as a barrier (16
>   commands, including benchmark case C1 verbatim); then an allowlist that
>   accepted `*` and `bash -c *` and `keryx *`; then a literal-command-word rule
>   whose word list omitted `timeout`, `setsid`, `busybox`, `parallel` and
>   eleven more in categories already banned, plus shell escapes through
>   `psql -c '\! …'`, `sqlite3 '.shell …'` and `tar --to-command`. The pattern
>   is the finding and it is now the new package's design constraint:
>   **containment may not be a list of forbidden command words** — each round's
>   rule was better and each round's vocabulary was behind. The corpus from all
>   three rounds ships as the new package's required regression suite so nobody
>   has to rediscover it. Recommended first release is the smallest honest one:
>   a posture that grants no shell at all and exposes only read-risk tools,
>   which is sufficient for the benchmark re-measurement that was the only thing
>   waiting. D1's half — parameter parity, one tool surface, and closing an
>   unapproved out-of-root read channel the work itself opened — ships on its
>   own. Docs-only.
> - **0.15.0** — Added `keryx-shell-remediation` (specification ready; no
>   implementation started). Turns the benchmark's six defects into **three
>   flows instead of six**, grouped by shared verification rather than
>   convenience. **P1** pairs D1 and D2 deliberately: fixing tool affinity alone
>   leaves nothing able to prove the fix, and fixing the unattended mode alone
>   passes the scenario for the wrong reason — by approving the shell
>   round-trip the agent should not have taken. Only together do they yield the
>   assertion that matters: answered correctly, through the native tool, with
>   nobody at the terminal. **P2** groups the three scriptable-door corrections
>   (tools on the non-interactive path, provider list from the registry with the
>   CLI reference fixed in the same change, no undeclared model default). **P3**
>   re-measures after the catalog corrections the run report names. Records the
>   trap explicitly: a blanket `--yes` would pass P1 while trading away the one
>   property the benchmark demonstrated keryx has, so three acceptance criteria
>   exist to fail the flow if a destructive action stops failing closed, and one
>   more to fail it if the default posture is loosened. Docs-only.
> - **0.14.0** — `keryx-shell-benchmark` **partially executed** (5 of 26 cases,
>   seven agent legs, target `helyx` at `bfad745b`) and **halted deliberately**:
>   it had already found two product defects every remaining case would have
>   re-measured. Report: `keryx-shell-benchmark/run-2026-08-05.md`, with 28
>   transcripts, 10 screenshots and the runner committed so it can be re-run.
>   **D1 (High):** on the flagship structural case the keryx agent called
>   `shell_exec("keryx gdgraph affected …")` while the native `graph_affected`
>   tool was registered and available — hit the default-deny shell gate and
>   never answered, while every other leg answered. A prompt/tool-description
>   defect, not a missing capability. **D2 (High):** `keryx shell` has no
>   auto-approve flag at all, so no unattended run — benchmark, CI or batch — is
>   possible; keryx completed 0 of 5 cases without a human. Also recorded:
>   removing the workspace cost Grok 4 seconds on the structural case, and the
>   baselines were *shelling out to the keryx CLI* because the target's
>   CLAUDE.md tells them to, which forced clean `naked-*` control legs.
>   Positives observed: the redaction seam fired on live output, and keryx
>   refused 10 previously-saved over-broad shell permissions. Docs-only.
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
| [Managed Review Feedback Loop](managed-review-feedback-loop/README.md) | implemented (initial runtime slice) | Low-level managed review persistence supports standalone/attached packages, ingest, coverage, findings, decisions, learning, and structural completion. Target orchestration ownership moves to Flow Reviewer. |
| [Flow Reviewer](flow-reviewer/README.md) | specification ready (future) | Task Manager-aware review orchestrator above stateless Review Orchestrator, with one task and durable history per reviewer, adaptive model routing, compact shared context, resume, schemas, and Gherkin acceptance scenarios. |
| [gdgraph Java/Python Import Resolution](gdgraph-java-import-resolution/README.md) | implemented | Language-aware import resolver so Java (Maven/Gradle) and Python source produce real dependency edges instead of nodes-only graphs; fixes the `0/0 = 100%` resolution-metric bug and seeds Java/Python grammars. Verified on example-backend: 0 → 47,984 edges, 94% in-repo resolution. |
| [Keryx Unattended Posture](keryx-unattended-posture/README.md) | specification ready (descoped from PR #253) | D2 on its own, with the evidence of three review rounds as its foundation. The design constraint is stated up front because it was learned the expensive way: **containment may not be a list of forbidden command words**. Round 1 leaned on the destructive-command classifier — whose own header forbids using it to block a command — and 16 dangerous commands executed. Round 2 added an operator allowlist and it accepted `*`, `bash -c *`, and `keryx *` (the pattern an operator on this repo is most likely to write, because our own CLAUDE.md tells agents to route through `keryx ctx run --`). Round 3 required a literal command word and banned wildcards after wrapper words, and `timeout *` still launched and read `~/.ssh/id_rsa`. Every command, pattern and escape from all three rounds ships as a mandatory regression corpus run against a real runner and a real fixture. Recommended first release: no shell at all, read-risk tools only — it cannot be defeated by a word nobody thought of, and it is enough for the benchmark's group A. Explicitly out of scope and explicitly not forgotten: a saved `keryx *` grant auto-approves `keryx ctx run -- rm -rf /` on the supervised path today; not reachable from an unattended run, and it needs its own change. |
| [Keryx Shell Remediation](keryx-shell-remediation/README.md) | specification ready (not started) | The benchmark's D1-D6 as three flows. **P1 (D1+D2)** — the agent reached past its own registered `graph_affected` tool for a `shell_exec` of the equivalent CLI, hit default-deny and answered nothing while six other legs answered; and no `keryx shell` run can complete unattended because there is no way to declare a posture at launch. Paired because either alone leaves the scenario unprovable or passes it for the wrong reason. **P2 (D3-D5)** — register tools on the non-interactive path, read `OPENAI_COMPAT_PROVIDERS` instead of a literal set and fix `cli-reference.md` in the same change, stop defaulting to an undeclared model id. **P3 (D6)** — re-run the catalog after planting a real secret for C2, using `--allowed-domains` for C4, moving A6/A7 to a target with decision pages, and adjudicating the 106-vs-102 transitive count, which is the only surviving candidate for a keryx advantage on A1 and is a correctness argument rather than a speed one. Out of scope everywhere: weakening a `deny`, rewriting a shell call behind the model's back, and any performance claim. |
| [Keryx Shell Remediation v2](keryx-shell-remediation-v2/README.md) | specification ready (not started) | The **second** benchmark run's four product defects, kept apart from the seven defects the run found in the benchmark itself. v1 made keryx able to *finish* a task; v2 asks whether the answer is *right* and whether a user can tell what protection they have. **P1** — `gdgraph` counts `await import()` as an ordinary import edge, so five of the eight cycles it reports on the target are not load-order cycles; the kind is available from `scanImports` and discarded one line later (`build.ts:230`), verified by running the transpiler. **P3** (flow 139, open) — the shell prompt's "give the shortest correct answer" is applied by the model to its *tool-call budget*: on A3 **and** A4, `opencode` on the **same model** gave the better answer purely by verifying, and keryx restated its own tool. P1 lands first because it is also P3's regression fixture — fix the disposition against a tool that is still wrong and a passing test cannot tell "checked" from "got lucky". **P2** — the approval menu offers a prefix grant `isShellCommandAllowed` will never honour, breaking an invariant stated three lines above the code that breaks it; not an escape, but the consent shown is not the consent given. **P4** — a Linux install has no OS containment and nothing says so: filesystem containment and network-off *are* implemented there and both need `bubblewrap`, which the 144-line installer never mentions and no command reports on, while `KERYX_SANDBOX_SHELL` is off by default. Explicitly out of scope: implementing the Linux domain allowlist (unimplemented by design — `bwrap --unshare-net` gives the process its own loopback, not the proxy's — and it fails closed, which is correct), and changing the sandbox default. Carries the counterweight the P3 fix must respect: on the A1 re-run the leg that *did* verify invented a correction, so the target is "check when the tool's answer is the deliverable", not "distrust the tool". |
| [Keryx Shell Benchmark](keryx-shell-benchmark/README.md) | **executed twice** — run 1 partial (5 of 26 cases), run 2 complete for group C and all of group A (42 runs). Findings: [findings.md](keryx-shell-benchmark/findings.md); next run: [run-3-runbook.md](keryx-shell-benchmark/run-3-runbook.md), blocked on four decisions | The task selection `keryx-execution-observability` left as a product decision, made concrete: 26 frozen cases in four groups — workspace leverage (blast radius, call chains, cycles, orphans, wiki architecture and recorded decisions, memory, related tests, budgeted repomap, health, context assembly), ordinary coding work as a floor check, containment, and session durability. Two keryx legs (DeepSeek, and free local `gemma4-coder`) against Claude Code and Codex on the same commit, one git worktree per run, byte-identical prompts, and a rubric that scores **grounding** apart from correctness so a lucky guess cannot pass as retrieval. Fairness is stated where it cuts against keryx: the baselines run frontier models against a 7B local leg, and they may read `.metaproject/` files — what they lack is the query layer. Negative outcomes (`keryx-regression`, `capability-unused`) are reported with the same prominence as wins, and no speed claim is published unless the observability decision rule is satisfied. Results emit into the existing `paired-3-5-v1` manifest and validate with `keryx metrics benchmark validate`. |
| [Keryx Execution Observability](keryx-execution-observability/README.md) | implemented (runtime capability; benchmark harness ready) | Provenance-aware execution metrics, active-time accounting, per-run evidence, baseline-aware CI, lightweight profiles, retry taxonomy, and paired Keryx/no-Keryx validation protocol. No performance claim has been made. |
| [Keryx Context Operations](keryx-context-operations/2026-07-12/README.md) | specification ready (future) | Git-native bounded context assembly with provenance, deterministic-first hybrid retrieval, policy gates, feedback lifecycle and corpus evaluation. It extends existing project sources; no new runtime is implemented yet. |
| [Keryx Provider Auth](keryx-provider-auth/README.md) | specification ready (future) | Expands the **implemented** provider registry (`src/commands/providers.ts` — eight OpenAI-compatible entries plus native Anthropic and Ollama, all Bearer API key today) with a declared authentication method per entry: `none`, `api-key`, `device-code`, `oauth-pkce-loopback`, `cloud-credentials`. Adds the **OAuth 2.0 device authorization grant** (RFC 8628), which needs no loopback listener and no browser on the keryx machine and so closes the gap the credential handoff link cannot — a provider can be authorized by opening a link on a phone, with only a short single-use code and a public verification URL crossing the transport. Expands the list: **OpenAI** (conspicuously absent today), Google Gemini, Mistral, Together/Fireworks/DeepInfra/Perplexity/Nebius, LM Studio and llama.cpp, plus **GitHub Copilot** as the first sanctioned subscription provider. Records D-01 with sources: subscription login only where the vendor permits third-party clients — Anthropic Claude Pro/Max and ChatGPT Plus/Pro are deliberately excluded because the cost of ignoring their terms falls on the operator's own account. The method is registry data, so a vendor's terms changing is a one-line edit and the compliance boundary stays reviewable. |
| [Keryx Remote Entry](keryx-remote-entry/README.md) | implemented (R4a–R4c: registry, listener, turn submission); R4d–R4f open | **Shipped:** R4a — user-global project registry (flow 127, PR #215; `src/lib/project-registry.ts`, `src/commands/projects.ts`). R4b — the `keryx serve` skeleton (flow 128, PR #216; `src/commands/serve.ts`, `src/lib/serve-{config,credential,server}.ts`, `src/lib/config-dir.ts`): off-by-default loopback listener, bearer authentication compared in constant time, `serve token issue \| rotate \| revoke` with only a salted hash persisted, a `stopped -> configured -> listening -> draining -> stopped` state machine where `refused` binds no socket at all, and exactly two authenticated read-only routes, `GET /v1/status` and `GET /v1/projects`, with authentication running **before** routing so an unauthenticated caller cannot distinguish a known path from an unknown one. R4c — turn submission (flow 133, PR #220; `src/lib/serve-{turn,turn-store,runner,throttle}.ts`): `POST /v1/turns` over the harness run loop, an idempotency key scoped per project so two projects cannot collide on one key, durable turn records, SSE streaming, and the two items R4b deferred — the non-weakening remote policy profile comparison (AC-04, which now has a `resolveLocalProfile`) and auth-failure throttling, owed from the first mutating route. An `ask` decision terminates in a **recorded denial**, stated as a boundary in `serve-turn.ts` rather than left to emerge from the absence of an approval store. **Open:** R4d asynchronous fail-closed approvals; R4e maintenance operations projected from the command registry; R4f the one-time expiring credential handoff. Also deferred with them: `GET /health` and cross-process liveness (no PID file yet — `serve status` reports configuration state only). **Specification:** `keryx serve`, a loopback-bound, off-by-default, token-authenticated HTTP entry over the **implemented** Project Agent Harness, so Telegram, a browser workspace and third-party embedding become clients of one surface instead of three integrations. Reuses the existing run loop, append-only session store and policy engine unchanged; adds asynchronous fail-closed approvals (unanswered or undeliverable resolves to deny), identity-first session binding, a remote policy profile that may never be weaker than local, server-stamped unforgeable turn origin, and mandatory redaction. **1.1.0** adds a user-global project registry populated by `keryx init` (the addressing keys a transport routes by — nothing on the machine knew the project set before), maintenance operations projected from `src/standard/command-registry.ts` and run directly rather than through the model with the registry's `read`/`model` flags driving classification and cost disclosure, and a one-time expiring loopback-bound credential handoff: **no route accepts a secret**. No new runtime dependency; no database. Records two decisions with named compensating controls: widening the remote boundary to `task.submit`, and keeping secrets off the remote surface entirely. Extending the command registry is a stated dependency. |
| [Keryx Telegram Transport](keryx-telegram-transport/README.md) | specification ready (future) | Optional transport, from 2.0.0 a **client of Keryx Remote Entry** rather than a parallel path into the harness: local long polling, bounded notifications, policy-constrained approvals, cancellation of own active operation, typed intents, and `task.submit`. **2.1.0 adds multi-project and voice to Release 0**: a forum supergroup with one project per topic, routed by topic identifier where an unmapped topic *refuses* rather than falling back to another project's session; per-binding serialization with parallel projects and queue-position reporting; three-state binding validation where an inconclusive check never clears a mapping; and voice in both directions, local-first, off by default, with every remote transcription or synthesis call passing the egress policy and synthesis accepting post-redaction text only. Supergroup membership authorizes nothing — every sender is authorized individually, before routing. **2.2.0** makes the deployment model explicit (one operator, one install, many projects): topics follow `keryx init` via the project registry instead of a bulk setup, ordering between forum configuration and registration stops mattering, a topic becomes an operating surface whose command menu is *generated* from the command registry so a new keryx command appears without a bot change, and provider setup works without a web UI because the transport renders a one-time handoff link rather than ever accepting a secret as a message. Authentication, session addressing, approval semantics, the remote policy profile and redaction remain delegated to Remote Entry. No remote control plane in Release 0. |
| [Keryx Metaproject-Native Harness](keryx-metaproject-native/README.md) | implemented (Phases 1–3 + S1/MP-6/MP-5a; Phase 4 and legacy-adapter retirement pending) | A single typed `MetaprojectPort` + schemas so the harness, interactive agent, and MCP server reach graph/wiki/memory/context in-process from one source (replacing subprocess wrappers and hardcoded MCP adapters), plus a universal, schema-published Task Manager (`flow-state.schema.json` + `ManagedFlowPort`) any runtime can drive while preserving the D-02 invariant. **Phases 1–3 shipped** (`src/harness/tool/metaproject-{port,adapter,operations}.ts`, `src/mcp/metaproject-tools.ts`, `flow-state` schema + `keryx flow schema` CLI; flows 037/038/040). **Flow 122 (PR #207) closed the harness-core `RunDeps.metaprojectPort` seam (S1), the MP-6 blast-radius escalation wiring, and the MP-5 `wikiBacklinks` operation.** Genuinely open: Phase 4 policy-context enrichment, legacy MCP adapter retirement, and subprocess-wrapper retirement. |
| [Keryx Multi-Agent Engine](keryx-multi-agent-engine/README.md) | implemented (A→B→C, flows 088–101) | Subagent orchestration over the Project Agent Harness: a fail-closed `resolveChildModel` resolver adding explicit-or-inherit model/provider selection, a policy-gated provider allowlist with scoped credentials, subagent depth/count caps and a single shared budget ledger (including the previously-deferred `maxCostUnits` cost dimension landed in flow 101), a deterministic monitoring fold (`keryx agents monitor <events-file>`), child-output injection quarantine, adaptive cost-aware model escalation, git-worktree isolation, and bounded peer messaging. **All of A→B→C shipped** as flows 088–101 with AC1–AC8 tests green. Genuinely remaining: a live `keryx agents` snapshot against a running run and a dedicated `orchestrator-state` fold. |
| [Keryx Linux Containment](keryx-linux-containment/README.md) | specification ready (future) | Landlock-first Linux containment, because the current Linux boundary does not hold on a stock Ubuntu 23.10+ and keryx reports that it does. `bubblewrap` builds its boundary from unprivileged user namespaces, which Ubuntu withdrew by default (`kernel.apparmor_restrict_unprivileged_userns=1`), so every contained run fails `bwrap: setting up uid map: Permission denied` — while launcher detection (a `PATH` lookup) and the static capability matrix compose into "Filesystem containment and network-off are available". Measured on Ubuntu 24.04 / kernel 6.8: Landlock ABI **4** is present and needs no privilege, no namespace and no LSM profile, where bubblewrap needs an AppArmor profile authored by hand. Three layers per [ADR-0010](../decisions/keryx-harness/ADR-0010-linux-containment-without-privilege.md) — Landlock default, bubblewrap fallback for old kernels, container deferred as the only path to a Linux domain allowlist (~409 ms/command, and `docker` group membership equals root on the host being protected). Sequenced so the **probe lands first and alone**: reporting capability from a trial containment rather than from a binary's presence removes a false statement from a shipped product and is independent of Landlock. States where Landlock is *weaker* than bubblewrap rather than hiding it — its network restriction is TCP-only, so `network: "off"` keeps selecting bubblewrap until a seccomp filter exists. No new npm dependency; blocked on the unmerged `fix/benchmark-remediation-v2`, which is where `keryx sandbox status` and the capability matrix currently live. |
| [Keryx OS Sandbox](keryx-os-sandbox/README.md) | implemented (macOS full; Linux filesystem + network-off only) | Kernel-enforced containment under the policy engine: workspace-write filesystem boundaries and secret read-deny via macOS Seatbelt / Linux bubblewrap, network off/on/restricted, a loopback domain-allowlist proxy with reported allow/deny rulings, credential masking behind a per-run sentinel, and opt-in TLS termination for HTTPS masking. Zero new npm dependencies. Fails closed when a launcher is missing or a posture is unsupported — the domain allowlist, credential masking and TLS termination are macOS-only and refuse to run on Linux rather than degrading to full host network. Includes human and agent guides plus a manual verification runbook. |
| [Keryx Sandbox Credential Auto-Mask](keryx-sandbox-credential-auto-mask/README.md) | implemented (P0–P0.b; PR #175–179) | Auto-derive HTTPS credential masks when restricted OS sandbox is on; fail-closed TLS (ADR-0007). **P0** resolver. **Verify** dual-axis. **P1** global `sandbox.json`. **P2** project `.keryx/sandbox-policy.json` + init skeleton. **P0.b** flipped the built-in unset-`maskMode` default from `manual` to **`auto`** and added a flag-gated live dual-axis smoke test (flow 108). Order: env → project → global → built-in (`auto`). Secrets: user-global `auth.json` only. |
| [Keryx Sandbox Harness Hardening](keryx-sandbox-harness-hardening/README.md) | implemented (H1+H2+H3-light) | Operator/security edge after live deep probe: harness **mask-without-TLS fail-closed**, structured spawn diagnostics (exit-71 class), portable **deep-probe** script + REPORT schema, agent rules for **network.decisions** over curl exitCode. Does not re-architect OS sandbox. H0 docs were already on main. Related already-landed UX: tool budget 48 (PR #180), multiline shell allow (PR #181). |
| [Keryx Project Agent Harness](keryx-project-agent-harness/README.md) | implemented (Release 0 + most of Release 1/2) | The execution loop that lets a model operate on a project through controlled tools while keeping the project brain local, durable, auditable, and reproducible. `src/harness/` is a substantial runtime (~175 files across 30 subdirectories): append-only session, allow/ask/deny policy engine, tool registry, provider port (fake + Anthropic + Ollama adapters), resume/recovery, branch/compaction, guarded mutation + approval, child-agent isolation (see Multi-Agent Engine), bounded parallel scheduling, extensions, OS sandbox integration, replay, completion, budget, and monitor. CLI: `keryx harness run|exec|extension|wave`. Release 2+ still open: harness TUI, network broker-mediated tools, full-strength executable extensions, provider-side session storage, external compatibility adapters. |
| [Keryx OpenTUI Shell](keryx-opentui-shell/README.md) | implemented (default shell; flows 059–066) | Full-screen OpenTUI (`@opentui/core`) interactive shell replacing the line-based `node:readline` renderer: live `/` command composer, persistent composer region, component-based rendering, with the deterministic agent driver and pure render helpers unchanged. The TUI is **the default shell when `stdout.isTTY`**; `--tui`/`--no-tui` flags and a graceful readline fallback remain. ADR-0005 Accepted. Additive features shipped beyond the original Phase 0–5 spec: side-workers, multi-agent spawn wiring, dual-store session persistence. |

