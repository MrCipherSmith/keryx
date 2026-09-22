// Bridges `AgentIO` (`src/commands/agent.ts`) to ACP `session/update`
// notifications, streamed as the turn runs (AC2) — never buffered to the end.
// Flow 285, T8.

import { randomUUID } from "node:crypto";
import type { AgentIO } from "../commands/agent";
import type { InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { textBlock, type AcpSessionId, type AcpSessionUpdate, type AcpToolKind } from "./protocol";

export type AcpUpdateSink = (sessionId: AcpSessionId, update: AcpSessionUpdate) => void;

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
 * `requestApproval` is deliberately NOT set here (T9's scope). Its absence is
 * `AgentIO`'s own documented default-deny floor: a shell/destructive call is
 * refused before it runs rather than silently permitted, and no ask ever
 * reaches this bridge to forward — there is nothing to wire until T9 adds it.
 */
export function createAcpAgentIo(sessionId: AcpSessionId, send: AcpUpdateSink): AgentIO {
  const pendingByName = new Map<string, string[]>();

  const emit = (update: AcpSessionUpdate): void => send(sessionId, update);

  return {
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
      const toolCallId = randomUUID();
      const queue = pendingByName.get(name) ?? [];
      queue.push(toolCallId);
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
