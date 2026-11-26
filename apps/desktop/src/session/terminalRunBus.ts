// The window's Run tracker (`terminalRuns.ts`) as the transcript's run card sees it: the card's two
// actions. `useAcpSession` registers the live tracker; the card (rendered far from the hook) calls through
// here instead of through prop threading, like `delegateBus.ts`.
export interface TerminalRunApi {
  /** Show the run's tab; false when it is closed or unknown. */
  showTab(runId: string): boolean;
  /** Send a snapshot of a running run's output to its session. */
  sendNow(runId: string): void;
}

let api: TerminalRunApi | null = null;

export function setTerminalRunApi(next: TerminalRunApi | null): void {
  api = next;
}

export const showTerminalRunTab = (runId: string): boolean => api?.showTab(runId) ?? false;
export const sendTerminalRunNow = (runId: string): void => api?.sendNow(runId);
