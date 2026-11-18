// The window's one `/delegate` terminal registry, as the transcript's result card sees it: whether a run's
// tab is still open, and a way to bring it forward. `useAcpSession` registers the live `DelegateTerminals`;
// the card (rendered far from the hook) reads through here instead of through prop threading.
export interface DelegateApi {
  focus(runId: string): boolean;
  isOpen(runId: string): boolean;
}
let api: DelegateApi | null = null;
const listeners = new Set<() => void>();
export function setDelegateApi(next: DelegateApi | null): void {
  api = next;
  notifyDelegateChange();
}
/** Show the run's terminal tab; false when it is closed or unknown. */
export const focusDelegateRun = (runId: string): boolean => api?.focus(runId) ?? false;
export const isDelegateRunOpen = (runId: string): boolean => api?.isOpen(runId) ?? false;
export function notifyDelegateChange(): void {
  listeners.forEach((l) => l());
}
export function onDelegateChange(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
