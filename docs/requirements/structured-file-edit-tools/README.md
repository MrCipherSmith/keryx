# Structured File-Edit Tools
Version: 0.2.0

## Purpose

Give the interactive agent (`keryx shell` / TUI) a native way to mutate
project files that is **not** `shell_exec`. Today the agent's only tool set
capable of changing a file at all is `shell_exec` (heredocs, `sed`, etc.) —
there is no `write_file`/`edit_file` equivalent to Claude Code's `Edit`,
OpenCode's `edit`, or Codex's `apply_patch`. Every real edit therefore:

1. Is classified `risk: "shell"` regardless of content, competing with every
   other non-read action (writes, destructive commands, network, subagent
   spawns) for the same small per-turn budget (`DEFAULT_MAX_NON_READ_TOOL_CALLS`,
   `src/commands/agent.ts`).
2. Goes through the shell metacharacter/destructive-command classifier
   (`src/lib/command-risk.ts`), which is tuned for *commands*, not file
   *content* — it has no opinion on "this diff deletes 40 files."
3. Shows the human approver a shell command string, not a diff.

This package designs `apply_patch`: a single, `risk: "write"` tool that takes
a standard multi-file unified diff, applies it in-process (no subprocess,
same trust tier as `read_file`/`list_dir`), and is approval-gated with a real
diff preview — one tool call can touch several files, so it collapses N
small edits into 1 non-read budget slot instead of N.

## Key finding this design depends on

`risk: "write"` is declared by `ToolRisk` (`src/harness/tool/types.ts`) but
**hard-denied unconditionally today**, regardless of approver or permission
mode — `executeCall`'s final branch (`src/commands/agent.ts:1984`) rejects
any risk other than `read`/`shell`/`destructive`/`delegate`. `permission-mode.ts`
documents this explicitly:

> `write` / `network` / `credential` are declared by `ToolRisk` but
> hard-denied unconditionally today regardless of approver or mode
> (agent.ts's final `else if (risk !== "read")` branch) — not this layer's
> concern.

`workspace_create`/`workspace_propose` — the only existing tools that mutate
anything — sidestep this by being declared `risk: "read"` **deliberately**
(`workspace-lifecycle-tool.ts:12`, explicit comment), because their write is
narrowly scoped to SAC bookkeeping. `apply_patch` mutates real project files
and must **not** take that shortcut — it needs the gate itself extended to a
real `write` path, with its own escalation classifier, mirroring how `shell`/
`destructive` already work (ADR-0008, ADR-0009). This is the load-bearing
decision of the whole package; see [prd.md](prd.md) §Recommendation and the
proposed ADR in [specification.md](specification.md) §7.

## Recommended delivery order

| Phase | Name | Outcome |
|-------|------|---------|
| **P0** | Approval-gate extension | **implemented** — `GatedToolRisk`/`executeCall`/`resolveApprovalDecision` handle `risk: "write"`, backed by ADR-0010 |
| **P1** | `apply_patch` tool (single/multi-file) | **implemented** — in-process target parsing + `confineToRoot` scoping + `git apply` (stdin, argv-only), wired into `buildInteractiveAgentTools` |
| **P2** | Diff-preview approval UI | not implemented — approval prompt still shows raw JSON tool input for `write` risk, same as every other risk today |
| **P3** | System-prompt + budget guidance | **implemented** — `buildAgentSystemInstruction` now points the agent at `apply_patch` for edits |

P0 landed as its own reviewable unit (`permission-mode.ts`, `agent.ts`'s gate
branch, `src/lib/patch-risk.ts` + tests) before the tool itself, backed by
[ADR-0010](../../decisions/keryx-harness/ADR-0010-write-risk-approval-gate.md).

## Status

**P0 + P1 + P3 implemented; P2 (diff-preview approval UI) not started.**
Iron Law #6: this line is the accurate claim — see "Honest baseline" below
for the file-level breakdown.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Overview, phased plan, status, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Patch format, tool schema, gate extension, classifier, approval UI, file touch-points, acceptance criteria. |

## Scope

**In scope**

- One new tool, `apply_patch`, taking a standard multi-file unified diff.
- Extending `GatedToolRisk`/`executeCall`/`resolveApprovalDecision` to a real
  `write` path (currently dead/hard-denied).
- A patch-specific escalation classifier (delete / many-files / credential-path
  / `.git` touch) — the `write` analog of `isDestructiveCommand`.
- Path confinement reusing `confineToRoot` (`interactive-tools.ts`).
- Diff rendering in the approval prompt reusing `classifyDiffLine`
  (`src/lib/md-blocks.ts`).

**Non-goals (this package)**

- A `str_replace`/line-anchored edit tool (Claude Code/OpenCode style) — a
  unified diff already covers single-hunk precision edits; a second tool
  would duplicate surface for no budget benefit.
- A "remember this pattern" auto-allow mechanic for edits (shell_exec's
  `permissions.json` equivalent) — deferred; V1 always asks or follows the
  existing `trust`/`auto` permission-mode rules unmodified.
- Support for non-git project roots (`git apply` requires a git repository —
  see specification.md §3 for the fallback error).
- Binary file patches.
- Changing `shell_exec`'s own classification or budget cost.

## Related Modules

- **ADR-0008** — Interactive shell delegate risk gate
  (`docs/decisions/keryx-harness/ADR-0008-interactive-shell-delegate-risk-gate.md`)
  — precedent for adding a new gated risk class to `executeCall`.
- **ADR-0009** — Destructive-command escalation
  (`docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md`)
  — precedent for an escalation-only classifier that never blocks on its own.
- **Command budget / `flow_status` package** — the non-read tool-call budget
  this tool is designed to relieve (`src/commands/agent.ts`,
  `DEFAULT_MAX_NON_READ_TOOL_CALLS`).
- **Code (current baseline)** — `src/commands/agent.ts` (`executeCall`,
  `AgentDeps`), `src/commands/permission-mode.ts`, `src/lib/command-risk.ts`,
  `src/harness/tool/builtin/interactive-tools.ts` (`confineToRoot`),
  `src/lib/md-blocks.ts` (`classifyDiffLine`), `src/commands/interactive-agent-tools.ts`.

## Honest baseline (current code)

| Capability | Status |
|---|---|
| `risk: "write"` reaching `executeCall`'s approval gate | **implemented** (`permission-mode.ts`, `agent.ts`, ADR-0010) |
| `apply_patch` tool: multi-file unified diff, `confineToRoot`-scoped, `git apply` (stdin, argv-only) | **implemented** (`src/harness/tool/builtin/apply-patch-tool.ts`) |
| Patch escalation classifier (delete / `.git` / many-files / credential paths) | **implemented** (`src/lib/patch-risk.ts`) |
| Registered in the interactive agent's tool set | **implemented** (`interactive-agent-tools.ts`) |
| System prompt steers edits toward `apply_patch` over `shell_exec` | **implemented** (`buildAgentSystemInstruction`) |
| Diff rendering in the approval prompt (`classifyDiffLine` reuse) | **not implemented** (P2) — approval UI shows raw JSON input for `write`, unchanged from every other risk |
| "Remember this pattern" auto-allow for edits | **not implemented** — explicit non-goal (see Scope) |
