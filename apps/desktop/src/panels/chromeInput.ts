// DOM events on the Chromium canvas as the host's `browser_input` events (CDP input). Pure, so the
// mapping is testable without a browser.

import type { BrowserInput } from "../platform/panels";

type Mods = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/** CDP's modifier bit mask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiers(e: Mods): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

/** A canvas point in the page's CSS pixels: the canvas is laid out at the page's viewport size. */
export function pagePoint(e: Pick<MouseEvent, "clientX" | "clientY">, rect: Pick<DOMRect, "left" | "top" | "width" | "height">, pageWidth: number, pageHeight: number) {
  const sx = rect.width > 0 && pageWidth > 0 ? pageWidth / rect.width : 1;
  const sy = rect.height > 0 && pageHeight > 0 ? pageHeight / rect.height : 1;
  return { x: Math.round((e.clientX - rect.left) * sx), y: Math.round((e.clientY - rect.top) * sy) };
}

export function mouseInput(
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  e: Pick<MouseEvent, "button" | "detail" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  point: { x: number; y: number },
): BrowserInput {
  const button = type === "mouseMoved" ? "none" : (BUTTONS[e.button] ?? "left");
  return { kind: "mouse", type, ...point, button, clicks: type === "mouseMoved" ? 0 : Math.max(1, e.detail || 1), modifiers: modifiers(e) };
}

export function wheelInput(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">, point: { x: number; y: number }): BrowserInput {
  // Lines and pages to pixels, roughly as browsers do.
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  return { kind: "wheel", ...point, dx: e.deltaX * unit, dy: e.deltaY * unit, modifiers: modifiers(e) };
}

/** The text a key types, if any: printable keys, Enter. Cmd/Ctrl chords type nothing. */
export function keyText(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): string | undefined {
  if (e.metaKey || e.ctrlKey) return undefined;
  if (e.key === "Enter") return "\r";
  return e.key.length === 1 ? e.key : undefined;
}

export function keyInput(type: "keyDown" | "keyUp", e: Pick<KeyboardEvent, "key" | "code" | "keyCode" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): BrowserInput {
  const text = type === "keyDown" ? keyText(e) : undefined;
  return { kind: "key", type, key: e.key, code: e.code, ...(text !== undefined ? { text } : {}), keyCode: e.keyCode || undefined, modifiers: modifiers(e) };
}

/** App shortcuts the canvas must leave to the app (panel toggles, the picker, window commands). */
export function isAppShortcut(e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  if (e.metaKey && e.shiftKey && (e.code === "KeyB" || e.code === "KeyC")) return true;
  if (e.ctrlKey && !e.metaKey && e.code === "Backquote") return true;
  // Window-level Cmd chords (new tab, close, quit, settings, switch project) stay with the app; editing chords go to the page.
  return e.metaKey && !e.shiftKey && !e.altKey && ["KeyW", "KeyQ", "KeyN", "KeyT", "Comma", "KeyO"].includes(e.code);
}
