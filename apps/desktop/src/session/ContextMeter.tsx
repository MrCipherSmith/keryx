import { useRef, useState } from "react";
import { Menu, type MenuItem } from "../components/Menu";
import { formatTokens } from "../lib/format";
import type { Usage } from "./reducer";

export type ContextTone = "ok" | "warn" | "high";

export interface ContextFill {
  /** 0–100, rounded. */
  pct: number;
  tone: ContextTone;
}

/** Share of the context window the last model call filled; null when the window size is unknown. */
export function contextFill(usage: Usage | null | undefined): ContextFill | null {
  if (!usage || !(usage.size > 0)) return null;
  const pct = Math.min(100, Math.max(0, Math.round((usage.used / usage.size) * 100)));
  return { pct, tone: pct >= 85 ? "high" : pct >= 70 ? "warn" : "ok" };
}

interface Props {
  usage: Usage | null | undefined;
  /** A turn is running: /compact is refused by keryx meanwhile. */
  busy: boolean;
  /** Run /compact for this session. */
  onCompact: () => void;
  /** Open the session Info tab. */
  onDetails: () => void;
}

/** A small context-fill gauge for the composer toolbar; its menu offers Compact and Details. */
export function ContextMeter({ usage, busy, onCompact, onDetails }: Props) {
  const fill = contextFill(usage);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!fill || !usage) return null;
  const items: MenuItem[] = [
    {
      id: "compact",
      label: "Compact",
      description: busy ? "Available when the current turn ends" : "Summarize the conversation to free up context",
      disabled: busy,
      onSelect: onCompact,
    },
    { id: "details", label: "Details", description: "Open the session Info tab", onSelect: onDetails },
  ];
  return (
    <>
      <button
        ref={btn}
        className={`context-meter is-${fill.tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Context ${fill.pct}% full`}
        title={`Last call: ${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens`}
      >
        <span className="context-meter-bar" aria-hidden>
          <span style={{ width: `${fill.pct}%` }} />
        </span>
        <span>{fill.pct}%</span>
      </button>
      {open ? <Menu anchor={btn.current} items={items} onClose={() => setOpen(false)} placement="above" label="Context" width={280} /> : null}
    </>
  );
}
