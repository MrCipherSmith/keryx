# `/goal` mechanism survey — keryx vs. 13 competitor coding-agent CLIs

Source for flow 186 (`bounded-autonomous-continuation-for-goal`). Produced
2026-08-21 by reading keryx's own `src/commands/goal-command.ts` and dispatching
one research pass per clone under `~/sandbox/forks/` — aider, cline, codex,
continue, crush, deepseek-harness, gemini-cli, grok-build, helyx, kilocode,
oh-my-claudecode, opencode, qwen-code. Two published artifacts (English and
Russian) present this as a formatted report; this file is the durable,
in-repo record the flow cites.

## Method

Each clone was asked the same question: does anything analogous to keryx's
`/goal <text> [--workspace <id>]` exist — a deterministic entry point that
declares a task, and/or persists context past the current turn/session? File
paths and line numbers below are as found in each clone at survey time; they
are not re-verified against upstream's current HEAD.

## Summary

| Tool | Goal command | Persistent goal state | Multi-turn autonomy | Distrusts its own "done" | Cross-session memory | Human review gate |
|---|---|---|---|---|---|---|
| **keryx** | `/goal` | Slate | — | — | SAC workspace | `keryx workspace review` |
| qwen-code | `/goal set\|edit\|pause\|resume\|clear` | GoalRecord (optimistic concurrency) | Stop-hook, capped 50 rounds | Evidence-cited verifier LLM pass | — | — |
| grok-build | `/goal` | plan.md + JSON snapshot | plan → execute → verify → retry | Skeptic subagents, stall fingerprinting | — | — |
| deepseek-harness | `/goal` | Event-sourced (CQRS) | Round-driver, hard cap | Authority proof (human msg or admitted round) | — | — |
| oh-my-claudecode | wraps host `/goal` | Unreviewed JSON ledger | Host-dependent | — | Self-attested snapshot only | — |
| gemini-cli | `/plan` (mode toggle) | Reset every session | — | — | — | — |
| opencode | plan persona + scratch file | Flat markdown | — | — | — | — |
| kilocode | — | — | — | — | Auto-capture, ungated (`kilo-memory`) | — |
| helyx | — | — | — | — | pgvector auto-recall, ungated | — |
| cline | — | — | — | — | "Memory Bank" — convention only, zero code | — |
| codex | — | — | — | — | — | — |
| crush | — | Static `CRUSH.md` | — | — | — | — |
| continue | — | — | — | — | — | — |
| aider | — | — | — | — | — | — |

## No equivalent (9/13)

- **aider** — 43 slash commands, all mode/file-scope switches
  (`/ask`/`/code`/`/architect`, `aider/commands.py:87-1638`). No task or
  memory concept exists.
- **cline** — `/newtask` is an alias of `/compact`. "Memory Bank"
  (`docs/best-practices/memory-bank.mdx`) is a pasted-instruction convention
  telling the model to self-discipline into editing markdown files — zero
  code, no lock, no schema, no review.
- **codex** — `update_plan` (`codex-rs/core/src/tools/handlers/plan.rs`) is a
  UI-only checklist, never persisted. "Plan mode" is an unrelated read-only
  permission preset that actively rejects `update_plan` calls while active.
- **continue** — zero hits for goal/objective/plan/task across the codebase.
  `/init` (`extensions/cli/src/commands/init.ts`) writes `AGENTS.md` once.
- **crush** — `new_session` clears the transcript, nothing more. `CRUSH.md`
  is generated once at setup, then loaded as static context forever.
- **gemini-cli** — `/plan` (`packages/cli/src/ui/commands/planCommand.ts`)
  flips `ApprovalMode.PLAN`. The plan file lives in session temp storage and
  is reset to `undefined` at session boundaries
  (`config.test.ts:1968-1973`).
- **helyx** — not a peer product (a Telegram relay onto real Claude Code
  sessions). Its `memory/long-term.ts` pgvector recall is model-written via
  an MCP tool with no human accept gate.
- **kilocode** — "Orchestrator" is a persona, not a goal binder.
  `packages/kilo-memory/` auto-captures on every turn-close, no review gate,
  decoupled from any goal-start moment.
- **opencode** — "plan" is a permission-scoped agent persona
  (`src/agent/agent.ts:156-169`). Behind an experimental flag it writes one
  flat markdown scratch file per session — nothing structural.

## Real goal engines (4/13) — session-autonomous, no durable memory

- **qwen-code** (`packages/core/src/goals/`, ~6,000 LOC, 15 files) — the
  heaviest implementation surveyed, and qwen-code-specific (not inherited
  from upstream gemini-cli). `GoalRecord` carries optimistic-concurrency
  control (`expectedGoalId`/`expectedRevision`). A Stop-hook
  (`goalHook.ts`, `MAX_GOAL_ITERATIONS = 50`) auto-redrives the turn loop.
  On a `complete` claim, the runtime builds a bounded evidence catalog from
  the transcript (100 entries / 24KB cap, `goal-evidence.ts`) and runs it
  past an independent verifier LLM call
  (`goal-verifier.ts`'s `GOAL_VERIFIER_SYSTEM_PROMPT`) that must reject any
  claim without a cited, typed evidence record. No cross-session memory —
  goal state recovers only from that session's own transcript log.
- **grok-build** (`crates/codegen/xai-grok-shell/src/session/goal_tracker.rs`,
  ~850 LOC) — a state machine (`Idle → Planning → Executing`,
  `GoalStatus: Active | UserPaused | BackOffPaused | NoProgressPaused |
  InfraPaused | Blocked | BudgetLimited | Complete`). Plan snapshotted
  immutably to `plan.baseline.md`. Independent "skeptic" subagents re-verify
  the implementer's claimed output in isolated scratch dirs; a
  `gap_fingerprint` compared round-to-round trips auto-pause on repeated
  identical rejections; a "strategist" subagent restructures the plan after
  repeated failures. Resumable JSON snapshot, but scoped to one goal's own
  run.
- **deepseek-harness**
  (`packages/goal/{goal,tool-goal,command-goal,goal-round-driver}/`) —
  event-sourced (CQRS): `goal/change` events fold into a `GoalProjection`.
  `GoalPhase` is durable; `GoalActivation` (armed/disarmed) is deliberately
  process-local and never persisted, so a resumed/forked session never
  silently inherits continuation authority. A model-facing tool can only
  complete/block a goal via a direct human message this turn, or by landing
  inside the exact admitted round for the current revision
  (`tool-goal/src/authority.ts:90-108`) — the model cannot self-authorize.
  Its own README states cross-session execution is explicitly out of scope
  ("belongs to its own plugin layer").
- **oh-my-claudecode** — does not implement its own; wraps Anthropic's
  *native* Claude Code `/goal`, which is a Stop-hook goal-*lock* (blocks the
  session from stopping until a condition holds) — structurally inverted
  from keryx's meaning (keryx's starts work; Claude's prevents stopping).
  OMC's own "ultragoal" skill writes an unreviewed JSON ledger and
  reconciles it against a model-self-reported snapshot, a limitation its own
  docs flag directly (`skills/ultragoal/SKILL.md:94`).

## Conclusions carried into flow 186

1. No competitor has anything resembling SAC's durable, cross-session,
   human-reviewed knowledge store bound to a goal. Every "memory" system
   found is either a static hand-edited file loaded verbatim, or fully
   automatic/model-authored with no accept step.
2. Three competitors independently built the piece keryx's `/goal` lacks:
   a bounded, self-verifying, multi-turn continuation loop. All three scope
   OUT cross-session memory as a separate, unsolved concern.
3. The concrete, keryx-sized graft is not "build a GoalRecord/event-sourced
   subsystem from scratch" — keryx's Task Manager (`keryx flow`) already
   has a live, task-completion-derived "is this done" signal
   (`isCourseDone`/`courseFromSlate`, `src/commands/agent.ts`) that a bound
   Slate course already uses to decide when to close. The missing pieces
   are: (a) a loop that re-drives `runAgentTurn` using that existing signal
   as its stop condition, and (b) one verifier `spawn_subagent` call before
   the loop actually stops — not a new evidence-catalog or event-sourcing
   layer.
