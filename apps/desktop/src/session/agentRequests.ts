// keryx's requests to the window (session/request_permission, _keryx/ask_user): which become a dialog.
// No React; the hook supplies the registry and the queue.

import { RpcError } from "../acp/client";
import type { AskUserRequest, AskUserResult, PermissionOutcome, PermissionRequest } from "../acp/types";
import type { DialogQueue } from "./dialogQueue";
import type { SessionRegistry } from "./sessionRegistry";

const CANCELLED: PermissionOutcome = { outcome: "cancelled" };

/**
 * Answers one request keryx sends to the client. A dialog is raised only for a session the registry
 * admits (a turn running, or a command in flight); everything else is answered "cancelled".
 */
export async function answerAgentRequest(
  method: string,
  params: unknown,
  reg: Pick<SessionRegistry, "admit">,
  dialogs: Pick<DialogQueue, "permission" | "ask">,
): Promise<unknown> {
  if (method === "session/request_permission") {
    const sid = reg.admit(params);
    if (!sid) return { outcome: CANCELLED };
    return { outcome: await dialogs.permission(sid, params as PermissionRequest) };
  }
  if (method === "_keryx/ask_user") {
    const sid = reg.admit(params);
    if (!sid) return { outcome: "cancelled" } satisfies AskUserResult;
    return dialogs.ask(sid, params as AskUserRequest);
  }
  throw new RpcError(-32601, `Method not found: ${method}`);
}
