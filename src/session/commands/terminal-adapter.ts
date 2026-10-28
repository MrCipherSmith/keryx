import { randomUUID } from "node:crypto";
import { canonicalDigest, validateControl, type Control } from "../../remote-control/protocol";
import type { SessionHostPort } from "../host-types";
import { isReasoningEffortLevel } from "../../commands/agent";
import { parseDemoteCommand } from "../../commands/agent-commands";
import { parseGoalArgs } from "../../commands/goal-command";
import { parseSetupArgs } from "../../commands/setup-guide";
import { executePlanCommand } from "./plan";
import { parseTrailArgs } from "../../tui/working-memory-command";
import { parseAutoReviewArgs } from "../../tui/autoreview-surface";
import { parseBusCommand } from "../../tui/bus-command";
import { parseIntakeArgs } from "../../tui/intake-surface";
import { parseChannelsArgs } from "../../tui/channels-surface";
import { parseRemoteControlArgs } from "../../tui/remote-control-surface";
import { parseProjectContextCommand } from "../../tui/project-context-inspector";
import { parseDecisionsCommand } from "../../tui/decisions-surface";
import { isReviewLayersCommand, isReviewParityCommand, isReviewReadinessCommand } from "../../tui/reviews-inspector";
import { parseTasksArgs } from "../../tui/tasks-command";
import { parseAcText, parseApprovalsText, parseConnectText, parseFlowOriginText, parseFlowsText, parseHistoryText, parseInspectorDetail, parseMcpText, parseModelText, parseProjectContextTab, parseQueueText, parseQuestionAnswerText, parseReviewsText, parseRewindText, parseRoutingText, parseTriggersText, parseWorkspaceText,
  refuse, typed, type TerminalCommandParse, type TerminalQueueAction } from "./terminal-grammar";

type Args = { [key: string]: Control["BoundedJson"] };
export type { TerminalCommandParse } from "./terminal-grammar";
const noArguments = (name: string, rest: string, why: string): TerminalCommandParse => rest.length === 0 ? typed(name) : refuse(name, why);
function parseTrail(rest: string): TerminalCommandParse {
  const parsed = parseTrailArgs(rest);
  if ("error" in parsed) return refuse("trail", parsed.error);
  // The TUI grammar names the slate_trail input; the native schema uses the TUI's own syntax names.
  const names: Record<string, string> = { limit: "count", tool: "tool", file: "file", from_step: "from", to_step: "to" };
  const args: Args = {};
  for (const [key, value] of Object.entries(parsed.input)) {
    const name = names[key];
    if (name === undefined || (typeof value !== "string" && typeof value !== "number")) return refuse("trail", `Unsupported trail filter '${key}'.`);
    args[name] = value;
  }
  return typed("trail", args);
}
function parseAutoReview(rest: string, line: string): TerminalCommandParse {
  const parsed = parseAutoReviewArgs(line);
  if (parsed.kind === "error") return refuse("autoreview", parsed.message);
  if (parsed.kind === "list") return typed(rest.split(/\s+/)[0] === "ls" ? "autoreview.ls" : "autoreview");
  if (parsed.kind === "start") {
    if (parsed.budgetMinutes === undefined || parsed.budgetTokens === undefined || !Number.isInteger(parsed.budgetMinutes)) return refuse("autoreview", "A native review start needs explicit whole --budget-minutes and --budget-tokens.");
    return typed("autoreview.start", { ref: parsed.ref, budgetMinutes: parsed.budgetMinutes, budgetTokens: parsed.budgetTokens });
  }
  return typed(`autoreview.${parsed.kind}`, parsed.selector === undefined ? {} : { selector: parsed.selector });
}
function parseBus(line: string): TerminalCommandParse {
  const parsed = parseBusCommand(line);
  switch (parsed.kind) {
    case "error": return refuse("bus", parsed.reason);
    case "modal": return typed("bus");
    case "send": case "ask": return typed(`bus.${parsed.kind}`, { to: parsed.toLabel, text: parsed.text });
    case "reply": return typed("bus.reply", { id: parsed.id, text: parsed.text });
    case "name": return typed("bus.name", { name: parsed.name });
    case "resume": case "override": return typed(`bus.${parsed.kind}`, parsed.leaseId === undefined ? {} : { leaseId: parsed.leaseId });
    case "pause":
      if (parsed.ttlMs !== undefined && parsed.ttlMs % 60_000 !== 0) return refuse("bus", "The typed pause TTL is whole minutes; use e.g. --ttl 30m.");
      return typed("bus.pause", { to: parsed.toLabel, scope: parsed.scope, ...(parsed.ttlMs === undefined ? {} : { ttlMinutes: parsed.ttlMs / 60_000 }), reason: parsed.reason });
  }
}
/** Each entry reuses the shipped TUI/readline grammar of its command, then names the catalogue handler that serves that parsed action. */
const parsers: Readonly<Record<string, (rest: string, line: string) => TerminalCommandParse>> = {
  reasoning: (rest) => {
    if (rest.length === 0) return typed("reasoning.show");
    if (!isReasoningEffortLevel(rest)) return refuse("reasoning", `Unknown reasoning effort '${rest}'.`);
    return typed("reasoning", { effort: rest === "off" ? "none" : rest });
  },
  plan: (rest) => {
    if (rest.length === 0) return typed("plan");
    let enabled: boolean | undefined;
    const parsed = executePlanCommand(rest, { current: false, commit: (value) => { enabled = value; } });
    return parsed.ok && enabled !== undefined ? typed("plan.set", { enabled }) : refuse("plan", "Usage: /plan [on|off]");
  },
  route: (rest) => {
    const arg = rest.toLowerCase();
    if (arg.length === 0) return typed("route");
    return arg === "on" || arg === "off" ? typed("route.set", { enabled: arg === "on" }) : refuse("route", `Unknown /route argument '${arg}'. Usage: /route [on|off]`);
  },
  model: (rest) => parseModelText(rest),
  connect: (rest) => parseConnectText(rest),
  mcp: (rest) => parseMcpText(rest),
  routing: (rest) => parseRoutingText(rest),
  approvals: (rest) => parseApprovalsText(rest),
  "questions.answer": (rest) => parseQuestionAnswerText(rest),
  history: (rest) => parseHistoryText(rest),
  flows: (rest) => parseFlowsText(rest),
  ac: (rest) => parseAcText(rest),
  workspace: (rest) => parseWorkspaceText(rest),
  triggers: (rest) => parseTriggersText(rest),
  flow: (rest) => parseFlowOriginText(rest),
  reviews: (rest) => parseReviewsText(rest),
  rewind: (rest) => parseRewindText(rest),
  queue: (rest) => parseQueueText(rest),
  editguard: (rest) => parseInspectorDetail("editguard", rest) ?? noArguments("editguard", rest, "/editguard on|off writes project configuration; it has no typed native request. Usage: /editguard [status]"),
  jevprofile: (rest) => parseInspectorDetail("jevprofile", rest) ?? noArguments("jevprofile", rest, "Toggling a review.jev key writes project configuration; it has no typed native request. Usage: /jevprofile [entries]"),
  // The dotted native name takes only the preview form of the same grammar.
  "rewind.preview": (rest) => { const parsed = parseRewindText(rest); return parsed.ok && parsed.commandName === "rewind.preview" ? parsed : refuse("rewind.preview", "Usage: /rewind.preview N [files|history|both]"); },
  setup: (rest) => {
    const request = parseSetupArgs([rest]);
    if (request.kind === "error") return refuse("setup", request.message);
    return request.kind === "all" ? typed("setup") : typed("setup", { scenario: request.scenario.id });
  },
  goal: (rest) => {
    const parsed = parseGoalArgs(rest);
    if ("error" in parsed) return refuse("goal", parsed.error);
    // `--auto` with no N means the shell's default cap; the typed request has no default, so it is refused rather than guessed.
    if (parsed.auto !== undefined && parsed.auto.rounds === undefined) return refuse("goal", "--auto needs an explicit round count here, e.g. /goal <text> --auto 3");
    return typed("goal", { text: parsed.text, ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }), ...(parsed.auto?.rounds === undefined ? {} : { autoRounds: parsed.auto.rounds }) });
  },
  demote: (rest) => { const parsed = parseDemoteCommand(rest); return parsed.ok ? typed("demote", { taskId: parsed.taskId }) : refuse("demote", parsed.reason); },
  tasks: (rest) => {
    const parsed = parseTasksArgs(rest);
    if (parsed.kind === "invalid") return refuse("tasks", parsed.usage.trim());
    if (parsed.kind === "list") return typed("tasks");
    if (parsed.kind === "kill") return typed("tasks.kill", { taskId: parsed.taskId });
    return typed("tasks.output", { taskId: parsed.taskId, ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }) });
  },
  trail: (rest) => parseTrail(rest),
  notes: (rest) => rest.length === 0 ? typed("notes") : typed("notes", { key: rest }),
  autoreview: (rest, line) => parseAutoReview(rest, line),
  bus: (_rest, line) => parseBus(line),
  intake: (_rest, line) => {
    const parsed = parseIntakeArgs(line);
    if (parsed.action === "invalid") return refuse("intake", parsed.message);
    return typed(parsed.action === "open" || parsed.action === "status" ? "intake" : `intake.${parsed.action}`);
  },
  channels: (_rest, line) => { const parsed = parseChannelsArgs(line); return parsed.action === "open" ? typed("channels") : refuse("channels", parsed.message); },
  "remote-control": (_rest, line) => {
    const parsed = parseRemoteControlArgs(line);
    if (parsed.action === "invalid") return refuse("remote-control", parsed.message);
    if (parsed.action === "status") return typed("remote-control");
    if (parsed.action === "off") return typed("remote-control.off");
    return typed("remote-control.name", parsed.name === undefined ? {} : { name: parsed.name });
  },
  projectctx: (rest, line) => {
    const tab = parseProjectContextTab(rest); if (tab !== undefined) return tab;
    const parsed = parseProjectContextCommand(line);
    if (parsed.kind === "invalid") return refuse("projectctx", parsed.message);
    if (parsed.kind === "set") return refuse("projectctx", `Setting enforcement to ${parsed.mode} writes project configuration; it has no typed native request.`);
    return typed(parsed.tab === "references" ? "projectctx.refs" : "projectctx");
  },
  decisions: (_rest, line) => {
    const parsed = parseDecisionsCommand(line);
    if (parsed.kind === "arms") return typed("decisions", { section: "arms" });
    if (parsed.kind === "show") return typed("decisions");
    return refuse("decisions", `/decisions ${parsed.kind} carries free text that no typed native request accepts.`);
  },
  review: (rest, line) => {
    if (rest.length === 0) return typed("review");
    // `/review layers|parity|readiness` are served by the native reviews sections the catalogue advertises.
    const section = isReviewLayersCommand(line) ? "layers" : isReviewParityCommand(line) ? "parity" : isReviewReadinessCommand(line) ? "readiness" : undefined;
    return section !== undefined && rest.split(/\s+/).length === 1 ? typed("reviews", { section }) : refuse("review", `Unknown /review argument '${rest}'. Usage: /review [layers|parity|readiness]`);
  },
};
/** Terminal slash text → the exact typed CommandInvoke the headless path sends, or the TUI's refusal. No guessed grammar. */
export function parseTerminalCommand(line: string): TerminalCommandParse {
  const trimmed = line.trim();
  const space = trimmed.search(/\s/);
  const token = (space < 0 ? trimmed : trimmed.slice(0, space)).replace(/^\//, "");
  const rest = space < 0 ? "" : trimmed.slice(space).trim();
  const parser = parsers[token];
  if (parser !== undefined) return parser(rest, `/${token}${rest.length === 0 ? "" : ` ${rest}`}`);
  // Commands without a shipped argument grammar take no arguments here; extra words are refused, never forwarded positionally.
  return noArguments(token, rest, `/${token} takes no typed arguments in the terminal adapter.`);
}

type TerminalHost = Pick<SessionHostPort, "inspect" | "catalogue" | "apply" | "queue">;
/**
 * The local terminal owner's authority. `work` is the operator's explicit work mode (spec 3.1: ad-hoc coding needs an explicit
 * operator work mode; Flow work pins its Flow): a workspace-class command runs as one new local run of this session under it,
 * and without it such a command is refused here rather than given an invented association.
 */
export interface TerminalAuthority { actorId: string; controllerLeaseId: string; controllerVersion: number; work?: Control["FlowAssociation"] }
type Refusal = { reason: string; errorCode: "invalid-arguments" | "forbidden" };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** The pending rows a typed list read returned: structured results directly, string results as the integrations envelope. */
function pendingRows(result: unknown): Record<string, unknown>[] {
  let value = result;
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown; } catch { return []; } }
  if (record(value) && value.ok === true) value = value.data;
  return Array.isArray(value) ? value.filter(record) : [];
}

/** The apply pins of an applied rewind preview: exactly the snapshot, mode, history version, preview digest and baseline it showed. */
function rewindPins(result: unknown): Args | undefined {
  let value = result;
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown; } catch { return undefined; } }
  const data = record(value) && value.ok === true && value.status === "preview" && record(value.data) ? value.data : undefined;
  if (data === undefined || typeof data.seq !== "number" || typeof data.mode !== "string" || typeof data.historyVersion !== "number" || typeof data.previewDigest !== "string" || typeof data.workspaceBaseline !== "string") return undefined;
  return { seq: data.seq, mode: data.mode, expectedHistoryVersion: data.historyVersion, previewDigest: data.previewDigest, workspaceBaseline: data.workspaceBaseline };
}

/** Terminal slash input is parsed into the same typed handler, never a model or OS shell. */
export function createTerminalSessionAdapter(host: TerminalHost, authority: TerminalAuthority) {
  /** The last successful rewind preview; like the readline `/rewind`, any other terminal input withdraws it. */
  let pendingRewind: Args | undefined;
  const invoke = async (commandName: string, args: Args, extra: { runId: string; turnId: string; association: Control["FlowAssociation"] } | Record<string, never> = {}) => {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version,
      controller: { controllerLeaseId: authority.controllerLeaseId, expectedControllerVersion: authority.controllerVersion },
      expectedConfigVersion: current.config.configVersion, catalogueDigest: catalogue.catalogueDigest, commandName, arguments: args, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: randomUUID(), payloadDigest: canonicalDigest(request), actorId: authority.actorId, request, ...extra });
  };
  /** The exact pins of the pending card the operator named, read through the same typed list a headless client reads. */
  const resolvePins = async (parsed: Extract<TerminalCommandParse, { ok: true }>, pending: Args | undefined): Promise<{ ok: true; args: Args } | { ok: false; refusal: Refusal }> => {
    const pins = parsed.pins; if (pins === undefined) return { ok: true, args: parsed.arguments };
    if (pins.kind === "history-version") return { ok: true, args: { ...parsed.arguments, expectedHistoryVersion: (await host.inspect()).historyVersion } };
    if (pins.kind === "rewind-confirm") return pending === undefined ? { ok: false, refusal: { reason: "Nothing to confirm. Pick a snapshot first: /rewind N [files|history|both]", errorCode: "invalid-arguments" } } : { ok: true, args: pending };
    const listed = await invoke(pins.kind === "approval" ? "approvals" : "questions.list", {});
    const rows = "result" in listed ? pendingRows(listed.result) : [];
    if (pins.kind === "approval") {
      const row = rows.find((item) => item.approvalId === pins.approvalId);
      if (row === undefined) return { ok: false, refusal: { reason: `No approval ${pins.approvalId} is pending in this session.`, errorCode: "forbidden" } };
      return { ok: true, args: { approvalId: pins.approvalId, runId: String(row.runId), turnId: String(row.turnId), fingerprint: String(row.fingerprint), policyDigest: String(row.policyDigest) } };
    }
    const row = rows.find((item) => item.questionId === pins.questionId);
    if (row === undefined) return { ok: false, refusal: { reason: `No question ${pins.questionId} is pending in this session.`, errorCode: "forbidden" } };
    return { ok: true, args: { ...parsed.arguments, runId: String(row.runId), turnId: String(row.turnId), fingerprint: String(row.fingerprint) } };
  };
  /** The named qN item of this session's pending queue, edited or removed through the frozen queue operation under its exact versions. */
  const applyQueue = async (action: TerminalQueueAction) => {
    const current = await host.inspect(); const page = await host.queue();
    const item = page.items.filter((entry) => entry.state === "queued").sort((left, right) => left.position - right.position)[action.position - 1];
    if (item === undefined) return (await refused("queue", { reason: `No queued item q${action.position} is pending in this session.`, errorCode: "forbidden" }))!;
    const base = { expectedSessionVersion: current.version, controller: { controllerLeaseId: authority.controllerLeaseId, expectedControllerVersion: authority.controllerVersion },
      queueItemId: item.queueItemId, expectedQueueVersion: page.queueVersion, expectedItemVersion: item.version };
    if (action.action === "remove") return host.apply({ kind: "remove-queue", operationId: randomUUID(), payloadDigest: canonicalDigest(base), actorId: authority.actorId, request: base });
    const request = { ...base, text: action.text ?? "" };
    return host.apply({ kind: "edit-queue", operationId: randomUUID(), payloadDigest: canonicalDigest(request), actorId: authority.actorId, request });
  };
  const refused = async (commandName: string, refusal: Refusal) => {
    const current = await host.inspect();
    const outcome = validateControl("CommandOutcome", { operationId: randomUUID(), sessionId: current.sessionId, commandName, status: "rejected", sessionVersion: current.version,
      result: JSON.stringify({ error: refusal.reason }).slice(0, 32768), confirmationId: null, errorCode: refusal.errorCode, confirmation: null, runId: null, turnId: null });
    return outcome.ok ? outcome.value : undefined;
  };
  return {
    async execute(line: string) {
      const parsed = parseTerminalCommand(line);
      const pending = pendingRewind; pendingRewind = undefined;
      if (!parsed.ok) {
        const outcome = await refused(parsed.commandName, { reason: parsed.reason, errorCode: "invalid-arguments" });
        // A refusal the wire cannot name (an invalid command token) reaches the host as that unknown command with no arguments.
        return outcome ?? invoke(parsed.commandName, {});
      }
      if (parsed.queue !== undefined) return applyQueue(parsed.queue);
      const entry = (await host.catalogue()).entries.find((item) => item.commandName === parsed.commandName);
      // A workspace-class command is one new local run of this session; it never runs without the operator's explicit work mode.
      let run: { runId: string; turnId: string; association: Control["FlowAssociation"] } | Record<string, never> = {};
      if (entry?.mutationClass === "workspace" && entry.availability === "available") {
        if (authority.work === undefined) return (await refused(parsed.commandName, { reason: `/${parsed.commandName} runs as a new local run and needs an explicit operator work mode (a Flow or ad-hoc).`, errorCode: "forbidden" }))!;
        run = { runId: randomUUID(), turnId: randomUUID(), association: authority.work };
      }
      const resolved = await resolvePins(parsed, pending);
      if (!resolved.ok) return (await refused(parsed.commandName, resolved.refusal))!;
      const outcome = await invoke(parsed.commandName, resolved.args, run);
      if (parsed.commandName === "rewind.preview" && outcome.status === "applied" && "result" in outcome) pendingRewind = rewindPins(outcome.result);
      return outcome;
    },
  };
}
