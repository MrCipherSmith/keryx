// Flow 300 review F13: a theme listener that repaints a panel or modal.
//
// `applyThemeId` calls every listener in turn, so one that throws breaks the
// recolour of everything after it. But swallowing every error would hide a
// real bug. The only error that is expected is the one from painting into
// renderables that are already gone — a modal closed, a panel disposed, or the
// whole renderer destroyed before its owner unsubscribed. That one is ignored;
// anything else is logged to the debug log and rethrown.

import { debugEvent } from "./debug-log";

/** `true` when a renderable, or the renderer it belongs to, has been destroyed. */
export function isRenderableGone(node: unknown): boolean {
  const n = node as { isDestroyed?: boolean; ctx?: { isDestroyed?: boolean } } | undefined;
  return n?.isDestroyed === true || n?.ctx?.isDestroyed === true;
}

export function guardedThemeRepaint(label: string, paint: () => void, isGone: () => boolean): () => void {
  return () => {
    if (isGone()) return;
    try {
      paint();
    } catch (error) {
      if (isGone()) return;
      debugEvent("theme.repaint-failed", { label, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
