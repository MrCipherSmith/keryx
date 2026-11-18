import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { toTerminalText, type StreamSource } from "./streamTabs";

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** A read-only terminal screen fed by `source` (no process, no keyboard input). */
export function StreamView({ source, active, onEnd }: { source: StreamSource; active: boolean; onEnd: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ended = useRef(onEnd);
  ended.current = onEnd;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: cssVar(el, "--mono", "ui-monospace, Menlo, monospace"),
      fontSize: 12,
      lineHeight: 1.15,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 50_000,
      convertEol: false,
      theme: {
        background: cssVar(el, "--term-bg", "#111513"),
        foreground: cssVar(el, "--term-fg", "#e4ebe7"),
        cursor: cssVar(el, "--term-bg", "#111513"),
        selectionBackground: cssVar(el, "--term-selection", "#3a5a50"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    const stop = source(
      (text) => term.write(toTerminalText(text)),
      (note) => {
        term.write(`\r\n\x1b[2m[${note}]\x1b[0m\r\n`);
        ended.current();
      },
    );
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
      stop();
      ro.disconnect();
      term.dispose();
      fitRef.current = null;
    };
  }, [source]);

  useEffect(() => {
    if (!active) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* not laid out */
    }
  }, [active]);

  return <div ref={host} className="term-view" hidden={!active} />;
}
