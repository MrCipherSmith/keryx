import { useRef } from "react";

interface Props {
  /** The panel's current width in pixels. */
  width: number;
  min: number;
  /** The widest the panel may be right now (a share of the window, so it is asked at use). */
  max: () => number;
  onChange: (width: number) => void;
  label: string;
}

export const clampWidth = (w: number, min: number, max: number): number => Math.round(Math.min(Math.max(min, max), Math.max(min, w)));

/**
 * A drag handle on the left edge of a right-hand panel: dragging left widens it. It is a
 * keyboard-reachable separator too: ArrowLeft widens, ArrowRight narrows (Shift for bigger steps),
 * Home and End go to the narrowest and the widest.
 */
export function ResizeHandle({ width, min, max, onChange, label }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const limit = (w: number) => clampWidth(w, min, max());

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => onChange(limit(startW + (startX - ev.clientX)));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    let next: number | undefined;
    if (e.key === "ArrowLeft") next = width + step;
    else if (e.key === "ArrowRight") next = width - step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max();
    if (next === undefined) return;
    e.preventDefault();
    onChange(limit(next));
  };

  return (
    <div
      ref={el}
      className="panel-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={Math.max(min, max())}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
