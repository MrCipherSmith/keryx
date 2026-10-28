# Headless Keryx session and future web chat
Version: 0.2.0

Status: normative session foundation for the expanded hub-remote-sessions specification; planned, not implemented. It supersedes the former design-only extension when the new canonical Flow is reviewed and frozen. The original sixteen-criterion Flow remains historical and is not repinned by this document.

## Owner intent

keryx serve hosts a complete agent session without starting OpenTUI/readline, a PTY, or a subprocess that scrapes keryx shell output. The future web chat controls the same session capabilities as the local interface, including commands and model/provider routing. This requires a shared session/application layer, not only exposing one runOffline call and a final result.

## Shared session host

Separate domain operations from renderers. A shared SessionHost owns native session history/lease, selected project/checkout/profile, message queue, turns, model/provider/reasoning/routing state, context/tool services, confirmations, local execution policy, budgets, supervised tasks and event publication. Terminal and web adapters render/submit typed operations; neither contains a separate implementation of business rules. Reuse runAgentTurn/AgentIO/AgentDeps and the injectable runAgentRepl/runShell seams, existing session lease/preservation/finalization APIs and buildInteractiveAgentTools. Existing non-TUI code is reused where it already implements these responsibilities; extraction is required only for responsibilities still embedded in TUI.

Keep identities distinct: machine/checkout identify execution location; sessionId identifies a continuing conversation; turnId/runId identify one execution within it; commandId identifies a user operation. Flow association belongs to the execution/result and does not erase a conversation after one task. A browser reconnect reattaches to a conversation and replays history/events without starting another turn. A restarted local host does not replay uncertain tool effects; existing unknown/recovery rules remain.

The future web chat submits messages, displays final/operator-facing streamed text and tool/approval cards, shows queue/tasks/usage and presents structured controls. The same host may serve multiple separately leased sessions; each keeps its own routing and context. One owner controls mutations at a time; other authorized clients observe. Session takeover requires an explicit versioned operation and confirmed owner release/recovery, not last connection wins. A controller lease never overrides local checkout/process ownership.

## Functional coverage

Required target groups:

- Conversation: new/open/resume/fork, ordered history, subsequent messages, turn cancellation, queued message edit/remove and compaction.
- Commands/help: discover the existing Keryx command vocabulary, validate typed arguments, execute the same domain handlers and return structured results/errors/confirmation requests.
- Model and routing: inspect locally available connected providers/models, choose model/reasoning effort, inspect/update session routing using locally permitted profiles and candidates, see effective model selection and fallback reasons per turn. Interpret the owner's routing request as model/provider routing, not network roaming.
- Context and development tools: existing workspace/wiki/spec/memory/Flow/tool/task capabilities through typed services, with equivalent ownership, security and provenance.
- Execution: real native tools, supervised tasks, subagents where locally enabled, progress, limits, usage and pending confirmations.
- Settings and confirmations: read effective configuration, apply allowed session settings and route sensitive changes through dedicated confirmed workflows. Provider secrets never become chat messages or session history.

TUI panels become structured data plus web components, not permanent domain exclusions because the old renderer is terminal-only. Terminal theme/key bindings/clipboard are client presentation features. Security-local operations, unavailable provider integrations or unsupported adapters have explicit reasons and setup paths. No claim of complete parity is allowed while required domain operations remain merely labeled unavailable.

Provider connection/credential entry requires a dedicated secure setup flow or local setup, not arbitrary secret text in chat. Existing external-agent capability/vendor/consent gates remain in force; designing SessionHost does not make Codex/Claude/OpenCode executors implemented. Optional adapters are tracked separately from native session parity.

## Commands and routing semantics

Advertise a versioned command catalogue derived from the actual registry: stable command ID/name, purpose, typed input requirements, read/mutation class, applicable session state, required confirmation and local-policy availability/reason. A slash-command picker and a settings button invoke the same handler. An explicit command is not silently sent to the model on parse failure, nor converted into an arbitrary operating-system shell command. Prompt text and command submissions are distinct typed operations, with a documented escape for literal slash-led text and no silent loss of attachments/multiline input.

Each mutating operation carries an idempotency identity and expected session/config version. A repeated identity returns the existing result; changed payload conflicts. Commands that change model/provider/routing/compaction/session identity run at an idle safe boundary. While busy, either enqueue explicitly with an observable receipt or reject as busy according to a documented per-command policy; do not alter a running turn midway. Model/provider/routing configuration is snapshotted when a queued message becomes an admitted turn. Per-turn events show the chosen effective version and later fallback outcome. Preserve the current routing semantics explicitly: manually selecting a model changes the session baseline while routing can remain enabled; classifier failure falls back to that baseline. Configuration receipts name the effective next-turn boundary rather than implying an in-flight model switch. Re-evaluate queued mutations if local policy/capability changes before application.

Remote routing may select only locally permitted connected candidates and data-egress/spend limits. Changes with cost/privacy consequences require an exact human confirmation; allowed session control cannot raise the machine's permission floor, tool trust, provider consent or budget ceiling. Safety profile widening or provider credential administration stays outside ordinary chat commands. This distinction must be explicit in the amended security policy rather than accidentally contradicting the original no-remote-permission-mode-change rule.

## Reuse evidence and gaps

src/commands/agent-commands.ts supplies command names/availability; src/remote/command-gateway.ts classifies a deliberate Telegram subset, including model and route controls. That Telegram list is evidence of existing domain operations, not the complete future web catalogue. src/acp/commands.ts exposes four actual editor commands and explicit model/reasoning next-turn semantics, not full shell parity. src/commands/shell-types.ts defines injectable ShellIO/ShellDeps and leased-session options. RemoteCommandHost/RemoteCommandRouter provide reusable serialized command/picker/confirmation seams; the catalogue itself has no executable handlers/argument schemas or headless capability metadata yet. Existing remote command host/router seams are reusable, but the complete host remains wired in the TUI; production serve does not inherit it merely by loading the command list.

Before implementation, produce a source-backed command coverage inventory with one row per actual command/subcommand: shared handler, headless capability, confirmation/busy policy, client rendering/setup needs, test and implementation phase. Reuse the registry and handlers; do not maintain a hand-written divergent web command list. New commands must fail a coverage check until classified. Baseline full-parity tests exercise an identical sequence through terminal and headless adapters and compare normalized domain outcomes, not terminal pixels.

## Acceptance requirements for this session foundation

- S1: Persistent native sessions run without importing/initializing terminal input/rendering; ordinary later turns retain history/context and native session identity. Verification: judged.
- S2: Command coverage inventory accounts for every actual registered command/subcommand with a reasoned status and explicit required parity set; required domain capabilities cannot pass as permanent TUI-only exclusions. Verification: judged.
- S3: Typed command discovery/execution shares actual handlers with local clients and preserves arguments, attachments, confirmation and busy semantics without model/OS-shell fallback. Verification: judged.
- S4: Model/provider/reasoning/routing can be inspected and changed within locally allowed candidates and budgets; versioning, next-turn snapshots, queued operations, cost/privacy confirmation and fallback provenance are tested. Verification: judged.
- S5: Multiple browser reconnects/observers, explicit controller ownership and session restart recovery cannot duplicate turns/commands or consume stale confirmations. Verification: judged.
- S6: History, compaction, queue edit/remove, tasks/subagents, context and existing confirmations are available through headless services under the same policy; missing required parity remains a reported gap. Verification: judged.
- S7: Headless/terminal parity tests compare normalized outcomes; full native coding/approval/cancellation and command sequences use the actual host with a deterministic provider, without a PTY or fake success responses. Verification: judged.
- S8: Future web-chat rendering is separable from the session foundation; the foundation provides structured results/events/capabilities and safely rendered operator-facing text, without hidden reasoning or credential exposure. Verification: judged.

## Staging

After the expanded specification is reviewed and frozen, implement shared SessionHost, command inventory and session/routing control APIs alongside existing start/progress/approval/cancel transport. A later web-chat Flow supplies conversation UI over these APIs. Rich management panels and additional vendor adapters can be staged, but full-functional-parity release claims require the agreed coverage set to pass. No runtime work or change to the historical Hub Flow is performed by publishing this contract.
