// Bridges `AgentIO` (`src/commands/agent.ts`) to ACP `session/update`
// notifications, streamed as the turn runs (AC2) — never buffered to the end.
// Flow 285, T8.

import { randomUUID } from "node:crypto";
import type { AgentIO, ApprovalMeta, ApprovalResponse } from "../commands/agent";
import type { InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { approvalFromPermissionResponse, permissionOptionsFor } from "./permission";
import {
  textBlock,
  type AcpPermissionOption,
  type AcpRequestPermissionResponse,
  type AcpSessionId,
  type AcpSessionUpdate,
  type AcpToolCallUpdate,
  type AcpToolKind,
} from "./protocol";

export type AcpUpdateSink = (sessionId: AcpSessionId, update: AcpSessionUpdate) => void;

/** What keryx needs the connection to ask the client, minus the transport. */
export interface AcpPermissionRequest {
  /** The call being authorised, carrying the id the client was already shown (F-3). */
  readonly toolCall: AcpToolCallUpdate;
  readonly options: readonly AcpPermissionOption[];
}

/**
 * Sends one `session/request_permission` and returns the client's answer.
 *
 * `undefined` means the client COULD NOT BE ASKED — it refused the method, the
 * connection ended with the question open, or it answered something that is
 * not an answer. Every one of those is a denial here (see
 * {@link createAcpAgentIo}); none of them is an approval-by-default.
 */
export type AcpPermissionAsker = (
  request: AcpPermissionRequest,
) => Promise<AcpRequestPermissionResponse | undefined>;

const TOOL_KIND_BY_NAME: Readonly<Record<string, AcpToolKind>> = {
  get_cwd: "read",
  list_dir: "read",
  read_file: "read",
  search_code: "search",
  apply_patch: "edit",
  shell_exec: "execute",
  web_fetch: "fetch",
  web_search: "search",
};

function toolKindFor(name: string): AcpToolKind {
  return TOOL_KIND_BY_NAME[name] ?? "other";
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A model-emitted argument string is not guaranteed valid JSON; the raw
    // text is still worth reporting rather than dropping the update.
    return text;
  }
}

/**
 * Builds the `AgentIO` a `session/prompt` turn runs with.
 *
 * F-3 (context.md §5): `onToolCall(name, input)` / `onToolResult(name,
 * result)` carry no id — ACP's `tool_call`/`tool_call_update` need one. This
 * mints a `toolCallId` per `onToolCall` and correlates the matching
 * `onToolResult` to the OLDEST still-open call of the SAME NAME (a per-name
 * FIFO queue) — the closest approximation available without threading an id
 * through `AgentIO` itself. Two concurrent calls to the same tool with the
 * same input are indistinguishable and resolve in start order; that
 * limitation is inherent to the hook shape (documented in `context.md` F-3),
 * not introduced by this adapter.
 *
 * `askPermission` (T9, AC3) turns keryx's approval gate into ACP's
 * `session/request_permission`. It is OPTIONAL, and its absence is `AgentIO`'s
 * own documented default-deny floor: with no `requestApproval` wired, a
 * shell/write/destructive call is refused before it runs rather than silently
 * permitted. When it IS wired, every answer that is not an explicit allow —
 * a rejection, `cancelled`, an unknown option id, a client that cannot be
 * asked at all — comes back as `false`, which is the same denial the local
 * operator's "no" produces (`executeCall`: "command not approved by the user;
 * not executed"). There is no path through this bridge from silence to a
 * running tool.
 */
export function createAcpAgentIo(
  sessionId: AcpSessionId,
  send: AcpUpdateSink,
  askPermission?: AcpPermissionAsker,
): AgentIO {
  const pendingByName = new Map<string, string[]>();

  const emit = (update: AcpSessionUpdate): void => send(sessionId, update);

  /** Mints an id for a call, announces it as `tool_call`, and opens it in the per-name FIFO. */
  const openToolCall = (name: string, input: string, front = false): string => {
    const toolCallId = randomUUID();
    const queue = pendingByName.get(name) ?? [];
    if (front) {
      queue.unshift(toolCallId);
    } else {
      queue.push(toolCallId);
    }
    pendingByName.set(name, queue);
    emit({
      sessionUpdate: "tool_call",
      toolCallId,
      title: name,
      name,
      kind: toolKindFor(name),
      status: "in_progress",
      rawInput: tryParseJson(input),
    });
    return toolCallId;
  };

  /**
   * ACP's ask, built on keryx's gate.
   *
   * ORDER IS THE POINT (F-3): the client must already have been shown the call
   * it is being asked to authorise. `runAgentTurn` calls `onToolCall` before
   * `executeCall` reaches the approval gate, so the `tool_call` update is
   * already on the wire and its id is the head of this tool's FIFO — the same
   * id `onToolResult` will later close. The fallback covers the one path where
   * a gate runs without a preceding `onToolCall` (the concurrent
   * `spawn_subagent` pre-pass, which approves before the batch loop announces):
   * it announces the call FIRST and puts its id at the head of the queue, so
   * the client still sees what it is approving and the result still lands on
   * that id. Never ask about a call the client has not been shown.
   */
  const requestApproval = async (
    tool: string,
    input: string,
    meta?: ApprovalMeta,
  ): Promise<ApprovalResponse> => {
    if (askPermission === undefined) {
      return false;
    }
    const toolCallId = pendingByName.get(tool)?.[0] ?? openToolCall(tool, input, true);
    const options = permissionOptionsFor(meta);
    const response = await askPermission({
      toolCall: {
        toolCallId,
        title: tool,
        name: tool,
        kind: toolKindFor(tool),
        // ACP's `pending` is precisely this state: the call exists and is
        // waiting on a decision. The `in_progress` the `tool_call` update
        // carried is superseded here and again by the result update.
        status: "pending",
        rawInput: tryParseJson(input),
      },
      options,
    });
    if (response === undefined) {
      // The client could not be asked. A call nobody authorised does not run.
      return false;
    }
    return approvalFromPermissionResponse(response, options, meta?.fingerprint);
  };

  return {
    ...(askPermission !== undefined ? { requestApproval } : {}),
    write: (text) => {
      if (text.length === 0) {
        return;
      }
      emit({ sessionUpdate: "agent_message_chunk", content: textBlock(text) });
    },
    onReasoningDelta: (delta) => {
      if (delta.redacted === true || delta.text === undefined || delta.text.length === 0) {
        return;
      }
      emit({ sessionUpdate: "agent_thought_chunk", content: textBlock(delta.text) });
    },
    onToolCall: (name, input) => {
      openToolCall(name, input);
    },
    onToolResult: (name, result: InteractiveToolResult) => {
      const queue = pendingByName.get(name);
      const toolCallId = queue?.shift();
      emit({
        sessionUpdate: "tool_call_update",
        // A result with no matching start (should not happen — `onToolCall`
        // always precedes `onToolResult` for the same call — but a fresh id
        // is still a reportable update rather than a silently dropped one).
        toolCallId: toolCallId ?? randomUUID(),
        status: result.isError ? "failed" : "completed",
        content: [{ type: "content", content: textBlock(result.output) }],
        rawOutput: result.output,
      });
    },
    onSystem: (text) => {
      if (text.length === 0) {
        return;
      }
      emit({ sessionUpdate: "agent_message_chunk", content: textBlock(text) });
    },
  };
}
