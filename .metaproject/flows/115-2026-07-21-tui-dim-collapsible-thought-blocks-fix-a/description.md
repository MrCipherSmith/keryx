# TUI: dim/collapsible thought blocks + fix alignSelf height-measurement breaking transcript layout and scroll

Status: formalized
Source: user report (screenshot: a bordered user-echo box rendered with its
border drawn through the text row, after `/think` expanded a large reasoning
block)

## Problem

Four defects reported against the OpenTUI agent shell, all observed after
`/think` expands a large reasoning block:

1. **Reasoning body renders at full brightness.** `createBlockView` paints every
   expanded body through `payloadChunks` → `markdownToChunks`
   (`src/tui/transcript-blocks.ts:789`), which emits normal-intensity chunks. A
   chain-of-thought is secondary content and must read as such (dim), the way
   the collapsed `◆ thought (N lines)` header already does.

2. **A large expanded block corrupts the transcript layout.** ROOT CAUSE, found
   by headless measurement against the shipped `createShellChrome` +
   `createBlockView`: a `BoxRenderable` carrying `alignSelf: "flex-start"`
   inside the scrollbox content **does not measure its intrinsic height**. It
   collapses to the viewport height and squeezes its children. Measured on a
   40x12 test renderer with a 30-line text child:

   | box options | measured box h | measured text h |
   |---|---|---|
   | plain | 30 | 30 |
   | `border` only | 32 | 30 |
   | `alignSelf: "flex-start"` | **12** | **12** |
   | `alignSelf` + `border` | **12** | **10** |
   | `alignSelf` + explicit `width` | 30 | 30 |

   Consequence in the real shell: a bordered box squeezed below its natural
   height draws its top and bottom border rows over the content row — exactly
   the corrupted `❯ добавляй` echo box in the user's screenshot.

3. **Content below the expanded block becomes unreachable.** The same
   mis-measurement under-reports the scrollbox content height: with a 30-line
   thought expanded, `scroll.scrollHeight` measured 23 against ~43 rows of real
   content, and `scrollTop` clamped at 12. Everything after the block (the
   assistant answer, `worked for Ns`, the next user echo) can never be scrolled
   into view.

4. **A reasoning block cannot be collapsed again from the composer.** `/think`
   only ever expands (`setBlockCollapsed(thought.id, false)`,
   `src/tui/tui-shell.ts:1546`); running it twice is a no-op. The only way back
   is `ctrl+o` → `Enter`, which is not discoverable from the block header.

Related history: flow 075 fixed the composer breaking on scroll with
`flexShrink: 0` + `minHeight: 0`; flow 109 then prescribed
`alignSelf: "flex-start"` for every new transcript box (its risk R4 mitigation)
— which is what introduced this class of defect.

## Expected Outcome

- Every transcript box measures its true height, so the scrollbox reports the
  real content height and nothing below an expanded block is unreachable.
- No bordered transcript box ever renders with its border drawn through its
  content.
- Reasoning bodies render dim (secondary), distinct from tool output.
- An expanded reasoning block is bounded to a readable preview; the full payload
  stays available through `y` / `/copy`.
- `/think` toggles the newest reasoning block both ways, and the block header
  advertises how to collapse it.
- Regression tests pin the measurement invariant so the next transcript box
  cannot silently reintroduce it.

## Out of Scope

- The readline shell rendering path (`src/commands/shell.ts`).
- Adopting `CodeRenderable` / `DiffRenderable` (flow 109 decision D-2 stands).
- Any change to the block registry's retention policy (flow 109 D-4).
- Upstreaming a fix to `@opentui/core`.
