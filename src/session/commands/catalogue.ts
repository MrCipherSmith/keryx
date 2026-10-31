import { settingsInspectionCommands } from "./settings-inspection";
import { NATIVE_DEFAULT_SERVICE_READINESS } from "../native-service-readiness";
import { rewindCommands } from "./rewind";
import { commandsForMode } from "../../commands/agent-commands";
import { catalogueDigest, type Control } from "../../remote-control/protocol";
import { projectInspectionCommands } from "./project-inspection";
import { acCheckCommands } from "./ac-check";
import { decisionFollowupCommands } from "./decision-followups";
import { approvalModeCommands, planCommands } from "./plan";
import { sessionSettingsCommands } from "./session-settings";
import { goalCommands } from "./goal";
import { sessionControlCommands } from "./session-control";
import { lifecycleCommands } from "../host-lifecycle";
import { questionCommands } from "./questions";
import { conversationCommands } from "./conversation";
import type { NativeCommandContribution } from "./handlers";
import { analysisCommands } from "./analysis";
import { tasksIntegrationsCommands } from "./tasks-integrations";
import { reasoningCommands } from "./reasoning";
import { projectRecordCommands } from "./project-records";
import { routingCategoryCommands } from "./routing-categories";

export const sharedCommandIds = new Set(["help", "status", "models", "routing", "reasoning", "history", "compact", "tasks", "queue"]);
/** specification.md 3.1: "Pure terminal display functions are client concerns." `/think` only chooses how reasoning blocks are shown. */
const presentation = new Set(["theme", "copy", "expand", "rendering", "game", "think"]);
/** specification.md 3.1: "unimplemented vendor adapters are explicit capability boundaries" and external-vendor execution "[is] not admitted by this Flow". */
const externalVendor = new Set(["delegate", "external-diff"]);
const localSetup = new Set(["connect", "search-connect", "setup", "permissions", "mode", "remote-policy", "remote-control"]);
const empty: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: {}, required: [] };
/** `/history [N]` (src/remote/history.ts): no number reads the whole ordered history, N (1-20) its last N messages. */
export const historyInputSchema: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: { count: { type: "integer", minimum: 1, maximum: 20 } }, required: [] };
/** `/compact [focus]` (the TUI joins the words after the command): the optional focus the compaction summary carries. */
export const compactInputSchema: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: { focus: { type: "string", maxLength: 200 } }, required: [] };
export function createCommandCatalogue(capabilityDigest: string, contributions: readonly NativeCommandContribution[] = []): Control["CommandCatalogue"] {
  const entries: Control["CommandCatalogueEntry"][] = commandsForMode("agent").map((command) => {
    const commandName = command.name.slice(1);
    const available = sharedCommandIds.has(commandName);
    return {
      commandName, summary: command.description, handlerId: `native.${commandName}`,
      inputSchema: commandName === "reasoning" ? { type: "object", additionalProperties: false,
        properties: { effort: { type: "string", maxLength: 16, enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] } }, required: ["effort"] } : commandName === "history" ? historyInputSchema : commandName === "compact" ? compactInputSchema : empty,
      resultSchema: { type: "string", maxLength: 32768 },
      mutationClass: localSetup.has(commandName) ? "sensitive-setup" : ["reasoning", "compact"].includes(commandName) ? "session" : "read",
      states: ["idle", "busy", "paused"], busyPolicy: ["reasoning", "compact"].includes(commandName) ? "reject" : "read-only",
      confirmation: localSetup.has(commandName) ? "local-only" : "none",
      availability: available ? "available" : localSetup.has(commandName) || presentation.has(commandName) || externalVendor.has(commandName) ? "policy-denied" : "implementation-gap",
      reason: available ? "shared-native-handler" : presentation.has(commandName) ? "client-presentation" : externalVendor.has(commandName) ? "external-vendor-execution-not-admitted" : localSetup.has(commandName) ? "dedicated-local-security-workflow" : "required-domain-handler-extraction-pending",
    };
  });
  for (const contribution of [...projectInspectionCommands(), ...acCheckCommands(), ...decisionFollowupCommands(), ...projectRecordCommands(), ...routingCategoryCommands(), ...conversationCommands(), ...questionCommands(), ...lifecycleCommands(), ...sessionControlCommands(), ...goalCommands(), ...sessionSettingsCommands(), ...reasoningCommands(), ...planCommands(), ...approvalModeCommands(), ...rewindCommands(), ...settingsInspectionCommands({ readiness: NATIVE_DEFAULT_SERVICE_READINESS.settings }), ...analysisCommands(NATIVE_DEFAULT_SERVICE_READINESS.analysis), ...tasksIntegrationsCommands({ readiness: NATIVE_DEFAULT_SERVICE_READINESS.integrations }), ...contributions]) {
    const index = entries.findIndex((entry) => entry.commandName === contribution.entry.commandName);
    if (index >= 0) entries[index] = contribution.entry;
    else entries.push(contribution.entry);
  }
  return { catalogueVersion: 1, catalogueDigest: catalogueDigest(entries), capabilityDigest, entries };
}
/**
 * The catalogue a native session host enforces: the shared entries, its runtime's contributions, and the lifecycle and owned rewind
 * ports the host was given. A machine profile publishes exactly this to Hub (hub-machine/production.ts), so every Hub-delivered
 * CommandInvoke carries the digest its host validates against.
 */
export function createHostCommandCatalogue(capabilityDigest: string, input: { contributions: readonly NativeCommandContribution[]; lifecycle: boolean; rewind: boolean }): Control["CommandCatalogue"] {
  return createCommandCatalogue(capabilityDigest, [...input.contributions, ...lifecycleCommands(input.lifecycle), ...rewindCommands(input.rewind)]);
}
