// `/decisions reason <why>` and `/decisions change <option>`: the TUI's follow-ups to the latest decision answered in this
// session (tui/decisions-surface.ts decisionsFollowup), over the same decision journal the native question journal writes.
// A follow-up acts only on a decision this session asked; the flow fallback reads nothing from the machine's environment.
import { validateArguments, type Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import { decisionsFollowup } from "../../tui/decisions-surface";
import type { NativeCommandContribution, SessionCommandContext } from "./handlers";

export type DecisionFollowupCommand = "decisions.reason" | "decisions.change";
export type DecisionFollowupResult =
  | { ok: true; source: "local-native"; data: { decisionId: string | null; text: string } }
  | { ok: false; source: "local-native"; error: { code: "invalid-arguments" | "implementation-gap" | "refused"; message: string } };

const closed = (field: string, maxLength: number): Control["ArgumentSchema"] => ({ type: "object", additionalProperties: false, properties: { [field]: { type: "string", maxLength } }, required: [field] });
/** The words after the verb, as the TUI joins them; a reason is cut by the journal at its own bound, an option is an id or a label. */
const schemas: Record<DecisionFollowupCommand, Control["ArgumentSchema"]> = { "decisions.reason": closed("text", 8000), "decisions.change": closed("choice", 8192) };
function failure(code: Extract<DecisionFollowupResult, { ok: false }>["error"]["code"], message: string): DecisionFollowupResult {
  return { ok: false, source: "local-native", error: { code, message } };
}

export async function executeDecisionFollowup(context: Pick<SessionCommandContext, "cwd" | "decisionJournal">, command: DecisionFollowupCommand, input: unknown): Promise<DecisionFollowupResult> {
  if (!validateArguments(schemas[command], input).ok) return failure("invalid-arguments", "Arguments do not match the selected decisions follow-up.");
  const journal = context.decisionJournal;
  if (journal === undefined) return failure("implementation-gap", "This session has no decision journal; nothing was changed.");
  const args = input as { text?: string; choice?: string };
  const done = await decisionsFollowup(command === "decisions.reason" ? { kind: "reason", text: args.text ?? "" } : { kind: "change", choice: args.choice ?? "" },
    { cwd: context.cwd, lastDecisionId: journal.lastDecisionId, session: journal.session, flowContext: async () => ({}) });
  const text = redactSensitiveText(done.text.replaceAll(context.cwd, "."));
  return done.ok ? { ok: true, source: "local-native", data: { decisionId: done.decisionId ?? null, text } } : failure("refused", text);
}

export function decisionFollowupCommands(): NativeCommandContribution[] {
  return (Object.keys(schemas) as DecisionFollowupCommand[]).map((commandName) => ({
    entry: { commandName, summary: commandName === "decisions.reason" ? "Add or change the reason for this session's latest deviating answer" : "Change this session's latest answered decision",
      handlerId: `native.decisions.${commandName.slice("decisions.".length)}`, inputSchema: schemas[commandName], resultSchema: { type: "string", maxLength: 32768 },
      mutationClass: "session", states: ["idle"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "shared-decision-journal-follow-up" },
    execute: (context, request) => executeDecisionFollowup(context, commandName, request.arguments),
  }));
}
