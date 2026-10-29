import path from "node:path";
import { commandsForMode } from "../../commands/agent-commands";
import { buildDoctorReport } from "../../commands/doctor";
import { renderSetupSlash } from "../../commands/setup-guide";
import { loadReport } from "../../decisions/service";
import { readLatestGovernanceReport } from "../../governance/service";
import { loadOpenReport } from "../../product/service";
import { validateArguments, type Control } from "../../remote-control/protocol";
import { computeBotMetrics } from "../../review/bot/metrics";
import { redactSensitiveText } from "../../security/service";
import { loadInspectorCatchUp, loadInspectorFlows, loadInspectorSlates, loadInspectorWorkspace, loadInspectorWorkspaces } from "../../tui/inspector-sources";
import { loadReviewDepth } from "../../tui/review-panel";
import { loadTriggerLedgerView } from "../../tui/trigger-ledger";
import type { NativeCommandContribution, SessionCommandContext } from "./handlers";

export type ProjectInspectionContext = Pick<SessionCommandContext, "cwd" | "nativeSessionDir" | "configDir" | "inspectionMode" | "projectContext" | "effect">;
type Source = "hub-canonical" | "local-native";
export type ProjectInspectionResult =
  | { ok: true; source: Source; data: unknown }
  | { ok: false; source: Source; error: { code: "invalid-arguments" | "setup-required" | "not-found" | "read-failed" | "quota-exceeded" | "local-required"; message: string } };

const text: Control["ArgumentSchema"] = { type: "string", maxLength: 200 };
const choice = (...values: string[]): Control["ArgumentSchema"] => ({ type: "string", maxLength: 64, enum: values });
const object = (properties: Record<string, Control["ArgumentSchema"]>): Control["ArgumentSchema"] => ({ type: "object", properties, additionalProperties: false, required: [] });
const schemas: Record<string, Control["ArgumentSchema"]> = {
  doctor: object({}), setup: object({ scenario: choice("init", "refresh", "repair") }),
  flows: object({ flowId: text }), flow: object({ flowId: text }), ac: object({ flowId: text }),
  workspace: object({ workspaceId: text }), review: object({}),
  reviews: object({ section: choice("overview", "layers", "parity", "readiness", "depth") }),
  product: object({}), governance: object({}), triggers: object({ name: text }),
  decisions: object({ section: choice("show", "arms") }), integrate: object({}),
  // The workspace inspector's Slate tab: one slate of the selected workspace, picked by the session it belongs to.
  "workspace.slate": { type: "object", properties: { workspaceId: text, sessionId: text }, additionalProperties: false, required: ["workspaceId", "sessionId"] },
};
const sourceFor = (context: ProjectInspectionContext, command: string): Source =>
  ["flow", "flows", "ac"].includes(command) && context.inspectionMode !== "local-native" ? "hub-canonical" : "local-native";
function failure(source: Source, code: Extract<ProjectInspectionResult, { ok: false }>["error"]["code"], message: string): ProjectInspectionResult {
  return { ok: false, source, error: { code, message } };
}

/** Data readers shared with the shipped terminal clients, with canonical remote Flow reads explicit. */
export async function executeProjectInspection(context: ProjectInspectionContext, command: string, input: unknown): Promise<ProjectInspectionResult> {
  const source = sourceFor(context, command);
  const schema = schemas[command];
  if (schema === undefined || !validateArguments(schema, input).ok) return failure(source, "invalid-arguments", "Arguments do not match the selected command.");
  const args = input as Record<string, string | undefined>;
  try {
    const read = readers[command];
    if (read === undefined) return failure(source, "invalid-arguments", "Unknown project command.");
    const data = await read(context, args);
    if (isFailure(data)) return data;
    const result: ProjectInspectionResult = { ok: true, source, data: sanitize(data, context) };
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= 30000 ? result : failure(source, "quota-exceeded", "The report exceeds the remote command result limit. Narrow the selection locally.");
  } catch {
    return failure(source, "read-failed", "The project report could not be read. No project state was changed.");
  }
}
function isFailure(value: unknown): value is Extract<ProjectInspectionResult, { ok: false }> {
  return value !== null && typeof value === "object" && "ok" in value && value.ok === false && "error" in value;
}

async function flows(context: ProjectInspectionContext, args: Record<string, string | undefined>): Promise<unknown> {
  if (context.inspectionMode !== "local-native") {
    if (context.projectContext?.source !== "hub-canonical") return failure("hub-canonical", "setup-required", "The scoped canonical Hub project reader is unavailable.");
    return args.flowId === undefined ? context.projectContext.listFlows() : context.projectContext.readFlow(args.flowId);
  }
  const records = await loadInspectorFlows(context.cwd);
  if (args.flowId === undefined) return records;
  return records.find((record) => record.id === args.flowId || path.basename(record.dir) === args.flowId)
    ?? failure("local-native", "not-found", "The selected local-native Flow was not found.");
}
async function workspace(context: ProjectInspectionContext, args: Record<string, string | undefined>): Promise<unknown> {
  if (args.workspaceId === undefined) return loadInspectorWorkspaces(context.cwd);
  const selected = await loadInspectorWorkspace(context.cwd, args.workspaceId);
  if (selected === undefined) return failure("local-native", "not-found", "The selected local-native workspace was not found.");
  return { workspace: selected, slates: await loadInspectorSlates(context.cwd, args.workspaceId) };
}

type Reader = (context: ProjectInspectionContext, args: Record<string, string | undefined>) => Promise<unknown>;
const readers: Record<string, Reader> = {
  doctor: (context) => buildDoctorReport(context.cwd),
  setup: async (_context, args) => renderSetupSlash(args.scenario ?? ""),
  flows, flow: flows,
  ac: async (context, args) => { const selected = await flows(context, args); return isFailure(selected) ? selected : { advisoryOnly: true, flow: selected }; },
  workspace,
  "workspace.slate": async (context, args) => {
    if (await loadInspectorWorkspace(context.cwd, args.workspaceId!) === undefined) return failure("local-native", "not-found", "The selected local-native workspace was not found.");
    return (await loadInspectorSlates(context.cwd, args.workspaceId!)).find((item) => item.sessionId === args.sessionId)
      ?? failure("local-native", "not-found", "No slate of the selected session is bound to this workspace.");
  },
  review: (context) => loadInspectorCatchUp(context.cwd),
  reviews: async (context, args) => {
    const depth = await loadReviewDepth(context.cwd);
    return args.section === undefined || args.section === "overview" ? { metrics: await computeBotMetrics(context.cwd), depth }
      : { section: args.section, depth };
  },
  product: (context) => loadOpenReport(context.cwd),
  governance: (context) => readLatestGovernanceReport(context.cwd),
  triggers: async (context, args) => {
    const view = await loadTriggerLedgerView(context.cwd);
    const entries = args.name === undefined ? view.entries : view.entries.filter((item) => item.entry.name === args.name);
    if (args.name !== undefined && entries.length === 0) return failure("local-native", "not-found", "The selected local-native trigger was not found.");
    return { config: view.config, entries, rejected: view.rejected, openReservations: view.openReservations, spend: view.spend };
  },
  decisions: async (context, args) => { const report = await loadReport(context.cwd); return args.section === "arms" ? { byArm: report.byArm, armA: report.armA, byChannel: report.byChannel, headlineChannel: report.headlineChannel } : report; },
  integrate: async () => failure("local-native", "local-required", "Editor installation and trust configuration require the dedicated local security workflow."),
};

/** Redaction precedes the text result entering a local outbox. Never export local root paths or environment dictionaries. */
function sanitize(value: unknown, context: ProjectInspectionContext): unknown {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (/^(?:env|environment|authorization|cookie|password|secret|token|apiKey)$/i.test(key)) return "[REDACTED]";
    if (typeof item !== "string") return item;
    let safe = item.replaceAll(context.cwd, ".").replaceAll(context.nativeSessionDir, "[native-session]");
    if (context.configDir !== undefined) safe = safe.replaceAll(context.configDir, "[local-config]");
    return redactSensitiveText(safe);
  }));
}

export function projectInspectionCommands(): NativeCommandContribution[] {
  const actual = commandsForMode("agent");
  return Object.entries(schemas).map(([commandName, inputSchema]) => ({
    entry: {
      commandName, summary: actual.find((command) => command.name === `/${commandName}`)?.description ?? commandName,
      handlerId: `native.project.${commandName}`, inputSchema, resultSchema: { type: "string", maxLength: 32768 },
      mutationClass: commandName === "integrate" ? "sensitive-setup" : "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only",
      confirmation: commandName === "integrate" ? "local-only" : "none", availability: commandName === "integrate" ? "policy-denied" : "available",
      reason: commandName === "integrate" ? "dedicated-local-editor-trust-workflow" : "shared-existing-project-domain-reader",
    },
    execute: (context, request) => executeProjectInspection(context, commandName, request.arguments),
  }));
}
