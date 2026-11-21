import { useEffect, useRef } from "react";
import { browserFrame, browserFrames, browserInput, type BrowserFrame, type BrowserInput } from "../platform/panels";
import { isAppShortcut, keyInput, mouseInput, pagePoint, wheelInput } from "./chromeInput";
import { framePump } from "./framePump";

/**
 * The active Chromium tab, drawn from the host's screencast on a canvas that fills the panel body.
 * The canvas is the page's viewport (the host sizes the page to the panel body), so a point on it
 * is the same point on the page; mouse, wheel, keys and pasted text go back as real input.
 */
export interface ChromeViewIo {
  frames: typeof browserFrames;
  frame: typeof browserFrame;
  input: typeof browserInput;
}

const EDITABLE_MARKER = "\u200b";

const hostIo: ChromeViewIo = { frames: browserFrames, frame: browserFrame, input: browserInput };

export function ChromeView({ tab, io = hostIo }: { tab: number; io?: ChromeViewIo }) {
  const ioRef = useRef(io);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Keys, paste and IME need an editable element: a transparent textarea over the canvas takes focus.
  const keys = useRef<HTMLTextAreaElement>(null);
  const last = useRef<BrowserFrame | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const composing = useRef(false);

  // Frames: the host sends a notice per frame; one fetch and draw at a time, always of the newest
  // frame, and a frame that fails or hangs is skipped (`framePump`).
  useEffect(() => {
    let drawn = 0;
    const pump = framePump({
      fetch: (t) => ioRef.current.frame(t),
      shown: () => tabRef.current,
      draw: async (jpeg, f) => {
        const c = canvas.current;
        if (!c) return;
        const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
        try {
          // A draw that outlived its time limit never paints over a newer frame.
          if (f.seq < drawn) return;
          drawn = f.seq;
          const dpr = window.devicePixelRatio || 1;
          const w = Math.max(1, Math.round(c.clientWidth * dpr));
          const h = Math.max(1, Math.round(c.clientHeight * dpr));
          if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
          }
          c.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
        } finally {
          bitmap.close();
        }
      },
    });
    void ioRef.current.frames((f) => {
      last.current = f;
      pump.push(f);
    }).catch(() => {});
    return () => pump.stop();
  }, []);

  useEffect(() => {
    const r = root.current;
    const c = canvas.current;
    const k = keys.current;
    if (!r || !c || !k) return;
    const send = (e: BrowserInput) => void ioRef.current.input(tab, e).catch(() => {});
    // A press on the page gives it the keyboard: the textarea (for paste and IME), or the view
    // itself if the textarea cannot take focus. Keys are handled on the view, so either works.
    const resetKeys = () => {
      k.value = EDITABLE_MARKER;
      k.setSelectionRange(EDITABLE_MARKER.length, EDITABLE_MARKER.length);
    };
    resetKeys();
    const takeKeys = () => {
      if (document.activeElement !== k && !composing.current) resetKeys();
      k.focus({ preventScroll: true });
      if (document.activeElement !== k) r.focus({ preventScroll: true });
    };
    const point = (e: MouseEvent) => {
      const f = last.current;
      const r = c.getBoundingClientRect();
      return pagePoint(e, r, f?.width || r.width, f?.height || r.height);
    };
    let moveQueued: MouseEvent | null = null;
    let wheelQueued: Extract<BrowserInput, { kind: "wheel" }> | null = null;
    let inputFrame = 0;
    const flushInput = () => {
      if (inputFrame) cancelAnimationFrame(inputFrame);
      inputFrame = 0;
      if (moveQueued) send(mouseInput("mouseMoved", moveQueued, point(moveQueued), held));
      if (wheelQueued) send(wheelQueued);
      moveQueued = wheelQueued = null;
    };
    const requestInputFrame = () => {
      if (!inputFrame) inputFrame = requestAnimationFrame(flushInput);
    };
    // The button pressed on the canvas, held until it is released (anywhere): drags and releases
    // outside the canvas still reach the page, and no stray release is sent for a press elsewhere.
    let held: number | null = null;
    const onDown = (e: MouseEvent) => {
      // Not the browser's default focus handling: it would move focus to the canvas's container.
      e.preventDefault();
      flushInput();
      takeKeys();
      held = e.button;
      send(mouseInput("mousePressed", e, point(e)));
    };
    const onUp = (e: MouseEvent) => {
      if (held === null) return;
      flushInput();
      held = null;
      send(mouseInput("mouseReleased", e, point(e)));
    };
    const onMove = (e: MouseEvent) => {
      if (wheelQueued) flushInput();
      moveQueued = e;
      requestInputFrame();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const wheel = wheelInput(e, point(e));
      if (wheelQueued && wheelQueued.modifiers !== wheel.modifiers) flushInput();
      wheelQueued = {
        ...wheel,
        dx: wheel.dx + (wheelQueued?.dx ?? 0),
        dy: wheel.dy + (wheelQueued?.dy ?? 0),
      };
      requestInputFrame();
    };
    const onKey = (e: KeyboardEvent) => {
      if (composing.current || e.isComposing || isAppShortcut(e)) return;
      // Cmd+V arrives as a paste event with the clipboard's text.
      if (e.metaKey && e.code === "KeyV") return;
      e.preventDefault();
      flushInput();
      send(keyInput(e.type === "keydown" ? "keyDown" : "keyUp", e));
    };
    // macOS can handle Edit > Select All in the native editor without a DOM keydown.
    // Its selection of the marker carries that command to the actual page.
    const relayNativeSelectAll = () => {
      if (document.activeElement !== k || composing.current || k.value !== EDITABLE_MARKER ||
          k.selectionStart !== 0 || k.selectionEnd !== EDITABLE_MARKER.length) return;
      resetKeys();
      flushInput();
      const command = { key: "a", code: "KeyA", keyCode: 65, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
      send(keyInput("keyDown", command));
      send(keyInput("keyUp", command));
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      relayNativeSelectAll();
      flushInput();
      send({ kind: "text", text });
    };
    const onCompStart = () => (composing.current = true);
    const onCompEnd = (e: CompositionEvent) => {
      composing.current = false;
      flushInput();
      if (e.data) send({ kind: "text", text: e.data });
      resetKeys();
    };
    // Whatever lands in the textarea was sent already.
    const onInput = () => {
      if (!composing.current) resetKeys();
    };
    const onContext = (e: MouseEvent) => e.preventDefault();
    c.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    c.addEventListener("mousemove", onMove);
    // While a button is held the drag continues outside the canvas.
    const onWindowMove = (e: MouseEvent) => {
      if (held !== null && e.target !== c) onMove(e);
    };
    window.addEventListener("mousemove", onWindowMove);
    c.addEventListener("wheel", onWheel, { passive: false });
    r.addEventListener("keydown", onKey);
    r.addEventListener("keyup", onKey);
    r.addEventListener("paste", onPaste);
    k.addEventListener("compositionstart", onCompStart);
    k.addEventListener("compositionend", onCompEnd);
    c.addEventListener("contextmenu", onContext);
    k.addEventListener("input", onInput);
    k.addEventListener("select", relayNativeSelectAll);
    return () => {
      if (inputFrame) cancelAnimationFrame(inputFrame);
      composing.current = false;
      c.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      c.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousemove", onWindowMove);
      c.removeEventListener("wheel", onWheel);
      r.removeEventListener("keydown", onKey);
      r.removeEventListener("keyup", onKey);
      r.removeEventListener("paste", onPaste);
      k.removeEventListener("compositionstart", onCompStart);
      k.removeEventListener("compositionend", onCompEnd);
      c.removeEventListener("contextmenu", onContext);
      k.removeEventListener("input", onInput);
      k.removeEventListener("select", relayNativeSelectAll);
    };
  }, [tab]);

  return (
    <div ref={root} className="chrome-view" tabIndex={-1}>
      <canvas ref={canvas} aria-label="Page" data-testid="chrome-view" />
      <textarea ref={keys} className="chrome-keys" aria-label="Page keyboard input" autoCapitalize="off" autoCorrect="off" spellCheck={false} tabIndex={-1} />
    </div>
  );
}
