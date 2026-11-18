// `ask_user` over ACP: the `_keryx/ask_user` agent → client request
// (Keryx Desktop Client M1, specification §3.6).
//
// ACP v1 has no question primitive the shell's `ask_user` fits (elicitation is a
// form, not a pick-one with descriptions), so keryx sends its own extension
// request — and only to a client that said it answers one
// (`initialize.clientCapabilities._meta.keryx.askUser === true`). Without that
// the tool is not offered at all (`shell-roster.ts`).
//
// Every answer that is not an answer — `cancelled`, a transport error, a
// malformed result, the turn being cancelled — reaches the model as a declined
// question (`ASK_USER_CANCEL`), never as a pick.
//
// Pure: importing this reads nothing and spawns nothing.

import { ASK_USER_CANCEL, type AskUserAnswer, type AskUserRequest } from "../harness/tool/builtin/ask-user-tool";
import type { AcpClientCapabilities, AcpMeta, AcpSessionId } from "./protocol";

export interface KeryxAskUserOption {
  readonly label: string;
  readonly description: string;
}

export interface KeryxAskUserParams {
  readonly sessionId: AcpSessionId;
  readonly question: string;
  readonly options: readonly KeryxAskUserOption[];
  readonly multiSelect: boolean;
  readonly _meta?: AcpMeta;
}

export type KeryxAskUserResult =
  | { readonly outcome: "answered"; readonly answers: readonly string[] }
  | { readonly outcome: "cancelled" };

/** True when the client advertised it answers `_keryx/ask_user`. */
export function clientAnswersAskUser(capabilities: AcpClientCapabilities | undefined): boolean {
  const keryx = capabilities?._meta?.["keryx"];
  return typeof keryx === "object" && keryx !== null && (keryx as Record<string, unknown>)["askUser"] === true;
}

/** The request keryx sends for one `ask_user` call. Extras the spec does not name ride in `_meta.keryx`. */
export function askUserParams(sessionId: AcpSessionId, request: AskUserRequest): KeryxAskUserParams {
  const recommended = request.options.find((option) => option.recommended === true);
  return {
    sessionId,
    question: request.question,
    options: request.options.map((option) => ({ label: option.label, description: option.description })),
    multiSelect: false,
    _meta: {
      keryx: {
        allowFreeform: request.allowFreeform === true,
        ...(recommended !== undefined ? { recommended: recommended.label } : {}),
        ...(request.irreversible === true ? { irreversible: true } : {}),
        ...(request.untrustedContent === true ? { untrustedContent: true } : {}),
      },
    },
  };
}

/**
 * The client's result as the tool's answer. A label (or an option id) picks that
 * option; any other non-empty text is the person's own answer; anything else —
 * `cancelled`, no answers, a malformed result — is a declined question.
 */
export function askUserAnswerFromResult(result: unknown, request: AskUserRequest): AskUserAnswer {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return ASK_USER_CANCEL;
  const record = result as Record<string, unknown>;
  if (record["outcome"] !== "answered" || !Array.isArray(record["answers"])) return ASK_USER_CANCEL;
  const first = record["answers"].find((answer): answer is string => typeof answer === "string" && answer.trim().length > 0);
  if (first === undefined) return ASK_USER_CANCEL;
  const text = first.trim();
  const picked =
    request.options.find((option) => option.label === text) ?? request.options.find((option) => option.id === text);
  if (picked !== undefined) return picked.id;
  return { kind: "own", text };
}
