# W2 — Agent Definitions Catalog
Version: 0.1.6

**Changelog (0.1.5, flow 314 T14):** renamed the generated per-stack pair
from `<stack>-reviewer`/`<stack>-build-error-resolver` to
`<stack>-code-auditor`/`<stack>-build-fixer` throughout this document,
documented `generateStackAgentPair` (`src/agents/generate.ts`) and
`keryx agents generate --stack <id> [--check] [--json]` as the generator/CLI
that produces the pair, and recorded Batch 1's actual generated coverage
(ts-js-node, python, go; react has none — its pack is still experimental).

## Summary

Keryx has a real, tested multi-agent *execution* substrate — spawn, depth/child
caps, budget ledger, model-tier resolution, worktree isolation, quarantine of
child free text, concurrent sibling waves — but no reusable, named **agent
persona catalogue**. Every dispatch's "who is this agent" is inline prompt text
an orchestrator skill writes into the `spawn_subagent` tool's `task` field at
call time; there is no `.claude/agents/*.md`-equivalent file that a human can
list, review, or reuse across orchestrators. This workstream adds a canonical,
harness-neutral agent-definition format, a compiler that turns a definition
into the dispatch inputs the existing execution substrate already accepts, and
exporters that materialize the same definition into host-native subagent files
for harnesses that have one. It also revises a documented non-goal: a
definition *layer* is added without replacing the dispatch contract as the
execution surface.

## Current state

- `docs/requirements/keryx-multi-agent-engine/README.md:162` states the
  non-goal verbatim: *"A separate `.claude/agents/*.md`-style loader — the
  dispatch contract is the definition surface."* This line is the thing D-2
  (below) revises.
- `src/harness/tool/builtin/spawn-subagent-tool.ts` wires the interactive
  `spawn_subagent` tool. Its `inputSchema` (around line 390) accepts only
  `task` (string), `mode` (`read_only|general`), `label`, `max_tool_calls`,
  `max_rounds`, `model_tier` (`light|standard|deep`, resolved by
  `src/gdskills/model-tier.ts` against the session's own model — no model
  names anywhere), and an optional `runtime` block for external-CLI delegation
  (`keryx agents external list`). There is **no persona field** — no
  `subagent_type`, no name, no tools allowlist parameter. Whatever "agent" the
  child becomes is entirely the prose in `task`.
- `src/harness/child/contract.ts` defines the actual wire shape: a
  `ChildContractExtension` (parent/session/attempt/budget/model-selection
  metadata) layered over the canonical `subagent-dispatch`/`subagent-result`
  contracts from `.metaproject/core/gdskills/contracts/`. Its own header notes
  the shape is "shaped, not validated" — nothing currently loads a JSON Schema
  to check a dispatch against it; the TypeScript types are the only guardrail.
  A compiled agent definition (below) feeds this same extension, it does not
  bypass or duplicate it.
- `src/harness/child/orchestrate.ts` (`DEFAULT_MAX_TREE_DEPTH=3`,
  `DEFAULT_MAX_CHILDREN=16`), `src/harness/child/model.ts` (tier resolution),
  `src/harness/child/ledger.ts` (budget), and `src/harness/child/quarantine.ts`
  (child free-text is `trustLevel: "derived"`, flagged not stripped) are the
  execution engine this workstream must compile INTO, never replace.
- `src/commands/agents.ts` implements exactly three `keryx agents` subcommands
  today: `bootstrap` (installs the Metaproject routing block into a runtime's
  global entrypoint file — unrelated to personas), `external` (drives other
  installed CLI coding agents), and `monitor` (folds an agent-event stream
  into a fleet snapshot, read-only). None of the three is a persona registry,
  so the new `keryx agents list|show|export|verify` subcommands below are
  additions, not collisions — `bootstrap`/`external`/`monitor` are unaffected.
- `src/gdskills/agent-catalogue-xref.test.ts` already guards a related but
  distinct concept: that a skill's dispatch-position reference (`agent: "x"`,
  `subagent_type: "x"`, `Agent("x")`, `Task("x")`) names something that exists
  in the tree. It is a cross-reference lint over `SKILL.md` prose today, not a
  registry of reusable personas — W2's guard test (AC5 below) extends this
  same lint to also resolve against the new agent-definition catalogue.
- `.metaproject/rules/core/model-selection.mdc` defines the three tiers
  (`light`/`standard`/`deep`) an agent definition's `model_tier` field must
  resolve to; there is deliberately no table of model names anywhere in this
  resolution (see W2 §Design, "model tier").

## Decision

**D-2 (revises the multi-agent-engine non-goal at
`docs/requirements/keryx-multi-agent-engine/README.md:162`):** keep the
dispatch contract as the sole execution surface — no relaxation of the child
contract, the policy engine, or the budget ledger — and ADD a canonical
agent-definition layer above it that **compiles into** dispatch contracts. The
definition never executes directly: `keryx agents show <name>` renders it,
`keryx agents export --runtime <id>` projects it into a host-native file, and
the keryx-shell path (§Design, "keryx shell child agents") compiles it into
the same `task`/`model_tier`/`mode` inputs `spawn_subagent` already accepts
today, plus policy-profile and tool-allowlist inputs threaded through the
existing child policy path. Nothing in `src/harness/child/` or
`spawn-subagent-tool.ts`'s wire shape changes; a definition is a new,
optional *producer* of the inputs those modules already consume. This must be
recorded in `brainstorm.md` as decision D-2 with this rationale (owned by the
umbrella writer; W2 supplies the text above).

## Goals & non-goals

**Goals**
- One canonical, harness-neutral agent-definition file format under
  `.metaproject/agents/<name>.md`, validated against a JSON Schema.
- A compiler that turns a definition into (a) the keryx-shell
  `spawn_subagent` dispatch inputs and (b) host-native subagent files for
  harnesses that support them, with a single shared prompt-defense baseline
  injected once by the compiler rather than duplicated per file.
- An initial catalogue: generic personas plus, per stack pack from W1, a
  generated code-auditor/build-fixer pair.
- `keryx agents list|show|export|verify` and a guard test tying every
  definition's declared `skills`/`tools` to what actually exists.
- Honest, per-harness export support recorded against the W5 capability
  matrix — no exporter claims a support level W5 has not verified.

**Non-goals**
- Replacing or bypassing the dispatch contract, the policy engine, or the
  child budget/depth caps (D-2).
- A model-name field anywhere in the format — only the tier vocabulary
  `.metaproject/rules/core/model-selection.mdc` already defines.
- Bulk-generating agents ahead of governance: per-stack pairs are generated
  only from a stack pack that has passed W1's gates (D-7, program-level).
- Cost/budget enforcement changes — unchanged non-goal inherited from the
  multi-agent engine (`README.md:159`).
- Automatic runtime selection of which agent to dispatch — routing which
  definition applies to a task stays the calling orchestrator skill's job,
  the same way `stack_requires`-gated review dispatch works today
  (`src/commands/review.ts`); W2 supplies the catalogue, not a router.

## Design

### Canonical format

`.metaproject/agents/<name>.md` — YAML frontmatter + Markdown body, validated
against `schemas/agent-definition.schema.json`. Modeled on the same
frontmatter-plus-progressive-disclosure shape Keryx already uses for
`SKILL.md` (`src/gdskills/skill-frontmatter.ts`), so the same authoring
muscle memory and the same one-level-deep reference-file discipline apply.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | unique id, `^[a-z][a-z0-9-]{1,63}$` — same character-class discipline as a skill name |
| `description` | string | yes | third person, states what it does and when to use it, ≤1024 chars (mirrors the Agent Skills description contract) |
| `role` | string | yes | one-line persona summary injected into the compiled prompt header |
| `tools` | string[] | yes | allowlist of tool names; empty array means no tools beyond the harness's own read baseline |
| `model_tier` | enum `light\|standard\|deep` | yes | maps directly to `model-selection.mdc`'s tiers; no model names permitted |
| `policy_profile` | string | yes | references a named policy profile (e.g. keryx shell's `shellChildReadOnlyProfile`/`shellParentProfile` family, or a host-side permission-mode name); the compiler resolves it per target, it never grants beyond what the target harness's own policy engine allows |
| `skills` | string[] | no | skill/module ids this agent should have preloaded or may route to; validated against the existing skill catalogue |
| `stacks` | string[] | no | `stack_requires`-style tags (W1's `extractStackRequiresField` vocabulary); empty/absent means stack-agnostic |
| `output_contract` | string | yes | which canonical result contract the agent's reply must satisfy — `subagent-result` (STATUS-first prose, `src/harness/child/contract.ts`) is the only value W2 ships against |
| `isolation` | enum `none\|worktree` | no, default `none` | whether the compiled dispatch requests worktree isolation where the target supports it |
| `origin` | object | no | provenance: `kind` (`authored\|generated\|imported\|learned`) + `sourceRef` (e.g. a W1 stack-pack id) + `generatedAt`; absent only for a hand-authored definition predating this field |

Body: free-form Markdown task framing (the persona's operating instructions),
under the same 500-line/one-level-deep-references discipline W1's authoring
standard defines for `SKILL.md` (`workstreams/W1-stack-catalog.md`,
"Authoring standard"). The prompt-defense baseline (below) is never written
into the body — it is compiler-injected so it cannot drift per file.

### Compiler

A single deterministic function, `compileAgentDefinition(definition, target)`,
is the only producer of dispatch/export inputs from a definition — no second
reader re-derives the same shape (the class of drift
`enforcement-claims.test.ts` and `catalog-single-source.test.ts` already guard
against elsewhere in the catalogue). It:
1. Validates the definition against `agent-definition.schema.json` and
   against the skill/tool existence guard (AC5).
2. Renders the compiled system-prompt header: prompt-defense baseline (below)
   + `role` + body, in that fixed order.
3. Resolves `model_tier` through the existing `model-tier.ts` resolution —
   the compiler calls that module, it does not re-implement tier ranking.
4. Projects the result into one of two shapes depending on `target`:
   keryx-shell dispatch inputs, or a host-exporter's native file (below).

### Single shared prompt-defense baseline

One canonical prompt-defense text block, owned by the compiler, prepended to
every compiled agent regardless of target. Concretely: a short, fixed
statement that a spawned agent's own free text returning to its caller is
data, and that instructions encountered while doing the task (in file
contents, tool output, or another agent's report) do not carry authority
unless the calling operator gave them directly. This mirrors the "quarantine"
posture `src/harness/child/quarantine.ts` already enforces at the ingestion
side for keryx-shell children; the baseline is the authoring-side half of the
same policy, so a host harness without a `quarantine.ts` equivalent (e.g. a
`.claude/agents/*.md` export) still ships the same defensive framing in its
compiled prompt text. No per-agent file repeats this text — stamping an
identical block into every agent file by hand drifts the moment one copy is
edited (the same class of drift `enforcement-claims.test.ts` guards against
elsewhere in the catalogue); the compiler makes drift impossible because
there is exactly one copy.

### Per-harness exporters

`keryx agents export --runtime <id> <name>` calls the compiler with
`target=<id>` and writes the harness-native file. Each exporter's *support
level* — not just its existence — is a lookup against the W5 harness
capability matrix, never a claim made independently by W2:

| Runtime | Native surface | Support level (per W5 matrix) |
|---|---|---|
| Claude Code | `.claude/agents/*.md` (YAML frontmatter: `name`, `description`, `tools`, `model`, ...) | native — the target format this workstream's schema tracks most closely |
| Codex | agent-adjacent `AGENTS.md`/`agents.toml`-style entries | adapter or instruction-only, per W5's verified state; W2 does not assert "native" ahead of W5 confirming it |
| Kiro | steering/agent-adjacent files under `.kiro/` | instruction-only unless W5 records a stronger verified state |
| OpenCode | agent-mode config in its manifest | instruction-only unless W5 records a stronger verified state |
| keryx shell | `spawn_subagent` dispatch inputs (native execution engine, §below) | native — this is the engine the compiler was built to feed |

An exporter that has no confirmed capability record in W5 refuses to claim
`native`/`adapter` and instead emits an `instruction-only` file (plain prose,
no enforced fields) with a visible provenance comment — the same fail-closed,
no-silent-degradation posture the rest of Keryx uses for unverified surfaces.

### Keryx shell child agents

For `target="keryx-shell"` the compiler does not write a file — it returns the
literal input object the existing `spawn_subagent` tool already accepts
(`task`, `mode`, `label`, `max_tool_calls`, `max_rounds`, `model_tier`,
optionally `runtime`): the compiled prompt header (baseline + role + body)
becomes the `task` string, `model_tier` passes through resolved-but-unchanged
(the tool still does its own runtime resolution against the session's actual
provider — the compiler never pre-resolves to a model name), `tools`/
`policy_profile` are threaded through the existing child policy path
(`shellChildReadOnlyProfile`/`shellParentProfile` in
`src/harness/policy/profiles.ts`) rather than through a new schema field on
the tool itself, and `isolation: worktree` maps to the existing worktree
isolation path in `src/harness/child/isolation.ts`. No change to
`spawn-subagent-tool.ts`'s `inputSchema` is required for this workstream —
the definition is a prompt/policy *producer*, the tool's wire shape is
untouched, consistent with D-2.

### Initial catalogue

Generic personas (hand-authored, stack-agnostic):

| Name | Role |
|---|---|
| `design-advisor` | system-design and structural-tradeoff reasoning |
| `work-planner` | breaks a request into an ordered task/dependency plan |
| `codebase-navigator` | read-only location and cross-reference search |
| `test-first-driver` | drives a failing-test-first implementation loop |
| `refactoring-steward` | scoped simplification/dedup pass, no behavior change |
| `error-path-auditor` | finds swallowed errors, empty catches, dropped rejections |
| `docs-maintainer` | keeps docs/comments in sync with a code change |
| `security-auditor` | stack-agnostic security-pattern review |
| `performance-auditor` | stack-agnostic performance-pattern review |
| `end-to-end-tester` | drives and reports on an end-to-end test pass |

Per-stack pairs, generated from each W1 stack pack once it has passed W1's
governance gates (dedupe + eval + stocktake) — not hand-authored, and not
produced ahead of a pack clearing those gates (D-7):

| Stack (from W1 pack list) | Generated pair |
|---|---|
| TS/JS/Node, React, Vue, Angular, Next/Nuxt, NestJS, Python, Django, FastAPI, Go, Rust, Java/Kotlin/Spring, C#/.NET, Swift/iOS, Kotlin/Android, Flutter/Dart, PHP/Laravel, Ruby/Rails, C/C++, SQL/DB, Docker/K8s/Terraform, CI (GitHub Actions/GitLab) | `<stack>-code-auditor` (read-only review; `policy_profile: read-only`; `model_tier: deep`; `skills` = the pack's review skill) + `<stack>-build-fixer` (build/type/lint/test failure resolution; `policy_profile: workspace-write`; worktree isolation; `model_tier: standard`; `skills` = the pack's build-fix skill), dispatched via the same `stack_requires`-style gating `review-orchestrator` already uses |

The pair is generated by the pure `generateStackAgentPair(pack)`
(`src/agents/generate.ts`), which reads only `pack.json`'s `skills` map
(`review`/`build-fix`) and `agentProfile` block (`displayName`, `auditFocus`,
`buildCommands`, `fixGuardrails`) and is deterministic — the same pack input
always produces byte-identical output, with no `generatedAt` or other
non-deterministic field written. It is invoked by
`keryx agents generate --stack <id> [--check] [--json]`
(`src/commands/agents-catalog.ts`), which writes both files under
`src/gdskills/bundled/agents/`. Generation refuses a pack that is not
gate-cleared: `stability` must be `"stable"` AND `checkStablePackGate(packDir,
"stable")` must report `status: "pass"` — the same shared check,
`checkStackPackGateCleared`, that `keryx agents verify` also uses (named
failure reason `stack-pack-not-gate-cleared`). `agents verify` additionally
reports `generated-drift` when a bundled generated file differs from a fresh
run of the generator against the same pack (a hand edit to a generated file),
and `stack-pack-not-gate-cleared` for any pair whose source pack has since
lost its gate-cleared status.

**Batch 1 status (flow 314, fix attempt 1 — honest gate re-run):** no
generated pair ships for any of the four batch-1 packs (`ts-js-node`,
`python`, `go`, `react`) — the honest DeepSeek `deepseek-chat` gate run
failed all four, so every one stays `stability: experimental` and each
pack's `agent-refs.json` lists `"agents": []` with a note (see
"Implementation notes: Wave 4 batch 1 (flow 314)" in
`W1-stack-catalog.md` for the per-pack, per-skill breakdown). The
deliverable this batch actually landed is the generator's safety, exercised
end-to-end against real and fixture packs: `id` must equal the pack's own
directory name, every frontmatter scalar and list item is emitted
double-quoted (no unquoted pack-supplied string can forge a new YAML key),
every write is contained under `src/gdskills/bundled/agents/` with no
traversal and no symlink target, generation refuses a pack that is not
gate-cleared (`stack-pack-not-gate-cleared`, checked before `--check` is
even considered), and `agents verify` reports `generated-source-mismatch`/
`generated-drift` for a hand-edited or now-mismatched generated file. That
safety is what the next batch (or a re-gated batch 1, after the grader
audit below) generates through.

This covers 22 of W1's 23 stack packs; `mobx` (a capability that extends
`react` rather than a standalone language/framework) gets no generated agent
pair — its review coverage stays the existing `code-mobx-store-review` skill,
gated the same `stack_requires`-style way. `sql-db` (also a `capability`
family pack) still gets a pair, since its coding-style/security content is
per-engine and standalone rather than an extension of another pack. 22 packs
× 2 personas = 44 generated definitions total.

Every generated pair's `origin.kind: generated` plus `origin.sourceRef`
records the source pack id (`schemas/agent-definition.schema.json`), and
the pair is re-generated (not hand-edited) if the pack changes — a hand edit
to a generated definition is flagged by `keryx agents verify` the same way a
stale generated file would be.

## CLI surface

```
keryx agents list [--stack <id>] [--json]
keryx agents show <name>
keryx agents export --runtime <claude|codex|kiro|opencode|keryx-shell> <name> [--dry-run] [--json]
keryx agents verify [<name>] [--json]
keryx agents generate --stack <id> [--check] [--json]
```

- `generate` writes the `<stack>-code-auditor`/`<stack>-build-fixer` pair for
  the named stack pack under `src/gdskills/bundled/agents/`; `--check`
  reports drift without writing and exits non-zero if either generated file
  differs from what is on disk; it refuses (before `--check` is even
  considered) a pack that is not gate-cleared, with reason
  `stack-pack-not-gate-cleared`.

- `list`/`show` are read-only, no writes.
- `export` writes only the target harness's own managed file (with a
  `_keryxManaged` sentinel where the target format supports one, per Keryx's
  own-file-marking convention), never overwrites a user-modified file it does
  not own, and supports `--dry-run` to print the plan without writing.
- `verify` checks: schema validity, every `tools`/`skills` reference resolves
  to something that exists (extends `agent-catalogue-xref.test.ts`'s check
  from a lint into a runnable command), every generated definition's
  `origin.sourceRef` pack still exists and matches, and every exporter
  target named on the definition (if any) has a corresponding W5 matrix
  record.
- These four subcommands are new additions under `keryx agents`; they do not
  rename, remove, or change the behavior of the existing `bootstrap`,
  `external`, or `monitor` subcommands in `src/commands/agents.ts`.

## Data contracts

- `schemas/agent-definition.schema.json` (this workstream owns it) — draft
  2020-12, `$id: keryx://schemas/agent-platform/agent-definition.schema.json`,
  validates the frontmatter table above.
- Compiled output for `target="keryx-shell"` is not a new schema — it is the
  existing `spawn_subagent` `inputSchema` in `spawn-subagent-tool.ts`, and the
  existing `ChildContractExtension`/canonical `subagent-dispatch` shapes in
  `src/harness/child/contract.ts`. W2 adds no new wire schema on that path.
- Compiled output for host exporters is that host's own native format (e.g.
  Claude Code's `.claude/agents/*.md` frontmatter) — W2 does not invent a new
  schema per host; it maps the canonical definition fields onto each host's
  already-documented frontmatter — unverified for any host beyond Claude Code
  — requires a first-party docs check before implementation.

## Integration

- **W1 (stack catalog):** per-stack code-auditor/build-fixer pairs are
  generated from W1 stack packs; a pack must clear W1's dedupe/eval/stocktake
  gates before W2 generates from it (D-7). W2's `skills[]` field validates
  against W1's skill catalogue.
- **W3 (self-learning) graduation:** W3's "graduate" stage (cluster → agent
  proposal) targets this format — a graduated proposal is a candidate
  `.metaproject/agents/<name>.md` file requiring the same human-consent gate
  as any other learned-content promotion, never an automatic write.
- **W4 (bundles):** agent definitions are one of the content kinds a portable
  bundle exports/imports (`portable-bundle.schema.json`, W4-owned); W2 is
  responsible only for the definition's own shape, not the bundle envelope.
- **W5 (harness matrix):** exporter support-level claims are looked up from,
  never asserted independently of, the W5 capability matrix; a new exporter
  ships as `instruction-only` until W5 records a stronger verified state.
- **W6 (hooks):** `SubagentStart`/`SubagentStop` hook events fire around a
  compiled dispatch the same way they fire around any other `spawn_subagent`
  call — W2 introduces no new hook surface, it is simply another producer of
  the same dispatch inputs those hooks already observe.
- **W8 (audit):** `keryx security audit-harness` treats agent definitions as
  one of its scanned surfaces (per W8 Design part A: "agents with
  unrestricted tools or no model tier"); W2's schema makes `tools` and
  `model_tier` both required precisely so that check has a field to inspect.

## Risks

- **Definition/dispatch drift** — if the compiler and `spawn-subagent-tool.ts`
  disagree about field names, a compiled dispatch silently no-ops a field.
  Mitigated by AC2 (a golden-fixture test asserting the compiler's
  keryx-shell output matches the tool's actual `inputSchema` keys).
- **Exporter over-claiming support** — an exporter shipped before its host is
  verified in W5 could imply a persona-catalogue feature the host doesn't
  actually enforce. Mitigated by the fail-closed `instruction-only` default
  and AC4.
- **Prompt-defense baseline going stale** — a single shared block is exactly
  the class of thing that can silently drift from the quarantine policy it
  mirrors if the two are edited independently. Mitigated by AC3 pointing both
  at a shared constant/test.
- **Generated-agent sprawl** — 22 stack packs × 2 personas (`mobx`, a
  capability extending `react`, gets no agent pair; `sql-db` does, per W1's
  target-stack table) is 44 generated definitions; ungated generation would
  repeat the coverage-without-quality
  problem the W1 governance gates (scout/eval/stocktake) exist to prevent for
  skills. Mitigated by gating generation on W1's per-pack governance gates,
  never on a bulk pass (D-7).

## Acceptance criteria

- **W2-AC1** — `agent-definition.schema.json` parses (`keryx ctx run -- bun -e
  "JSON.parse(...)"`) and validates every field in the table above, with
  `tools`, `model_tier`, and `output_contract` required.
- **W2-AC2** — a test asserts the compiler's `target="keryx-shell"` output
  uses exactly the key set `spawn_subagent`'s `inputSchema` in
  `spawn-subagent-tool.ts` accepts (`task`, `mode`, `label`,
  `max_tool_calls`, `max_rounds`, `model_tier`, `runtime`?) — no invented
  keys, no silently dropped fields.
- **W2-AC3** — the prompt-defense baseline exists as exactly one source
  constant; a guard test fails if any compiled output (any target) contains a
  baseline string that does not match that constant verbatim.
- **W2-AC4** — an exporter for a runtime with no corresponding `native` or
  `adapter` record in the W5 capability matrix produces only
  `instruction-only` output, verified by a test that stubs an unverified
  runtime id.
- **W2-AC5** — `keryx agents verify` fails closed (non-zero exit, named
  reason) for a definition whose `tools[]` or `skills[]` references something
  absent from the catalogue, and this check subsumes what
  `agent-catalogue-xref.test.ts` already checks for dispatch-position
  references in skill prose (no regression on that existing guard).
- **W2-AC6** — every generated per-stack pair's `origin.sourceRef`
  resolves to an existing, gate-cleared W1 stack pack; `keryx agents verify`
  fails closed if the referenced pack no longer exists or has been retired.
- **W2-AC7** — `model_tier` resolution in the compiled keryx-shell output is
  delegated to `src/gdskills/model-tier.ts` (no re-implementation), verified
  by a test that a definition never emits a literal model name.
- **W2-AC8** — `keryx agents list|show|export|verify` coexist with, and do not
  alter the documented behavior of, `keryx agents bootstrap|external|monitor`
  (regression test against the existing `agent-commands.test.ts` suite).

## Open questions

- OQ-W2.1 — should `policy_profile` be a closed enum shared across all targets,
  or a per-target lookup table (a Claude Code `permissionMode` value is not
  the same vocabulary as a keryx-shell policy-engine profile name)? Leaning
  per-target lookup, pending W5's adapter registry shape.
- OQ-W2.2 — does `keryx agents export` need a `--all` / manifest-driven bulk mode
  for the Wave 4 content scale-out, or does each generated pair get exported
  individually as its stack pack lands? Leaning individual, to keep W1's
  per-pack gating meaningful.
- OQ-W2.3 — should the compiled `output_contract` field support more than
  `subagent-result` once W6/W8 need a different result shape (e.g. an audit
  finding contract for a W8-dispatched agent)? Deferred to W8's own schema
  design; W2 ships with the one value it can prove today.
