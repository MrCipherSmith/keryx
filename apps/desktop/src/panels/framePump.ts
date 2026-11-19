import type { BrowserFrame } from "../platform/panels";

export interface FramePumpDeps {
  /** The JPEG of the newest frame of `tab` (empty when the host has none). */
  fetch: (tab: number) => Promise<ArrayBuffer>;
  draw: (jpeg: ArrayBuffer, frame: BrowserFrame) => Promise<void>;
  /** The tab the canvas shows; notices of another tab are dropped. */
  shown: () => number;
  /** A fetch or draw that takes longer than this is given up, so the pump never stalls. */
  timeoutMs?: number;
}

export interface FramePump {
  push: (frame: BrowserFrame) => void;
  stop: () => void;
}

/**
 * Draws the canvas from the host's frame notices: one fetch and draw at a time, always of the newest
 * frame. A fetch or draw that fails or hangs costs that frame only; the next notice brings a newer one.
 */
export function framePump({ fetch, draw, shown, timeoutMs = 3000 }: FramePumpDeps): FramePump {
  let pending: BrowserFrame | null = null;
  let busy = false;
  let stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    const f = pending;
    pending = null;
    if (!f || f.tab !== shown()) return;
    busy = true;
    try {
      const jpeg = await within(fetch(f.tab), timeoutMs);
      if (!stopped && jpeg.byteLength > 0) await within(draw(jpeg, f), timeoutMs);
    } catch {
      // This frame is lost; the next notice brings a newer one.
    } finally {
      busy = false;
      if (!stopped && pending) void run();
    }
  };
  return {
    push(frame) {
      if (stopped) return;
      pending = frame;
      void run();
    },
    stop() {
      stopped = true;
      pending = null;
    },
  };
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
