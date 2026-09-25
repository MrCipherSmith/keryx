# Integrations: the harness adapter registry

Keryx can install small, sentinel-tagged hooks and standing-instructions files
into other coding agents' own config, so that Keryx's routing guard, security
checks, and orientation context apply no matter which harness a person is
actually driving. This page describes the unified **registry** those installs
come from, the `keryx integrations` command family, install-state and
`doctor` drift detection, the generated **capability matrix**, and the
per-harness notes — including the honest experimental caveats for the
harnesses added in flow 307 (Gemini CLI, Kiro, GitHub Copilot agent, Zed).

This is a distinct namespace from `keryx harness run|exec|extension|wave`
(Keryx's own agent runtime — see [harness.md](./harness.md)); `keryx
integrate` (MCP client configuration) is also a separate command, unrelated to
this registry.

## The registry, in one sentence

Before this registry, three independently-versioned installers each wrote
into host settings files with their own idea of which harnesses existed: the
gdctx routing/shell guard (`src/ctx/runtimes.ts`), the graph+wiki orientation
injector (`src/ctx/orient-runtimes.ts`), and the security
check-input/check-output installer (`src/security/agent-hooks/runtimes.ts`).
They disagreed with each other about runtime coverage and, at one point,
silently clobbered each other's entries in the same file. The unified
registry (`src/integrations/`) instead describes each harness once, as a set
of **capability flags on named surfaces** (`block`, `prompt-gate`,
`inject-context`, `instructions`, and others), with exactly one merge/strip/
validate path per physical settings file — so two surfaces that target the
same file (say, the ctx guard and a security check) can never destroy each
other's entries again.

## Command family

```text
keryx integrations install   --runtime <id> [--surface <flag|surface-id>]... [--dry-run] [--json]
keryx integrations doctor    --runtime <id> [--surface <flag|surface-id>]... [--json]
keryx integrations uninstall --runtime <id> [--surface <flag|surface-id>]... [--dry-run] [--json]
keryx integrations matrix    [--check] [--write] [--json] [--file <path>]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `install` | `--runtime <id>`, `--surface <flag>...`, `--dry-run`, `--json` | Resolves every registered surface for `<id>` (or only the named surfaces, repeatable), applies each surface's merge in deterministic order, and records what it wrote to install-state. `--dry-run` reports what it would write and changes nothing. |
| `doctor` | `--runtime <id>`, `--surface <flag>...`, `--json` | Re-validates every surface already recorded in install-state against the live settings file and reports drift — a surface that install-state says should be there but is now missing, or has gone stale. `--surface` restricts the check to the named surface(s), including one never installed yet. |
| `uninstall` | `--runtime <id>`, `--surface <flag>...`, `--dry-run`, `--json` | Removes only the sentinel-tagged entries Keryx itself installed for the named runtime/surfaces, leaving every other entry in the file — including the operator's own — untouched. |
| `matrix` | `--check`, `--write`, `--json`, `--file <path>` | Prints (or validates) the generated capability matrix. `--check` regenerates the matrix from the registry and diffs it against the checked-in artifact, exiting non-zero on drift, with no file written — this is the command CI runs. `--write` regenerates and overwrites the matrix artifact in place. `--file <path>` uses a matrix artifact path other than the default `docs/integrations/harness-capability-matrix.json`. |

### Example: install the ctx guard and instructions for Gemini CLI

```bash
keryx integrations install --runtime gemini-cli --surface block --surface instructions
```

Omit `--surface` to install every surface the runtime's adapter declares:

```bash
keryx integrations install --runtime kiro
```

### Example: check for drift

```bash
keryx integrations doctor --runtime kiro --json
```

## Install-state and doctor drift

`keryx integrations install` records, per project, which `(runtime, surface)`
pairs it installed, when, and against which Keryx version. State lives at:

```
.metaproject/data/integrations/install-state/<runtime>.json
```

and is written **only** when `<root>/.metaproject` already exists — installing
into a project with no Metaproject workspace never creates one just to hold
this state. Each record follows the `install-manifest.schema.json`
`installState`/`installedModuleRecord` shape, with two additive fields this
registry stamps: `keryxVersion` and `installedAt`. A record also carries an
optional `surface` discriminator, since one runtime can have several surfaces
(e.g. `block` and `instructions`) each independently installed or removed.

`doctor` reads this state to know what *should* be present, then compares
against the live settings file. When something has gone missing, it reports
drift naming the version and date Keryx installed it — for example:

```
ctx-guard (block) was installed by Keryx 0.2.140 on 2026-08-03 and is now missing: .gemini/settings.json: file is missing
```

(`ctx-guard (block)` is the *surface* id and flag — not the runtime id `gemini-cli` — since one runtime can carry several surfaces, each drifting independently.)

— rather than the less useful "surface is missing," because knowing *when*
and *by which build* narrows down what changed the file in between.

## The capability matrix

`docs/integrations/harness-capability-matrix.json` is **generated from the
registry** (`src/integrations/matrix.ts`), not maintained by hand — read it
directly for the current, authoritative per-harness/per-surface state. A
guard test (`src/integrations/harness-capability-matrix.test.ts`) regenerates
the matrix from the registry and fails the build if the checked-in artifact
has drifted; `keryx integrations matrix --check` runs the same regeneration
in CI, with nothing written.

Each harness entry in the matrix reports a `state`, one of:

- **`native`** — a `host-hook` adapter at `confidence: "verified"`; the
  surface actively installs and validates.
- **`adapter`** — works through a thin bridge, or is an `experimental`
  host-hook adapter (every W5-b harness below ships at this state).
- **`instruction-only`** — no runtime enforcement; a file is written and
  read, but nothing decides anything (e.g. `GEMINI.md`, Kiro steering,
  `.github/copilot-instructions.md`).
- **`unsupported`** — no known mechanism; registered only so the CLI gives a
  precise refusal message instead of silently doing nothing.

To regenerate the matrix after a registry change:

```bash
keryx integrations matrix --write
```

### The `instructions` surface's managed markdown block

Gemini CLI, Kiro, and GitHub Copilot agent's `instructions` surfaces all
install the same short pointer between `<!-- keryx:instructions -->` /
`<!-- /keryx:instructions -->` markers into a secondary instructions file.
Install into an absent file creates it (Kiro only: with its
`inclusion: always` front matter first), LF-terminated. Install into an
existing file never adds front matter — even a file Keryx itself created
that the user later emptied back out — and only ever touches the block
itself, appending it (with one blank separator line) when absent or
replacing it in place when present. Uninstall removes the block plus that
one separator line, then deletes the file only when nothing but
whitespace, or Keryx's own front matter, is left. One documented
consequence of keeping this simple: install → uninstall on an existing file
is byte-identical when the file ended with a newline (the common case); a
file that lacked a final newline may gain one, and a pre-existing empty (or
whitespace-only) file that install wrote the block into is removed on
uninstall along with it, the same as a file install created outright.

## Per-harness notes (new in flow 307 / W5-b)

These four harnesses had zero entries in any registry before this flow. Every
new adapter below ships at `confidence: "experimental"` with non-empty
`risk_notes` and `source_docs` — **except** Zed's `block` surface, which is
`verified` because it is backed by code (`src/acp/permission.ts`) and a
pinning test, not a documentation fetch. Treat every `experimental` row as
unverified against a live install.

### Gemini CLI

- Ctx guard (`block`): `.gemini/settings.json`, under `hooks.BeforeTool`.
- Instructions (`instructions`): `GEMINI.md`.
- **Caveat:** Gemini CLI's hooks default-enabled flag, and the version it was
  introduced in, are not confirmed in first-party docs — verify on a live
  install before relying on it. Whether Gemini CLI reads `GEMINI.md`
  end-to-end (beyond the documented `context.fileName` option) is likewise
  not independently confirmed here.

### Kiro

- Ctx guard (`block`): `.kiro/hooks/keryx-ctx-guard.json`.
- Instructions (`instructions`): `.kiro/steering/keryx.md` (written with
  `inclusion: always` front matter).
- **Caveat:** Kiro's hook stdin field names and its shell tool's name are
  third-party-reported only, not confirmed by first-party docs — the guard's
  matcher is a best guess and may gate nothing on a real install. Open Kiro
  issues also report that steering-file `inclusion` modes are not always
  honoured, even with `inclusion: always` set. Verify both before relying on
  either.

### GitHub Copilot agent

- Ctx guard (`block`): `.github/hooks/keryx-ctx-guard.json`, under
  `hooks.preToolUse`.
- Instructions (`instructions`): `.github/copilot-instructions.md`.
- **Caveat:** the shell tool's name Copilot's hook payload carries is not
  documented, so this guard parses any tool call whose payload carries
  `toolArgs.command`, whatever `toolName` turns out to be. Whether the
  Copilot *coding agent* (as opposed to the Copilot CLI/IDE chat) reads
  `.github/copilot-instructions.md` the same way is also not independently
  confirmed here.

### Zed

- **Nothing is installed.** Zed has no scriptable pre-exec hook at all, so a
  host-hook adapter is not possible. Instead, enforcement travels *with the
  agent*: when Keryx runs as the ACP agent inside Zed,
  `src/acp/permission.ts`'s `approvalFromPermissionResponse` denies by
  construction on every outcome that is not an explicit
  `allow_once`/`allow_always` selection — a cancellation, a malformed
  payload, or an option Keryx never offered all fall through to a denial.
  This is registered as its own adapter kind,
  `adapterKind: "policy-travels-with-agent"`, and is `confidence: "verified"`
  for the `block` surface because it is proven by code and
  `src/acp/permission.test.ts`, not by a documentation fetch.
- Instructions (`instructions`): probe-only against `AGENTS.md`. Keryx writes
  nothing new here beyond what `keryx init`/`keryx update` already produce.
- **Caveat (AGENTS.md shadowing):** Zed picks the **first** matching rules
  file among `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`,
  `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, and more. An earlier file in that list shadows `AGENTS.md`
  even when `AGENTS.md` itself carries Keryx's block correctly — so a repo
  with, say, a stray `.cursorrules` file can silently keep Zed from ever
  reading Keryx's instructions.

### keryx-shell (placeholder)

Registered with every surface flag present but `unsupported` — this is W6's
future `keryx shell` hook runtime. No surface here is installed by `keryx
integrations` yet; every cell is a target for that later workstream.

## rules-export surface

`rules-export` (flow 313, W4 portability) renders the canonical
`.metaproject/rules/**` library — an index of path + one-line description per
rule, never a rule's body — into a harness's own instruction file, as a
second managed block distinct from the `keryx:instructions` pointer block
above:

```
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
`claude` (`CLAUDE.md`), `codex` (`AGENTS.md`), `gemini-cli` (`GEMINI.md`),
`github-copilot-agent` (`.github/copilot-instructions.md`, appended with no
front matter), `cursor` (`.cursor/rules/keryx-rules.mdc`, created with
`alwaysApply: true` front matter), `kiro` (`.kiro/steering/keryx-rules.md`,
`inclusion: always`), and `windsurf` (`.windsurf/rules/keryx-rules.md`,
`trigger: always_on`).

The block is written through the same `markdown-block.ts` contract every
`instructions` surface above uses — install only ever touches its OWN
`<!-- keryx:rules -->`/`<!-- /keryx:rules -->` span, so a file already
carrying a `keryx:index` or `keryx:instructions` block (CLAUDE.md/AGENTS.md's
Metaproject bootstrap, or GEMINI.md/`.github/copilot-instructions.md`'s
pointer block) keeps that other block byte-for-byte. Re-running install after
a rule changes updates only the block; `keryx integrations uninstall
--runtime <id> --surface rules-export` removes it and restores the
surrounding file, with the same caveats "The `instructions` surface's managed
markdown block" above documents for the byte-exactness of that round trip (a
file with no final newline may gain one; a pre-existing empty/whitespace-only
file install wrote the block into is deleted on uninstall along with it). A
rule's own title/description text is neutralised before rendering (HTML
comment delimiters and backticks are stripped/rewritten) so a rule file can
never forge or close the marker itself; a rule whose own **path** cannot be
neutralised this way (it contains a control character, `<`, `>`, a backtick,
or a literal `<!--`/`-->`) is skipped — not rendered — and reported as an
install warning naming the path and reason, while every other rule still
installs. Install/uninstall also refuse to write through a symlink whose
resolved target leaves the project root (a symlink that stays inside the
project, e.g. `CLAUDE.md -> AGENTS.md`, is followed normally).

`src/integrations/rules-export.ts`'s `renderRulesForHarnesses`/
`installedRulesExportHarnesses` are the programmatic entry points a later
task (`keryx bundle import --render-for`) drives; they go through the same
installer core and install-state as every other surface, rather than a
second bookkeeping layer.

## Write containment

Every write, remove, rename, and directory-create this module performs into a
project tree — the markdown-block managed installs above, the JSON
settings-file owner, install-state, the capability matrix artifact, the
OpenCode plugin file, `rules distill`/`rules sync`'s writes into
`.metaproject/` and back into the entrypoint files themselves, and agent
export — goes through the ONE primitive in `src/lib/contained-write.ts`
(`writeContained`/`removeContained`/`mkdirContained`/`renameContained`),
never a raw `node:fs/promises` call. A `src/lib/contained-write.ratchet.test.ts`
test scans these modules' source for a raw `writeFile`/`rm`/`unlink`/
`rename`/`mkdir`/`appendFile`/`copyFile` import and fails the build if one
creeps back in outside that one file.

The primitive refuses (with a named `ContainedWriteError.reason`, never a
silent no-op or a bare exception) on:

- an absolute `rel` path, or one containing a lexical `..` segment;
- a path that steps through a literal `.git` directory segment;
- a symlink segment (intermediate or final) whose resolved real path leaves
  the project root — same rule `src/lib/symlink-safety.ts` already used for
  reads and the managed-block installs above, so both agree byte-for-byte;
- a symlink CYCLE or a DANGLING symlink anywhere on the path;
- overwriting an existing non-regular-file entry (writes), or a non-directory
  entry already sitting where a directory is expected (`mkdirContained`).

A symlink whose resolved target stays INSIDE the project root (the
`CLAUDE.md -> AGENTS.md` layout mentioned above) is followed, not refused —
the write lands in the symlink's target, exactly like a plain `writeFile`
would, and the symlink itself is left in place. Every other write is
atomic: the payload goes to a temporary file beside the target, then is
renamed into place, so a reader never observes a partially written file and
a crash mid-write leaves either the old content or none, never a truncation.

## Legacy command aliases

`keryx ctx install-hook`/`uninstall-hook`, `keryx orient install-hook`, and
`keryx security hooks install|uninstall` keep their existing commands, flags,
and output shape — they are kept as aliases that internally delegate to
`keryx integrations install`/`uninstall --runtime <id> --surface <selector>`,
with the surface(s) implied by which alias was called. One outward behavior
is now more precise rather than "exactly as before": an uninstall alias
whose target file exists but does not actually carry Keryx's managed entry
now reports "nothing to remove" (it previously reported success
unconditionally whenever the file existed, whether or not the entry was
there to strip):

| Legacy command | Delegates to |
|---|---|
| `keryx ctx install-hook`/`uninstall-hook --runtime <id>` | `keryx integrations install`/`uninstall --runtime <id> --surface ctx-guard` |
| `keryx orient install-hook --runtime <id>` | `keryx integrations install --runtime <id> --surface orient` |
| `keryx security hooks install --runtime <id>` | `keryx integrations install --runtime <id> --surface security-check-input --surface security-check-output` |

Each `--surface` selector above is a surface **id**, not a `SurfaceFlag`: a
flag such as `block` can match more than one surface on the same runtime
(Claude's `ctx-guard` and `security-check-output` both carry the `block`
flag), so a flag selects every surface that carries it while an id selects
exactly one — which is why these aliases, each of which must install (or
remove) precisely one subsystem's surface and no other, are spelled with
ids rather than the flag their alias name might suggest.

No existing script or CI job that calls the old commands needs to change.

**Not aliased:** `keryx ctx hook <runtime>` is the runtime guard *handler*
itself — the command a host settings file's `PreToolUse` entry invokes
directly (e.g. `.claude/settings.json`, and now also `.gemini/settings.json`,
`.kiro/hooks/keryx-ctx-guard.json`, `.github/hooks/keryx-ctx-guard.json`).
It is not an installer, so it has no `keryx integrations` equivalent and its
behavior is unchanged by this registry.

`keryx harness run|exec|extension|wave` is Keryx's own agent runtime and is
entirely unrelated to this page — see [harness.md](./harness.md).

## See also

- [cli-reference.md](./cli-reference.md#harness) — every flag, in full.
- [modules.md](./modules.md) — per-module mechanics reference.
- [architecture.md](./architecture.md) — where host-harness integrations sit
  in the layered system.
- `docs/requirements/keryx-agent-platform-expansion/workstreams/W5-multi-harness.md`
  — the design document this registry implements, including the target
  matrix, open questions (notably **OQ-3**, the unverified `securityHooks`
  key on Cursor/Windsurf), and what remains for later workstreams.
