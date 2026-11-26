// Tracked project records a native session changes through the same owners the TUI uses: the project-context enforcement mode
// (`/projectctx warn|block`, gdskills/project-context-config.ts) and a local Flow's origin (`/flow origin <id> <kind> --reason …`,
// flow/service.ts originSet). Each write is one owned workspace effect over exactly the files it names, inside an admitted run.
import { flowServiceDeps } from "../../commands/flow";
import { createFlowService, resolveFlowDir } from "../../flow/service";
import type { FlowService } from "../../flow/types";
import { writeProjectContextEnforcement } from "../../gdskills/project-context-config";
import { loadProjectContextStatus } from "../../gdskills/project-context-status";
import { validateArguments, type Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import { formatOriginSetResult, summarizeOrigins } from "../../tui/flow-origin-command";
import { PROJECT_CONTEXT_CONFIG_REFUSAL } from "../../tui/project-context-inspector";
import type { NativeCommandContribution, SessionCommandContext } from "./handlers";
import { formatRefResult, runRefAction } from "../../commands/ref";
import { LINKED_PROJECTS_PATH } from "../../lib/linked-projects";

export type ProjectRecordContext = Pick<SessionCommandContext, "cwd" | "effect">;
export type ProjectRecordResult =
  | { ok: true; source: "local-native"; data: unknown }
  | { ok: false; source: "local-native"; error: { code: "invalid-arguments" | "not-admitted" | "not-found" | "refused" | "read-failed"; message: string } };

const PROJECT_CONFIG = ".metaproject/tasks.config.json";
const text = (maxLength: number): Control["ArgumentSchema"] => ({ type: "string", maxLength });
const schemas: Record<string, Control["ArgumentSchema"]> = {
  "projectctx.set": { type: "object", additionalProperties: false, properties: { mode: { type: "string", maxLength: 8, enum: ["warn", "block"] } }, required: ["mode"] },
  "flow.origins": { type: "object", additionalProperties: false, properties: {}, required: [] },
  "flow.origin.set": { type: "object", additionalProperties: false, properties: { flowId: text(200), kind: text(64), reason: text(2000), quote: text(8000), source: text(2000) }, required: ["flowId", "kind", "reason"] },
  // Linked projects (`.metaproject/linked-projects.json`): `/ref [list|add|remove]` and its one-word aliases.
  ref: { type: "object", additionalProperties: false, properties: { action: { type: "string", maxLength: 8, enum: ["list", "add", "remove"] }, target: text(4096), name: text(64), note: text(200) }, required: [] },
  "ref-list": { type: "object", additionalProperties: false, properties: {}, required: [] },
  "add-ref": { type: "object", additionalProperties: false, properties: { target: text(4096), name: text(64), note: text(200) }, required: ["target"] },
  "ref-remove": { type: "object", additionalProperties: false, properties: { target: text(4096) }, required: ["target"] },
};
const REF_COMMANDS = new Set(["ref", "ref-list", "add-ref", "ref-remove"]);
/** Whether a typed ref request only reads. */
function refAction(command: string, args: Record<string, string | undefined>): "list" | "add" | "remove" {
  if (command === "add-ref") return "add";
  if (command === "ref-remove") return "remove";
  if (command === "ref") return (args.action as "list" | "add" | "remove" | undefined) ?? "list";
  return "list";
}
/** `/ref …`: the same owner the TUI and `keryx ref` use; a change is one owned write of linked-projects.json. */
async function runRef(context: ProjectRecordContext, command: string, args: Record<string, string | undefined>): Promise<ProjectRecordResult> {
  const action = refAction(command, args);
  if (action === "list") {
    const result = await runRefAction(context.cwd, ["list"]);
    return ok(context, { projects: result.projects.map(({ name, path, exists }) => ({ name, path, exists })), text: formatRefResult(result) });
  }
  if (args.target === undefined || args.target.trim() === "") return failure("invalid-arguments", `/ref ${action} needs a folder or name.`);
  const effect = context.effect;
  if (effect === undefined) return failure("not-admitted", "Changing the linked projects needs an admitted run.");
  const argv = action === "add"
    ? ["add", args.target, ...(args.name === undefined ? [] : ["--name", args.name]), ...(args.note === undefined ? [] : ["--note", args.note])]
    : ["remove", args.target];
  const result = await effect.mutate("project-record", [LINKED_PROJECTS_PATH], () => runRefAction(context.cwd, argv));
  if (!result.ok) return failure(action === "remove" ? "not-found" : "refused", result.error ?? `/ref ${action} failed.`);
  return ok(context, { projects: result.projects.map(({ name, path, exists }) => ({ name, path, exists })), text: formatRefResult(result) });
}
function failure(code: Extract<ProjectRecordResult, { ok: false }>["error"]["code"], message: string): ProjectRecordResult {
  return { ok: false, source: "local-native", error: { code, message } };
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const ok = (context: ProjectRecordContext, data: Record<string, unknown>): ProjectRecordResult =>
  ({ ok: true, source: "local-native", data: JSON.parse(redactSensitiveText(JSON.stringify(data).replaceAll(context.cwd, "."))) as unknown });

/** `/projectctx warn|block`: refused on an unreadable config exactly as the TUI refuses it, otherwise one owned write of tasks.config.json. */
async function setProjectContext(context: ProjectRecordContext, mode: "warn" | "block"): Promise<ProjectRecordResult> {
  const effect = context.effect;
  if (effect === undefined) return failure("not-admitted", "Changing the project-context enforcement needs an admitted run.");
  const current = await loadProjectContextStatus(context.cwd);
  if (current.configError !== undefined) return failure("refused", PROJECT_CONTEXT_CONFIG_REFUSAL);
  await effect.mutate("project-record", [PROJECT_CONFIG], () => writeProjectContextEnforcement(context.cwd, mode));
  return ok(context, { enforcement: mode, text: `ProjectCtx: ${mode}` });
}

/** `/flow origin <id> <kind> --reason …`: the flow service's own evidence rule, lock and journal line, as one owned write of that Flow's record. */
async function setFlowOrigin(context: ProjectRecordContext, service: FlowService, args: { flowId: string; kind: string; reason: string; quote?: string; source?: string }): Promise<ProjectRecordResult> {
  const effect = context.effect;
  if (effect === undefined) return failure("not-admitted", "Setting a Flow origin needs an admitted run.");
  // Refused before any owned effect begins, so an invalid reason never leaves the checkout's ownership uncertain.
  if (args.reason.trim().length === 0) return failure("invalid-arguments", `/flow origin ${args.flowId} ${args.kind} needs --reason "<why>".`);
  if (/[\r\n]/.test(args.reason)) return failure("invalid-arguments", "flow origin: --reason must fit on one line (no line breaks) — it is written as a single `journal.md` bullet.");
  let dir: string;
  try { dir = await resolveFlowDir(context.cwd, args.flowId); } catch (cause) { return failure("not-found", `flow origin: ${message(cause)}`); }
  const record = `.metaproject/flows/${dir}`;
  const result = await effect.mutate("project-record", [`${record}/flow.json`, `${record}/journal.md`], () => service.originSet({ cwd: context.cwd, id: args.flowId, kind: args.kind,
    reason: args.reason, quote: args.quote, source: args.source }));
  return ok(context, { flowId: result.flow.id, previous: result.previous, next: result.next, changed: result.changed, text: formatOriginSetResult(result) });
}

export async function executeProjectRecord(context: ProjectRecordContext, command: string, input: unknown, service: FlowService = createFlowService(flowServiceDeps())): Promise<ProjectRecordResult> {
  const schema = schemas[command];
  if (schema === undefined || !validateArguments(schema, input).ok) return failure("invalid-arguments", "Arguments do not match the selected command.");
  const args = input as Record<string, string | undefined>;
  if (command === "projectctx.set") return setProjectContext(context, args.mode as "warn" | "block");
  if (REF_COMMANDS.has(command)) return runRef(context, command, args);
  if (command === "flow.origin.set") return setFlowOrigin(context, service, args as { flowId: string; kind: string; reason: string; quote?: string; source?: string });
  // `/flow origin` with no id: the TUI's bounded summary of this checkout's local Flow origins.
  try { return ok(context, { text: await summarizeOrigins(context.cwd, service) }); } catch { return failure("read-failed", "The local Flow origins could not be read."); }
}

export function projectRecordCommands(): NativeCommandContribution[] {
  return Object.entries(schemas).map(([commandName, inputSchema]) => {
    if (REF_COMMANDS.has(commandName)) {
      // `ref` may write (add/remove); `ref-list` only reads.
      const read = commandName === "ref-list";
      return {
        entry: { commandName, summary: read ? "List this project's linked projects with a summary of each" : commandName === "ref"
          ? "List, add or remove this project's linked projects (.metaproject/linked-projects.json)" : commandName === "add-ref" ? "Link a folder to this project" : "Unlink a linked project; the folder is not touched",
        handlerId: `native.project-record.${commandName}`, inputSchema, resultSchema: { type: "string", maxLength: 32768 },
        mutationClass: read ? "read" : "workspace", states: read ? ["idle", "busy", "paused"] : ["idle"], busyPolicy: read ? "read-only" : "reject", confirmation: "none",
        availability: "available", reason: read ? "shared-existing-linked-projects-reader" : "shared-existing-project-record-owner" },
        execute: (context, request) => executeProjectRecord(context, commandName, request.arguments),
      } satisfies NativeCommandContribution;
    }
    const read = commandName === "flow.origins";
    return {
      entry: { commandName, summary: commandName === "projectctx.set" ? "Set the project-context enforcement mode (warn or block) in the project config"
        : read ? "Summarize the origins of this checkout's local Flows" : "Set a local Flow's origin with a reason and its evidence",
      handlerId: `native.project-record.${commandName}`, inputSchema, resultSchema: { type: "string", maxLength: 32768 },
      mutationClass: read ? "read" : "workspace", states: read ? ["idle", "busy", "paused"] : ["idle"], busyPolicy: read ? "read-only" : "reject", confirmation: "none",
      availability: "available", reason: read ? "shared-existing-flow-origin-reader" : "shared-existing-project-record-owner" },
      execute: (context, request) => executeProjectRecord(context, commandName, request.arguments),
    } satisfies NativeCommandContribution;
  });
}
