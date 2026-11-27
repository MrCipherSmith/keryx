import { useRef, type RefObject } from "react";

export const PANEL_MIN_WIDTH = 360;

/**
 * The drag/keyboard handle on the left edge of a review side panel (pull request details, a Review).
 * The panel keeps at least 360px and leaves at least 280px of its container to the list beside it.
 */
export function PanelResizer({ panel, panelId, width, label, onResize }: {
  panel: RefObject<HTMLElement | null>;
  panelId: string;
  width: number;
  label: string;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const currentWidth = () => panel.current?.offsetWidth || width;
  const maxWidth = () => Math.max(PANEL_MIN_WIDTH, (panel.current?.parentElement?.clientWidth || window.innerWidth) - 280);
  const resize = (next: number) => onResize(Math.min(maxWidth(), Math.max(PANEL_MIN_WIDTH, next)));
  return <div className="side-resize review-detail-resize" role="separator" tabIndex={0}
    aria-orientation="vertical" aria-label={label} aria-controls={panelId}
    aria-valuemin={PANEL_MIN_WIDTH} aria-valuenow={Math.min(maxWidth(), width)} aria-valuemax={maxWidth()}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: currentWidth() };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const keys: Record<string, number> = { ArrowLeft: currentWidth() + 32, ArrowRight: currentWidth() - 32, Home: PANEL_MIN_WIDTH, End: maxWidth() };
      if (!Object.hasOwn(keys, event.key)) return;
      event.preventDefault();
      resize(keys[event.key]!);
    }} />;
}
