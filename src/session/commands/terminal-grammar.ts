// Terminal text forms for native operations the TUI reaches only through a modal (model/provider picker,
// MCP consumer view, routing inspector, approval and question cards, session picker). Pure parsing: each form produces the
// exact closed typed request of the catalogue handler the modal's action calls, or a refusal with its usage.
// Nothing here defaults a field the typed schema requires.
import type { Control } from "../../remote-control/protocol";
import { MCP_TRUST_USAGE, parseMcpTrustCommand } from "../../mcp-servers/approval-render";
import { HISTORY_USAGE, parseHistoryArgs } from "../../remote/history";
import { parseQueueCommand } from "../../tui/main-queue";

type Args = { [key: string]: Control["BoundedJson"] };
/** Pins the terminal resolves from this session's own typed pending list before it sends the answer. */
export type TerminalPins = { kind: "approval"; approvalId: string } | { kind: "question"; questionId: string }
  /** The session's current history version, the pin a rewind preview is taken against. */
  | { kind: "history-version" }
  /** The exact pins of this terminal's last rewind preview (`/rewind confirm`). */
  | { kind: "rewind-confirm" }
  /** The selected session's current record pins (version; for a resume also its held controller, history version and baseline). */
  | { kind: "session-target"; sessionId: string }
  /** This session's history pins and the target checkout's inventory pins a fork names. */
  | { kind: "fork-source"; targetCheckoutId: string };
/** A queued item the operator named by its qN position; the terminal applies the frozen QueueRemove/QueueEdit operation to it. */
export interface TerminalQueueAction { action: "remove" | "edit"; position: number; text?: string }
/** A typed request for the shared handler, or the TUI's own refusal. Never a positional argument list. */
export type TerminalCommandParse = { ok: true; commandName: string; arguments: Args; pins?: TerminalPins; queue?: TerminalQueueAction } | { ok: false; commandName: string; reason: string };
export const refuse = (commandName: string, reason: string): TerminalCommandParse => ({ ok: false, commandName, reason });
export const typed = (commandName: string, args: Args = {}): TerminalCommandParse => ({ ok: true, commandName, arguments: args });

/** One bounded identifier token: what the catalogue's 200-character id fields accept, without whitespace. */
const ID = /^[^\s]{1,200}$/;
const words = (rest: string): string[] => rest.split(/\s+/).filter((word) => word.length > 0);

export const MODEL_USAGE = "Usage: /model [candidateId]";
/** `/model <candidateId>` is the picker's selection; the typed manual-baseline pick. */
export function parseModelText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("model");
  return parts.length === 1 && ID.test(parts[0]!) ? typed("model", { candidateId: parts[0]! }) : refuse("model", MODEL_USAGE);
}

export const CONNECT_USAGE = "Usage: /connect [test <candidateId>|select <candidateId>]";
/** `/connect test|select <candidateId>`: the Providers dialog's probe and pick actions. Credential entry stays in the dialog. */
export function parseConnectText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("connect");
  const [action, id] = parts;
  return parts.length === 2 && (action === "test" || action === "select") && ID.test(id!) ? typed(`connect.${action}`, { id: id! }) : refuse("connect", CONNECT_USAGE);
}

export const MCP_USAGE = `Usage: /mcp [disconnect <server>] | ${MCP_TRUST_USAGE}`;
/** `/mcp trust …` is the shipped TUI grammar; `/mcp disconnect <server>` is the consumer view's disconnect action. */
export function parseMcpText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("mcp");
  if (parts[0] === "disconnect") return parts.length === 2 && ID.test(parts[1]!) ? typed("mcp.disconnect", { name: parts[1]! }) : refuse("mcp", MCP_USAGE);
  const trust = parseMcpTrustCommand(`/mcp ${parts.join(" ")}`);
  if (trust === undefined || trust.kind === "usage") return refuse("mcp", trust === undefined ? MCP_USAGE : `${trust.reason}. ${MCP_USAGE}`);
  if (trust.kind === "list") return typed("mcp.trust-list");
  if (trust.kind === "revoke-all") return typed("mcp.trust-revoke-all");
  return ID.test(trust.target) ? typed("mcp.trust-revoke-fqn", { fqn: trust.target }) : refuse("mcp", MCP_USAGE);
}

export const ROUTING_CONFIGURE_USAGE = "Usage: /routing configure on|off profile=<id> candidates=<id,id,…> fallback=<id>";
/** `/routing configure …`: the routing inspector's save action. Every field of the closed routing input is explicit. */
export function parseRoutingText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("routing");
  if (parts[0] !== "configure" || parts.length !== 5 || (parts[1] !== "on" && parts[1] !== "off")) return refuse("routing", ROUTING_CONFIGURE_USAGE);
  const fields = new Map<string, string>();
  for (const part of parts.slice(2)) {
    const separator = part.indexOf("=");
    const key = part.slice(0, separator); const value = part.slice(separator + 1);
    if (separator <= 0 || fields.has(key) || !["profile", "candidates", "fallback"].includes(key) || value.length === 0) return refuse("routing", ROUTING_CONFIGURE_USAGE);
    fields.set(key, value);
  }
  const candidateIds = fields.get("candidates")!.split(",");
  if ([fields.get("profile")!, fields.get("fallback")!, ...candidateIds].some((id) => !ID.test(id)) || candidateIds.length > 128 || new Set(candidateIds).size !== candidateIds.length) return refuse("routing", ROUTING_CONFIGURE_USAGE);
  return typed("routing.configure", { enabled: parts[1] === "on", profileId: fields.get("profile")!, candidateIds, fallbackCandidateId: fields.get("fallback")! });
}

export const APPROVALS_USAGE = "Usage: /approvals [allow-once <approvalId>|deny <approvalId>]";
/** `/approvals allow-once|deny <approvalId>`: the approval card's two buttons. The run/turn/fingerprint/policy pins are the pending card's own. */
export function parseApprovalsText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("approvals");
  const [action, approvalId] = parts;
  if (parts.length !== 2 || (action !== "allow-once" && action !== "deny") || !ID.test(approvalId!)) return refuse("approvals", APPROVALS_USAGE);
  return { ok: true, commandName: `approvals.${action}`, arguments: { approvalId: approvalId! }, pins: { kind: "approval", approvalId: approvalId! } };
}

export const QUESTION_ANSWER_USAGE = "Usage: /questions.answer <questionId> <optionId> [--reason <text>] | <questionId> --own <text> | <questionId> --cancel";
/** `/questions.answer …`: the question card's option, own-answer and cancel actions. */
export function parseQuestionAnswerText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  const [questionId, choice, flag] = parts;
  if (questionId === undefined || choice === undefined || !ID.test(questionId)) return refuse("questions.answer", QUESTION_ANSWER_USAGE);
  // Free text keeps its own spacing: only the leading tokens are removed.
  const tail = (from: number) => parts.length <= from ? "" : rest.trim().replace(new RegExp(`^(?:\\S+\\s+){${from}}`), "").trim();
  let answers: Args;
  if (choice === "--cancel") { if (parts.length !== 2) return refuse("questions.answer", QUESTION_ANSWER_USAGE); answers = { kind: "cancel" }; }
  else if (choice === "--own") { const text = tail(2); if (text.length === 0 || text.length > 8000) return refuse("questions.answer", QUESTION_ANSWER_USAGE); answers = { kind: "own", text }; }
  else if (choice.startsWith("--") || !ID.test(choice)) return refuse("questions.answer", QUESTION_ANSWER_USAGE);
  else if (flag === undefined) answers = { kind: "option", choice };
  else { const reason = tail(3); if (flag !== "--reason" || reason.length === 0 || reason.length > 8000) return refuse("questions.answer", QUESTION_ANSWER_USAGE); answers = { kind: "option", choice, reason }; }
  return { ok: true, commandName: "questions.answer", arguments: { questionId, answers }, pins: { kind: "question", questionId } };
}

/** `/history [N]` is the shipped remote-history grammar: no number reads the whole ordered history, N reads its last N messages. */
export function parseHistoryText(rest: string): TerminalCommandParse {
  if (words(rest).length === 0) return typed("history");
  const parsed = parseHistoryArgs(rest);
  return parsed.ok ? typed("history", { count: parsed.count }) : refuse("history", HISTORY_USAGE);
}

/** One optional selector after the command: the inspector modal's drill-down pick (a Flow, workspace or trigger). */
function selected(commandName: string, rest: string, field: string, usage: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed(commandName);
  return parts.length === 1 && ID.test(parts[0]!) ? typed(commandName, { [field]: parts[0]! }) : refuse(commandName, usage);
}
export const FLOWS_USAGE = "Usage: /flows [flowId]";
/** `/flows <flowId>`: the Flow inspector's selection of one Flow. */
export function parseFlowsText(rest: string): TerminalCommandParse { return selected("flows", rest, "flowId", FLOWS_USAGE); }
export const AC_USAGE = "Usage: /ac [flowId]  (running the checks has no typed native request)";
/** `/ac <flowId>`: the AC tab of one selected Flow, cached results only. `check` executes checks and is refused. */
export function parseAcText(rest: string): TerminalCommandParse {
  return words(rest).includes("check") ? refuse("ac", AC_USAGE) : selected("ac", rest, "flowId", AC_USAGE);
}
export const WORKSPACE_USAGE = "Usage: /workspace [workspaceId]";
/** `/workspace <workspaceId>`: the workspace inspector's selection and its slates. */
export function parseWorkspaceText(rest: string): TerminalCommandParse { return selected("workspace", rest, "workspaceId", WORKSPACE_USAGE); }
export const TRIGGERS_USAGE = "Usage: /triggers [name]  (running a trigger has no typed native request)";
/** `/triggers <name>`: the triggers inspector's selection of one configured trigger. Running one is refused. */
export function parseTriggersText(rest: string): TerminalCommandParse { return selected("triggers", rest, "name", TRIGGERS_USAGE); }
export const FLOW_ORIGIN_READ_USAGE = "Usage: /flow origin <flowId>  (setting an origin and the recent-origin summary have no typed native request)";
/** `/flow origin <flowId>` reads one Flow; the shipped set form (`<id> <kind> --reason …`) and the bare summary are refused. */
export function parseFlowOriginText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  return parts.length === 2 && parts[0] === "origin" && ID.test(parts[1]!) ? typed("flow", { flowId: parts[1]! }) : refuse("flow", FLOW_ORIGIN_READ_USAGE);
}
export const REVIEWS_USAGE = "Usage: /reviews [depth]";
/** `/reviews depth`: the reviews panel's per-review depth (readiness, parity, layers) without the bot metrics. */
export function parseReviewsText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("reviews");
  return parts.length === 1 && parts[0] === "depth" ? typed("reviews", { section: "depth" }) : refuse("reviews", REVIEWS_USAGE);
}
/** `/projectctx last|references`: the inspector's Last resolve and References tabs in full. `undefined`: the shipped TUI grammar decides. */
export function parseProjectContextTab(rest: string): TerminalCommandParse | undefined {
  const parts = words(rest);
  if (parts.length !== 1) return undefined;
  return parts[0] === "last" ? typed("projectctx.last") : parts[0] === "references" ? typed("projectctx.references") : undefined;
}

export const REWIND_USAGE = "Usage: /rewind [N [files|history|both]] · /rewind confirm";
/**
 * The shipped readline grammar (src/rewind/readline-command.ts): `/rewind` lists, `/rewind N [mode]` previews one snapshot
 * (default files) and `/rewind confirm` applies the pending preview. Natively the apply is the confirmed rewind.apply of that preview.
 */
export function parseRewindText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("rewind");
  if (parts.length === 1 && parts[0] === "confirm") return { ok: true, commandName: "rewind.apply", arguments: {}, pins: { kind: "rewind-confirm" } };
  const mode = parts[1] ?? "files";
  if (parts.length > 2 || !/^[1-9]\d{0,14}$/.test(parts[0]!) || !["files", "history", "both"].includes(mode)) return refuse("rewind", REWIND_USAGE);
  return { ok: true, commandName: "rewind.preview", arguments: { seq: Number(parts[0]), mode }, pins: { kind: "history-version" } };
}

export const SESSIONS_USAGE = "Usage: /sessions [open <sessionId> | resume <sessionId> | fork <checkoutId> <title>]";
/**
 * `/sessions` lists (the picker); its selection actions are the typed lifecycle operations Hub delivers: `open` attaches a session as a
 * read-only reader, `resume` continues a closed one, `fork` copies this session's whole history into a new session on another mapped
 * checkout. Every version, controller, baseline and inventory pin comes from a fresh read; the title is never defaulted.
 */
export function parseSessionsText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("sessions");
  const [action, target] = parts;
  if ((action === "open" || action === "resume") && parts.length === 2 && ID.test(target!))
    return { ok: true, commandName: `sessions.${action}`, arguments: { sessionId: target! }, pins: { kind: "session-target", sessionId: target! } };
  if (action === "fork" && parts.length >= 3 && ID.test(target!)) {
    // The title keeps its own spacing: only the action and checkout tokens are removed.
    const title = rest.trim().replace(/^\S+\s+\S+\s+/, "").trim();
    if (title.length > 0 && title.length <= 200) return { ok: true, commandName: "sessions.fork", arguments: { targetCheckoutId: target!, title }, pins: { kind: "fork-source", targetCheckoutId: target! } };
  }
  return refuse("sessions", SESSIONS_USAGE);
}

/** `/editguard status` and `/jevprofile entries`: the modals' detail view (threshold and recent flags; every review.jev key). `undefined`: the shipped grammar decides. */
export function parseInspectorDetail(commandName: "editguard" | "jevprofile", rest: string): TerminalCommandParse | undefined {
  const parts = words(rest);
  if (parts.length !== 1) return undefined;
  if (commandName === "editguard" && parts[0] === "status") return typed("editguard.status");
  if (commandName === "jevprofile" && parts[0] === "entries") return typed("jevprofile.entries");
  return undefined;
}

export const QUEUE_USAGE = "Usage: /queue [remove [N] | edit N <new text>]  (N = qN position, default 1)";
/**
 * The shipped `/queue <remove|edit|force> [N]` grammar (src/tui/main-queue.ts). Natively remove and edit are the frozen QueueRemove and
 * QueueEdit operations; an edit carries its replacement text. Pulling an item into the composer and forcing one to the front have none.
 */
export function parseQueueText(rest: string): TerminalCommandParse {
  const parts = words(rest);
  if (parts.length === 0) return typed("queue");
  const head = parseQueueCommand(parts.slice(0, 2).join(" "));
  if (head === undefined) return refuse("queue", QUEUE_USAGE);
  if (head.action === "force") return refuse("queue", "Moving a queued item to the front has no typed native request: the frozen queue operations are edit and remove.");
  if (head.action === "remove") return parts.length <= 2 ? { ok: true, commandName: "queue", arguments: {}, queue: { action: "remove", position: head.position } } : refuse("queue", QUEUE_USAGE);
  if (parts.length < 3 || !/^\d+$/.test(parts[1]!)) return refuse("queue", "A native queue edit replaces the item's text: /queue edit N <new text>. Pulling an item into the composer is terminal presentation.");
  const text = rest.trim().replace(/^\S+\s+\S+\s+/, "");
  return text.length > 32768 ? refuse("queue", QUEUE_USAGE) : { ok: true, commandName: "queue", arguments: {}, queue: { action: "edit", position: head.position, text } };
}
