# Implementation Plan

Status: approved scope (operator answers, 2026-09-19)

## Approach

1. **One step surface for both hosts.** A `StepSurface` helper in `tui-shell.ts`:
   given the shell chrome it opens a single-tab ModalHost dialog (title, footer,
   body = tab body, Esc → the step's own back/cancel result via `onClose`);
   given a bare renderer it mounts today's `overlayBox` with a title line. Each
   wizard step renders into `surface.body` and ends with `surface.close()`.
   Step functions take `Renderer | ModalChrome` like the pickers already do
   (flow 269), so the startup picker and chat shell pass the renderer and are
   unchanged (AC3).
2. **ModalHost arrows.** A single-tab modal never consumes ←/→ (tab switching
   needs a second tab), so text fields in a step keep cursor movement (AC4).
3. **/tools and /mcp.** Row formatters take a width and emit hanging-indent
   lines; home paths collapse to `~`; per-tab footers; a column header naming
   the risk column as approval ("read = no approval"). Grok TOML: an
   `[[x]]` header whose first key is not `mcp_servers` closes the current table
   silently; `[[mcp_servers…]]` stays a problem (AC5–AC8).
4. **Mode row.** Sidebar row `Mode` = permission mode, plus ` · read-only`
   highlighted; repainted from `applyMode` and `/plan` (AC9).
5. **Splash.** An empty-state wordmark added to the transcript when the session
   has no prior messages, removed on the first operator submit; the boot
   animation drops its fake step labels (AC10).

## Steps

1. Lane A (subagent, disjoint files): `src/tui/mcp-inspector.ts`,
   `src/tui/mcp-consumer.ts`, `src/mcp-servers/compat.ts` + their tests (AC5–AC8).
2. Lane B (orchestrator): `modal-host.ts` arrows, `StepSurface`, both wizards in
   `tui-shell.ts` (AC1–AC4).
3. Lane B: sidebar Mode row and splash (AC9–AC10).
4. Verification: full TUI/mcp-servers tests, typecheck, lint, live pty check.
5. Review round, PR.

No lane stages another lane's files; no `git stash`; no `git add -A`.

## Risks

- Wizard step Esc semantics differ per step (back vs cancel); each step's
  `onClose` must map to the same result its overlay Esc returns.
- Device-login step polls in the background; closing its modal must stop the poll.
- Two modals opened back to back: `openModal` on an open host runs the previous
  `onClose`; a step must close its own modal before the next step opens.
