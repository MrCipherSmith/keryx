# Keryx Project Agent Harness Brainstorm and Decisions
Version: 0.1.0

## Framing

The decision is whether Keryx should remain a project context/control plane
used by external agent runtimes, or become an independent project-oriented
agent harness that owns execution while treating models and clients as
replaceable providers/transports.

## Option A: Stay a Context Plane

Keryx continues to produce graph, wiki, memory, skills, health, security, and
flow artifacts. Claude Code, OpenCode, Pi, or Codex execute the work.

- Effort: S
- Short-term risk: low
- Strategic differentiation: medium
- Main weakness: Keryx cannot enforce its own runtime contract or completion
  gates when an external agent ignores them.

## Option B: Embed One Existing Runtime

Keryx embeds or wraps OpenCode or Pi and becomes dependent on that runtime's
session, tool, permission, and provider contracts.

- Effort: M
- Short-term value: high
- Strategic risk: high
- Main weakness: project-oriented state becomes subordinate to another
  runtime's lifecycle and release cadence.

## Option C: Build a Keryx-Owned Harness

Keryx owns a small provider-neutral execution core. Existing project modules
become first-party tools and context providers; external runtimes are optional
adapters.

- Effort: L/XL
- Short-term risk: medium/high
- Strategic differentiation: very high
- Main strength: the `.metaproject/` project brain becomes the primary product
  rather than an integration layer.

## Option D: Two-Layer Product

Build a Keryx-owned single-agent runtime first, then add external adapters and
optional compatibility packages after the project-native contracts stabilize.

- Effort: XL over multiple phases
- Strategic risk: manageable if staged
- Recommendation: selected.

## Research-Derived Design Inputs

### From Pi

Pi documents a minimal core extended through TypeScript extensions, skills,
prompts, themes, packages, SDK, and JSONL/RPC. Its session design uses an
append-only tree, stable entry ids, compaction, branch summarization, and
streamed events. Keryx should adopt the durable event/session discipline while
making project artifacts and policy first-class.

### From OpenCode

OpenCode documents primary agents and subagents, tool permissions with
`allow`/`ask`/`deny`, custom tools, plugins, MCP servers, and project/global
configuration. Keryx should adopt the separation between role, tool, and
permission, but store the authoritative policy in `.metaproject/`.

### From oh-my-claude

The quality harness demonstrates that “done” must be a gated state. It uses
intent classification, specialist routing, pre/post compaction hooks, reviewer
sequences, and hard stop gates. Keryx should implement these as typed runtime
policies and evidence gates instead of shell overlays tied to one client.

### From oh-my-claudecode

The project demonstrates staged team execution, parallel workers, adaptive
roles, persistent loops, replay/state artifacts, and explicit warnings against
competing loop authorities. Keryx should add bounded waves and child sessions
only after the single-agent loop is reliable.

## Selected Decisions

### D1: Keryx Owns the Project Lifecycle

The harness, not the model provider, owns flow state, acceptance criteria,
budgets, retries, evidence, and completion.

### D2: Single-Agent First

Implement the complete single-agent path before parallel child agents. This
reduces debugging dimensions and creates a reliable substrate for delegation.

### D3: Event-Sourced Session Core

Use append-only JSONL events with stable ids and derived current views. This
supports resume, replay, compaction, audit, and multiple transports.

### D4: Tool Registry Before Prompt Features

The model may only affect the project through typed tools. Prompt templates,
skills, and roles cannot bypass tool policy.

### D5: Policy Is a First-Class Domain

Permission resolution is deterministic, testable, and independent of the CLI or
TUI. Interactive approval is a transport concern over a policy decision.

### D6: Evidence-Backed Completion

The runtime never treats a final assistant message as sufficient. Completion
is a gate evaluation over project artifacts and runtime evidence.

### D7: Preserve the Deterministic Floor

The harness is an explicit capability. Existing Keryx commands must not load a
provider, open a socket, or require a model when the harness is disabled.

### D8: Existing Contracts Are Reused

Use current `subagent-dispatch`, `subagent-result`, `agent-event`,
`orchestrator-state`, and `review-finding` contracts. Add new contracts only
for harness-specific state.

## Critical Questions

1. What is the minimal safe tool set for the first vertical slice?
2. How are shell and filesystem actions sandboxed on macOS/Linux/Windows?
3. Which provider APIs are supported without binding the domain to one SDK?
4. How is user approval represented in headless RPC mode?
5. How are context freshness and source trust represented?
6. What evidence is necessary to claim a task is complete?
7. How does a child agent avoid duplicating parent context and budget?
8. How are stale sessions migrated after schema changes?

The implementation plan assigns each question to a concrete phase and test
slice. An unresolved question must remain an explicit `OPEN` decision in the
flow rather than being silently guessed by a worker.
