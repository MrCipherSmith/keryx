import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { useEscape } from "./ui";

export type MenuItem =
  | {
      kind?: "item";
      id: string;
      label: ReactNode;
      description?: ReactNode;
      icon?: IconName;
      hint?: ReactNode;
      checked?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator"; id: string }
  | { kind: "header"; id: string; label: ReactNode };

interface Props {
  anchor: HTMLElement | null;
  items: MenuItem[];
  onClose: () => void;
  /**
   * Where the menu opens relative to the anchor:
   * - "below" (default): under the anchor.
   * - "above": bottom-anchored, opens upward (composer chips sit at the bottom of the window).
   * - "auto": measures the menu and flips to the side that fits, clamped to the viewport.
   */
  placement?: "below" | "above" | "auto";
  /** Close when any scroll (or a window resize) moves the anchor more than 2px away from where the menu opened. */
  closeOnScroll?: boolean;
  label: string;
  width?: number;
  footer?: ReactNode;
}

/** A keyboard-navigable popover menu anchored to a button. */
export function Menu({ anchor, items, onClose, placement = "below", closeOnScroll = false, label, width = 280, footer }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: -9999, top: -9999 });
  useEscape(onClose);

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    if (placement === "below") setPos({ left, top: r.bottom + 4 });
    else if (placement === "above") setPos({ left, bottom: window.innerHeight - r.top + 4 });
    else {
      // auto: the menu is mounted off-screen first, so its real height is known here.
      const margin = 8;
      const vh = window.innerHeight;
      const h = ref.current?.offsetHeight ?? 0;
      const spaceBelow = vh - r.bottom - 4 - margin;
      const spaceAbove = r.top - 4 - margin;
      const above = h > spaceBelow && spaceAbove > spaceBelow;
      const wanted = above ? r.top - 4 - h : r.bottom + 4;
      setPos({ left, top: Math.max(margin, Math.min(wanted, vh - h - margin)) });
    }
    const first =
      ref.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
      ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])');
    first?.focus();
  }, [anchor, placement, width, items.length]);

  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    if (!anchor || !closeOnScroll) return;
    const start = anchor.getBoundingClientRect();
    const onScroll = () => {
      const r = anchor.getBoundingClientRect();
      if (Math.abs(r.top - start.top) > 2 || Math.abs(r.left - start.left) > 2) onClose();
    };
    const onResize = () => onClose();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, closeOnScroll, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[(i + 1) % all.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      all[(i - 1 + all.length) % all.length]?.focus();
    } else if (e.key === "Tab") {
      onClose();
    }
  };

  return (
    <div ref={ref} className="menu" role="menu" aria-label={label} style={{ ...pos, width }} onKeyDown={onKeyDown}>
      {items.map((it) => {
        if (it.kind === "separator") return <div key={it.id} className="menu-sep" role="separator" />;
        if (it.kind === "header") return <div key={it.id} className="menu-header">{it.label}</div>;
        const radio = it.checked !== undefined;
        return (
          <button
            key={it.id}
            role={radio ? "menuitemradio" : "menuitem"}
            aria-checked={radio ? it.checked : undefined}
            className="menu-item"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className="menu-icon">
              {radio ? it.checked ? <Icon name="check" size={14} /> : null : it.icon ? <Icon name={it.icon} size={14} /> : null}
            </span>
            <span className="menu-text">
              <span className="menu-label">{it.label}</span>
              {it.description ? <span className="menu-desc">{it.description}</span> : null}
            </span>
            {it.hint ? <span className="menu-hint">{it.hint}</span> : null}
          </button>
        );
      })}
      {footer ? <div className="menu-footer">{footer}</div> : null}
    </div>
  );
}
