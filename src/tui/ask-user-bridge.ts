// Host bridge for `ask_user` tool ↔ TUI composer-dock picker.
//
// makeAgentDeps builds tools before the TUI dock exists; the TUI registers the
// real interactive host here, and the tool invokes through this bridge.

import { ASK_USER_NO_HOST, type AskUserFn } from "../harness/tool/builtin/ask-user-tool";

let host: AskUserFn | undefined;


export function setAskUserHost(fn: AskUserFn | undefined): void {
  host = fn;
}

export async function invokeAskUserHost(
  request: Parameters<AskUserFn>[0],
): Promise<string> {
  if (host === undefined) {
    // Fail closed with a NAMED cause. `setAskUserHost` has exactly one caller
    // (`src/tui/tui-shell.ts`), so every other surface — `keryx shell --no-tui`,
    // a non-TTY, or any TUI init falling back to readline — lands here on EVERY
    // `ask_user` call. Returning the shared Esc-cancel sentinel here reported a
    // human dismissal for a question no human ever saw; `ASK_USER_NO_HOST` makes
    // the tool result say what actually happened. An unasked question must never
    // be reported as an answered one — the fix for that silence is this named
    // cause, never a synthetic answer.
    return ASK_USER_NO_HOST;
  }
  return host(request);
}
