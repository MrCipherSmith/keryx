import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { ptyAttach, ptyResize, ptyWrite, type PtyEvent } from "../platform/panels";

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** One terminal tab's screen: an xterm attached to the tab's PTY. Unmounting leaves the PTY running. */
export function TermView({
  id,
  active,
  onExit,
  onError,
}: {
  id: number;
  active: boolean;
  onExit: (code: number | null) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const cb = useRef({ onExit, onError });
  cb.current = { onExit, onError };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const term = new Terminal({
      fontFamily: cssVar(el, "--mono", "ui-monospace, Menlo, monospace"),
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: {
        background: cssVar(el, "--term-bg", "#111513"),
        foreground: cssVar(el, "--term-fg", "#e4ebe7"),
        cursor: cssVar(el, "--term-fg", "#e4ebe7"),
        selectionBackground: cssVar(el, "--term-selection", "#3a5a50"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }

    const onEvent = (e: PtyEvent) => {
      if (disposed) return;
      if (e.kind === "data") term.write(e.data);
      else {
        term.write(`\r\n\x1b[2m[process exited${e.code !== null ? ` with code ${e.code}` : ""}]\x1b[0m\r\n`);
        cb.current.onExit(e.code);
      }
    };
    ptyAttach(id, onEvent)
      .then(() => {
        if (!disposed) void ptyResize(id, term.cols, term.rows).catch(() => {});
      })
      .catch((err: unknown) => cb.current.onError(String(err instanceof Error ? err.message : err)));
    const input = term.onData((data) => void ptyWrite(id, data).catch(() => {}));
    const resize = term.onResize(({ cols, rows }) => void ptyResize(id, cols, rows).catch(() => {}));
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* detached */
      }
    });
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
      input.dispose();
      resize.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!active) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* not laid out */
    }
    termRef.current?.focus();
  }, [active]);

  return <div ref={host} className="term-view" hidden={!active} data-testid={`term-${id}`} />;
}
