// Portal targets for session controls in the title bar and session content in the side panel.

import { useSyncExternalStore } from "react";

type Slot = "activity" | "info" | "sessionControls";

const slots: Record<Slot, HTMLElement | null> = { activity: null, info: null, sessionControls: null };
let running = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};

const refs: Record<Slot, (el: HTMLElement | null) => void> = {
  activity: (el) => setSlot("activity", el),
  info: (el) => setSlot("info", el),
  sessionControls: (el) => setSlot("sessionControls", el),
};
function setSlot(tab: Slot, el: HTMLElement | null): void {
  if (slots[tab] === el) return;
  slots[tab] = el;
  emit();
}

/** A (stable) ref callback for the element that hosts `tab`'s content; null on unmount. */
export const slotRef = (tab: Slot) => refs[tab];

export const useSlot = (tab: Slot): HTMLElement | null => useSyncExternalStore(subscribe, () => slots[tab]);

/** The session view's running subagents and tasks. */
export function setActivityRunning(n: number): void {
  if (running === n) return;
  running = n;
  emit();
}

export const useActivityRunning = (): number => useSyncExternalStore(subscribe, () => running);
