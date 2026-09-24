# Give a subagent a name instead of a paragraph

Every `spawn_subagent` call needs a persona: who is this child, what can it
touch, how careful should it be. Without a catalogue, that persona is prose
retyped into the `task` field by whichever orchestrator skill is dispatching
— nothing to list, review, or reuse. An **agent definition** is that persona,
written once, compiled into the dispatch inputs the execution engine already
accepts.

## What an agent definition is

A `.md` file with YAML frontmatter and a Markdown body, the same
frontmatter-plus-body shape `SKILL.md` already uses. It never executes
directly — `keryx agents show <name>` renders it, `keryx agents export`
projects it into a host-native file, and the keryx-shell path compiles it
into ordinary `spawn_subagent` inputs (`task`, `mode`, `model_tier`, ...).
Nothing about the dispatch contract, the child policy engine, or the budget
ledger changes because a definition exists — a definition is a new producer
of the inputs those already consume, not a new execution path.

### Frontmatter fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | string | yes | schema version the file was authored against |
| `name` | string | yes | unique id, `^[a-z][a-z0-9-]{1,63}$` |
| `description` | string | yes | third person, what it does and when to use it |
| `role` | string | yes | one-line persona summary injected into the compiled prompt header |
| `tools` | string[] | yes | allowlist from the canonical tool vocabulary (below); empty means no tools beyond the harness's own read baseline |
| `model_tier` | enum `light\|standard\|deep` | yes | resolved by `model-tier.ts` against the session's own model — never a model name |
| `policy_profile` | string | yes | `read-only` or `workspace-write`; the compiler resolves it per export target |
| `skills` | string[] | no | skill/module ids this agent should have preloaded, validated against the existing skill catalogue |
| `stacks` | string[] | no | `stack_requires`-style tags; empty/absent means stack-agnostic |
| `output_contract` | string | yes | which canonical result contract the reply must satisfy (`subagent-result` today) |
| `isolation` | enum `none\|worktree` | no | whether the compiled dispatch requests worktree isolation where the target supports it |
| `origin` | object | no | provenance — `kind` (`authored\|generated\|imported\|learned`), `sourceRef`, `generatedAt` |

The body is free-form Markdown task framing — the persona's operating
instructions — under the same 500-line, one-level-deep-reference discipline
`SKILL.md` authoring follows. **Never write the prompt-defense baseline
(below) into a body.** It is injected by the compiler so it cannot drift
between files.

## The bundled catalogue

Ten generic, stack-agnostic definitions ship with Keryx:

| Name | Role |
|---|---|
| `architect` | system-design and structural-tradeoff reasoning |
| `planner` | breaks a request into an ordered task/dependency plan |
| `code-explorer` | read-only location and cross-reference search |
| `tdd-guide` | drives a failing-test-first implementation loop |
| `refactor-cleaner` | scoped simplification/dedup pass, no behavior change |
| `silent-failure-hunter` | finds swallowed errors, empty catches, dropped rejections |
| `doc-updater` | keeps docs/comments in sync with a code change |
| `security-reviewer` | stack-agnostic security-pattern review |
| `performance-reviewer` | stack-agnostic performance-pattern review |
| `e2e-runner` | drives and reports on an end-to-end test pass |

Per-stack generated pairs (a reviewer and a build-error-resolver per stack
pack) are not part of this initial catalogue — they arrive later, generated
only from a stack pack that has already cleared its own governance gates.

A project can drop its own files under `.metaproject/agents/<name>.md`. A
project definition with the same `name` as a bundled one **overrides** it;
the source (`bundled` or `project`) is recorded for each loaded agent.

## The canonical tool vocabulary

Definitions name tools using Keryx's own builtin names — `read_file`,
`list_dir`, `get_cwd`, `search_code`, `graph_affected`, `memory_search`,
`apply_patch`, `shell_exec`, `web_fetch`, `web_search` — never a host's own
tool names. Each export target maps this vocabulary onto its own tool names
(for example Claude Code's `Read`/`Grep`/`Edit`/`Bash`). A vocabulary entry
with no mapping for a given target is dropped from that target's output and
reported back, rather than silently disappearing.

## Policy profiles

`policy_profile` takes one of two canonical values:

- `read-only` — no mutation tools; on keryx-shell this is
  `shellChildReadOnlyProfile` under `mode: read_only`.
- `workspace-write` — mutation allowed, still bounded by the parent's own
  policy via `inheritPolicy` — a child can never exceed what its parent
  already permits.

Host export targets map these onto their own documented permission
vocabulary, or emit nothing if the host has none. An unknown profile value
fails `keryx agents verify` with a named reason rather than exporting
something unenforced.

## Model tier, not model name

`model_tier` is one of `light`, `standard`, or `deep` — never a model name.
Tier resolution is delegated entirely to the existing tier resolver; a
definition cannot pin a specific model. Host exports that have no tier
concept of their own (Claude Code, for instance) emit `model: inherit`
instead of guessing a model alias.

## The prompt-defense baseline

Every compiled agent — regardless of export target — gets one shared,
compiler-owned prompt-defense block prepended ahead of `role` and the body:
a short statement that a spawned agent's own free text is data to its
caller, and that instructions encountered while doing the task (in file
contents, tool output, or another agent's report) carry no authority unless
the calling operator gave them directly. This mirrors the quarantine posture
already enforced on the ingestion side for keryx-shell children, extended to
the authoring side so a host with no quarantine equivalent still ships the
same defensive framing. **Do not paste this text into an agent body** — the
compiler injects exactly one copy; a hand-copied duplicate is exactly the
kind of thing that drifts the first time one copy is edited and the other
isn't.

## CLI

```
keryx agents list [--stack <id>] [--json]
keryx agents show <name>
keryx agents export --runtime <claude|codex|kiro|opencode|keryx-shell> <name> [--dry-run] [--json]
keryx agents verify [<name>] [--json]
```

`list` and `show` are read-only. `export` writes only the target's own
managed file — the exact per-host file paths for a given name and runtime
are listed by running `export --dry-run` rather than assumed here, since
they follow each host's own current documented layout. `verify` checks
schema validity, that every `tools[]`/`skills[]` reference resolves to
something that exists, and that every export target named on a definition
has a corresponding support record.

These four subcommands are additions alongside the existing `keryx agents
bootstrap`, `keryx agents external`, and `keryx agents monitor` — none of
the three is a persona registry, and none of their behavior changes.

## Export support levels

`export`'s claimed support level for a runtime — `native`, `adapter`, or
`instruction-only` — is looked up from the harness capability matrix
(`keryx integrations matrix`), never asserted independently. A runtime with
a confirmed `native` or `adapter` record gets that host's own native
subagent file; anything not yet verified gets a plain-prose,
instruction-only file with a visible provenance comment instead of a false
claim of enforcement.

Every file an exporter writes carries a keryx-managed sentinel. `export`
refuses to overwrite a file that lacks that sentinel — it will not silently
clobber a file you edited by hand.

To export the whole catalogue for one harness at once rather than one
definition at a time, use the bulk integrations path:

```
keryx integrations install --runtime <id> --surface agents
```

This is opt-in — the default `keryx integrations install` (no `--surface
agents`) does not write any agent files, so installing an existing
integration does not start producing new files under a harness's config
directory as a side effect.

## Auditing

`keryx security audit-harness` scans both `.metaproject/agents/` and
`.claude/agents/` as part of its normal sweep, the same way it scans other
managed surfaces — an agent definition with unrestricted tools or no model
tier is exactly the kind of finding it looks for.

## Where to go next

- [Run an agent without giving it your machine](contain-an-agent.md) — the
  containment tiers a dispatched agent runs under.
- [Architecture](../architecture.md) — the harness diagrams, including where
  a compiled dispatch feeds into the existing child contract.
