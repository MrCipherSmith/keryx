// Host bridge for `ask_user` tool ↔ TUI composer-dock picker.
//
// makeAgentDeps builds tools before the TUI dock exists; the TUI registers the
// real interactive host here, and the tool invokes through this bridge.

import type { AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import { journalAsk } from "../decisions/service";

let host: AskUserFn | undefined;

export function setAskUserHost(fn: AskUserFn | undefined): void {
  host = fn;
}

export async function invokeAskUserHost(
  request: Parameters<AskUserFn>[0],
): Promise<string> {
  if (host === undefined) {
    return "__cancel__";
  }
  return host(request);
}

// Flow 392: where the blind-mode reveal is shown. The TUI registers the
// transcript; without one the reveal is simply not shown (the journal has it).
let notice: ((text: string) => void) | undefined;

export function setAskUserNotice(fn: ((text: string) => void) | undefined): void {
  notice = fn;
}

/**
 * `invokeAskUserHost` with the recommendation journal around it (flow 392): the
 * question is recorded before it is shown, a third are shown blind, the answer is
 * recorded and the recommendation revealed. A question nobody can answer (no host
 * registered, e.g. the line shell) is passed through unrecorded. The journal never
 * throws into the question: see `journalAsk`.
 */
export function journaledAskUser(cwd: string): AskUserFn {
  const journaled = journalAsk(invokeAskUserHost, {
    cwd,
    flow: process.env["KERYX_FLOW"] !== undefined && process.env["KERYX_FLOW"].length > 0 ? process.env["KERYX_FLOW"] : undefined,
    notify: (text) => notice?.(text),
  });
  return (request) => (host === undefined ? invokeAskUserHost(request) : journaled(request));
}
