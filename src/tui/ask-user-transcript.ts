// Flow 401 (AC2): the line the transcript shows right after the ask_user question breadcrumb.
//
// Kept out of tui-shell.ts so a headless test can render exactly what the operator sees: an own
// answer (it is what the agent now acts on; redacted and flattened the way the journal keeps
// it, so a pasted credential never reaches the screen), a picked option with its typed reason, a
// plain pick, or a cancel.
import { storedOperatorText } from "../decisions/service";
import type { ComposerChoiceResult } from "./composer-choice";
import { dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export interface AskAnswerLineOption {
  id: string;
  label: string;
}

/** Adds the answer line to `transcript`. */
export function mountAskAnswerLine(
  otui: OpenTui,
  renderer: ConstructorParameters<OpenTui["TextRenderable"]>[0],
  transcript: { add: (node: never) => unknown },
  id: string,
  options: readonly AskAnswerLineOption[],
  result: ComposerChoiceResult,
  cancelId = "__cancel__",
): void {
  let content: ReturnType<typeof otui.t>;
  if (result.kind === "own") {
    content = otui.t`${roleChunk(otui, "ok", "→ ✍")} ${dimChunk(otui, storedOperatorText(result.text))}`;
  } else if (result.id === cancelId) {
    content = otui.t`${dimChunk(otui, "→ cancelled")}`;
  } else {
    const label = options.find((o) => o.id === result.id)?.label ?? result.id;
    content =
      result.kind === "reason"
        ? otui.t`${roleChunk(otui, "ok", "→")} ${dimChunk(otui, label)} ${dimChunk(otui, `— ${storedOperatorText(result.reason)}`)}`
        : otui.t`${roleChunk(otui, "ok", "→")} ${dimChunk(otui, label)}`;
  }
  transcript.add(new otui.TextRenderable(renderer, { id, content }) as never);
}
