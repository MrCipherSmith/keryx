# Flow 031 — keryx shell rich-inline rendering

Status: formalized
Source: user request ("свой harness с нормальным UI, как claude/opencode").
Follow-on to flow 021 (interactive shell `runShell` core) and flow 022 (R2-4
provider/model selection adapter). Consistent with 022's frozen posture:
**Variant A — no new dependencies, hand-rolled ANSI** (`dependencies` stays `{}`).

## Problem

The interactive `keryx` shell renders as a bare line-based `node:readline` REPL
(`src/commands/shell.ts` `shellCommand`): assistant tokens, system notices, and
errors all flow through a single `io.write(string)` sink to `process.stdout` with
no styling, no role separation, no streaming affordance, and no markdown. Next to
Claude Code / opencode it reads as unfinished, even though the underlying
`runShell` core, provider streaming, and provider/model selection already work.

The single mixed `write` stream is also the blocker: from `write` calls alone the
TTY layer cannot tell an assistant token from a system line, nor detect turn
boundaries, so it cannot show a spinner or re-render a completed reply as
markdown.

## Expected Outcome

Running `keryx` (or `keryx shell`) against any provider gives a modern, readable
inline chat experience while the deterministic `runShell` core and all its
existing tests stay intact:

1. **Structured IO seam** — `ShellIO` gains OPTIONAL, backward-compatible hooks
   (`onTurnStart?`, `onTurnEnd?`, `onSystem?`) so the TTY layer can distinguish
   assistant token deltas from system/error text and see turn boundaries. When a
   hook is absent, behavior is byte-identical to today (every core write falls
   back to `io.write`), so flow-021/022 unit tests stay green unchanged.
2. **Reusable pure renderer** — a new `renderMarkdown(md)` (plus small role/label
   helpers) in `src/lib/ui.ts`, built on the existing `style`/`symbols`/
   `colorEnabled()` toolkit: headings, **bold**, `inline code`, fenced ``` code
   blocks, and `-`/`*` bullet lists → styled terminal text. Pure `string→string`,
   unit-tested under `FORCE_COLOR` and `NO_COLOR`.
3. **Rich TTY wrapper** — `shellCommand` renders: a styled session header, a
   colored input prompt with a role marker, a role label + spinner ("thinking…")
   on `onTurnStart` that clears on the first token, live raw token streaming, and
   a markdown re-render of the completed reply on `onTurnEnd`; `onSystem` styles
   notices (dim/cyan) and errors (red). All color degrades to plain text when
   `NO_COLOR` is set or output is not a TTY.

## Out of Scope

- **No full-screen TUI** (alt-screen, scrollback pane, status bar, mouse). This
  flow stays in the inline line-flow; a full-screen TUI remains a separate future
  dependency decision (as recorded in flow 022).
- **No new production dependency** — `dependencies` REMAINS `{}`; hand-rolled ANSI
  via `src/lib/ui.ts` only (no Ink / OpenTUI / chalk / markdown lib).
- **No change to the `runShell` turn semantics, history model, provider
  selection, egress posture, or JSONL-RPC runtime contract.** The only core edit
  is the additive optional-hook seam; provider/model detection (flow 022) is
  reused unchanged.
- The `ANTHROPIC_API_KEY` credential is never stored/entered/logged (unchanged).
- Frozen requirements package, canonical schemas, ADRs, `src/eval/`,
  `src/contracts/` — read/cite only.
