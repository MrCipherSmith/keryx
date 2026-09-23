# W8 — Harness-config security audit & impact-evidence gate
Version: 0.1.3

## Summary

W8 adds two `planned` capabilities that share one theme: replace attestation with deterministic
evidence.

**Part A** is `keryx security audit-harness`, a read-only sweep over every file Keryx-aware harnesses
read as configuration or instruction — entrypoint prose, permission settings, MCP server configs, hook
scripts, W2 agent definitions, skill scripts, and W4 imported bundles — scored against a fixed check
catalog and reported with severity, a 0-100 score, and a letter grade. It proposes fixes; it never
writes one.

**Part B** is the impact-evidence gate: on the first edit of a file in a session, inject the answer to
"what does this touch" — importers, related tests, memory caveats — computed by existing, already-shipped
commands (`keryx gdgraph affected`, `keryx test related`), rather than trusting the agent to state it
correctly. Keryx computes the evidence instead of trusting an agent's assertion: the graph and
test-mapping commands already exist to make the evidence computed, not self-attested, so this design
uses them.

Both parts are `planned`. Nothing described here exists in `src/security/`, `src/commands/security.ts`,
or anywhere in `src/harness/` today; every code path this document cites is cited to justify what the new
work extends, not to claim the new work is done.

## Current state

Keryx already has a real, tested security subsystem. This workstream is additive to it, not a rewrite.

**`keryx security` command** (`src/commands/security.ts`) has eleven subcommands today: `status`,
`scan`, `scan-mcp`, `check-input`, `check-output`, `redact`, `report`, `policy`, `incidents`, `hooks`,
`eval`. None of them is a harness-configuration audit. `scan <path>` (lines 194–251) runs the shared
detector pipeline over arbitrary file/directory content with a trust `--source` and emits a
`SecurityDecision`; it treats every scanned path uniformly and has no notion of "this file is
`.claude/settings.json`" versus "this file is prose." `scan-mcp` (lines 381–536) is the one subcommand
that already targets a named harness-config surface: it walks MCP manifest JSON and returns leak-safe
`DetectorMatch[]` for three threat classes.

**Detectors** live under `src/security/detect/`: `injection.ts`, `injection/` (sub-detectors), `exfil.ts`,
`secrets.ts`, `pii.ts` + `pii/`, `egress.ts`, `entropy.ts`, and `mcp.ts`. `mcp.ts`
(`src/security/detect/mcp.ts`) is directly reusable for the MCP-config check in Part A: it already
detects tool-poisoning (`POISONING_PATTERNS`, lines 52–88, covering ignore-instructions, imperative
directives, exfil verbs, reveal-secrets, embedded credentials via `sk-`/`ghp_`/`AKIA`/`xox`/`Bearer`
patterns, and HTML/`<important>` comment payloads), line-jumping (`LINE_JUMPING_PATTERNS`, lines 93–112:
cross-tool redirection, priority-override, context-override phrasing), invisible/steganographic Unicode
(`INVISIBLE_UNICODE`, lines 117–121), tool-name shadowing (duplicate names within one manifest, lines
255–269), and rug-pull drift against a pinned sha256 baseline (`hashToolDefinition`/`buildMcpBaseline`,
lines 38–45, 293–300). Findings are leak-safe by construction — the `value` field carries a category
token (`tool:<name>`), never manifest content (comment, lines 12–15). `scan-mcp` does not yet check for
one thing W8 Design part A calls out below (`unpinned-mcp-launcher`): an **unpinned** `npx`/`uvx`-launched
MCP server command in `.mcp.json` itself (as opposed to drift in an already-pinned tool definition) —
that is net-new detection logic for Part A, not a reuse.

**Config integrity**: `src/security/config.ts` computes and verifies a config checksum
(`verifyConfigChecksum`, referenced at `security.ts:174`, `:722`; canonical JSON stringify at
`config.ts:270`) so out-of-band edits to `.metaproject/security.config.json` are detected, and
`src/security/self-protect.ts` treats a checksum mismatch as a `high`-severity finding plus a recorded
incident (`self-protect.ts:14, 28, 78-79`; `security.test.ts:145-159`). `keryx security policy validate`
(`security.ts:713-743`) surfaces both schema errors and checksum mismatches with a non-zero exit. This is
the pattern Part A's baseline/suppression file reuses for its own tamper detection (see Design A).

**Hook installers** are three separate registries, not one: `src/ctx/runtimes.ts` (the gdctx routing
guard, 6 runtime ids at varying confidence), `src/ctx/orient-runtimes.ts` (context injection at
session/prompt start, 3 runtime ids), and `src/security/agent-hooks.ts` + `src/security/agent-hooks/runtimes.ts`
(the check-input/check-output installer, 4 runtime ids; `checkInputCommand`/`checkOutputCommand` at
`runtimes.ts:37-41`). These registries already collided once: the check-input/output installer and the
ctx guard installer used to write incompatible JSON shapes into the same `hooks` key in
`.cursor/hooks.json`/`.windsurf/hooks.json`, each installer's strip helper silently destroying the
other's entries, fixed by inventing an unverified `securityHooks` key (open question OQ-3,
`src/security/agent-hooks/runtimes.ts:169-201`). Part B's impact-evidence
gate is a **fourth** hook-writing concern and must not repeat that failure — see Risks.

**Destructive-command classification already exists**, in `src/lib/command-risk.ts`, not in
`hook-classify.ts` (that file is the gdctx *routing* classifier only — "should this shell command go
through `keryx ctx`", lines 1-12). `classifyCommand(command): "shell" | "destructive"`
(`command-risk.ts:224-243`) has named, independently-testable rules — privilege escalation, `rm` of a
catastrophic target (`CATASTROPHIC_TARGETS`, lines 56-76), `dd` onto a block device, recursive
chmod/chown of a system root, host power state, `mkfs`, container-escape flags, protected-branch force
push, `curl|sh`-shaped remote-script execution. Its own header states its limit: "NOT a security
boundary" (lines 10-16) — a nudge that decides how loudly to ask; the real boundaries are the human
approval gate, the shell-permission metacharacter restriction, and OS containment. The module also
exports `isPublishCommand` and the `touchesAgentCredentials`/`touchesSacConfirmReview`/
`touchesFlowConfirm`/`touchesSchedulerControl` family, consumed today by the interactive-agent approval
gate (`src/commands/agent.ts:70`) and the ACP permission mapper (`src/harness/external/
acp-permission.ts:22,69,104-105`). Part B's destructive shell gate reuses `isDestructiveCommand` rather
than inventing a second classifier.

**Deterministic evidence commands already exist and are exactly what Part B needs**: `keryx gdgraph
affected <file>` (`src/commands/gdgraph.ts`, `runAffected`, lines 693+; delegates to
`computeAffected(graph, target, { depth, ranked })` from `src/gdgraph/affected.ts`, with symbol-aware
resolution — an unresolved symbol name is looked up against `graph.symbols` and rewritten to its owning
file, lines 709-720) and `keryx test related <file>` (`src/commands/test.ts`, `runRelated`, lines 363+;
delegates to `relatedTestsInContext(cwd, context, target)` from `src/testing/service.ts`, already used
today by `test suggest`, lines 78-79). Both are read-only, both already return a `status`/completeness
flag when the underlying walk was partial (`context.status === "incomplete"`, `test.ts:118-121`) rather
than silently reporting a truncated result as exhaustive — the same fail-closed-on-partial-evidence
posture Part B's gate needs to inherit rather than reinvent.

**Memory** (`src/memory/types.ts`) already has a `caveat` field on its claim/entry shape (lines 111, 281:
"deferral/qualification attached to the claim") — Part B's "memory caveats for the file" evidence slot is
a query over existing memory entries scoped to the target path, not a new memory feature.

**No hook runtime exists in `keryx shell` today** to run Part B's gate in — confirmed: 0 lifecycle-event
names in `src/harness` (see W6 Current state). Part
B's keryx-shell execution path is therefore entirely
dependent on W6 landing its hook runtime first; in host harnesses it depends on W5's adapter registry. See
Integration.

## Goals & non-goals

**Goals**

1. Give an operator one command that answers "is my harness configuration safe to hand to an agent" for
   every surface Keryx-aware harnesses read, with a reproducible score and actionable fix proposals.
2. Make the impact evidence an agent sees before its first edit of a file **computed**, not
   **self-attested** — reusing `gdgraph affected` and `test related` rather than asking the model to
   assert importers/tests and trusting the assertion.
3. Keep both features inside Keryx's existing conventions: deterministic core, fail closed with named
   reasons, proposals-never-write, human consent before anything persists, `_keryxManaged` sentinels.
4. Make CI adoption mechanical: one exit code contract, one JSON shape, a baseline file for accepted risk
   with mandatory justification text (never a silent suppression).

**Non-goals**

- Not a general-purpose static analyzer or dependency-vulnerability scanner (that space is
  `keryx security scan`/`eval` and out of scope here).
- Not a new detector engine. Part A composes existing `src/security/detect/*` detectors plus a small set
  of net-new, surface-specific checks (unpinned MCP launchers, hook-interpolation injection, agent
  definitions with no model tier); it does not replace `check-input`/`check-output`/`scan-mcp`.
- Not an auto-fix tool. Every finding in Part A produces a fix *proposal* record; applying a fix is a
  separate, explicit command reusing the existing proposal/apply pattern from `src/gdskills/learn.ts`
  (W3) — never a side effect of running the audit.
- Not a replacement for the human approval gate, OS sandboxing, or `command-risk.ts`'s classifier. The
  destructive-shell gate in Part B is friction and evidence, not a new enforcement boundary; it is
  explicitly a peer to `command-risk.ts`'s own documented self-limits, not a claim of completeness beyond
  them.
- Not a fourth independent hook-writing installer that ignores the OQ-3 collision history — Part B's
  keryx-shell delivery goes through W6's single hook runtime, and its host delivery goes through W5's
  single adapter registry, specifically so a fifth silent-clobber incident does not happen.

## Design part A — `keryx security audit-harness`

### Command shape

```
keryx security audit-harness [path] [--fix-proposals] [--json] [--ci]
                              [--baseline <file>] [--severity-floor <level>]
```

Adds `audit-harness` and `impact-evidence` (13 subcommands total) to `securityCommand`'s switch
(`src/commands/security.ts:91-129`), next to `scan-mcp`, following the same
`asJson`/`heading`/`renderDecision`-style output split already used by every other subcommand in that
file. `path` defaults to the project root resolved via `resolveProjectRoot` (already imported at
`security.ts:15`).

### Surfaces

| Surface id | What it enumerates | Discovery |
|---|---|---|
| `instructions` | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and any file W4's harness-specific instruction exporters write | Fixed filename list at repo root; project-configurable extra globs |
| `settings` | `.claude/settings*.json`, `.codex/hooks.json`+`config.toml` (settings-relevant keys), `.cursor/settings.json`, `.windsurf/settings.json`, other W5-registered settings paths | Driven by W5's unified adapter registry (`settingsPath()` per adapter — the pattern `security/agent-hooks/runtimes.ts`'s `RuntimeHook.settingsPath` already establishes) |
| `mcp-configs` | `.mcp.json` and any per-harness MCP manifest location (`.claude/settings.json` `mcpServers`, `.cursor/mcp.json`, …) | Same adapter registry, MCP-capable adapters only |
| `hooks` | Every hook command file/script referenced from a discovered `settings`/`hooks.json` entry, plus W6's `.metaproject/hooks.json`/`~/.keryx/hooks.json` once W6 ships | Resolved by following `command`/`argv`/`hooks[].command` fields out of the `settings` surface |
| `agent-definitions` | `.metaproject/agents/*.md` (W2 canonical format) and every harness-exported form (`.claude/agents/*.md`, Codex agents toml, …) | W2's catalog listing |
| `skills` | Script files under `.metaproject/skills/**/scripts/` and installed `.claude/skills/**` | Existing skill install-state (W1) |
| `imported-bundles` | Contents of a W4 portable bundle staged for import (skills, rules, agents, learned patterns, hook configs) | W4's bundle manifest, pre-apply only |

### Checks

| Check id | Applies to | Detector reused / new | Severity |
|---|---|---|---|
| `secret-in-instructions` | `instructions` | `src/security/detect/secrets.ts` (reused) | critical |
| `prompt-injection-in-instructions` | `instructions` | `src/security/detect/injection.ts` (reused) | high |
| `auto-run-directive` | `instructions`, `agent-definitions` | new: phrase table modeled on `mcp.ts`'s `POISONING_PATTERNS` imperative-directive class (§`POISONING_PATTERNS`, lines 60-64), scoped to instruction prose rather than MCP tool text | high |
| `over-permissive-allowlist` | `settings` | new: flags `permissions.allow` entries with unscoped wildcards (`Bash(*)`, no path/arg restriction) | medium |
| `missing-deny-list` | `settings` | new: flags a settings file with an `allow` list and no `deny` entries for the credential/destructive families `command-risk.ts` already names (`CREDENTIAL_MARKERS`, `touchesAgentCredentials`) | medium |
| `bypass-flag-present` | `settings` | new: flags `--dangerously-skip-permissions`-class flags recorded in a settings/launch config | critical |
| `unpinned-mcp-launcher` | `mcp-configs` | new: an `npx`/`uvx`/`bunx` command with no `@version` pin and no lockfile-equivalent reference | high |
| `mcp-tool-poisoning` | `mcp-configs` | `src/security/detect/mcp.ts` `scanMcpManifest` (reused, unchanged) | high–critical |
| `mcp-rug-pull` | `mcp-configs` | `src/security/detect/mcp.ts` baseline drift (reused; requires a prior `scan-mcp --pin`, else reported `not-established`, never silently skipped — mirrors the three-way `absent`/`ok`/`unreadable` distinction in `security.ts:322-337`) | high |
| `hook-command-injection` | `hooks` | new: flags a hook `command` string built by shell-interpolating an untrusted value (`${...}` / `$(...)` around a tool-input-derived variable) rather than passed as an argv element | critical |
| `hook-exfiltration-shape` | `hooks` | new: flags a hook command whose argv contains a network client (`curl`/`wget`/`nc`) fed from stdin/tool-output | high |
| `hook-silent-suppression` | `hooks` | new: flags `2>/dev/null`, `\|\| true`, or an empty `catch` used to make a failing gate hook report success | high |
| `agent-unrestricted-tools` | `agent-definitions` | new: an agent definition with no `tools` allowlist (W2 schema) | medium |
| `agent-missing-model-tier` | `agent-definitions` | new: an agent definition with no declared `model_tier`; W2's schema makes `model_tier` required for a canonical `.metaproject/agents/*.md` file, so this check fires on exported host forms (which may drop the field) and on schema-invalid canonical files, not on a valid canonical definition | low |
| `skill-script-secret` / `skill-script-injection` | `skills` | `secrets.ts` / `injection.ts` (reused) run over script bodies | high |
| `bundle-*` | `imported-bundles` | every check above, run against staged bundle contents before W4's import applies anything | inherits per-check severity |

Every check is independently testable and independently disable-able via the baseline file (below); the
table above is the v1 catalog, not a closed set — new checks are additive rows, not a versioned break, as
long as they slot into an existing surface and severity.

### Severity model, score, and grade

Severities are the four already used across `src/security/types.ts`
(`critical`/`high`/`medium`/`low`) — no new vocabulary. The score is deterministic and reproducible from
the finding list alone:

```
score = max(0, 100 − Σ(weight(severity) × count(severity)))
weight = { critical: 25, high: 10, medium: 4, low: 1 }
grade  = A (90-100) | B (75-89) | C (60-74) | D (40-59) | F (<40)
```

A single `critical` finding caps the grade at `C` regardless of the numeric score, so one leaked key
cannot be averaged away by an otherwise clean report. The weight table and cap are recorded once, in the
schema and in this document, so a re-run against unchanged findings always reproduces the same number —
no model-scored severity, no hidden normalization.

### Fix proposals

A finding with a known remediation shape (e.g. "pin `npx @scope/pkg@1.2.3`", "add `Bash(git log:*)`
narrowed pattern instead of `Bash(*)`", "move interpolated value to argv") carries a `fixProposal` object
in its finding record (see schema) with a unified-diff-shaped `patch` field and a human-readable
`rationale`. `audit-harness --fix-proposals` only **emits** these; nothing in this command writes to disk.
Applying one is `keryx security audit-harness apply --proposal <id>`, which reuses the
propose/store/apply/changelog pattern already shipped for learned patterns (`src/gdskills/learn.ts`, W3) —
same "nothing persists without an explicit apply call" discipline, same changelog record of what changed
and why.

### CI mode

`--ci` sets exit code from the same gate vocabulary the rest of `security.ts` already standardized on
(`isPassGate`, lines 700-711; `exitCodeFor`, lines 971-976): any `critical` or `high` finding, or a
`baseline`/`suppressions` file that itself fails schema/checksum validation, exits 1; `medium`/`low`-only
exits 0 with the score still printed. This mirrors `reportExitCode`'s established mode-vs-gate split
rather than inventing a second exit-code table for this one subcommand.

### Baseline / suppression file

`.metaproject/security-audit-baseline.json`, checksum-guarded the same way
`.metaproject/security.config.json` is (`verifyConfigChecksum`, reused as-is — the baseline is a config
artifact, not a new integrity mechanism). Each suppressed finding requires:

```json
{ "findingId": "...", "justification": "...", "expiresAt": "2026-12-31", "author": "..." }
```

`justification` is required and non-empty (schema-enforced); an entry with no `expiresAt` is flagged at
`low` severity by the audit itself ("indefinite suppression") so baselines cannot silently accumulate
forever. A baseline whose checksum does not match its recorded value is treated exactly like a tampered
`security.config.json` today: reported, not silently trusted, and — under `--ci` — a gate failure in its
own right.

## Design part B — impact-evidence gate

### Mechanism

On the first edit (Write/Edit-class tool call) of a given file path within a session, a `PreToolUse`-class
hook computes and injects, as `additionalContext`, a deterministic evidence block, using each harness's
own `PreToolUse` `additionalContext` shape (marked "to verify" per harness until W5's adapter registry
confirms it — this is distinct from `src/ctx/orient-runtimes.ts`'s session/prompt-start injection
contract, see Runtime paths below):

- **Importers / affected surface** — `keryx gdgraph affected <file> --json` (existing command, reused
  verbatim; when the graph reports the target unindexed rather than zero-edges, the evidence block says so
  explicitly rather than presenting "no importers found" — the AFC-10 distinction the command itself
  already makes, `gdgraph.ts:739-752`).
- **Affected symbols** — same `computeAffected` result, symbol-ranked mode (`--ranked`), when the graph
  carries symbol data (`graph.symbols`); omitted, not fabricated, when it does not.
- **Related tests** — `keryx test related <file> --json` (existing command, reused verbatim), including
  its own incompleteness flag when the testing-context walk was partial.
- **Memory caveats** — entries from `src/memory/` scoped to the target path with a non-null `caveat`
  field (existing field, `src/memory/types.ts:111,281`), read-only.

A subsequent edit of the **same file in the same session** does not re-inject: the gate is a first-touch
briefing, not a running commentary, so it does not compound context cost across a multi-edit session.

### Strict mode

An optional `strict` setting requires the agent's next tool call after injection to include a short
acknowledgement field referencing the injected evidence before the edit is allowed to proceed (an `ask`
outcome, not a silent pass-through) — the deterministic-evidence analogue of "deny and require facts"
behavior, except the facts are pre-computed and the agent only has to show it read them, never author
them from scratch.

### Destructive shell gate

Every shell command classified `destructive` by the already-shipped `isDestructiveCommand`
(`src/lib/command-risk.ts:246-248`) — reused, not reimplemented — is gated every time (not just first
touch) and requires a rollback line (e.g. "this can be undone by: …", validated for non-emptiness, not for
correctness — the module's own documented limit applies here too: this is friction, not a boundary).

### Denial dampening, batch honesty, exemptions

- **Denial dampening**: after N consecutive full denials of the same evidence-gate prompt within a
  session, subsequent prompts collapse to a condensed one-line notice rather than repeating the full
  evidence block, so a determined "just let me work" loop does not balloon context.
- **Batch-sibling honesty**: when a tool call edits multiple files in one call, the evidence block names
  every sibling file explicitly rather than reporting evidence for only the first — a batch is not a way to
  dodge the gate for files 2..n.
- **Exemption globs**: a project-configured glob list (e.g. generated files, lockfiles) skips injection
  entirely; skips are logged, not silent.

### Failure semantics

Mirrors the fail-open/fail-closed split specified by W6's own hook classes: `hook-config.schema.json`
adds a `gate-advisory` class alongside `gate`/`observe`/`context` — profile-aware, fail-open with a
recorded warning in `read-only-review` and `monitored-trusted-local`, fail-closed in
`unattended-untrusted` — and `keryx.impact-evidence` registers as `gate-advisory` by default and as
`gate` in `strict` mode. Concretely: a graph/testing-service error during evidence computation is
**fail-open-with-a-recorded-warning** in advisory profiles (the edit proceeds, the warning is visible,
nothing is silently swallowed) and **fail-closed** in `unattended-untrusted`/CI-gated unattended runs,
consistent with the headless fail-closed rule already implemented in `src/harness/policy/engine.ts`
(`engine.ts:234-241`, an `ask` becomes `deny` when `ctx.interactive === false`).

### Kill switches

A project-level config flag, `.metaproject/security.config.json`'s `impactEvidence.enabled` (the same
checksum-guarded config file `src/security/config.ts` already reads/writes, `configPath()`), and a
per-run `KERYX_DISABLE_IMPACT_GATE` environment override, both logged when used (a disabled gate must be
visible in the audit trail, not merely absent from it).

### Subagent behavior

Follows the same explicit-inheritance rule W6 is designed around (a spawned Keryx subagent inherits its
**parent's** explicit hook set, never a host's ambient hooks — mirroring the `--safe-mode` rationale
already shipped for external `claude -p` children, `src/harness/external/codec/claude-cli.ts:20-24`): a
subagent gets the impact-evidence gate only if its parent's hook set includes it, and its own first-touch
tracking is scoped to its own session, not shared with the parent's.

### Runtime paths

- **In `keryx shell`**: registered as a built-in `PreToolUse`-class hook in W6's hook runtime
  (compiled built-in tier, W6), gated by the `gate-advisory` failure semantics described above (`gate`
  in `strict` mode).
- **In host harnesses**: delivered through W5's unified adapter registry as a `pre-tool-context`
  capability entry — a `PreToolUse` surface that can carry `additionalContext`, distinct from the
  session/prompt-start-only `inject-context` surface — using each harness's own `PreToolUse`
  `additionalContext` shape, marked "to verify" per harness until W5's adapter registry confirms it
  (not the orient session/prompt-start shapes) — this workstream adds the check/evidence logic, not a
  fifth hook-transport registry.

### Cost / latency budget

Both evidence commands are already read-only and already used interactively (`test suggest` calls
`relatedTestsInContext` today); the gate's added cost is bounded to one `gdgraph affected` call plus one
`test related` call plus one bounded memory query per first-touched file per session — not per edit. A
documented budget (e.g. p95 under 2s per first touch) is validated by the same correctness benchmark W7
already tracks for `gdctx`/`gdgraph` correctness (`fixtures/benchmark/keryx/gdctx-fact-preservation.json`,
see W7's Correctness benchmark section).

### CLI surface

```
keryx security audit-harness [path] [--fix-proposals] [--json] [--ci] [--baseline <file>]
keryx security audit-harness apply --proposal <id>
keryx security impact-evidence status          # show gate config, kill-switch state, per-session touch log
keryx security impact-evidence test <file>     # dry-run the evidence block without editing anything
```

## Data contracts

- `schemas/harness-audit-report.schema.json` (this workstream) — the full `audit-harness` output shape:
  surfaces scanned, per-finding records (id, surface, check, severity, confidence, evidence, fix
  proposal), summary (score, grade, counts by severity), coverage status, and baseline/suppression
  application record.
- Impact-evidence injection payload is not schema'd separately in this package; it is a plain-text
  `additionalContext` block whose four sections map directly to the existing JSON shapes already emitted
  by `keryx gdgraph affected --json` and `keryx test related --json` (no new wire format — this workstream
  composes two existing, already-JSON-shaped commands).

## Integration

- **W1** — skill scripts are a Part A surface; the audit reuses W1's install-state to enumerate them.
- **W2** — agent definitions are a Part A surface and source of the `agent-unrestricted-tools`/
  `agent-missing-model-tier` checks; the compiler that turns canonical definitions into per-harness exports
  is a natural place to run these checks pre-export, catching a bad definition before it is ever written
  into a host's `.claude/agents/*.md`.
- **W3** — the fix-proposal apply mechanism reuses W3's proposal/apply/changelog machinery verbatim rather
  than inventing a parallel one; W3's learning-observer hook class is a second consumer of W6's hook
  runtime alongside Part B's gate, so their fail-open/fail-closed rows in the W6 hook-config schema must
  stay distinguishable (`class: "observe"` vs `"gate"`).
- **W4** — imported bundles are audited (Part A, `imported-bundles` surface) before import applies, per
  W4's own stated plan → security-audit → apply sequencing; the rug-pull/tool-poisoning checks are the
  same ones `scan-mcp` already runs, applied to staged bundle content instead of a live `.mcp.json`.
- **W5** — Part A's `settings`/`mcp-configs`/`hooks` surface discovery and Part B's host-harness delivery
  both depend on W5's single unified adapter registry existing; until then, Part A's surface enumeration
  falls back to the fixed per-harness paths already known to the three existing registries
  (`src/ctx/runtimes.ts`, `src/ctx/orient-runtimes.ts`, `src/security/agent-hooks/runtimes.ts`).
- **W6** — Part B's keryx-shell execution path is entirely dependent on W6's hook runtime; Part A has no
  W6 dependency (it is a one-shot CLI scan, not a hook).
- **W7** — the evidence gate's cost/correctness claims depend on `gdgraph affected`/`test related`
  themselves being correct and fresh; a W7 regression in either command is a direct regression in Part B's
  evidence quality, not an independent failure.

## Risks

- **Hook-registry collision, again.** The check-input/output installer and the ctx routing guard already
  clobbered each other once on Cursor/Windsurf (`src/security/agent-hooks/runtimes.ts:169-201`, OQ-3).
  Part B is a
  fourth hook-writing concern; routing it exclusively through W5's future unified registry (rather than a
  bespoke installer) is the mitigation, and this document treats "W5 lands first" as a hard prerequisite,
  not a nice-to-have.
- **False confidence from a scored grade.** A single numeric grade invites treating "B" as "safe." The
  severity cap (one critical finding ceilings the grade at C) and the mandatory-justification baseline
  file are the two structural mitigations; the score is documented here as a triage aid, not a certification.
- **Evidence-gate cost creep.** If `gdgraph`/testing-context walks are slow on a large repo, first-touch
  latency could push users to reach for the kill switch by default, defeating the feature. The
  once-per-file-per-session scoping and the explicit budget target are the mitigations; W7's correctness
  and performance work is a load-bearing dependency here.
- **New detector false positives.** The net-new checks (hook-interpolation injection, silent suppression,
  unpinned launchers) are pattern-based like the existing `mcp.ts` detectors and inherit the same
  possibility of false positives on ordinary code; they ship behind the same `eval`-corpus discipline
  `security eval` already applies to the existing detector set (`security.ts:824-871`), not as
  unvalidated new rules.
- **Baseline rot.** A suppression with no `expiresAt` is flagged, not blocked, so an operator can still
  accumulate stale suppressions; this is an accepted trade against fail-closed-by-default (blocking would
  make the baseline file unusable for genuinely long-lived accepted risk).

## Acceptance criteria

- **W8-AC1**: `keryx security audit-harness` runs against a project with no `.metaproject/agents/`, no
  MCP config, and only a `CLAUDE.md`, and reports coverage per surface (scanned/not-applicable/error) —
  never silently treating an absent surface as "checked and clean."
- **W8-AC2**: A manifest with a `POISONING_PATTERNS`-matching tool description is flagged under the
  `mcp-tool-poisoning` check with the same category/policyId/severity `scanMcpManifest` already returns
  for it — i.e., Part A's MCP surface produces byte-identical findings to running `scan-mcp` directly on
  the same manifest, proving the reuse is real and not a re-implementation.
- **W8-AC3**: An unpinned `npx <pkg>` MCP server entry (no `@version`) is flagged `unpinned-mcp-launcher`
  at `high`; the same entry pinned to `npx <pkg>@1.2.3` is not flagged.
- **W8-AC4**: A single `critical` finding caps the reported grade at `C` even when the numeric score alone
  would round to `A`/`B`.
- **W8-AC5**: `--fix-proposals` output contains zero filesystem writes (verified by a test that snapshots
  the target directory before and after the run); `apply --proposal <id>` is the only code path that
  writes, and it writes a changelog entry.
- **W8-AC6**: `--ci` exits non-zero on any unsuppressed `critical`/`high` finding and zero otherwise,
  using the same `isPassGate`-style allowlist-not-denylist pattern already fixed in `exitCodeFor`
  (`security.ts:971-976`) rather than a fresh ad hoc exit-code branch.
- **W8-AC7**: A suppression entry with no `justification` fails baseline-file schema validation; one with
  no `expiresAt` validates but is itself reported as a `low`-severity `indefinite-suppression` finding.
- **W8-AC8**: A tampered baseline file (content changed without updating its checksum) is reported as
  tampered, the same way a tampered `security.config.json` is today (`self-protect.ts` checksum-mismatch
  path), and is a `--ci` gate failure in its own right.
- **W8-AC9**: On the first Edit of `foo.ts` in a session, the injected evidence for "importers" is
  byte-for-byte the same JSON `keryx gdgraph affected foo.ts --json` returns standalone at the same graph
  state — no independent re-derivation.
- **W8-AC10**: A second Edit of the same `foo.ts` later in the same session injects no evidence block (or
  the condensed dampened form after N denials); a first Edit of a *different* file `bar.ts` in the same
  session does inject its own full evidence block.
- **W8-AC11**: When `keryx gdgraph affected` itself reports the target file unindexed (not "zero edges"),
  the injected evidence block says "not indexed," never "no importers found."
- **W8-AC12**: A batch tool call editing three files for the first time in a session produces an evidence
  block naming all three, not only the first.
- **W8-AC13**: `isDestructiveCommand("rm -rf /")` reaching the shell gate requires a non-empty rollback
  line before proceeding, in every permission mode except when the kill switch is set (and its use is
  logged); a non-destructive command is never asked for one.
- **W8-AC14**: `keryx.impact-evidence` registers as hook class `gate-advisory` by default (`gate` in
  `strict` mode). Under `unattended-untrusted` with the graph/testing service unavailable, the edit is
  denied (fail-closed); under `read-only-review`/`monitored-trusted-local` with the same service
  failure, the edit proceeds with a visible warning (fail-open-with-warning) — both paths covered by a
  test that forces the service call to throw.
- **W8-AC15**: Disabling the gate via `KERYX_DISABLE_IMPACT_GATE` produces a logged record distinguishable
  from "gate ran and found nothing."

## Open questions

- **OQ-W8.1**: Should `unpinned-mcp-launcher` also fire for a *local* (non-`npx`/`uvx`) MCP server binary
  with no recorded checksum, or is that scope creep into `scan`'s general territory? Leaning: out of scope
  for v1, revisit once W5's adapter registry standardizes MCP-config discovery.
- **OQ-W8.2**: Where does the impact-evidence gate's per-session first-touch state live in `keryx shell`
  before W6's hook runtime has its own session-scoped store? Candidate: piggyback on the same session
  state W6 will need for its own hook-execution bookkeeping, but that is a W6 design decision this
  document cannot make unilaterally.
- **OQ-W8.3**: Does `strict` mode's acknowledgement requirement apply per-file or per-session? Per-file is
  more honest evidence-of-reading but doubles the friction of denial dampening's own bookkeeping; needs a
  decision once real usage data exists, not before.
- **OQ-W8.4**: Should the harness-audit score be tracked over time (a trend line) as part of `keryx
  security report`, or does that conflate two different report cadences (report is "recent findings",
  audit-harness is "point-in-time config posture")? Leaning: keep them separate outputs for now; revisit
  if operators ask for a combined dashboard.
