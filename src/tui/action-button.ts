// The one clickable-button factory behind the queue dock's Force/Edit/Delete,
// `/connect`'s Test/Disconnect (flow 304) and `/settings`' value buttons
// (flow 374). It lives here, not in `tui-shell.ts`, so a modal can import it
// without importing the shell that imports the modal.

import { getTheme } from "./theme";
import { boldChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;

/**
 * Small styled label mimicking a clickable button — mirrors
 * `composer-choice.ts`'s "small styled label" pattern (bold/colored
 * `TextRenderable`, no border) rather than a bordered box: a bordered child
 * box next to a plain-text label in the same row would need its own explicit
 * height to avoid the row's cross-axis stretch fighting its border rows (see
 * `.metaproject/memory/lessons/tui-alignself-height-collapse.md` — this file
 * avoids `alignSelf` entirely for exactly that class of bug).
 */
export function smallActionButton(
  otui: OpenTui,
  r: Renderer,
  label: string,
  id: string,
  color: string,
  onMouseDown: () => void,
): { box: Box; setActive: (active: boolean) => void } {
  const box = new otui.BoxRenderable(r, {
    id,
    flexShrink: 0,
    marginLeft: 1,
    paddingLeft: 1,
    paddingRight: 1,
    onMouseDown: (event: { stopPropagation: () => void }) => {
      // Part A (flow 170 T5 investigation): @opentui/core's
      // Renderable.processMouseEvent fires this handler THEN, unless told
      // otherwise, walks up .parent and fires every ancestor's onMouseDown
      // too (confirmed against the bundled implementation,
      // node_modules/@opentui/core/chunk-bun-tkm837n2.js, the
      // processMouseEvent/onMouseDown setter pair) -- mouse events bubble by
      // default. A row/dock above this button may have its own
      // onMouseDown (queueDock's background click, or a row's label click
      // here); without stopping it here, every button click would ALSO fire
      // that ancestor handler as an unwanted bubbled side effect. Stop it at
      // the deepest, most specific handler -- the button itself.
      event.stopPropagation();
      onMouseDown();
    },
  });
  // Theme-driven color, not `otui.red`/`otui.yellow` (fixed ANSI-bright
  // helpers) -- plain content + `.fg` is the same pattern
  // `transcript-blocks.ts`'s block header already uses for theme colors.
  const text = new otui.TextRenderable(r, { id: `${id}-t`, content: `[${label}]` });
  text.fg = color;
  box.add(text);
  const setActive = (active: boolean): void => {
    box.backgroundColor = active ? getTheme().highlight : undefined;
    text.content = active ? otui.t`${boldChunk(otui, `[${label}]`)}` : `[${label}]`;
    text.fg = color;
  };
  return { box, setActive };
}
