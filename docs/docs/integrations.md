# Integrations: the harness adapter registry

Keryx can install small, sentinel-tagged hooks and standing-instructions files into other coding agents' own configuration, so that its routing guard, security checks and orientation context apply whichever agent a person is driving. This page describes the unified **registry** those installs come from, the `keryx integrations` command family, install-state and `doctor` drift detection, the generated **capability matrix**, and the per-harness notes, including which adapters are experimental.

Two neighbouring commands are separate things:

- `keryx integrate` registers keryx itself as an MCP server in an editor or agent's client config (`.cursor/mcp.json`, `.mcp.json`, `opencode.json`, `.vscode/mcp.json`). It takes one or more of `cursor`, `claude`, `opencode`, `vscode`, `generic` (comma-separated) or `all`, and `--remove` and `--dry-run` work with it. See [CLI reference: integrate](./cli-reference.md#integrate).
- `keryx harness run|exec|extension|wave` is keryx's own agent runtime, covered in [harness.md](./harness.md).

For a task-first introduction, read [Connect your agents](modules/integrations.md).

## The registry

Three installers used to write into host settings files with their own idea of which harnesses existed: the gdctx routing guard, the graph and wiki orientation injector, and the security check-input and check-output installer. They disagreed about coverage and could overwrite each other's entries in the same file. The unified registry (`src/integrations/`) describes each harness once, as a set of **capability flags on named surfaces** (`block`, `prompt-gate`, `inject-context`, `instructions`, `rules` and others), with exactly one merge, strip and validate path per physical settings file. Two surfaces that target the same file can no longer destroy each other's entries.

**Settings file for the `claude` runtime.** Every `claude` surface (ctx guard, orient, both security checks, the learning observer and the edit guard) resolves its file through one resolver, so they land in the same one: `.claude/settings.local.json`, which is per developer and gitignored, by default, or the tracked `.claude/settings.json` when `agentEntrypoints.claudeSettings` in `metaproject.json` has scope `shared`. The two files are merged by the host, so a hook present in both would fire twice; keryx keeps each managed group in one of them. While the tracked file still holds keryx-managed groups (committed by the team, or waiting for `keryx update` to move them), installers keep writing there rather than start a second copy. Cloud and remote sessions do not read `settings.local.json`; use shared scope for them. See [where the block goes](workspace-and-lifecycle.md#where-the-block-goes-local-and-shared-scope). Other runtimes' settings files are unchanged.

## Command family

```text
keryx integrations install   --runtime <id>[,<id>...|all] [--surface <flag|surface-id>]... [--dry-run] [--json]
keryx integrations doctor    --runtime <id>[,<id>...|all] [--surface <flag|surface-id>]... [--json]
keryx integrations uninstall --runtime <id>[,<id>...|all] [--surface <flag|surface-id>]... [--dry-run] [--json]
keryx integrations matrix    [--check] [--write] [--json] [--file <path>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `install` | `--runtime <id>[,<id>...\|all]`, `--surface <flag>...`, `--dry-run`, `--json` | Resolves every registered surface for each runtime (or only the named surfaces, repeatable), applies each surface's merge in deterministic order, and records what it wrote to install-state. `--dry-run` reports what it would write and changes nothing. |
| `doctor` | `--runtime <id>[,<id>...\|all]`, `--surface <flag>...`, `--json` | Re-validates every surface already recorded in install-state against the live settings file and reports drift: a surface that install-state says should be there but is now missing, or has gone stale. `--surface` restricts the check to the named surface(s), including one never installed yet. |
| `uninstall` | `--runtime <id>[,<id>...\|all]`, `--surface <flag>...`, `--dry-run`, `--json` | Removes only the sentinel-tagged entries keryx itself installed for the named runtime and surfaces, leaving every other entry in the file, including your own, untouched. |
| `matrix` | `--check`, `--write`, `--json`, `--file <path>` | Prints (or validates) the generated capability matrix. `--check` regenerates the matrix from the registry and diffs it against the checked-in artifact, exiting non-zero on drift with no file written. This is the command CI runs. `--write` regenerates and overwrites the artifact. `--file <path>` uses an artifact path other than the default `docs/integrations/harness-capability-matrix.json`. |

`--runtime` takes a single id, a comma-separated list, or `all`.

### Example: install the ctx guard and instructions for one runtime

```bash
keryx integrations install --runtime gemini-cli --surface block --surface instructions
```

Omit `--surface` to install every surface the runtime's adapter declares. Preview it first:

```bash
keryx integrations install --runtime kiro --dry-run
```

```text
keryx integrations install (dry run)
  kiro
  · ctx-guard (block) -> .kiro/hooks/keryx-ctx-guard.json would-install
      experimental — verify on a live install
      …
  · instructions (instructions) -> .kiro/steering/keryx.md would-install
      experimental — verify on a live install
      …
```

### Example: check for drift

```bash
keryx integrations doctor --runtime kiro --json
```

## Install-state and doctor drift

`keryx integrations install` records, per project, which `(runtime, surface)` pairs it installed, when, and against which keryx version. State lives at:

```text
.metaproject/data/integrations/install-state/<runtime>.json
```

and is written **only** when `<root>/.metaproject` already exists: installing into a project with no Metaproject workspace never creates one just to hold this state. Each record follows the `install-manifest.schema.json` shape, with two additive fields (`keryxVersion` and `installedAt`) and an optional `surface` discriminator, since one runtime can have several surfaces (for example `block` and `instructions`), each independently installed or removed.

`doctor` reads this state to know what *should* be present, then compares it against the live settings file. When something has gone missing, it reports drift naming the version and date keryx installed it, for example:

```text
ctx-guard (block) was installed by Keryx 0.2.140 on 2026-08-03 and is now missing: .gemini/settings.json: file is missing
```

`ctx-guard (block)` is the *surface* id and flag, not the runtime id `gemini-cli`, since one runtime can carry several surfaces, each drifting independently. Knowing *when* and *by which build* narrows down what changed the file in between.

## The capability matrix

`docs/integrations/harness-capability-matrix.json` is **generated from the registry** (`src/integrations/matrix.ts`), not maintained by hand. Read it, or run `keryx integrations matrix`, for the current per-harness and per-surface state. A guard test regenerates the matrix from the registry and fails the build if the checked-in artifact has drifted, and `keryx integrations matrix --check` runs the same regeneration in CI.

```text
  id                    state    confidence    supported flags
  claude                native   verified      block,prompt-gate,inject-context,observe,agents,rules
  codex                 native   verified      block,inject-context,agents,rules
  cursor                native   verified      block,prompt-gate,inject-context,rules
  windsurf              native   verified      block,prompt-gate,rules
  antigravity           adapter  experimental  block
  opencode              adapter  experimental  block,agents
  zed                   adapter  experimental  block,instructions
  generic-mcp           adapter  experimental  block,prompt-gate
  gemini-cli            adapter  experimental  block,instructions,rules
  kiro                  adapter  experimental  block,agents,instructions,rules
  github-copilot-agent  adapter  experimental  block,instructions,rules
  keryx-shell           adapter  verified      block,prompt-gate,inject-context,pre-tool-context,observe,post-tool,session-start,stop
```

Each harness reports a `state`:

- **`native`**: a host-hook adapter at `confidence: "verified"`. The surface installs and validates.
- **`adapter`**: works through a thin bridge, or is an `experimental` host-hook adapter.
- **`instruction-only`**: no runtime enforcement. A file is written and read, but nothing decides anything (for example `GEMINI.md`, Kiro steering, `.github/copilot-instructions.md`).
- **`unsupported`**: no known mechanism. Registered only so the CLI gives a precise refusal instead of silently doing nothing.

`keryx-shell` is verified: it is keryx's own shell runtime, with eight surfaces that the shell's [lifecycle hooks](hooks.md) implement. Treat every `experimental` row as unverified against a live install. To regenerate the matrix after a registry change:

```bash
keryx integrations matrix --write
```

### The `instructions` surface's managed markdown block

The `gemini-cli`, `kiro` and `github-copilot-agent` runtimes' `instructions` surfaces all install the same short pointer between `<!-- keryx:instructions -->` and `<!-- /keryx:instructions -->` markers into a secondary instructions file. Install into an absent file creates it (for `kiro` only: with its `inclusion: always` front matter first), LF-terminated. Install into an existing file never adds front matter and only ever touches the block itself, appending it (with one blank separator line) when absent or replacing it in place when present. Uninstall removes the block plus that separator line, then deletes the file only when nothing but whitespace, or keryx's own front matter, is left. A file that lacked a final newline may gain one on a round trip, and a pre-existing empty file that install wrote the block into is removed on uninstall.

## Per-harness notes

Every adapter marked `experimental` in the matrix ships with notes on what is unverified, except the `zed` `block` surface, which is backed by code and a test rather than by a documentation fetch.

| Runtime | What `install` writes | Caveat |
|---|---|---|
| `gemini-cli` | Ctx guard in `.gemini/settings.json` under `hooks.BeforeTool`; instructions in `GEMINI.md` | The hooks default-enabled flag, and the version that introduced it, are not confirmed in first-party documentation. Whether `GEMINI.md` is read end to end is not independently confirmed. Verify on a live install. |
| `kiro` | Ctx guard in `.kiro/hooks/keryx-ctx-guard.json`; instructions in `.kiro/steering/keryx.md` (with `inclusion: always` front matter) | Hook stdin field names and the shell tool's name are third-party-reported only, so the guard's matcher is a best guess and may gate nothing. Steering `inclusion` modes are reported as not always honoured. |
| `github-copilot-agent` | Ctx guard in `.github/hooks/keryx-ctx-guard.json` under `hooks.preToolUse`; instructions in `.github/copilot-instructions.md` | The shell tool's name in the hook payload is not documented, so the guard parses any tool call whose payload carries `toolArgs.command`. Whether the coding agent, as opposed to chat, reads the instructions file the same way is not confirmed. |
| `zed` | Nothing is installed; the `instructions` surface only probes `AGENTS.md`. | No scriptable pre-exec hook exists. Enforcement travels with the agent: when keryx runs as the ACP agent inside the editor, every outcome that is not an explicit `allow_once` or `allow_always` selection (a cancellation, a malformed payload, an option keryx never offered) is denied. See [ACP server](cli-reference.md#acp). **Shadowing:** the editor picks the first matching rules file among `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and more, so an earlier file shadows `AGENTS.md` even when it carries keryx's block. **Local scope:** under the default `scope: "local"` for the `codex` entry the block goes to `AGENTS.override.md`, which the editor does not read; set the `codex` entry of `agentEntrypoints.root` to scope `shared` for it to see the block. |

## rules-export surface

`rules-export` renders the canonical `.metaproject/rules/**` library, as an index of path and one-line description per rule and never a rule's body, into a harness's own instruction file, as a second managed block distinct from the `keryx:instructions` pointer block:

```text
<!-- keryx:rules -->
## Project rules (Keryx)

Canonical source: `.metaproject/rules/` (managed by keryx; edit the rules
there, not this block). Read the rule that matches your task before acting:

- `.metaproject/rules/core/git-concurrency.mdc` — No git stash in a shared
  tree; explicit pathspecs instead of `git add -A`; commit at task
  boundaries.
<!-- /keryx:rules -->
```

It is **opt-in** (`optIn: true`) — `keryx integrations install --runtime
<id>` with no `--surface` never writes it; reach it explicitly with `--surface
rules-export` (its id) or `--surface rules` (its flag), kept deliberately
independent of `--surface instructions` (the pre-existing `keryx:instructions`
pointer surfaces on gemini-cli/kiro/github-copilot-agent): naming one never
also reaches the other. Registered for
`claude`, `codex`, `gemini-cli` (`GEMINI.md`),
`github-copilot-agent` (`.github/copilot-instructions.md`, appended with no
front matter), `cursor` (`.cursor/rules/keryx-rules.mdc`, created with
`alwaysApply: true` front matter), `kiro` (`.kiro/steering/keryx-rules.md`,
`inclusion: always`), and `windsurf` (`.windsurf/rules/keryx-rules.md`,
`trigger: always_on`).

For `claude` and `codex` the file follows `agentEntrypoints.root` in
`.metaproject/metaproject.json`, the way the `keryx:index` block does
([Where the block goes](workspace-and-lifecycle.md#where-the-block-goes-local-and-shared-scope)),
since 0.3.47:

| Runtime | Scope `local` (the default) | Scope `shared` |
|---|---|---|
| `claude` | `CLAUDE.local.md` | `CLAUDE.md` |
| `codex` | `AGENTS.override.md` | `AGENTS.md` |

- A local file is made git-ignored before the block is written: when this
  checkout's ignore rules do not cover it yet (a fresh clone before
  `keryx update`), the install writes keryx's managed block in
  `.git/info/exclude`, the same one `keryx update` writes.
- For Codex the block goes into the `AGENTS.override.md` keryx generated, in
  keryx's own slot right after its `keryx:index` block, and every regeneration
  of that file (`keryx update`, `keryx rules sync`, `keryx rules distill`)
  carries it over. The override's staleness hash stays the hash of `AGENTS.md`
  alone. Only that slot is ever written, refreshed or removed: a block inside
  the override's copy of `AGENTS.md` is the team's text, and a block the team
  removed from `AGENTS.md` is gone from the override at its next regeneration.
- Codex with `mode: "skip"`, no `AGENTS.md`, no override generated yet in this
  checkout, or an `AGENTS.override.md` keryx did not generate — or Claude with a
  `CLAUDE.local.md` git tracks: nothing is written, the install succeeds with
  a warning saying which, and its status is `skipped` (`--json` included).
- A team file that already carries a `keryx:rules` block keeps getting it:
  committed in `HEAD`, it is the team's shared choice; as an uncommitted edit
  (what a keryx before 0.3.47 left), `keryx update` moves it to the local file.
  Until then every command keeps writing where the block is, so it is never in
  two files.
- Switching a runtime between local and shared in the manifest and running
  `keryx update` (or `keryx init`, `keryx rules sync`, `keryx rules distill`)
  moves an installed block to the runtime's new file, re-rendered there, and
  records that file in install-state. Installing again after the switch does
  the same. `uninstall --dry-run` names a block the real run would also take
  out of the other file.
- A manifest that does not state the runtime in entry form (not yet migrated
  by `keryx update`) still gets the team file, as before 0.3.47. So does an
  entry the manifest states with any file other than the runtime's own
  (`CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `AGENTS.override.md`): the
  block never goes anywhere else.

Install, uninstall, `keryx integrations doctor`, `--dry-run`, install-state
and `keryx bundle import --render-for` all read the same resolved file. The
other harnesses' files have no per-developer counterpart their tool reads, so
installing into them stays an explicit edit to the team's instructions.

| Runtime | File |
|---|---|
| `claude` | `CLAUDE.md` |
| `codex` | `AGENTS.md` |
| `gemini-cli` | `GEMINI.md` |
| `github-copilot-agent` | `.github/copilot-instructions.md` (appended, no front matter) |
| `cursor` | `.cursor/rules/keryx-rules.mdc` (created with `alwaysApply: true`) |
| `kiro` | `.kiro/steering/keryx-rules.md` (`inclusion: always`) |
| `windsurf` | `.windsurf/rules/keryx-rules.md` (`trigger: always_on`) |

Unlike the `keryx:index` block, which goes to per-developer files by default, this block is always written to those tracked files, because installing it is an explicit edit to the team's instructions.

Install only touches its own `<!-- keryx:rules -->` span, so a file that already carries a `keryx:index` or `keryx:instructions` block keeps that other block byte for byte. Re-running install after a rule changes updates only the block, and `keryx integrations uninstall --runtime <id> --surface rules-export` removes it. A rule's title and description are neutralised before rendering, so a rule file can never forge or close the marker; a rule whose own **path** cannot be neutralised (it contains a control character, `<`, `>`, a backtick, or a literal `<!--` or `-->`) is skipped and reported as an install warning, while every other rule still installs. Install and uninstall refuse to write through a symlink whose resolved target leaves the project root; a symlink that stays inside the project, such as `CLAUDE.md -> AGENTS.md`, is followed. `keryx bundle import --render-for <harness>` uses the same installer and install-state.

## Write containment

Every write, remove, rename and directory-create this module performs into a project tree goes through one primitive in `src/lib/contained-write.ts`, never a raw filesystem call, and a test fails the build if a raw call creeps back in. This covers the managed markdown blocks, the JSON settings-file owner, install-state, the matrix artifact, `rules distill` and `rules sync`, and agent export. The primitive refuses, with a named reason and never a silent no-op, on:

- an absolute path, or one containing a lexical `..` segment;
- a path that steps through a literal `.git` directory segment;
- a symlink segment whose resolved real path leaves the project root;
- a symlink cycle or a dangling symlink anywhere on the path;
- overwriting an existing non-regular-file entry, or a non-directory entry sitting where a directory is expected.

A symlink whose resolved target stays inside the project root is followed, and the symlink itself is left in place. Every other write is atomic: the payload goes to a temporary file beside the target and is renamed into place, so a reader never sees a partial file.

## Legacy command aliases

`keryx ctx install-hook` and `uninstall-hook`, `keryx orient install-hook`, and `keryx security hooks install|uninstall` keep their commands, flags and output shape. They are aliases that delegate to `keryx integrations install` or `uninstall --runtime <id> --surface <selector>`, with the surface implied by which alias was called. An uninstall alias whose target file exists but does not carry keryx's managed entry reports "nothing to remove".

| Legacy command | Delegates to |
|---|---|
| `keryx ctx install-hook`/`uninstall-hook --runtime <id>` | `keryx integrations install`/`uninstall --runtime <id> --surface ctx-guard` |
| `keryx orient install-hook --runtime <id>` | `keryx integrations install --runtime <id> --surface orient` |
| `keryx security hooks install --runtime <id>` | `keryx integrations install --runtime <id> --surface security-check-input --surface security-check-output` |

Each `--surface` selector above is a surface **id**, not a flag: a flag such as `block` can match more than one surface on the same runtime (for `claude`, both `ctx-guard` and `security-check-output` carry it), so a flag selects every surface that carries it while an id selects exactly one.

**Not aliased:** `keryx ctx hook <runtime>` is the runtime guard *handler* itself, the command a host settings file's `PreToolUse` entry invokes directly. It is not an installer, so it has no `keryx integrations` equivalent.

## See also

- [Connect your agents](modules/integrations.md): the task-first introduction.
- [CLI reference: integrations](./cli-reference.md#integrations): every flag, in full.
- [Module reference](./modules.md): per-module mechanics.
- [Architecture](./architecture.md): where host-harness integrations sit in the layered system.
