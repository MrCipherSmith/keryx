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
keryx integrations doctor    --runtime <id> [--json]
keryx integrations uninstall --runtime <id> [--surface <flag|surface-id>]... [--dry-run] [--json]
keryx integrations matrix    [--check] [--write] [--json]
```

| Subcommand | Flags / args | Description |
|---|---|---|
| `install` | `--runtime <id>`, `--surface <flag>...`, `--dry-run`, `--json` | Resolves every registered surface for `<id>` (or only the named surfaces, repeatable), applies each surface's merge in deterministic order, and records what it wrote to install-state. `--dry-run` reports what it would write and changes nothing. |
| `doctor` | `--runtime <id>`, `--json` | Re-validates every surface already recorded in install-state against the live settings file and reports drift — a surface that install-state says should be there but is now missing, or has gone stale. |
| `uninstall` | `--runtime <id>`, `--surface <flag>...`, `--dry-run`, `--json` | Removes only the sentinel-tagged entries Keryx itself installed for the named runtime/surfaces, leaving every other entry in the file — including the operator's own — untouched. |
| `matrix` | `--check`, `--write`, `--json` | Prints (or validates) the generated capability matrix. `--check` regenerates the matrix from the registry and diffs it against the checked-in artifact, exiting non-zero on drift, with no file written — this is the command CI runs. `--write` regenerates and overwrites `docs/integrations/harness-capability-matrix.json` in place. |

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
gemini-cli: block surface was installed by Keryx 0.2.140 on 2026-08-03 and is now missing
```

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

## Legacy command aliases

`keryx ctx install-hook`/`uninstall-hook`, `keryx orient install-hook`, and
`keryx security hooks install|uninstall` continue to work exactly as before —
they are kept as aliases that internally delegate to `keryx integrations
install`/`uninstall --runtime <id> --surface <flag>`, with the surface(s)
implied by which alias was called:

| Legacy command | Delegates to |
|---|---|
| `keryx ctx install-hook`/`uninstall-hook --runtime <id>` | `keryx integrations install`/`uninstall --runtime <id> --surface block` |
| `keryx orient install-hook --runtime <id>` | `keryx integrations install --runtime <id> --surface inject-context` |
| `keryx security hooks install --runtime <id>` | `keryx integrations install --runtime <id> --surface prompt-gate --surface block` |

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
