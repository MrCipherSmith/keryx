// Bridges `AgentIO` (`src/commands/agent.ts`) to ACP `session/update`
// notifications, streamed as the turn runs (AC2) — never buffered to the end.
// Flow 285, T8.

import { randomUUID } from "node:crypto";
import type { AgentIO, ApprovalMeta, ApprovalResponse } from "../commands/agent";
import type { PermissionMode } from "../commands/permission-mode";
import type { InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { acpPermissionReasons, approvalFromPermissionResponse, permissionOptionsFor } from "./permission";
import {
  SYSTEM_NOTE_META,
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

/**
 * ACP `kind` per tool name — what the client uses to pick an icon and a
 * rendering. Every tool an ACP session can be offered is listed (flow 288,
 * AC2; `roster.test.ts` fails on a roster tool that falls back to `other`):
 *
 *   `search`  answers a query over many things — code, the graph, memory, the
 *             wiki's claims, related tests, an MCP catalog.
 *   `read`    fetches one named thing, or a fixed report — a file, a wiki
 *             page, flow or health status, a skill, the repo map.
 *   `execute` runs something outside keryx — a shell command, or a tool on one
 *             of the client's MCP servers.
 *   `edit`    changes files.
 */
const TOOL_KIND_BY_NAME: Readonly<Record<string, AcpToolKind>> = {
  get_cwd: "read",
  list_dir: "read",
  read_file: "read",
  apply_patch: "edit",
  shell_exec: "execute",
  web_fetch: "fetch",
  web_search: "search",
  // keryx's project tools (flow 288).
  search_code: "search",
  graph_find: "search",
  graph_query: "search",
  graph_symbol: "search",
  graph_path: "search",
  graph_affected: "search",
  memory_search: "search",
  wiki_ask: "search",
  wiki_resolve: "search",
  wiki_backlinks: "search",
  wiki_evidence: "search",
  test_related: "search",
  read_wiki: "read",
  wiki_freshness: "read",
  flow_status: "read",
  health_status: "read",
  skills_catalog: "read",
  skill_load: "read",
  skills_resolve_context: "read",
  repomap: "read",
  // The client's own MCP servers (flow 287).
  search_tool: "search",
  use_tool: "execute",
  // `keryx acp --profile shell` (Keryx Desktop Client M1): the rest of keryx shell's roster.
  shell_task_output: "read",
  shell_task_wait: "read",
  shell_task_kill: "execute",
  shell_job_output: "read",
  shell_job_kill: "execute",
  workspace_overview: "read",
  workspace_read: "read",
  workspace_list: "read",
  workspace_show: "read",
  workspace_create: "edit",
  workspace_propose: "edit",
  ask_user: "think",
  slate_read: "read",
  slate_write_seed: "edit",
  slate_note: "edit",
  slate_trail: "read",
  recall_step: "read",
  history_search: "search",
  spawn_subagent: "think",
  plan_get: "think",
  plan_set: "think",
  plan_update: "think",
};

/**
 * Tools that are allowed to render as `other` on purpose. Empty: every tool an
 * ACP session is offered has a kind above. A name added here is a decision
 * someone made, which is the point of keeping the list.
 */
export const ACP_TOOL_KIND_OTHER_EXCEPTIONS: ReadonlySet<string> = new Set<string>();

/**
 * The ACP `kind` for a tool by name, for a `tool_call`/`tool_call_update`.
 *
 * Exported (flow 285, T10): `session/load`'s history replay
 * (`server.ts:replayHistory`) rebuilds a `tool_call` from a stored
 * `NormalizedToolCall` the same way a LIVE turn's `onToolCall` does here — one
 * lookup table, not two that could drift.
 */
export function toolKindFor(name: string): AcpToolKind {
  return TOOL_KIND_BY_NAME[name] ?? "other";
}

/**
 * Parses a tool-call argument string as JSON for `rawInput`, falling back to
 * the raw text when it is not valid JSON (a model-emitted argument string is
 * not guaranteed to parse). Exported for the same reuse reason as
 * {@link toolKindFor}.
 */
export function tryParseJson(text: string): unknown {
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
 * mints exactly ONE `toolCallId` per actual tool call — whichever of
 * `onToolCall` and the approval gate reaches the adapter first announces it,
 * the other adopts it — and correlates the matching `onToolResult` to the
 * OLDEST still-open call of the SAME NAME (a per-name FIFO queue) — the
 * closest approximation available without threading an id
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
export interface AcpAgentIoOptions {
  /**
   * The shell profile's live permission mode (`trust`/`auto` skip the ask for
   * what `resolveApprovalDecision` allows). Absent: `ask`, the editor profile.
   * When present, a call the mode approved is reported on its own id as a
   * `tool_call_update` carrying `_meta.keryx.autoApproved: true`.
   */
  readonly permissionMode?: () => PermissionMode;
  /**
   * Shell profile: each `session/request_permission` says why keryx asks, as
   * `toolCall._meta.keryx.reasons` (`acpPermissionReasons`; PR #1213 review
   * security-code-w7 SEC-W7R3-001). Absent: the editor profile's request is
   * unchanged.
   */
  readonly permissionReasons?: boolean;
}

/** The `AgentIO` of one turn, plus the id the client was shown for a call (see {@link AcpAgentIo.toolCallIdFor}). */
export type AcpAgentIo = AgentIO & {
  /**
   * The `toolCallId` this turn announced for a call of `name` with `input`: the open call whose argument
   * string parses to the same value, else the oldest one open. `undefined` when none is open. The
   * shell profile hands it to `spawn_subagent` (`InteractiveToolContext.toolCallId`) so the client can
   * link a subagent to its `tool_call`. Two concurrent calls with identical input are
   * indistinguishable and resolve in start order, the same limit the per-name queue has.
   */
  toolCallIdFor(name: string, input: Record<string, unknown>): string | undefined;
};

export function createAcpAgentIo(
  sessionId: AcpSessionId,
  send: AcpUpdateSink,
  askPermission?: AcpPermissionAsker,
  ioOptions: AcpAgentIoOptions = {},
): AcpAgentIo {
  /**
   * One entry per ACP tool call that has been ANNOUNCED and not yet closed.
   *
   * `claimed` is what makes "exactly one id per call" hold when the approval
   * gate runs BEFORE `onToolCall` (see {@link requestApproval}): an entry the
   * permission path announced ahead of time is `claimed: false` until the
   * matching `onToolCall` adopts it, and an adopted entry never mints a second
   * id for the same call.
   */
  interface PendingToolCall {
    readonly toolCallId: string;
    /** The exact argument string both `requestApproval` and `onToolCall` are handed for this call. */
    readonly input: string;
    claimed: boolean;
  }
  const pendingByName = new Map<string, PendingToolCall[]>();

  const emit = (update: AcpSessionUpdate): void => send(sessionId, update);

  /** Mints an id for a call, announces it as `tool_call`, and opens it in the per-name FIFO. */
  const openToolCall = (name: string, input: string, claimed: boolean): string => {
    const toolCallId = randomUUID();
    const queue = pendingByName.get(name) ?? [];
    // ALWAYS in announcement order. The client sees these ids in this order,
    // and `onToolCall`/`onToolResult` below resolve within that order rather
    // than against it.
    queue.push({ toolCallId, input, claimed });
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
   * it is being asked to authorise, under the id that will later report the
   * outcome — ONE id per actual tool call, never two.
   *
   * `runAgentTurn` reaches this gate from two directions. Usually `onToolCall`
   * has already announced the call (`commands/agent.ts`, the per-call loop),
   * and the entry with this exact `input` is reused. But two paths approve
   * BEFORE that announcement: the untrusted-content taint gate (which asks,
   * then falls through to `io.onToolCall`) and the concurrent
   * `spawn_subagent` pre-pass (which approves inside `executeCall` before the
   * batch loop announces). Both used to produce a SECOND `tool_call` id for
   * the same call, and since `onToolResult` closes only one of them, the other
   * stayed "running" in the client forever. So this announces the call itself
   * when nothing matches, and marks the entry unclaimed — the `onToolCall`
   * that follows adopts it instead of minting another id.
   */
  /**
   * Flow 306 fix round 2 (finding D): `user_prompt` (the `UserPromptSubmit`
   * hook-ask gate, `commands/agent.ts`) asks THROUGH this same `requestApproval`
   * — the ONE seam every approval already goes through — but is not a real
   * tool call: no `executeCall` ever runs it, so it never reaches
   * `onToolCall`/`onToolResult` below. `openToolCall` above still announces it
   * as a `tool_call` (status `in_progress`, then `pending`) so the client can
   * see the thing it is authorising — F-3's own ordering requirement — but
   * with nothing to adopt or close it, that pseudo call stayed `pending` in
   * the client forever. Closed here, right after the answer, for exactly the
   * pseudo tool_call `openToolCall` opened for THIS call: a real tool's entry
   * is left alone (`onToolCall`/`onToolResult` still own it) by only acting
   * when the queue still holds an entry for `toolCallId`.
   */
  const closePseudoToolCall = (tool: string, toolCallId: string, approved: boolean): void => {
    if (tool !== "user_prompt") {
      return;
    }
    const queue = pendingByName.get(tool);
    const index = queue?.findIndex((entry) => entry.toolCallId === toolCallId) ?? -1;
    if (index < 0) {
      return;
    }
    queue?.splice(index, 1);
    emit({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: approved ? "completed" : "failed",
      content: [{ type: "content", content: textBlock(approved ? "approved" : "not approved") }],
    });
  };

  const requestApproval = async (
    tool: string,
    input: string,
    meta?: ApprovalMeta,
  ): Promise<ApprovalResponse> => {
    if (askPermission === undefined) {
      return false;
    }
    // Matched on the argument string, which every approval site in
    // `commands/agent.ts` passes verbatim from the same `call.input` that
    // reaches `onToolCall` — precise enough to pair the right call even when
    // several calls to the same tool are open at once.
    const pending = pendingByName.get(tool)?.find((entry) => entry.input === input);
    const toolCallId = pending?.toolCallId ?? openToolCall(tool, input, false);
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
        ...(ioOptions.permissionReasons === true ? { _meta: { keryx: { reasons: acpPermissionReasons(meta) } } } : {}),
      },
      options,
    });
    if (response === undefined) {
      // The client could not be asked. A call nobody authorised does not run.
      closePseudoToolCall(tool, toolCallId, false);
      return false;
    }
    const approved = approvalFromPermissionResponse(response, options, meta?.fingerprint, meta?.mcpTrustAvailable === true);
    // `ApprovalResponse` is `boolean | {approved, fingerprint?}` (the
    // "allow_always" shape carries a fingerprint for the allowlist match
    // elsewhere) — `closePseudoToolCall` only needs the plain outcome.
    closePseudoToolCall(tool, toolCallId, typeof approved === "boolean" ? approved : approved.approved);
    return approved;
  };

  /**
   * A permission mode let this call run unasked. The call was already announced
   * (`onToolCall` precedes the gate in `runAgentTurn`'s batch loop), so the mark
   * goes on THAT id; a call with no announced entry is announced here first, so
   * the client never sees a mark for an id it was not shown.
   */
  const onAutoApproved = (tool: string, input: string): void => {
    const pending = pendingByName.get(tool)?.find((entry) => entry.input === input);
    const toolCallId = pending?.toolCallId ?? openToolCall(tool, input, false);
    emit({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "in_progress",
      _meta: { keryx: { autoApproved: true } },
    });
  };

  const toolCallIdFor = (name: string, input: Record<string, unknown>): string | undefined => {
    const open = pendingByName.get(name) ?? [];
    const wanted = JSON.stringify(input);
    const exact = open.find((entry) => JSON.stringify(tryParseJson(entry.input)) === wanted);
    return (exact ?? open[0])?.toolCallId;
  };

  const permissionMode = ioOptions.permissionMode;
  return {
    toolCallIdFor,
    ...(askPermission !== undefined ? { requestApproval } : {}),
    ...(permissionMode !== undefined ? { permissionMode, onAutoApproved } : {}),
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
      // A call the permission path already announced (see `requestApproval`)
      // is ADOPTED here, not announced again: the client keeps the one id it
      // was shown, and that id is the one `onToolResult` closes below.
      const announcedAhead = pendingByName.get(name)?.find((entry) => !entry.claimed && entry.input === input);
      if (announcedAhead !== undefined) {
        announcedAhead.claimed = true;
        return;
      }
      openToolCall(name, input, true);
    },
    onToolResult: (name, result: InteractiveToolResult) => {
      const queue = pendingByName.get(name);
      // The oldest call this adapter has actually SEEN start (F-3's per-name
      // FIFO). Preferring a claimed entry keeps the pairing right when the
      // permission path announced a call whose `onToolCall` has not arrived
      // yet — that entry belongs to a later result, not this one. With none
      // claimed, the head is the call being closed: the gate refused it before
      // `onToolCall` was ever reached, and its announced id is still the one
      // to report against.
      //
      // "Oldest claimed" is correct because the queue is never MIXED in a way
      // that would defeat it, not because it is correct in general: the batch
      // loop in `commands/agent.ts` runs calls for one tool name strictly in
      // sequence (at most one entry open at a time), and the only concurrent
      // path — the `spawn_subagent` pre-pass — leaves every entry unclaimed
      // while it runs. A future caller that can hold a claimed entry open
      // AHEAD of an unclaimed one would close the wrong call here, and would
      // need a real per-call token rather than this ordering argument.
      const index = queue?.findIndex((entry) => entry.claimed) ?? -1;
      const pending = queue?.splice(index >= 0 ? index : 0, 1)[0];
      const toolCallId = pending?.toolCallId;
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
      // keryx's own note, not the model's words: `_meta.keryx.system` lets a client show it apart
      // from the reply it would otherwise run into. A client that does not know the meta shows the text.
      emit({ sessionUpdate: "agent_message_chunk", content: textBlock(text), _meta: SYSTEM_NOTE_META });
    },
  };
}
