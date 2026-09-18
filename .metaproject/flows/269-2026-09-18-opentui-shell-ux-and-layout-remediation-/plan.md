# Implementation Plan: OpenTUI Shell UX & Layout Remediation

## Strategy

Execute implementation in 4 distinct phases corresponding to AC1–AC10, following strict TDD workflow:
1. Write/update failing unit tests in `src/tui/*.test.ts`.
2. Apply minimal robust code changes in `src/tui/`.
3. Verify test passes.
4. Run live verification via `tmux capture-pane`.

## Phase 1: Modal Isolation & Border Boundaries (AC1, AC2)
- Inspect and update `src/tui/modal-host.ts`:
  - Ensure backdrop container spans the full main viewport and fills cells with background color.
  - Calculate `maxWidth = Math.min(mainWidth - 4, 104)` relative to `chrome.main.width`, clamping right border before sidebar.
- Test in `src/tui/modal-host.test.ts`.

## Phase 2: Picker Unification in ModalHost (AC3, AC4)
- Extract model list rendering logic into a component compatible with `openModal` in `src/tui/modal-host.ts`.
- Mount `/model` through `openModal({ title: "Select Model", tabs: [...] })` instead of `selectProviderModelInTui` raw screen wipe.
- Mount `/sessions` through `openModal` with clean single-line footer.
- Test in `src/tui/session-info.test.ts` and `src/tui/tui-shell.test.ts`.

## Phase 3: Scroll Ergonomics & Stream Following (AC5, AC6)
- In `src/tui/shell-chrome.ts`: add auto-scroll hook in composer submit (`scroll.scrollTop = scroll.scrollHeight; scroll.stickyScroll = true`).
- In `src/tui/transcript-blocks.ts`: modify `exit()` in `createBlockNavController` to check if user navigated/scrolled down; retain current position instead of unconditionally restoring `savedScrollTop`.
- Test in `src/tui/shell-chrome.test.ts` and `src/tui/transcript-blocks.test.ts`.

## Phase 4: Adaptive Heights, Empty States & Typography (AC7, AC8, AC9, AC10)
- In `src/tui/modal-host.ts`: dynamically compute height from tab body item count + chrome padding, clamped at 85% of terminal height.
- In `src/tui/review-inspector.ts`: detect 0 items, render compact box, and omit action shortcuts from footer hints.
- In `src/commands/agent-commands.ts` / `src/tui/shell-chrome.ts`: implement hanging indent formatting for `/help`.
- Run full suite: `bun test src/tui/` and verify in live tmux session.
