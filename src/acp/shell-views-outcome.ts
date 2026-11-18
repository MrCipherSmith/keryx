// Turns a view or a shared subcommand's answer into the `ShellCommandOutcome` the
// `_keryx/command` runners return (T10b).

import type { ActionResult } from "../commands/shell-subcommands";
import type { ShellCommandOutcome } from "./shell-command-runners";
import { viewText, type ShellView } from "./shell-views";

/** A view answers with its plain-text rendering too, so a client that cannot render views still reads it. */
export function viewOutcome(view: ShellView): ShellCommandOutcome {
  return { text: viewText(view), view };
}

/** A subcommand's answer: a failure is a known command refused, a write tells the client to refresh its config. */
export function actionOutcome(result: ActionResult, effects: ShellCommandOutcome["effects"] = ["config"]): ShellCommandOutcome {
  if (!result.ok) return { text: result.text, refused: true };
  return { text: result.text, ...(result.changed === true && effects !== undefined && effects.length > 0 ? { effects } : {}) };
}

/** A known command refused with a reason: the view's action is not available in this host. */
export function refusal(reason: string): ShellCommandOutcome {
  return { text: reason.endsWith("\n") ? reason : `${reason}\n`, refused: true };
}
