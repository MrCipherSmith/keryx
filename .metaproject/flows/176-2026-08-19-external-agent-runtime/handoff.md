# Handoff — flow 176, External Agent Runtime
Version: 1.0.0
Written: 2026-08-20

Read this first if you are picking the work up cold. The full chronology is in
[journal.md](journal.md); this is only what you need to continue.

## Where things stand

| | |
|---|---|
| Branch | `feat/keryx-external-agent-runtime` (pushed, in sync with origin) |
| PR | **draft #354** against `main` (`gh pr view 354`) |
| Flow | `in-progress`, tasks 19/19, **acceptance criteria 14/17** |
| Suite | 4794 pass, 0 fail; `bun run typecheck` clean; no new dependencies |
| Package | `docs/requirements/keryx-external-agent-runtime/` |

The flow **cannot legitimately complete** while three criteria are unmet. That
is the correct state, not a blocker to route around — do not confirm them to
close the flow.

## What works

keryx can delegate bounded, read-only work to `codex exec` and `claude -p` as
child agents of the existing harness. Registry, both codecs, the `runtime`
dispatch block and its validator, child environment, prompt assembly, process
supervision with a real spawn port, the orchestrating runtime, the opt-in
capability gate, `keryx agents external list|probe`, the `spawn_subagent` seam,
and the operator surface — live transcript, Work/Meta/Command modal, sidebar
marker, per-addressee queue, `/delegate`.

**Off by default.** Enable with `externalAgents.enabled` in the user config, and
inside a workspace also `keryx init --external-agents`. Hard disabled under a
remote transport or CI regardless of configuration.

## The three unmet criteria — this is the remaining work

**AC13 — smallest, do it first.** `resultSchemaPath` is set only in tests, so
the runtime never requests a structured result, so R22's validation against
`subagent-result` never runs and AC13 has nothing to fire on. Both codecs
already build the flag correctly (`--output-schema` / `--json-schema`); nothing
asks them to. Wire it in `runtime.ts` — write the schema to a temp file, pass
the path, validate the result, and map an invalid one to `Error` rather than
silently accepting prose.

**AC5 — half done, and the missing half is a real question.** The codecs parse
every fixture into the canonical event sequence. Nothing folds those events
through `reduceAgents`, because `ExternalEvent` (`src/harness/external/types.ts`)
and `AgentEvent` (`src/harness/monitor/reduce.ts`) are **different types with no
bridge**. Two module headers claim the fold works unchanged; that claim is
aspirational and should be either made true or deleted. Decide whether to map
one onto the other or to widen the monitor — do not just delete the comment and
confirm the AC.

**AC12 — the real feature.** §7.6's supervision triggers do not exist anywhere
(`phase_changed`, `budget_threshold`, `no_progress`, `agent_asked`,
`scope_drift`), so the parent agent receives a child's result and nothing before
it. R15 is marked UNMET in `specification.md` §7.6, `agent-protocol.md` §4 and
the package README. The plumbing is there — the supervisor emits canonical
events live through `onEvent` and the operator surface already consumes that
stream — so what is missing is the consumer, not the mechanism.

## Things that will waste your time if you do not know them

- **The `keryx` binary on PATH is a stale build.** It carries its own bundled
  copy of the contract schemas and will reject the `runtime` block. Always use
  `bun src/cli.ts …` to exercise CLI behaviour on this branch.
- **One test in the suite is order-dependent and fails intermittently**:
  `same-size historical receipt corruption invalidates the checkpoint and
  refuses append` (`src/harness/resume`). It passes 29/29 in isolation, fails
  0–2 times per full run regardless of this branch, and is not ours. A single
  red full-suite run is not evidence of breakage here.
- **Four working-tree entries are pre-existing and not from this flow**:
  `.metaproject/flows/144-…-agent-mode-web-fetch/{flow.json,journal.md}` and the
  untracked `.metaproject/context-operations/`,
  `.metaproject/workspaces/workspace-86f1eb7d089b4f1a/`. Left alone deliberately.
- **`keryx flow task add` assigns ids sequentially**, so `--depends` written
  against an intended numbering will be wrong. It happened once here; see the
  journal's note on T10–T13.
- **The live smoke spends subscription quota.** `bun scripts/smoke/external-agents.ts`
  — three short runs. Not in `bun test`, and it must stay out.

## Run these to see the state yourself

```bash
bun src/cli.ts agents external list          # capability + three-state availability
bun src/cli.ts agents external probe codex-cli   # version only; spends no quota
bun scripts/smoke/external-agents.ts         # real CLIs; SPENDS QUOTA
keryx flow status 176
```

## Rules this work is built on — do not quietly relax them

- **keryx never reads a vendor credential store**, not even to check whether the
  operator is logged in. Availability therefore has three states and `not
  probed` is a real one, rendered as itself and never as a tick.
- **No vendor sanction is claimed.** Neither vendor's terms address headless
  third-party orchestration of their client; it is carried as an open risk and
  mitigated structurally (off by default, local-only, barred from remote
  transports and CI). See `decisions.md` D-01.
- **The disposable worktree is the containment guarantee**, not the tool roster.
  Deny-lists and allow-lists reduce noise; the throwaway checkout is what
  survives a hole in them. Verified live: the working tree was byte-unchanged
  across every smoke run and no worktree leaked.
- **Failure is named, never substituted.** No fallback to another agent, another
  runtime, or the parent's own model (D-07).
- **External output is input, never evidence** (D-05).

## Where the reasoning lives

- `docs/requirements/keryx-external-agent-runtime/decisions.md` — D-01..D-11,
  including the refusals, which are the load-bearing part.
- `.../brainstorm.md` — the eleven resolved forks and the reference designs.
- `.../specification.md` — corrections are dated and stacked at the top; the
  implementation overturned the spec four times and each is recorded.
- [journal.md](journal.md) — per-task chronology, including the three bugs the
  live smoke found that 4794 offline tests could not, and the three separate
  occasions a subagent's honesty caught a defect a confident report would have
  buried.
