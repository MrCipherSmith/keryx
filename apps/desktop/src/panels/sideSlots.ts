// Where the session view puts its Activity and Info content inside the window's side panel. The panel lives in
// the app shell, the session state in the session view: the panel offers an element per tab, the view
// portals into it (and reports how many runs are going, for the Activity tab's badge).

import { useSyncExternalStore } from "react";

export type SlotTab = "activity" | "info";

const slots: Record<SlotTab, HTMLElement | null> = { activity: null, info: null };
let running = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};

const refs: Record<SlotTab, (el: HTMLElement | null) => void> = {
  activity: (el) => setSlot("activity", el),
  info: (el) => setSlot("info", el),
};
function setSlot(tab: SlotTab, el: HTMLElement | null): void {
  if (slots[tab] === el) return;
  slots[tab] = el;
  emit();
}

/** A (stable) ref callback for the element that hosts `tab`'s content; null on unmount. */
export const slotRef = (tab: SlotTab) => refs[tab];

export const useSlot = (tab: SlotTab): HTMLElement | null => useSyncExternalStore(subscribe, () => slots[tab]);

/** The session view's running subagents and tasks. */
export function setActivityRunning(n: number): void {
  if (running === n) return;
  running = n;
  emit();
}

export const useActivityRunning = (): number => useSyncExternalStore(subscribe, () => running);
