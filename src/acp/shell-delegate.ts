// `/delegate <agent> <task>` over `keryx acp --profile shell` (Keryx Desktop Client M2b,
// specification §3.9.4 and §3.9.5a).
//
// The shell's external-run port (`createLazyRunExternal`, the capability gate, the vendor
// consent, the disposable worktree) is reused as it is. What differs is the surface around it:
//
//   - the TUI's `approveExternalSpawn` card becomes one `session/request_permission` (kind
//     `execute`, the vendor CLI and the task in `rawInput`, allow once / reject once only — an
//     external run costs paid quota, so the client must not remember an "always");
//   - the run's events go out as `_keryx/subagent` fleet events with `runtime: "external"` and
//     no `parentToolCallId` (nothing in the model's transcript started it);
//   - a `session/cancel` or a release of the session stops the run (`stop`).
//
// One module-global listener (`external-bridge.ts`) is the TUI's way to watch a run; here each
// call builds its own observer, so two sessions' runs never meet.

import { parseDelegateCommand } from "../commands/agent-commands";
import type { ExternalRunHandle } from "../harness/external/supervise";
import type { ExternalEvent } from "../harness/external/types";
import { canonicalExternalAgentId, getExternalAgent, interactiveArgvFor } from "../harness/external/registry";
import { agentConfig, checkExternalAgentVendorGates, resolveExternalAgentsCapability } from "../capability/external-agents";
import {
  createLazyRunExternal,
  type CreateRunExternalOptions,
  type ExternalRunObserver,
  type RunExternalFn,
} from "../harness/run-external-factory";
import type { SpawnSubagentFleetEvent } from "../harness/tool/builtin/spawn-subagent-tool";
import { delegateReport, OPERATOR_SANDBOX, type DelegateOutcome } from "../tui/external-operator";
import { approvalFromPermissionResponse, ACP_PERMISSION_OPTION_IDS } from "./permission";
import type { AcpPermissionOption, AcpRequestPermissionRequest, AcpRequestPermissionResponse } from "./protocol";

/**
 * The run `/delegate` hands the desktop to start in its built-in terminal (D-14): argv is built by
 * keryx from the registry, never from client input; the client spawns it as given, in `cwd`.
 */
export interface DelegateTerminalLaunch {
  readonly runId: string;
  readonly agentId: string;
  readonly title: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

/** True when the client advertised `initialize.clientCapabilities._meta.keryx.terminal === true` (the desktop). */
export function clientRunsTerminal(capabilities: { readonly _meta?: Record<string, unknown> | undefined } | undefined): boolean {
  const keryx = capabilities?._meta?.["keryx"];
  return typeof keryx === "object" && keryx !== null && (keryx as Record<string, unknown>)["terminal"] === true;
}

/** What `/delegate` answers `_keryx/command` with. */
export interface DelegateAnswer {
  readonly text: string;
  /** With the `openTerminal` effect: the interactive run the client starts. Absent on the headless path. */
  readonly terminal?: DelegateTerminalLaunch;
  /** A refusal (bad usage, rejected approval, capability off) as opposed to a run that ran. */
  readonly refused?: true;
}

export interface SessionExternalRuns {
  delegate(args: string): Promise<DelegateAnswer>;
  /** Stops every run of the session, and withdraws an approval still being asked. Idempotent. */
  stop(reason: string): void;
}

export interface SessionExternalRunsInput {
  readonly cwd: string;
  readonly configDir?: string | undefined;
  /**
   * Sends one `session/request_permission`; `onSent` gets the request id so `stop` can withdraw it.
   * `undefined` = the client could not be asked, which is a refusal.
   */
  readonly ask: (
    request: AcpRequestPermissionRequest,
    onSent: (requestId: string) => void,
  ) => Promise<AcpRequestPermissionResponse | undefined>;
  readonly withdraw: (requestId: string, reason: string) => void;
  readonly sessionId: string;
  /** The client runs terminals (the desktop): `/delegate` opens one interactive run instead of a headless one. */
  readonly terminalCapable?: boolean | undefined;
  /** Environment the capability gate reads (transport, CI markers); `process.env` otherwise. Test seam. */
  readonly gateEnv?: Readonly<Record<string, string | undefined>> | undefined;
  readonly emitFleet: (event: SpawnSubagentFleetEvent) => void;
  /** Test seam: the run port. `createLazyRunExternal` otherwise. */
  readonly makeRunExternal?: ((options: CreateRunExternalOptions) => RunExternalFn) | undefined;
  readonly idSeq?: () => string;
}

/** The two options an external run's approval offers. No "always": see the header. */
const APPROVAL_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: ACP_PERMISSION_OPTION_IDS.allowOnce, name: "Run it", kind: "allow_once" },
  { optionId: ACP_PERMISSION_OPTION_IDS.rejectOnce, name: "Do not run", kind: "reject_once" },
];

/** One external event as the Subagents tab's log entry, or `undefined` when it adds nothing to read. */
function logEntryFor(event: ExternalEvent): { kind: "text" | "reasoning" | "tool" | "result" | "system"; text: string } | undefined {
  switch (event.kind) {
    case "assistant_text":
      return { kind: "text", text: event.text };
    case "thinking":
      return { kind: "reasoning", text: event.text };
    case "tool_call":
      return { kind: "tool", text: event.detail === undefined ? event.name : `${event.name}: ${event.detail}` };
    case "tool_result":
      return event.detail === undefined ? undefined : { kind: "tool", text: event.detail };
    case "user_message":
      return { kind: "system", text: `message sent: ${event.text}` };
    case "retry":
      return { kind: "system", text: `retrying: ${event.message}` };
    case "child_started":
      return { kind: "system", text: event.sessionRef === undefined ? "started" : `started (${event.sessionRef})` };
    case "child_finished":
      return event.text === undefined || event.text.length === 0 ? undefined : { kind: "result", text: event.text };
    case "child_failed":
      return { kind: "result", text: `failed: ${event.message}` };
    case "usage":
      return undefined;
  }
}

export function createSessionExternalRuns(input: SessionExternalRunsInput): SessionExternalRuns {
  const handles = new Set<ExternalRunHandle>();
  const requestIds = new Set<string>();
  let stopped: string | undefined;

  const stop = (reason: string): void => {
    stopped = reason;
    for (const id of requestIds) input.withdraw(id, reason);
    requestIds.clear();
    for (const handle of handles) handle.kill();
  };

  /** The approval: `true` only for an explicit allow. */
  const approved = async (agentId: string, task: string, runId: string, interactive: readonly string[] | undefined): Promise<boolean> => {
    const response = await input.ask(
      {
        sessionId: input.sessionId,
        toolCall: {
          toolCallId: runId,
          title:
            interactive === undefined
              ? `Run ${agentId} on this task`
              : `Run ${agentId} interactively in the terminal on this task. It uses the CLI's own permission prompts; keryx's sandbox does not apply.`,
          name: "delegate",
          kind: "execute",
          status: "pending",
          rawInput:
            interactive === undefined
              ? { agent: agentId, task, sandbox: OPERATOR_SANDBOX }
              : { agent: agentId, task, interactive: true, command: interactive.join(" "), sandbox: "none (the CLI's own permission prompts)" },
        },
        options: APPROVAL_OPTIONS,
      },
      (id) => requestIds.add(id),
    );
    // `onSent` has run by now; the ask is settled either way.
    requestIds.clear();
    if (response === undefined) return false;
    return approvalFromPermissionResponse(response, APPROVAL_OPTIONS) === true;
  };

  const delegate = async (args: string): Promise<DelegateAnswer> => {
    const parsed = parseDelegateCommand(args);
    if (!parsed.ok) return { text: `◇ ${parsed.reason}\n`, refused: true };
    const entry = getExternalAgent(canonicalExternalAgentId(parsed.agentId));
    if (entry === undefined) return { text: `◇ unknown external agent "${parsed.agentId}"\n`, refused: true };
    stopped = undefined;

    const runId = `ext:${(input.idSeq ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`))()}`;
    const interactiveArgv = input.terminalCapable === true ? interactiveArgvFor(entry, parsed.task) : undefined;
    if (input.terminalCapable === true) {
      if (interactiveArgv === undefined) return { text: `◇ ${entry.id} has no interactive form to run in the terminal\n`, refused: true };
      // Default-on in the desktop (D-14): an `externalAgents.enabled` never written counts as on.
      const gate = await resolveExternalAgentsCapability({
        cwd: input.cwd,
        env: input.gateEnv ?? process.env,
        defaultOn: true,
        ...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
      });
      if (!gate.ok) return { text: `◇ /delegate refused: ${gate.reason}\n`, refused: true };
      if (!agentConfig(gate.config, entry.id).enabled) {
        return {
          text: `◇ /delegate refused: external agent "${entry.id}" is disabled; enable it under \`externalAgents.agents.${entry.id}\` in the keryx user config\n`,
          refused: true,
        };
      }
      const vendorGate = await checkExternalAgentVendorGates({
        agentId: entry.id,
        cwd: input.cwd,
        config: gate.config,
        ...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
      });
      if (vendorGate !== undefined) return { text: `◇ /delegate refused: ${vendorGate.reason}\n`, refused: true };
    }
    if (!(await approved(entry.id, parsed.task, runId, interactiveArgv))) {
      return {
        text: stopped !== undefined ? `◇ /delegate stopped: ${stopped}\n` : `◇ /delegate refused: ${entry.id} was not approved to run\n`,
        refused: true,
      };
    }
    if (stopped !== undefined) return { text: `◇ /delegate stopped: ${stopped}\n`, refused: true };

    if (interactiveArgv !== undefined) {
      const firstWords = parsed.task.split(/\s+/).slice(0, 5).join(" ");
      const title = `${entry.label.trim() || entry.id} · ${firstWords.length > 32 ? `${firstWords.slice(0, 31)}…` : firstWords}`;
      return {
        text: `◇ ${entry.id} opened in the terminal: ${title}\n`,
        terminal: { runId, agentId: entry.id, title, argv: interactiveArgv, cwd: input.cwd },
      };
    }

    const label = entry.label.trim().length > 18 ? `${entry.label.trim().slice(0, 15)}…` : entry.label.trim() || "external";
    const fleet = (status: "running" | "done" | "failed", detail: string): void =>
      input.emitFleet({ kind: "upsert", id: runId, label, status, detail, task: parsed.task, runtime: "external", agentId: entry.id });
    const log = (entry: { kind: "text" | "reasoning" | "tool" | "result" | "system"; text: string }): void =>
      input.emitFleet({ kind: "log", id: runId, entry });
    fleet("running", "delegated");

    // `assistant_text` events are messages; the tab replaces a text entry by the next one, so a run of
    // them is sent as the whole text so far, like the shell's own subagent log.
    let textSoFar = "";
    let mine: ExternalRunHandle | undefined;
    const observer: ExternalRunObserver = {
      onSpawned: (_id, handle) => {
        mine = handle;
        handles.add(handle);
        if (stopped !== undefined) handle.kill();
      },
      onEvent: (_id, event) => {
        const entry = logEntryFor(event);
        if (event.kind === "assistant_text") {
          textSoFar = textSoFar.length === 0 ? event.text : `${textSoFar}\n\n${event.text}`;
          log({ kind: "text", text: textSoFar });
          return;
        }
        textSoFar = "";
        if (entry !== undefined) log(entry);
      },
      onWarning: (_id, warning) => log({ kind: "system", text: warning }),
    };

    const make = input.makeRunExternal ?? createLazyRunExternal;
    // The operator has just approved this exact run, so the gate's own `spawnDecision: "ask"` question
    // is already answered; only this call's id reaches the hook.
    const hook = make({
      cwd: input.cwd,
      ...(input.configDir !== undefined ? { configDir: input.configDir } : {}),
      observer,
      approve: async (request) => (request.workerId === runId ? { ok: true } : { ok: false, reason: "not the run the operator approved" }),
    });

    let outcome: DelegateOutcome;
    try {
      const result = await hook({
        runtime: { kind: "external", agent: entry.id, sandbox: OPERATOR_SANDBOX },
        task: parsed.task,
        mode: "read_only",
        workerId: runId,
        label,
      });
      outcome = { ok: true, runId, label, result };
    } catch (cause) {
      outcome = {
        ok: false,
        reason: `the external runtime failed before the agent could report: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    } finally {
      if (mine !== undefined) handles.delete(mine);
    }

    const report = delegateReport(entry.id, outcome);
    const status = outcome.ok ? outcome.result.status : "error";
    fleet(report.failed ? "failed" : "done", status);
    if (stopped !== undefined) return { text: `◇ ${entry.id} stopped: ${stopped}\n` };
    // A run that ran and failed is a report; one the gate refused (or that never started) is a refusal.
    const refused = report.failed && (!outcome.ok || outcome.result.status === "Denied");
    return { text: report.text, ...(refused ? { refused: true as const } : {}) };
  };

  return { delegate, stop };
}
