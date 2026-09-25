# W5 — Multi-harness support & capability matrix
Version: 0.1.4

> **Status (W5-a, flow 321):** the unified registry has landed in `src/integrations/` for the runtimes that existed before this workstream (claude, codex, cursor, windsurf, antigravity, opencode, zed as unsupported, generic-mcp). `HarnessAdapter.surfaces` is a list rather than a per-flag record, because Claude already carries two `block` surfaces in one file (the ctx guard and security check-output). New adapters, the `keryx integrations` CLI and the generated matrix remain W5-b.
>
> **Status (W5-b, flow 323):** adapters for gemini-cli, kiro, and
> github-copilot-agent have landed in `src/integrations/surfaces-w5b.ts`, each
> at `confidence: "experimental"` with non-empty `risk_notes`/`source_docs`
> (`block` via a host-hook settings file, plus an `instructions` surface).
> Zed is registered as `adapterKind: "policy-travels-with-agent"`, with its
> `block` surface `confidence: "verified"` against `src/acp/permission.ts`,
> and a probe-only `instructions` surface against `AGENTS.md`. A
> `keryx-shell` placeholder adapter is registered with every surface flag
> `unsupported`, pending W6. The generated capability matrix artifact
> (`docs/integrations/harness-capability-matrix.json`, produced by
> `src/integrations/matrix.ts`) is checked in and drift-guarded by
> `src/integrations/harness-capability-matrix.test.ts` and `keryx
> integrations matrix --check` in CI. The `keryx integrations
> install|doctor|uninstall|matrix` CLI family exists, with per-target
> install-state at
> `.metaproject/data/integrations/install-state/<runtime>.json` (written only
> when `.metaproject/` already exists), and the legacy `keryx ctx
> install-hook|uninstall-hook`, `keryx orient install-hook|uninstall-hook`,
> and `keryx security hooks install|uninstall` commands keep working
> unchanged, delegating internally to the same installer core. `keryx ctx
> hook <runtime>` is unchanged and now also serves gemini-cli, kiro, and
> github-copilot-agent. Still open: **OQ-3** (unverified `securityHooks` key
> on Cursor/Windsurf) is not resolved by this flow; MCP client-config
> ownership (`keryx integrate`) has not been moved into this registry; and
> the Kiro/GitHub-Copilot-agent payload field names remain third-party-only,
> unconfirmed by first-party docs.

## Summary

Keryx today writes into host-harness settings files through **three separate,
independently-versioned registries** — the gdctx routing/shell guard
(`src/ctx/runtimes.ts`), the graph+wiki orientation injector
(`src/ctx/orient-runtimes.ts`), and the security check-input/check-output
installer (`src/security/agent-hooks/runtimes.ts`) — each with its own runtime
id list, its own settings-file merge/strip/validate logic, and its own idea of
which harnesses exist. They disagree with each other about runtime coverage,
they have already produced one real file-clobbering bug for the harnesses they
share, and none of the three has an entry for Gemini CLI, Kiro, GitHub Copilot,
or Zed. W5 replaces the three registries with **one harness adapter registry**
that every Keryx-managed surface (guard, security, orientation, and — per W6 —
the future keryx-shell hook runtime) is expressed against, adds honestly-scoped
adapters for the missing harnesses, and generates a **capability matrix** that
states, per harness and per surface, exactly what is native, adapter-backed,
instruction-only, or unsupported — validated in CI so the matrix can never
silently drift from the registry it describes.

This document is a planning artifact. Everything described as new
(`planned`) does not exist in the codebase; every claim about current behavior
is backed by a file path a reader can open.

## Current state

### The three registries today

| Registry | File | Purpose | Runtimes registered | Confidence split |
|---|---|---|---|---|
| ctx guard | `src/ctx/runtimes.ts` (`CTX_RUNTIMES`, lines 626–633) | PreToolUse-style block/allow for shell commands, routed through one shared classifier (`hook-classify.ts`) | `claude`, `codex`, `cursor`, `windsurf` (`confidence: "verified"`); `antigravity`, `opencode` (`confidence: "experimental"`); `zed` listed only in `UNSUPPORTED_RUNTIMES` (line 622) with a tracking-issue citation | 4 verified / 2 experimental / 1 explicitly unsupported |
| orient injector | `src/ctx/orient-runtimes.ts` (`ORIENT_RUNTIMES`, line 170) | UserPromptSubmit/sessionStart context injection (graph+wiki orientation block) | `claude`, `codex`, `cursor` only; `windsurf`, `zed`, `opencode`, `antigravity` are listed in `UNSUPPORTED_ORIENT` (lines 163–168) with per-harness reasons (exit-code-only hooks, no scriptable hook, undocumented/buggy, unverified) | 3 verified / 0 experimental / 4 explicitly unsupported |
| security check-input/output | `src/security/agent-hooks/runtimes.ts` (`RUNTIME_HOOKS`, lines 315–320) | Routes agent input/output through `keryx security check-input`/`check-output` | `claude` (own event-keyed schema), `cursor`, `windsurf`, `generic-mcp` (flat `securityHooks` schema) | No codex, no antigravity, no opencode entry at all — not even a documented-unsupported one |

Each registry independently defines its own `Confidence`/`GroupShape` types,
its own `_keryxManaged` sentinel string (`ctx-agent-hooks`, `ctx-orient-hooks`,
`security-agent-hooks`), and its own merge/strip/validate walker. There is no
shared interface between them today — an engineer adding a fourth surface
(e.g. W6's shell hook runtime) has three existing shapes to imitate and no
canonical one to extend.

### The `securityHooks` / OQ-3 clobbering history

`src/security/agent-hooks/runtimes.ts` (lines 169–201) documents, in its own
source comments, a real bug: the ctx guard and the security installer both
target `.cursor/hooks.json` and `.windsurf/hooks.json`. The ctx guard writes
`hooks` as an **object** keyed by the runtime's real event name
(`beforeShellExecution`, `pre_run_command`), a shape it calls
`confidence: "verified"`. The security installer used to write the same
`hooks` key as an **array** of `{on, command}` entries. Two incompatible JSON
types under one key, and each installer's strip helper replaced whatever it
did not recognize wholesale — so whichever installer ran second silently
destroyed the first, while the shared `_keryxManaged` sentinel discipline kept
claiming both installs were present (`_keryxManaged: ["ctx-agent-hooks",
"security-agent-hooks"]` even when only one guard actually worked). Measured
before the fix, in the file's own comment:

```
ctx then security -> ctx.validate: ["cursor: missing beforeShellExecution guard"]
security then ctx -> sec.validate: ["cursor: missing input hook routing …"]
```

The fix moves the security installer's cursor/windsurf entries to a
new, Keryx-invented top-level key, `securityHooks` (`SECURITY_HOOKS_KEY`, line
204). The file's own comment states this key "matches no documented contract
for cursor or windsurf" and is tracked as open question **OQ-3**: nothing
confirms Cursor or Windsurf actually reads a `securityHooks` key, so
`keryx security hooks install --runtime cursor` may currently be a no-op from
the runtime's own point of view, even though it validates clean against
Keryx's own schema. The fix is regression-tested end-to-end in
`src/security/agent-hooks.coexistence.test.ts`, which drives both installer
orderings against the **real** `CTX_RUNTIMES` registry (not a hand-built
stand-in) and asserts neither destroys the other, migrates pre-fix legacy
arrays without dropping user entries, and closes a `.find`-vs-`.some` validator
bug that let a hostile entry with a matching `on` field validate as clean
(`agent-hooks.coexistence.test.ts` lines 311–338). The test file's own header
records that the original bug shipped "despite prior tests" because the
existing suite reached the collision only by calling `validate` directly with
a hand-built object the installer could never itself produce — a fixture-drift
failure mode, not a missing assertion.

This history is the direct justification for W5's core design decision: one
merge/strip/validate path per settings file, not one per subsystem writing
into that file.

### ACP: a structurally different portability channel

`src/acp/permission.ts` shows Keryx already has one channel where enforcement
travels with the agent instead of living in host-side hook config: when Keryx
runs as an ACP agent (e.g., inside Zed), every `session/request_permission`
outcome that is not an explicit `allow_once`/`allow_always` selection is
denied by construction (`approvalFromPermissionResponse`, lines 140–169 —
`cancelled`, a malformed payload, and an `optionId` Keryx never offered all
fall through to `return false`). This works for Zed today even though Zed has
no scriptable pre-exec hook of its own (`UNSUPPORTED_RUNTIMES.zed` in
`src/ctx/runtimes.ts`). W5's Zed adapter formalizes this as a distinct
adapter kind (`policy_travels_with_agent`, see Design) rather than pretending
Zed has a host-side hook it does not have.

## Goals & non-goals

**Goals**
- Replace the three overlapping registries with one harness adapter registry
  that every Keryx-managed hook-writing surface is defined against.
- Make per-harness support level an honest, generated, CI-checked fact —
  never a hand-maintained claim that can drift from what the registry
  actually implements.
- Add first adapters (however minimal) for Gemini CLI, Kiro, and GitHub
  Copilot agent, which today have zero entries in any registry.
- Formalize the ACP/Zed policy-travels-with-agent pattern as its own adapter
  kind rather than folding it into the same shape as a host-side hook
  installer.
- Give operators one `keryx integrations` command family for install/doctor/
  uninstall/matrix across every Keryx-managed surface, replacing three
  differently-shaped CLI surfaces with one. This is a distinct namespace from
  the existing `keryx harness run|exec|extension|wave` (Keryx's own agent
  runtime, `src/commands/harness.ts`), which W5 does not touch.
- Preserve every currently-shipped installer command as a working alias — zero
  breakage for anyone with `keryx ctx install-hook`, `keryx security hooks
  install`, or `keryx orient install-hook` already wired into their setup.
  `keryx ctx hook <runtime>` itself is not an installer and is not aliased —
  see Design → Migration from existing commands.

**Non-goals**
- W5 does not implement W6's keryx-shell hook runtime (SessionStart,
  PreToolUse, etc. inside `keryx shell` itself) — it defines the registry
  shape W6's built-in hooks will register against.
- W5 does not implement the audit checks that read the resulting config files
  for security issues — that is W8. W5 only guarantees the files W8 reads are
  produced by one code path per file, not three that might disagree.
- W5 does not promise verified, first-party-confirmed behavior for every
  harness in the target matrix on day one. Several rows are explicitly
  `to verify` (see Design → Target matrix) and ship as `adapter`/
  `instruction-only` with `confidence: "experimental"` rather than blocked
  on external verification.
- W5 does not change the command classifier (`hook-classify.ts`) or the
  policy engine (`src/harness/policy/engine.ts`) — those are consumed by the
  adapters, not redesigned by this workstream.
- W5 does not attempt real-time detection of a harness's installed version;
  `keryx integrations doctor` checks Keryx's own artifact state, not the host
  application.

## Design: unified harness adapter registry

### Why a registry of surfaces, not a registry of hooks

The current registries are shaped around one hook mechanism each (a
PreToolUse-style guard, a context injector, a check-input/output pair). That
shape is why a fourth writer (W6) would have had to invent a fourth
registry. The unified registry instead describes a harness once, as a set of
**capability flags on named surfaces**, and each Keryx subsystem (ctx guard,
security hooks, orientation, W6's future built-ins, W2's agent export, W4's
instruction export) asks the registry "does harness X support surface Y, and
if so, how do I install into it" — rather than each subsystem maintaining its
own harness list.

### TypeScript interface sketch

```ts
// planned — src/harness-adapters/registry.ts

/** One capability a harness surface may or may not have. */
export type SurfaceFlag =
  | "block"            // can deny/allow a tool call before it runs (PreToolUse-style)
  | "prompt-gate"      // can deny/allow at a UserPromptSubmit-style prompt-entry point, with block authority (distinct from "inject-context", which has no decision authority)
  | "pre-tool-context" // can carry additionalContext on a PreToolUse-style call (W8 first-edit evidence delivery)
  | "inject-context"   // can add text to context at session/prompt start
  | "observe"          // can receive a read-only post-hoc event (no decision authority)
  | "post-tool"        // can react after a tool call completes (PostToolUse-style)
  | "session-start"    // has a session-start lifecycle point
  | "stop"             // has an end-of-turn/session-stop lifecycle point
  | "skills"           // can load/discover SKILL.md-shaped capability packages
  | "agents"           // can load a subagent/custom-agent definition format
  | "instructions"     // reads a standing project-instructions file (AGENTS.md-family)
  | "rules"            // flow 313 (W4): receives the canonical-rules index as a managed block (opt-in rules-export surfaces)
  | "mcp";             // can act as an MCP client to Keryx's own MCP server

export type Confidence = "verified" | "experimental";

/** How enforcement reaches this harness. */
export type AdapterKind =
  | "host-hook"                 // Keryx writes a command into the harness's own hook config
  | "policy-travels-with-agent" // Keryx runs AS the agent (ACP); no host hook config involved
  | "instruction-only";         // no runtime enforcement; Keryx writes prose into a read file

/** One managed record inside a settings file: payload in, decision out. */
export interface PayloadCodec<TPayload> {
  /** Parse the harness's wire shape into the field(s) Keryx's classifiers need. */
  parse(raw: string): TPayload | null;
}

export interface DecisionCodec {
  /** How this harness's surface is told "no", given a human-readable message. */
  deny(message: string): { exitCode: number; stdout?: string; stderr?: string };
  /** How this harness's surface is told "yes". */
  allow(): { exitCode: number; stdout?: string; stderr?: string };
}

/** One surface (e.g. "block" on Claude) that a HarnessAdapter implements. */
export interface SurfaceAdapter<TPayload = unknown> {
  readonly flag: SurfaceFlag;
  readonly settingsFile: (projectRoot: string) => string;
  readonly payloadCodec?: PayloadCodec<TPayload>;   // absent for non-JSON / no-input surfaces
  readonly decisionCodec?: DecisionCodec;           // absent for observe-only surfaces
  /** One shared merge/strip/validate path per settings FILE — see below. */
  merge(settings: Record<string, unknown>): Record<string, unknown>;
  strip(settings: Record<string, unknown>): Record<string, unknown>;
  validate(settings: Record<string, unknown>): string[];
}

export interface HarnessAdapter {
  readonly id: string;                 // "claude" | "codex" | "cursor" | "gemini-cli" | ...
  readonly label: string;
  readonly confidence: Confidence;
  readonly adapterKind: AdapterKind;
  readonly surfaces: Partial<Record<SurfaceFlag, SurfaceAdapter>>;
  readonly sourceDocs: readonly string[];   // citations backing this adapter's claims
  readonly lastVerified: string;            // ISO date of last confirmation against sourceDocs
}

export const HARNESS_ADAPTERS: HarnessAdapter[] = []; // planned — populated per harness below
```

This sketch keeps the part of today's design that already works well — one
shared command classifier feeding every block-capable adapter — and fixes the
part that does not: today, "does this harness support surface Y" is answered
by checking whether an id appears in one of three separate arrays; under this
design it is answered by reading one field (`adapter.surfaces["block"]`) on
one record.

### One merge path per settings file

The `securityHooks`/OQ-3 history (Current state, above) exists because two
independently-written merge functions targeted the same file. The unified
registry makes this structurally impossible for future surfaces by keying
merges on **the settings file itself**, not on the subsystem writing to it:

```ts
// planned — src/harness-adapters/settings-file.ts

/** Every surface adapter that targets one physical file, keyed by that file. */
export interface SettingsFileOwner {
  readonly path: string;
  /** Every registered surface writing here, each under its own event/group key. */
  readonly surfaces: readonly SurfaceAdapter[];
  /** Applies every surface's merge in a fixed, deterministic order, then
   *  re-validates the WHOLE file against every registered surface — so a
   *  later surface's merge cannot silently invalidate an earlier one without
   *  the install failing loudly instead of reporting a partial success. */
  installAll(existing: Record<string, unknown>): { settings: Record<string, unknown>; errors: string[] };
}
```

Concretely: `.cursor/hooks.json` becomes **one** `SettingsFileOwner` record
listing the `block` surface (today's ctx guard), the `inject-context` surface
(today's orient injector), and the `prompt-gate`/`block` surfaces (today's
security check-input/check-output; see W6 built-in hooks) as sibling `SurfaceAdapter`s under the
same owner — instead of three separate modules each independently reading and
rewriting the same file with their own idea of what `hooks` means. A single
walker (the flat-vs-nested group-shape logic already proven out in
`src/ctx/runtimes.ts`'s `managedGroupsFor`) is shared by every surface that
targets that file, closing the class of bug the coexistence test exists to
guard, by construction rather than by a growing pile of ordering tests.

### New adapters

**Gemini CLI** — `to verify` (unverified — requires first-party docs check
before implementation): `hooks/hooks.json` inside a Gemini extension directory
(not the top-level `.gemini/` config) is reported to run hooks synchronously
and to be enabled by default since v0.26.0+, per Gemini CLI public hooks
documentation (to verify). Registered as a `host-hook` adapter,
`confidence: "experimental"` until a first-party fetch confirms the exact JSON
shape and event names; `instructions` surface (`GEMINI.md`) ships at
`confidence: "experimental"` alongside it — see W5-AC5 — pending a recorded
first-party verification of the `GEMINI.md` read path itself, since Keryx's
existing AGENTS.md/CLAUDE.md generation machinery
(`src/rules/agent-entrypoints.ts:116-125`) writes only those two files today.

**Kiro** — `to verify` (unverified — requires first-party docs check before
implementation): `.kiro/hooks/*.json` declarative event-driven automations
(file save/create/delete, pre/post tool-use, pre/post spec-task) are reported,
with the caveat that file hooks "fire only on agent-made edits, not manual
editor saves." `host-hook` adapter, `confidence: "experimental"`;
`instructions` surface via `.kiro/steering/*.md` files, also
`confidence: "experimental"` pending first-party verification (see W5-AC5).

**GitHub Copilot agent** — `to verify` (unverified — requires first-party docs
check before implementation): a `preToolUse` hook for Copilot CLI receiving
JSON tool-call context with approve/deny authority is reported, plus
`AGENTS.md` and GitHub-native `.github/copilot-instructions.md`/
`.github/instructions/**.instructions.md`. `host-hook` adapter for `block`,
`confidence: "experimental"`; `instructions` surface also
`confidence: "experimental"` pending first-party verification (see W5-AC5),
even though `AGENTS.md` is Keryx's existing generation target
(`src/rules/agent-entrypoints.ts:116-125`) — the open question is whether
Copilot itself reads that file, not whether Keryx can write it.

**Zed via ACP** — the policy-travels-with-agent model. Zed has no scriptable
pre-exec hook (`UNSUPPORTED_RUNTIMES.zed`, `src/ctx/runtimes.ts` line 623,
citing the upstream tracking issue cited in `src/ctx/runtimes.ts:623`), so a
`host-hook` adapter is not possible for Zed and should not be represented as
an "unsupported, needs future work" row the way Gemini/Kiro are. Instead the
Zed adapter is registered with
`adapterKind: "policy-travels-with-agent"`: when Keryx runs as the ACP agent
inside Zed, `src/acp/permission.ts`'s existing deny-by-default mapping
(`approvalFromPermissionResponse`) already implements the `block` surface's
safety property — every non-allow ACP outcome is a denial — without writing
into any Zed-owned settings file at all. Concretely, the Zed adapter's `block`
`SurfaceAdapter` has no `settingsFile`/`merge`/`strip` (there is nothing to
install into a host file) and instead documents that the surface is satisfied
by Keryx's own runtime behavior when acting as the ACP agent. This is
`confidence: "verified"` for `block` (the mapping is code-proven and pinned by
`permission.test.ts`, per `src/acp/permission.ts`'s own header) and
`instruction-only` for everything that requires Zed itself to read a Keryx
artifact (Zed's own `AGENTS.md` support), since that path does not go through
ACP at all.

**opencode / antigravity — kept experimental.** Both already carry
`confidence: "experimental"` in `src/ctx/runtimes.ts` and are explicitly
excluded from `src/ctx/orient-runtimes.ts`'s context-injection surface
(`UNSUPPORTED_ORIENT`, citing undocumented/buggy propagation for opencode and
"unverified, no first-party docs" for antigravity's context-injection hook).
The unified registry keeps both at `experimental` confidence and does not
promote either to `verified` as part of W5 — doing so would require a
first-party verification pass that is still missing for these harnesses, and
this workstream is scoped to the registry unification and the *new* adapters,
not to closing pre-existing verification gaps on unrelated harnesses.

### Target matrix (harness × surface, planned state)

`V` = verified, `E` = experimental, `I` = instruction-only, `U` = unsupported,
`—` = not applicable (adapter kind makes the surface meaningless for this
harness). Cells marked `to verify` are genuinely unknown pending a first-party
docs fetch — they are **not** a promise of what ships, only the
currently-planned target confidence.

Canonical harness ids used everywhere in this document, in the target matrix,
and in the `harnessId` enums of `install-manifest.schema.json` and
`portable-bundle.schema.json`: `claude`, `codex`, `cursor`, `windsurf`,
`gemini-cli`, `kiro`, `github-copilot-agent`, `zed`, `antigravity`,
`opencode`, `generic-mcp`, `keryx-shell`.

| Harness | block | prompt-gate | pre-tool-context | inject-context | observe | post-tool | session-start | stop | skills | agents | instructions | mcp | rules |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | V | V (cited) | E (to verify) | V | E (to verify) | E (to verify) | E (to verify) | E (to verify) | V | V | E (to verify) | E (to verify) | V |
| codex | V | E (to verify) | E (to verify) | V | I | I | I (to verify) | U | I (to verify) | I (to verify) | E (to verify) | E (to verify) | V |
| cursor | V (OQ-3 for security-check-output) | E (OQ-3) | E (to verify) | V | E (to verify) | E (to verify) | E (to verify) | I (to verify) | I (to verify) | I (to verify) | E (to verify) | E (to verify) | E (to verify) |
| windsurf | V (OQ-3 for security-check-output) | E (OQ-3) | E (to verify) | U | E (to verify) | E (to verify) | U | U | I (to verify) | I (to verify) | E (to verify) | E (to verify) | E (to verify) |
| gemini-cli | E (to verify) | E (to verify) | E (to verify) | I (to verify) | E (to verify) | E (to verify) | E (to verify) | E (to verify) | I (to verify) | I (to verify) | E (to verify) | I (to verify) | E (to verify) |
| kiro | E (to verify) | E (to verify) | E (to verify) | I (to verify) | E (to verify) | E (to verify) | I (to verify) | I (to verify) | I (to verify) | I (to verify) | E (to verify, steering) | I (to verify) | E (to verify, steering) |
| github-copilot-agent | E (to verify) | E (to verify) | E (to verify) | I (to verify) | I (to verify) | I (to verify) | I (to verify) | I (to verify) | I (to verify) | I (to verify) | E (to verify) | E (to verify) | E (to verify) |
| zed (ACP) | V (policy-travels-with-agent) | U | — | U | — | — | — | — | I (to verify) | — | E (to verify, AGENTS.md not via ACP) | I (to verify) | — |
| antigravity | E | E (to verify) | E (to verify) | U (unverified propagation) | E | E | E (to verify) | U | I (to verify) | I (to verify) | I (to verify) | I (to verify) | — |
| opencode | E | E (to verify) | E (to verify) | U (undocumented/buggy) | E | E | I (to verify) | I (to verify) | I (to verify) | I (to verify) | E (to verify) | E (to verify) | — |
| generic-mcp | U | U | U | U | U | U | U | U | U | U | U | E (to verify) | — |
| keryx-shell | E (to verify, W6) | E (to verify, W6) | E (to verify, W6) | E (to verify, W6) | E (to verify, W6) | E (to verify, W6) | E (to verify, W6) | E (to verify, W6) | I (to verify) | I (to verify) | I (to verify) | E (to verify, W6) | — |

Rows for `claude`, `codex`, `cursor`, `windsurf`, `antigravity`, `opencode`
`block`/`inject-context` cells reproduce exactly the confidence already
recorded in `CTX_RUNTIMES`/`ORIENT_RUNTIMES`/`UNSUPPORTED_ORIENT` — W5 does
not upgrade or downgrade any confidence level that already exists in code
without new evidence. Cursor's and Windsurf's `block` cells carry an
annotation, not a downgrade: the `block` flag itself is `V` because the ctx
guard (`CTX_RUNTIMES`, `hooks` key, `Bash` matcher) is verified for both, but
the *same flag* is also where `security-check-output` (a `PreToolUse`
`Write|Edit` gate; see W6 built-in hooks) lands, and that hook is written under the
Keryx-invented `securityHooks` key (Current state → the `securityHooks`/OQ-3
clobbering history), whose own source comment
(`src/security/agent-hooks/runtimes.ts:195-200`) states the key "matches no
documented contract" for Cursor or Windsurf — hence the "OQ-3 for
security-check-output" note on those two `block` cells. `security-check-input`
(`UserPromptSubmit`; see W6 built-in hooks) is the new `prompt-gate` flag, not `inject-context`
(which carries no decision authority): Cursor's and Windsurf's `prompt-gate`
cells are `E (OQ-3)` for the identical reason — the same unverified
`securityHooks` key backs both. Claude's `prompt-gate` cell is `V (cited)`:
`claudeMerge` (`src/security/agent-hooks/runtimes.ts:92-113`) writes a
`UserPromptSubmit` hook entry running `checkInputCommand("claude")`, a
code-proven, gate-authority entry point, distinct from the unverified
`securityHooks` path Cursor/Windsurf use. OQ-3 (Open questions) is not
resolved by W5.
The `rules` column (flow 313, W4 portability's `rules-export` surface —
distinct from the pre-existing `instructions` column, which is a different,
opt-out-by-default block) is sourced directly from
`docs/integrations/harness-capability-matrix.json`'s own `rules` surface
entries, not asserted here: `V` for `claude`/`codex`, whose matrix rows carry
`confidence: "verified"` and a `native` `rules` surface
(`CLAUDE.md`/`AGENTS.md`); `E (to verify)` for `cursor`, `windsurf`,
`gemini-cli`, `kiro`, and `github-copilot-agent`, whose matrix rows carry
`confidence: "experimental"` and an `adapter`-state `rules` surface; `—` for
`zed`, `antigravity`, `opencode`, `generic-mcp`, and `keryx-shell`, none of
which has a `rules` entry in the matrix at all (no rules-export adapter is
implemented for them). See `docs/docs/guides/portability.md`'s own
"Rules export to harness instruction files" confidence table for the
identical claim in guide form.
`skills`/`agents` columns are `to verify` for every harness except Claude
because no code in this repository currently exports either surface to a
non-Claude harness (`src/gdskills/catalog.ts:517`: the
`skill-runtime-exporter` skill is described as exporting "canonical skills to
runtime-compatible Codex or Claude artifacts" only; W2's exporter list is the
actual source of truth for that column once W2 lands). The `pre-tool-context`
column (Design → TypeScript interface sketch) is `E (to verify)` for every
harness, including claude/codex/cursor/windsurf: carrying `additionalContext`
on a PreToolUse-style call is asserted by analogy to the existing `block`
surface, but no code path or first-party doc in this repository confirms any
harness actually honors an injected `additionalContext` value on that call —
`block`'s own verification (the guard denies/allows) does not establish that
the same call also carries usable context; `—` where the adapter kind has no
PreToolUse call to carry it on (Zed's ACP block surface). A cell may be
promoted back to `V` only alongside a citation added to this table's
supporting text (as done above for claude `prompt-gate`). Every other
`observe`/`post-tool`/`session-start`/`stop`/`instructions`/`mcp` cell without
a code path or first-party doc citation backing that specific harness
(including Claude's own `observe`/`post-tool`/`instructions`/`mcp` cells,
which this workstream's in-repo evidence does not independently confirm
beyond the `block`/`prompt-gate`/`inject-context`/`skills`/`agents` cells
already sourced above) is `E (to verify)`: an honest matrix reports what is
proven, not what is plausible. The `generic-mcp` and `keryx-shell` rows are
placeholders: `generic-mcp` is any harness reachable only as a Keryx MCP
client, with no host-hook surface at all; `keryx-shell` is W6's own
`keryx shell` lifecycle-hook runtime (Non-goals) and every cell above is a
target for that workstream, not something W5 implements.

### Generated capability matrix

The matrix above is a design target; the artifact W5 actually ships is
**generated from the registry**, not maintained by hand, so it cannot drift
the way the current situation — three registries nobody reconciles — already
has. The four states used are: `native` (a
`host-hook`/direct adapter, `confidence: "verified"`, surface actively
installs and validates), `adapter` (works through a thin bridge — e.g.
OpenCode's generated JS plugin, or any `experimental` host-hook adapter),
`instruction-only` (no runtime enforcement; a file gets written and read but
nothing decides anything), `unsupported` (no known mechanism; registered only
so the CLI gives a precise message, mirroring today's `UNSUPPORTED_RUNTIMES`
pattern).

Required record fields per matrix entry (schema:
`harness-capability-matrix.schema.json`):

- `id` — harness id, matches `HarnessAdapter.id`.
- `state` — `native | adapter | instruction-only | unsupported`.
- `surfaces_supported` — array of `SurfaceFlag` values this harness has in
  `state` or better.
- `surfaces_unsupported` — array of `SurfaceFlag` values explicitly not
  available, each with a one-line reason (mirrors `UNSUPPORTED_ORIENT`'s
  per-harness reason strings today).
- `install_command` — the `keryx integrations install --runtime <id>` invocation.
- `verification_command` — the `keryx integrations doctor --runtime <id>`
  invocation that proves the install is live.
- `risk_notes` — free text; must be non-empty when `confidence: "experimental"`.
- `last_verified` — ISO date the `sourceDocs` were last actually read.
- `source_docs` — array of citation strings (public standard/doc URLs or
  in-repo file paths); empty is a validation failure for any `native` entry.

**CI check**: a guard test (`harness-capability-matrix.test.ts`, planned)
regenerates the matrix from `HARNESS_ADAPTERS` and diffs it against the
checked-in JSON artifact; a mismatch fails the build. `keryx integrations
matrix --check` runs the same regeneration in CI without writing the file,
exiting non-zero on drift — the same "generated, not hand-maintained"
discipline `keryx skills stocktake` (W1) and `keryx agents verify` (W2) use
for their own artifacts.

### CLI: `keryx integrations install|doctor|uninstall|matrix`

`keryx harness` already exists (`src/commands/harness.ts`) as
`keryx harness run|exec|extension|wave` — Keryx's own agent-runtime command
family, unrelated to host-integration install/doctor/uninstall/matrix. W5
therefore places the host-integration commands under a distinct namespace,
`keryx integrations`, rather than colliding with that existing command tree
(see W5-AC3a).

```
keryx integrations install --runtime <id> [--surface <flag>...] [--dry-run] [--json]
keryx integrations doctor  --runtime <id> [--json]
keryx integrations uninstall --runtime <id> [--surface <flag>...]
keryx integrations matrix [--check] [--json]
```

- `install` resolves every registered surface for `<id>` (or the subset named
  by repeated `--surface`), applies each `SettingsFileOwner.installAll` in
  deterministic order, and reports per-surface success/failure — this is the
  single command that replaces running `keryx ctx install-hook`, `keryx
  security hooks install`, and `keryx orient install-hook` separately, and it
  is the only path that can guarantee the one-merge-path-per-file property,
  because it is the only caller that knows about every surface targeting a
  given file at once. `keryx ctx hook <runtime>` is not part of this
  consolidation — see Migration from existing commands, below.
- `doctor` re-validates every surface already recorded in install-state
  against the live settings file and reports drift (a surface installed by an
  older Keryx version whose matcher went stale — the exact case
  `src/ctx/runtimes.ts`'s `describeExistingGuard`/`hasStalePreToolUseMatcher`
  already detect for the ctx guard alone; `doctor` generalizes that check to
  every surface).
- `uninstall` removes only the sentinel-tagged entries for the named
  runtime/surfaces, leaving every other surface's entries (Keryx's own or the
  operator's) untouched — the coexistence guarantee already proven for the
  ctx/security pair, generalized to N surfaces per file.
- `matrix [--check]` prints/validates the generated capability matrix
  described above.

### Install-state

`keryx integrations install` records, per project, which `(runtime, surface)`
pairs are installed, when, and against which Keryx version — reusing the
install-state shape already specified by W1's install-manifest schema rather
than inventing a second one. `doctor` reads this state to know what *should*
be present before comparing against what *is* present, so a drift report can
say "surface X was installed by Keryx 0.3.1 and is now missing" instead of
just "surface X is missing."

### Migration from existing commands

`keryx ctx install-hook`/`uninstall-hook`, `keryx orient install-hook`, and
`keryx security hooks install|uninstall` are **kept as aliases** that
internally delegate to `keryx integrations install`/`uninstall --runtime <id>
--surface <flag>` with the flag(s) implied by which alias was called
(`ctx install-hook`/`uninstall-hook` → `--surface block`; `orient
install-hook` → `--surface inject-context`; `security hooks install` →
`--surface prompt-gate --surface block`, since `keryx.security-check-input`
and `keryx.security-check-output` both stay gate-class decisions — the
`UserPromptSubmit` check-input hook is the new `prompt-gate` surface, which
carries block/deny authority (distinct from the non-authoritative
`inject-context` surface the orient injector uses on the same event type),
and check-output stays a `PreToolUse` `Write|Edit` `block` surface — neither
is the non-authoritative `observe`/`post-tool` surfaces). This is required by
W5 Goals (non-breakage) and mirrors how `src/commands/update.ts` already
treats `AGENTS.md`/`CLAUDE.md` migration as additive, not destructive. No
existing script or CI job that calls the old commands needs to change.

`keryx ctx hook <runtime>` is **not** an alias and is not touched by this
consolidation: it is the runtime guard handler itself (`src/commands/ctx.ts`
calls `runCtxHook`; host settings files such as `.claude/settings.json`
invoke it directly from their own `PreToolUse` hook entry). Aliasing it to an
installer would break every already-installed guard, which is why only the
installer commands above (`install-hook`/`uninstall-hook` and their `orient`/
`security` counterparts) become `keryx integrations` aliases.

## Data contracts

- `harness-capability-matrix.schema.json` (this workstream owns it) — see
  Design → Generated capability matrix for the field list.
- `HarnessAdapter`/`SurfaceAdapter` (TypeScript interfaces, Design section) —
  not a JSON Schema artifact; these are the in-process registry shape other
  workstreams' code imports.
- Install-state records reuse W1's `install-manifest.schema.json` shape
  (W1 owns that schema); W5 adds `surface` as an additional discriminator
  field within an entry. W1's schema is planned to grow an optional `surface`
  field on `installedModuleRecord` to accept it, as an open extension point,
  rather than W5 forking a parallel install-state format.

## Integration

- **W3 (self-learning observers)** — the Observe stage uses the `observe`,
  `post-tool`, `session-start` and `stop` surfaces plus observe-only
  registrations on the PreToolUse and prompt-entry points, per W3's
  hook-to-observation mapping. W3's `.metaproject/data/learning/observations/`
  writer is a consumer of `SurfaceAdapter` output, not a fourth registry; W3
  must not grow its own per-harness list.
- **W4 (instruction export)** — the `instructions` surface flag and its
  per-harness confidence column are the capability facts W4's
  AGENTS.md/CLAUDE.md/GEMINI.md/Kiro-steering export needs before it decides
  whether a given harness gets a generated file or is skipped with a stated
  reason.
- **W6 (keryx shell lifecycle hooks)** — W6's built-in hooks (ctx routing
  guard, security check-input/output, learning observer, impact-evidence
  injector) register against the *same* `SurfaceFlag` vocabulary this
  document defines, so a hook authored once for `keryx shell` and a hook
  installed once into a host harness are describing the same contract, not
  two contracts that happen to look similar.
- **W8 (harness-config security audit)** — `keryx security audit-harness`
  needs to know every file Keryx might have written into, across every
  surface, to audit it; the unified `SettingsFileOwner` list (one entry per
  physical file, listing every surface that targets it) is exactly the
  enumeration W8's scanner walks, replacing "ask three registries and hope
  the union is complete."

## Risks

- **Verification debt on new adapters.** Gemini CLI, Kiro, and GitHub Copilot
  agent adapters are being added at `experimental` confidence without a
  first-party docs fetch in this workstream (their hooks contracts remain
  unverified — requires first-party docs check before implementation).
  Shipping an adapter before verification repeats the exact failure mode
  `OQ-3` already
  represents — an install that validates clean against Keryx's own schema
  while the target harness silently ignores it. Mitigation: every
  `experimental` adapter's matrix entry requires non-empty `risk_notes` and
  the CLI prints a warning at install time (mirroring the existing
  `antigravity`/`opencode` behavior).
- **Migration regressions.** Consolidating three merge/strip/validate
  implementations into one risks reintroducing the exact class of bug
  `agent-hooks.coexistence.test.ts` was written to catch, if the unification
  is done by re-deriving the walkers instead of reusing the ones already
  proven correct (`managedGroupsFor`, `hasRunnableGuard` in
  `src/ctx/runtimes.ts`). Mitigation: the coexistence test suite becomes a
  permanent fixture of the unified registry's own test file, driven against
  every `SettingsFileOwner`, not retired once the three old registries are
  removed.
- **Alias drift.** If the old installer command names (`keryx ctx
  install-hook`, etc.) are kept as thin wrappers but not exercised by the same
  test suite as the new `keryx integrations` commands, they can silently stop
  matching the new behavior. Mitigation: alias commands are tested by
  literally invoking the new command internally (no parallel implementation to
  drift). `keryx ctx hook <runtime>` itself is unaffected — it is not an
  alias and needs no such coverage from this workstream.
- **Matrix becomes aspirational.** A generated-but-never-checked matrix is
  worse than no matrix, because it reads as authoritative. Mitigation: the
  CI check (`keryx integrations matrix --check`) is a required gate, not an
  optional lint, from the first PR that introduces the registry.
- **Namespace collision.** `keryx harness` already names Keryx's own
  agent-runtime command family (`run|exec|extension|wave`,
  `src/commands/harness.ts`). Placing host-integration commands under
  `keryx integrations` instead avoids the collision outright; the residual
  risk is a future contributor reintroducing host-integration subcommands
  under `keryx harness` by habit. Mitigation: W5-AC3a pins
  `keryx harness run|exec|extension|wave`'s existing behavior and help text
  as unchanged, so a regression there is caught the same way any other
  behavior change would be.

## Acceptance criteria

- **W5-AC1** — `src/ctx/runtimes.ts`'s `CTX_RUNTIMES`, `src/ctx/orient-runtimes.ts`'s
  `ORIENT_RUNTIMES`, and `src/security/agent-hooks/runtimes.ts`'s
  `RUNTIME_HOOKS` are each re-expressed as `SurfaceAdapter` registrations
  against the unified `HarnessAdapter` registry, with zero loss of existing
  `confidence`/behavior for any currently-registered runtime, proven by
  porting `agent-hooks.coexistence.test.ts` to run against the new registry
  and pass unchanged in intent.
- **W5-AC2** — every settings file targeted by two or more surfaces (at
  minimum: `.claude/settings.json`, `.cursor/hooks.json`,
  `.windsurf/hooks.json`) is owned by exactly one `SettingsFileOwner`, and a
  new coexistence test proves that installing all of that file's surfaces in
  every permutation order leaves every surface valid.
- **W5-AC3** — `keryx integrations install|doctor|uninstall --runtime <id>`
  exist, cover every surface a registered adapter declares, and `keryx ctx
  install-hook`/`uninstall-hook`, `keryx security hooks install|uninstall`,
  `keryx orient install-hook` continue to work unchanged as aliases (verified
  by existing tests for those commands passing without modification).
  `keryx ctx hook <runtime>` remains the unchanged runtime handler invoked by
  host settings files — it is not one of the aliased installer commands and
  W5 does not change its behavior, signature, or invocation sites.
- **W5-AC3a** — `keryx harness run|exec|extension|wave` (Keryx's own
  agent-runtime command family, `src/commands/harness.ts`) and its existing
  help text are unchanged by this workstream; the new host-integration
  commands live entirely under the separate `keryx integrations` namespace.
- **W5-AC4** — `keryx integrations matrix [--check]` generates
  `harness-capability-matrix.schema.json`-conformant output directly from the
  registry, and a CI guard test fails if the checked-in matrix artifact drifts
  from what the registry currently produces.
- **W5-AC5** — Gemini CLI, Kiro, and GitHub Copilot agent each have a
  registered `HarnessAdapter` with an `instructions` surface at `experimental`
  confidence with non-empty `source_docs` and `risk_notes`, and a `block`
  surface at `experimental` confidence with non-empty `risk_notes` and
  `source_docs`. Promotion of either surface to `verified` confidence happens
  only after a recorded first-party verification (Open questions has none of
  this pre-decided).
- **W5-AC6** — Zed is registered with `adapterKind: "policy-travels-with-agent"`
  and its `block` surface's `verified` confidence is backed by a citation to
  `src/acp/permission.ts` and its pinning test, not to a host-side hook file
  that does not exist.
- **W5-AC7** — opencode and antigravity remain at `confidence: "experimental"`
  in the unified registry with the same per-surface unsupported reasons
  currently recorded in `UNSUPPORTED_ORIENT`, i.e. this workstream does not
  silently upgrade either harness's confidence as a side effect of the
  refactor.
- **W5-AC8** — `harness-capability-matrix.schema.json` parses under JSON
  Schema draft 2020-12 (verified via `keryx ctx run -- bun -e
  "JSON.parse(require('fs').readFileSync('<path>','utf8'))"`) and rejects a
  matrix entry missing any required field.

## Open questions

- **OQ-3 (carried forward, not resolved by W5)** — does Cursor or Windsurf
  actually read a `securityHooks`-shaped top-level key, or any equivalent
  Keryx could target instead? W5 unifies the *code path* that writes this key
  but does not itself verify the runtime honors it; W8's audit or a dedicated
  verification pass must close this before `securityHooks`-backed surfaces
  are promoted past `experimental`.
- Should `skills`/`agents` surface confidence for non-Claude harnesses be
  owned by W5's registry directly, or sourced entirely from W2's exporter
  list (this document currently defers to W2 as the source of truth for those
  two columns) — needs a decision before the matrix's `skills`/`agents`
  columns can move past `to verify` for any harness other than Claude.
- What is the deterministic ordering rule when two surfaces on the same
  `SettingsFileOwner` would otherwise both want to occupy the same
  event/group key (e.g. two `block`-flag surfaces on the same file, which
  does not exist today but could once W6's built-ins register alongside a
  host-installed guard)? Not yet specified; W6 should not assume an ordering
  W5 has not defined.
- Should `keryx integrations doctor` also detect a harness's *own* version (e.g.
  parsing `.gemini/` for a version marker) to warn when an `experimental`
  adapter's contract was verified against a since-superseded release? Left
  out of scope for W5-AC criteria; flagged as a possible W5 follow-up once the
  registry ships.
