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
| `schema_version` | integer | no | when present, must be the literal `1`; absent is treated as `1` |
| `name` | string | yes | unique id, `^[a-z][a-z0-9-]{1,63}$` |
| `description` | string | yes | third person, what it does and when to use it |
| `role` | string | yes | one-line persona summary injected into the compiled prompt header |
| `tools` | string[] | yes | allowlist from the canonical tool vocabulary (below); empty means only the target host's own read baseline — see "Empty `tools[]`" below |
| `model_tier` | enum `light\|standard\|deep` | yes | resolved by `model-tier.ts` against the session's own model — never a model name |
| `policy_profile` | string | yes | `read-only` or `workspace-write`; the compiler resolves it per export target |
| `skills` | string[] | no | skill/module ids this agent should have preloaded, validated against the existing skill catalogue |
| `stacks` | string[] | no | `stack_requires`-style tags; empty/absent means stack-agnostic |
| `output_contract` | string | yes | which canonical result contract the reply must satisfy (`subagent-result` today) |
| `isolation` | enum `none\|worktree` | no | whether the compiled dispatch requests worktree isolation where the target supports it |
| `origin` | object | no | provenance — `kind` (`authored\|generated\|imported\|learned`), `sourceRef`, `generatedAt` — an agent that arrived via `keryx bundle import` carries `origin.kind: imported` with `sourceRef` set to the exporting bundle's `bundleId`; see [Portability](portability.md#agents-imported-from-a-bundle) |

The body is free-form Markdown task framing — the persona's operating
instructions — under the same 500-line, one-level-deep-reference discipline
`SKILL.md` authoring follows. **Never write the prompt-defense baseline
(below) into a body.** It is injected by the compiler so it cannot drift
between files.

## The bundled catalogue

Ten generic, stack-agnostic definitions ship with Keryx:

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

### Empty `tools[]`

An empty (or fully-unmapped) `tools[]` does not mean "no tools at all" — it
means the definition inherits only the target host's own read baseline, and
that baseline is host-specific:

- **Claude Code** — the host's implicit read tools (`Read`, `Grep`, `Glob`);
  the exporter never emits a bare `tools:` line, since an omitted/empty
  `tools:` in Claude Code's own frontmatter means "inherit every tool",
  which would be the opposite of least privilege.
- **OpenCode** — `edit`, `bash`, and `web*` tools explicitly denied via the
  `permission` block; read tools remain available.
- **Kiro** — the `read` tag only.
- **Codex** — has no per-tool allowlist at all, so `tools[]` (empty or not)
  never affects its export: `sandbox_mode` follows `policy_profile` alone —
  `read-only` → `sandbox_mode = "read-only"`, `workspace-write` →
  `sandbox_mode = "workspace-write"` — every declared tool is reported
  governed-by-sandbox rather than dropped.

## Policy profiles

`policy_profile` takes one of two canonical values:

- `read-only` — no mutation tools; on keryx-shell this is
  `shellChildReadOnlyProfile` under `mode: read_only`. Every host exporter
  strips write/shell tools (for example `apply_patch`, `shell_exec`) out of
  a `read-only` definition's output — a dropped tool is reported the same
  way an unmapped one is, never silently. `keryx agents verify` also flags a
  `read-only` definition that still *names* a write/shell tool in `tools[]`
  as a `policy-tool-conflict`, independent of what any exporter does with it.
- `workspace-write` — mutation allowed, still bounded by the parent's own
  policy via `inheritPolicy` — a child can never exceed what its parent
  already permits.

Host export targets map these onto their own documented permission
vocabulary, or emit nothing if the host has none. An unknown profile value
fails `keryx agents verify` with a named reason rather than exporting
something unenforced.

## keryx-shell: only `mode` is enforced today

For `target: keryx-shell`, the compiler produces two things: `input` (the
actual `spawn_subagent` call — `task`, `mode`, `label`, `model_tier`, a
subset of the tool's real input schema) and a `policy` sidecar (`profile`,
`toolAllowlist`, `isolation`) describing what the definition *intends*.

Only `input.mode` is enforced by `spawn_subagent` today: it selects between
the read-only child profile and the parent-equivalent profile, and the child
still goes through `inheritPolicy` so it can never exceed its own parent
regardless of what the definition asked for. The `policy` sidecar's
`toolAllowlist`, `isolation`, and the finer-grained write capability it
implies are **advisory** — nothing in `spawn_subagent` currently consumes
them, so a `workspace-write` definition naming `shell_exec` or requesting
`isolation: worktree` gets a `general`-mode child, not a child with that
specific tool allowlist or that specific isolation. This is a deliberate D-2
boundary (a definition is a *producer* of `spawn_subagent` inputs, not a new
execution path) rather than an oversight, but it means the sidecar describes
intent, not a guarantee. `keryx agents show <name>` and `keryx agents export
--runtime keryx-shell <name>` both print the sidecar labeled as advisory so
this is visible before you rely on it.

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
keryx agents export --runtime <claude|codex|kiro|opencode|keryx-shell> <name> [--force] [--dry-run] [--json]
keryx agents verify [<name>] [--json]
```

`list` and `show` are read-only. `export` writes only the target's own
managed file — the exact per-host file paths for a given name and runtime
are listed by running `export --dry-run` rather than assumed here, since
they follow each host's own current documented layout. Two different
refusals, only one of which `--force` can push through:

- A file with no keryx-managed sentinel for this agent at all is never
  overwritten — not even with `--force`. `export` does not know this file is
  its own, so it never touches it.
- A managed file whose own recorded `content-sha256` no longer matches its
  content (a hand edit made after export) is refused unless `--force` is
  passed.

A managed, unedited file that is merely stale — its source definition
changed since it was last exported — is updated with no flag needed; that is
not a refusal at all.

`verify` never re-derives compile/export logic — it assembles named problem
rows from the same checks `compile`/`export`/`schema` already run, plus a
few checks that are verify's alone. A definition (or `--name`) can fail with
any of:

- `schema-invalid` — frontmatter fails `validateAgentDefinition`.
- `unknown-tool` — a `tools[]` entry is outside the canonical vocabulary.
- `unknown-skill` — a `skills[]` entry does not resolve in the skill
  catalogue.
- `unknown-policy-profile` — `policy_profile` is not `read-only` or
  `workspace-write`.
- `policy-tool-conflict` — `policy_profile: read-only` still names a
  write/shell tool (`apply_patch`, `shell_exec`) in `tools[]`.
- `origin-missing-source-ref` — a non-`authored` `origin.kind` has no
  `origin.sourceRef`.
- `invalid-source-ref` — `origin.sourceRef` is not a single safe stack-pack
  id (fails closed before the id is ever resolved to a path).
- `stack-pack-missing` — a `generated` origin's `sourceRef` does not resolve
  to an existing W1 stack pack.
- `baseline-in-body` — the body repeats the prompt-defense baseline text the
  compiler already injects once.
- `no-export-support` — the export-support lookup for a runtime could not be
  resolved (surfaced rather than thrown).
- `catalog-error` (reported separately, per definition) — the file failed to
  load at all: unreadable, invalid frontmatter, a duplicate name, or a
  file-stem/`name` mismatch.
- `not-found` — `--name` named nothing in the catalog.

Every runtime — `claude`, `codex`, `kiro`, `opencode`, `keryx-shell` — is
resolved automatically for every checked definition; a definition never
names its own export targets, so there is nothing for it to omit.

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

Every file an exporter writes carries a keryx-managed sentinel — every byte
of the file, with only that sentinel's own hash value blanked, is what the
`content-sha256` it also carries verifies. `export` never overwrites a file
that lacks a structural sentinel for this agent at all, whatever `--force`
says, and refuses to overwrite a sentinel-bearing file whose `content-sha256`
no longer matches (a hand edit made after export, anywhere in the file —
not just outside the sentinel line) unless `--force` is passed. A managed,
unedited file that is merely stale is updated with no flag needed.

To export the whole catalogue for one harness at once rather than one
definition at a time, use the bulk integrations path:

```
keryx integrations install --runtime <id> --surface agents
```

This is opt-in — the default `keryx integrations install` (no `--surface
agents`) does not write any agent files, so installing an existing
integration does not start producing new files under a harness's config
directory as a side effect.

`keryx integrations uninstall --runtime <id> --surface agents` removes only
the managed files this exporter itself wrote and that still verify. A
managed file that was hand-edited since export is kept, never deleted —
uninstall has no `--force` override for this — and is reported as a warning
alongside the uninstall result.

## Auditing

`keryx security audit-harness` scans every host directory an exporter can
write agent files into — `.metaproject/agents/` (markdown, the project
source tree itself), `.claude/agents/` (markdown), `.codex/agents/` (TOML),
`.kiro/agents/` (JSON), and `.opencode/agents/` (markdown) — as part of its
normal sweep, the same way it scans other managed surfaces. An agent
definition with unrestricted tools (including an explicitly empty or null
`tools` value in a Claude-shaped file, which Claude Code itself treats as
"inherit everything") or no model tier is exactly the kind of finding it
looks for.

## Where to go next

- [Run an agent without giving it your machine](contain-an-agent.md) — the
  containment tiers a dispatched agent runs under.
- [Architecture](../architecture.md) — the harness diagrams, including where
  a compiled dispatch feeds into the existing child contract.
