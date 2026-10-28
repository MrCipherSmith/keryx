import { settingsInspectionCommands } from "./settings-inspection";
import type { NativeRewindPort } from "./rewind";
import { validateArguments, validateControl, type Control } from "../../remote-control/protocol";
import type { NativeSessionRuntime } from "../native-runtime";
import type { NormalizedMessage } from "../../harness/provider/types";
import { executeReasoningCommand, reasoningCommands } from "./reasoning";
import type { SessionCommandEffect, SessionCommandInspection, SessionProjectReadPort } from "./effects";
import { projectInspectionCommands } from "./project-inspection";
import { conversationCommands } from "./conversation";
import type { TasksApprovalPort, TasksIntegrationsPort } from "./tasks-integrations";

import type { OwnedControlCommand } from "../../remote-control/owned-controls";
import { questionCommands, type SessionQuestionPort } from "./questions";

import { approvalModeCommands, planCommands, type SessionRestriction } from "./plan";
import { sessionSettingsCommands } from "./session-settings";
import { goalCommands } from "./goal";
import { sessionControlCommands } from "./session-control";
import type { SessionLifecyclePort, SessionLifecycleInput } from "../host-lifecycle";
export interface SessionCommandContext {
  rewind?: NativeRewindPort;
  lifecycle?: SessionLifecyclePort;
  lifecycleInput?: SessionLifecycleInput;
  actorId?: string;
  restriction?: () => SessionRestriction;
  close?: () => Promise<{ status: "closed" }>;
  interrupt?: () => Promise<{ status: "stopped" | "unknown" | "too-late" }>;
  questions?: SessionQuestionPort;
  cwd: string;
  nativeSessionDir: string;
  configDir?: string;
  runId?: string;
  turnId?: string;
  effect?: SessionCommandEffect;
  inspection?: SessionCommandInspection;
  integrations?: TasksIntegrationsPort;
  approvals?: TasksApprovalPort;
  authorizeIntegration?: (action: string) => Promise<void>;
  authorizeOwnedControl?: (command: OwnedControlCommand, args: Readonly<Record<string, Control["BoundedJson"] | undefined>>) => Promise<void>;
  ownedControlPermit?: { commandName: OwnedControlCommand; resourceDigest: string };
  projectContext?: SessionProjectReadPort;
  inspectionMode?: "hub-remote" | "local-native";
  operationId: string;
  record: Control["SessionRecord"];
  catalogue: Control["CommandCatalogue"];
  runtime: NativeSessionRuntime;
  history(): NormalizedMessage[];
  publicHistory?(): Control["SessionMessage"][];
  contributions?: readonly NativeCommandContribution[];
  /** Host-owned compaction of the active context; `focus` is carried into the compaction summary, as the TUI `/compact <focus>` does. */
  compact(options?: { focus?: string }): { removed: number; noop: boolean };
}
export interface NativeCommandContribution {
  entry: Control["CommandCatalogueEntry"];
  structuredResult?: boolean;
  execute(context: SessionCommandContext, request: Control["CommandInvoke"]): Promise<unknown>;
}
/** Shared typed domain handler used by headless and terminal adapters. No unknown command fallback. */
export async function executeSessionCommand(context: SessionCommandContext, request: Control["CommandInvoke"]): Promise<Control["CommandOutcome"]> {
  const entry = context.catalogue.entries.find((item) => item.commandName === request.commandName);
  let errorCode: Control["CommandOutcome"]["errorCode"] = null;
  let result: unknown = null;
  const contribution = [...projectInspectionCommands(), ...conversationCommands(), ...questionCommands(), ...sessionControlCommands(), ...goalCommands(), ...sessionSettingsCommands(), ...reasoningCommands(), ...planCommands(), ...approvalModeCommands(), ...settingsInspectionCommands(), ...(context.contributions ?? [])].reverse().find((item) => item.entry.commandName === request.commandName);
  if (request.catalogueDigest !== context.catalogue.catalogueDigest) errorCode = "stale-catalogue";
  else if (request.expectedConfigVersion !== context.record.config.configVersion) errorCode = "policy-changed";
  else if (entry === undefined) errorCode = "unknown-command";
  else if (entry.availability !== "available") errorCode = entry.availability === "implementation-gap" ? "implementation-gap" : "forbidden";
  else if (context.effect === undefined && context.ownedControlPermit?.commandName !== request.commandName && ["busy", "paused"].includes(context.record.state) && entry.busyPolicy === "reject") errorCode = "busy";
  else if (!validateArguments(entry.inputSchema, request.arguments).ok) errorCode = "invalid-arguments";
  else if (contribution !== undefined) {
    try { result = await contribution.execute(context, request); }
    catch { result = { ok: false, error: { code: "domain-refused", message: "The native command did not complete under its current authority." } }; }
    if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
      errorCode = "forbidden";
    }
  }
  else if (request.commandName === "reasoning") {
    const args = request.arguments;
    if (args === null || typeof args !== "object" || Array.isArray(args) || !("effort" in args) || typeof args.effort !== "string"
      || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(args.effort) || Object.keys(args).length !== 1) errorCode = "invalid-arguments";
    else {
      const config = validateControl("SessionConfig", { ...context.record.config, reasoningEffort: args.effort, configVersion: context.record.config.configVersion + 1 });
      if (!config.ok || !context.runtime.routing(config.value).validate(config.value)) errorCode = "forbidden";
      else { const applied = executeReasoningCommand(args.effort === "none" ? "off" : args.effort, { current: context.record.config.reasoningEffort,
        commit: () => { context.record.config = config.value; context.record.version++; } });
        if (!applied.ok) errorCode = applied.error === "invalid-arguments" ? "invalid-arguments" : "forbidden";
        else result = args.effort;
      }
    }
  } else if (request.arguments === null || typeof request.arguments !== "object" || Array.isArray(request.arguments) || (!["history", "compact"].includes(request.commandName) && Object.keys(request.arguments).length !== 0)) errorCode = "invalid-arguments";
  else {
    const handlers: Record<string, () => unknown> = {
      help: () => context.catalogue,
      status: () => context.record,
      models: () => context.runtime.routing(context.record.config).availability(),
      routing: () => context.record.config.routing,
      history: () => { const all = context.publicHistory?.() ?? []; const count = (request.arguments as { count?: number }).count; return count === undefined ? all : all.slice(-count); },
      tasks: () => context.runtime.jobs.list().map((item) => ({ taskId: item.jobId, status: item.status, description: item.description ?? "" })),
      compact: () => { const focus = (request.arguments as { focus?: string }).focus; return context.compact(focus === undefined ? undefined : { focus }); },
      queue: () => ({ status: context.record.state, queueVersion: context.record.queueVersion }),
    };
    result = handlers[request.commandName]?.() ?? null;
  }
  const wireResult = contribution?.structuredResult === true && errorCode === null ? result : JSON.stringify(result).slice(0, 32768);
  if (contribution?.structuredResult === true && errorCode === null && !validateArguments(contribution.entry.resultSchema, wireResult).ok) throw new SessionCommandError("invalid-command-result");
  const parsed = validateControl("CommandOutcome", { operationId: context.operationId, sessionId: context.record.sessionId, commandName: request.commandName,
    status: errorCode === null ? request.commandName === "interrupt" && typeof result === "object" && result !== null && "status" in result && result.status === "unknown" ? "recovery-required" : "applied" : "rejected", sessionVersion: context.record.version, result: wireResult,
    confirmationId: null, errorCode, confirmation: null, runId: context.effect?.runId ?? null, turnId: context.effect?.turnId ?? null });
  if (!parsed.ok) throw new SessionCommandError(parsed.error.code);
  return parsed.value;
}
export class SessionCommandError extends Error { constructor(readonly code: string) { super(code); this.name = "SessionCommandError"; } }
