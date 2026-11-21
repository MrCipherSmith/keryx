// Shared primitives: overlays with focus management, empty states, spinners.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])';

/** Traps Tab inside `ref`, focuses the first field (or `[data-autofocus]`), restores focus on unmount. */
export function useFocusTrap(ref: React.RefObject<HTMLElement>, active = true, focusRoot = false) {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement as HTMLElement | null;
    const target = focusRoot ? null : (root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>(FOCUSABLE));
    (target ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === root || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (before && document.contains(before)) before.focus();
    };
  }, [ref, active, focusRoot]);
}

// Esc closes only the topmost layer: layers register on a stack in mount order.
const escapeStack: Array<{ current: (() => void) | null }> = [];

function onEscapeKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.current?.();
}

/** Register a layer; `null` holds the layer (it blocks lower ones) without closing. */
export function useEscape(handler: (() => void) | null, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    if (!escapeStack.length) window.addEventListener("keydown", onEscapeKey);
    const entry = { get current() { return ref.current; } };
    escapeStack.push(entry);
    overlayListeners.forEach((l) => l());
    return () => {
      const i = escapeStack.indexOf(entry);
      if (i >= 0) escapeStack.splice(i, 1);
      if (!escapeStack.length) window.removeEventListener("keydown", onEscapeKey);
      overlayListeners.forEach((l) => l());
    };
  }, [active]);
}

const overlayListeners = new Set<() => void>();

/** Called whenever an overlay layer opens or closes (native views laid over the page hide under one). */
export function onOverlayChange(listener: () => void): () => void {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

/** True while any overlay layer is open (global shortcuts back off). */
export function overlayOpen(): boolean {
  return escapeStack.length > 0;
}

interface DialogProps {
  title: ReactNode;
  icon?: IconName;
  tone?: "default" | "danger" | "warn";
  onClose: (() => void) | null;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Esc is handled by the caller (permission dialogs answer instead of closing). */
  ownEscape?: boolean;
  /** Focus the dialog container instead of a control, so a stray Enter cannot hit a default action. */
  focusRoot?: boolean;
  /** Key handling scoped to the dialog: only events whose target is inside it arrive here. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

export function Dialog({ title, icon, tone = "default", onClose, children, footer, width = 460, ownEscape, focusRoot, onKeyDown }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, true, focusRoot);
  useEscape(ownEscape ? null : onClose);
  return (
    // The backdrop never dismisses (an accidental click must not decline a request) and never steals focus.
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div
        ref={ref}
        className={`dialog tone-${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-head">
          {icon ? (
            <span className="dialog-icon">
              <Icon name={icon} size={18} />
            </span>
          ) : null}
          <h2 id={id}>{title}</h2>
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

interface SheetProps {
  label: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

/** A side sheet over the right edge; Esc and the scrim close it. */
export function Sheet({ label, onClose, children, width = 560 }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEscape(onClose);
  return (
    <div className="sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} className="sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={{ width }}>
        {children}
      </aside>
    </div>
  );
}

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" role={label ? "status" : undefined} aria-label={label}>
      <Icon name="loader" size={size} strokeWidth={2} />
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {children ? <div className="empty-body">{children}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
