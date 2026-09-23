# Keryx Agent Platform Expansion — Brainstorm
Version: 0.1.2

## Original request (paraphrased)

The user asked, roughly in this order, for Keryx to:

1. Broaden stack/framework coverage in its skills and rules catalog — today's
   coverage is effectively NestJS/Prisma and React/MobX.
2. Add a self-learning loop: observe what happens during and after sessions
   (corrections, reverted edits, test outcomes, review comments) and turn
   repeated patterns into durable, reusable knowledge, with human consent
   before anything persists — not just the existing single-reviewer,
   single-project "reviewer comments update a profile rule" pattern.
3. Make skills, rules, agents, and learned content portable — across
   projects, across the local machine (`~/`), and across supported agent
   harnesses — instead of locked to whichever one project or harness produced
   them.
4. Support more harnesses consistently, including giving `keryx shell` itself
   a real, user-configurable hook system, not just host-harness hook
   installers.
5. Fix known correctness defects in `gdgraph`/`gdctx` — the layer nearly
   everything else (search, impact analysis, routing) depends on.
6. Keep the skills/rules catalog and a new agent-definitions catalog aligned
   with current best practices for authoring, discovery, and quality
   (dedupe before creating, evals before shipping, periodic re-verification)
   — and separately, actually build out a reusable, standing catalog of agent
   definitions ("agents"), since today every "agent" is inline prompt text an
   orchestrator skill writes at dispatch time.
7. Evaluate additional capability ideas (self-learning loops, portable memory
   formats, cross-harness adapters, install manifests, config security audits,
   evidence-before-edit gates, agent/skill catalog shapes) against Keryx's own
   needs, justified on their own merits rather than named, copied, or mirrored
   from anywhere else.

## Decisions

### D-1 — Program package with eight workstreams

**Context:** The seven-item request list above spans catalog breadth,
learning, portability, multi-harness support, shell hooks, graph/ctx
correctness, and governance — too broad and too interdependent for one flat
requirements document.

**Options considered:**
- One combined requirements package covering everything.
- Eight independent workstream packages with no shared umbrella.
- One program package (this one) with eight workstream files sharing a common
  spec, PRD, and implementation plan.

**Decision:** Program package with eight workstreams (W1–W8), mapped from the
request list as: item 1 → W1; item 2 → W3; item 3 → W4; item 4 → W5 (host
harnesses) + W6 (keryx shell); item 5 → W7; item 6 (catalog best practices) →
W1, item 6 (agent catalog) → W2; item 7 (adoption candidates, per pattern) →
self-learning ideas → W3, config-audit/evidence-gate ideas → W8, adapter/
matrix ideas → W5, install-manifest ideas → W1 (profiles), portable-memory
ideas → W4 (import).

**Consequences:** Every workstream can be implemented and reviewed
independently once this package is accepted, but cross-workstream contracts
(hook events, harness registry, learned-pattern shape, agent-definition
shape) must be designed once, in the umbrella specification, so no two
workstreams invent incompatible versions of the same idea.

### D-2 — Agent definitions layer compiles into dispatch contracts

**Context:** `docs/requirements/keryx-multi-agent-engine/README.md` (line
162) states, as an explicit non-goal for that package's release: "A separate
`.claude/agents/*.md`-style loader — the dispatch contract is the definition
surface." Today every agent is inline prompt text plus a `subagent_type`
string written by whichever orchestrator skill calls `spawn_subagent`.

**Options considered:**
- Leave the non-goal in place; keep authoring agents as inline prompt text
  per orchestrator skill.
- Replace the dispatch contract with a new agent-definition-driven loader.
- Add a canonical agent-definition layer that compiles into the existing
  dispatch contract, without replacing or weakening it.

**Decision:** Add the canonical agent-definition layer (W2). The dispatch
contract remains the execution surface; a `.metaproject/agents/<name>.md`
definition is a compile-time input that produces the same
`spawn_subagent`-shaped dispatch Keryx already executes, plus exportable
projections for host harnesses that want their own native agent file.

**Consequences:** This revises, rather than reverses, the multi-agent-engine
non-goal — the loader still does not replace the dispatch contract as the
runtime execution surface. `keryx-multi-agent-engine`'s own maintainers should
review W2 against this framing before implementation starts.

### D-3 — skill-lifecycle amendment: passive observe/extract, human-applied mutation

**Context:** `.metaproject/rules/core/skill-lifecycle.mdc` states learn/verify
"must live in the agent loop," explicitly never a git hook, and that the
existing `gdskills` post-commit hook "only runs `skills verify --all --dry-run`
... and never mutates." W3's Observe stage needs a hook (W6, or a host hook
via W5) to record events without a human typing a command each time.

**Options considered:**
- Keep the current rule as-is and require a human to manually trigger every
  observation, which defeats the purpose of a passive learning loop.
- Relax the rule to allow hooks to mutate skills/rules directly.
- Amend the rule to permit passive OBSERVE/EXTRACT from hooks (writing only
  to `.metaproject/data/learning/observations/` and `candidates/`), while
  keeping MUTATION (anything touching a `SKILL.md`, `.mdc` rule, or agent
  definition) exclusively in the human-applied agent loop.

**Decision:** Amend `skill-lifecycle.mdc` to draw the line at
observe/extract-vs-mutate rather than hook-vs-agent-loop. Hooks may write
data; only `applyLearningProposal`-style code, invoked by a human decision,
may write skills, rules, or agents.

**Consequences:** The rule amendment must be a recorded, reviewed change to
`skill-lifecycle.mdc` before W3's Observe stage ships, not an implicit
reinterpretation. W6's hook runtime must guarantee its built-in learning
observer cannot reach a write path other than the observations/candidates
directories.

### D-4 — No automatic promotion; numeric confidence with deterministic update

**Context:** `docs/requirements/shared-agent-context-generational-memory/README.md`
states "No automatic promotion, acceptance, or overwrite is permitted."
`src/gdskills/learn.ts` and `src/memory/types.ts` both use a 3-value
confidence enum (`low|medium|high`), not a continuous score.

**Options considered:**
- Keep the 3-value enum; skip numeric confidence entirely.
- Add a continuous 0–1 confidence score with automatic promotion once a
  threshold is crossed.
- Add a continuous 0–1 confidence score with a deterministic
  reinforcement/contradiction update rule, but keep every scope-crossing
  event (promotion, acceptance) gated on an explicit human confirm.

**Decision:** Numeric confidence with deterministic updates, no automatic
promotion. Crossing the "seen in ≥2 projects and confidence ≥0.8" threshold
produces a promotion *candidate*, never a promoted-and-active pattern.

**Consequences:** W3's schema and W4's cross-project store must both encode
"candidate" as a distinct, non-terminal status. Any future change to make
promotion automatic is a separate, explicitly governed decision — not
something W3 or W4 can quietly enable later.

### D-5 — Hooks tighten, never loosen, policy engine decisions

**Context:** `src/harness/policy/engine.ts` implements a hard-deny,
fail-closed allow/ask/deny engine with a documented precedence order. W6 adds
a hook runtime that must not create a second, competing source of truth for
the same tool-call decision.

**Options considered:**
- Let hooks make independent allow/deny decisions that can override the
  policy engine.
- Run hooks and the policy engine as two unrelated systems and let whichever
  runs last win (the failure mode already observed between the ctx guard and
  security-hooks installers for Cursor/Windsurf).
- Constrain hooks to only ever tighten a decision the policy engine already
  made — deny, ask, or add context — never loosen it.

**Decision:** Hooks tighten only. A hook may turn an `allow` into `ask` or
`deny`, or attach `additionalContext`; it can never turn a `deny` into
`allow`, and it can never override a hard deny.

**Consequences:** W6's specification must state this precedence explicitly
and W8's impact-evidence gate, W3's observer, and W5's host-harness adapters
must all be implemented against it, so a future hook cannot reintroduce the
exact clobbering-class bug already fixed once for Cursor/Windsurf.

### D-6 — One harness adapter registry; generated, CI-validated honesty matrix

**Context:** Three separate hook registries exist today
(`src/ctx/runtimes.ts`, `src/ctx/orient-runtimes.ts`,
`src/security/agent-hooks/runtimes.ts`) with different runtime coverage, and
the Cursor/Windsurf `securityHooks` key is documented in its own source
comment as matching no confirmed contract (tracked as OQ-3).

**Options considered:**
- Leave the three registries separate and add a fourth for W6.
- Merge them into one registry but keep the capability matrix hand-maintained.
- Merge them into one registry with capability flags, and generate the
  capability matrix from that registry with a CI validator that fails if a
  required field is missing.

**Decision:** One harness adapter registry (W5-a) with capability flags;
matrix generated from it and validated in CI (W5-a/W5-b).

**Consequences:** W2's exporters, W4's instruction-file export, and W6's
ACP/serve/trigger support all read this one registry instead of maintaining
their own per-harness lists, removing the class of bug where two installers
disagree about what a harness supports.

### D-7 — Content scale-out only through governance gates

**Context:** Keryx ships 72 skills and 34 rules today, mostly meta/
orchestration/review-of-two-stacks, with no stack-coverage eval and no
dedupe gate. Scaling to the full stack list in the W1 target-stack table
(`workstreams/W1-stack-catalog.md`) without governance would multiply an
already-unverified catalog.

**Options considered:**
- Generate all requested stack packs and per-stack agents immediately.
- Generate them gradually but without any quality gate.
- Build the governance gates first (dedupe scout, trigger/behavior evals,
  stocktake), then scale out content in small batches, each gated by those
  evals.

**Decision:** Governance gates first; content scale-out (Wave 4) proceeds in
batches of roughly four stacks, each batch passing W1's evals before the next
starts.

**Consequences:** Wave 4 cannot start until W1's governance tooling exists
and has been exercised at least once. This intentionally slows the
highest-visibility part of the program (more stacks) behind the least visible
(eval tooling).

### D-8 — Fix gdgraph/gdctx first; every other workstream routes through them

**Context:** `keryx ctx run`, `keryx ctx read`, and `keryx ctx rg` are the
mandated routing layer for code search and long-output commands in this
repository (per `.metaproject/index.md` and `CLAUDE.md`), and have live,
reproduced defects (stdout misclassification, trusted-project redaction
false positives, bundled short-flag rejection).

**Options considered:**
- Treat W7 as equal priority to the other seven workstreams.
- Defer W7 until after the higher-visibility workstreams (W1/W2) ship.
- Sequence W7 first, before any workstream that will generate or search
  significant new content through the same routing layer.

**Decision:** W7 is Wave 0, alongside W5-a's unified adapter registry.

**Consequences:** W1's stack-pack authoring, W2's agent generation, and W3's
extraction all inherit whatever ctx/gdgraph behavior exists at the time they
run — sequencing W7 first means they inherit fixes, not defects. This is a
scheduling decision recorded in
[implementation-plan.md](implementation-plan.md), not a technical dependency
enforced by code.
