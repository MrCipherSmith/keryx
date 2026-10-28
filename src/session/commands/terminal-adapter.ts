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

type Args = { [key: string]: Control["BoundedJson"] };
/** A typed request for the shared handler, or the TUI's own refusal. Never a positional argument list. */
export type TerminalCommandParse = { ok: true; commandName: string; arguments: Args } | { ok: false; commandName: string; reason: string };
const refuse = (commandName: string, reason: string): TerminalCommandParse => ({ ok: false, commandName, reason });
const typed = (commandName: string, args: Args = {}): TerminalCommandParse => ({ ok: true, commandName, arguments: args });
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
    if (rest.length === 0) return refuse("reasoning", "Showing the effort has no typed native request; read it with /status or /settings.");
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
  model: (rest) => noArguments("model", rest, "/model selects through the interactive picker; it has no typed argument syntax."),
  connect: (rest) => noArguments("connect", rest, "/connect manages providers through its dialog; it has no typed argument syntax."),
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
  projectctx: (_rest, line) => {
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

/** Terminal slash input is parsed into the same typed handler, never a model or OS shell. */
export function createTerminalSessionAdapter(host: Pick<SessionHostPort, "inspect" | "catalogue" | "apply">, authority: { actorId: string; controllerLeaseId: string; controllerVersion: number }) {
  return {
    async execute(line: string) {
      const parsed = parseTerminalCommand(line);
      const record = await host.inspect();
      if (!parsed.ok) {
        const refused = validateControl("CommandOutcome", { operationId: randomUUID(), sessionId: record.sessionId, commandName: parsed.commandName, status: "rejected", sessionVersion: record.version,
          result: JSON.stringify({ error: parsed.reason }).slice(0, 32768), confirmationId: null, errorCode: "invalid-arguments", confirmation: null, runId: null, turnId: null });
        if (refused.ok) return refused.value;
      }
      const catalogue = await host.catalogue();
      const request: Control["CommandInvoke"] = { expectedSessionVersion: record.version,
        controller: { controllerLeaseId: authority.controllerLeaseId, expectedControllerVersion: authority.controllerVersion },
        expectedConfigVersion: record.config.configVersion, catalogueDigest: catalogue.catalogueDigest, commandName: parsed.commandName,
        // A refusal the wire cannot name (an invalid command token) reaches the host as that unknown command with no arguments.
        arguments: parsed.ok ? parsed.arguments : {}, busyPolicy: "reject" };
      return host.apply({ kind: "command", operationId: randomUUID(), payloadDigest: canonicalDigest(request), actorId: authority.actorId, request });
    },
  };
}
