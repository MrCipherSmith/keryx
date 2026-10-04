// Host bridge for `ask_user` tool ↔ TUI composer-dock picker.
//
// makeAgentDeps builds tools before the TUI dock exists; the TUI registers the
// real interactive host here, and the tool invokes through this bridge.

import { randomUUID } from "node:crypto";
import type { AskUserFn } from "../harness/tool/builtin/ask-user-tool";
import { journalAsk, resolveFlowContext } from "../decisions/service";

let host: AskUserFn | undefined;

export function setAskUserHost(fn: AskUserFn | undefined): void {
  host = fn;
}

export async function invokeAskUserHost(
  request: Parameters<AskUserFn>[0],
): ReturnType<AskUserFn> {
  if (host === undefined) {
    return "__cancel__";
  }
  return host(request);
}

// Flow 392: where the blind-mode reveal is shown. The TUI registers the
// transcript; without one the reveal is simply not shown (the journal has it).
let notice: ((text: string) => void) | undefined;

// The latest question answered through the journal: what `/decisions reason` and
// `/decisions change` act on when no id is given.
let lastDecisionId: string | undefined;

// One id per running shell, recorded on every question it journals: `/decisions change`
// without an id may only touch a decision that carries this id, never another session's.
const sessionId = `s-${randomUUID()}`;

export function askUserSessionId(): string {
  return sessionId;
}

export function lastAskUserDecisionId(): string | undefined {
  return lastDecisionId;
}

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
    // the flow and its stage come from the checkout (env, branch, the one flow in progress), not only from KERYX_FLOW
    session: sessionId,
    context: () => resolveFlowContext(cwd),
    notify: (text) => notice?.(text),
    // a journaling failure is shown as a note in the transcript; the question itself is never stopped by it
    onNote: (text) => notice?.(text),
    onDecision: (id) => {
      lastDecisionId = id;
    },
  });
  return (request) => (host === undefined ? invokeAskUserHost(request) : journaled(request));
}
