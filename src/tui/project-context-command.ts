// The pure, OpenTUI-free half of `project-context-inspector.ts`: the /projectctx command grammar and
// its refusal text, shared with the ACP `shell` profile. `project-context-inspector.ts` re-exports it.

import type { ProjectContextStatus } from "../gdskills/project-context-status";


export const PROJECT_CONTEXT_COMMAND = "/projectctx";

export type EnforcementMode = ProjectContextStatus["enforcement"];

export type ProjectContextTab = "status" | "last" | "references";

export type ProjectContextCommand =
  | { kind: "open"; /** Absent: the Status tab. */ tab?: "references" }
  | { kind: "set"; mode: EnforcementMode }
  | { kind: "invalid"; message: string };

export function isProjectContextCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === PROJECT_CONTEXT_COMMAND;
}

export function parseProjectContextCommand(line: string): ProjectContextCommand {
  const [, ...rest] = line.trim().split(/\s+/);
  if (rest.length === 0) return { kind: "open" };
  const arg = rest[0] as string;
  if (rest.length === 1 && (arg === "warn" || arg === "block")) return { kind: "set", mode: arg };
  if (rest.length === 1 && arg === "refs") return { kind: "open", tab: "references" };
  return { kind: "invalid", message: `Unknown ${PROJECT_CONTEXT_COMMAND} argument '${rest.join(" ")}'. Usage: ${PROJECT_CONTEXT_COMMAND} [warn|block|refs]` };
}

export const NO_RESOLVE_TEXT = "no resolve recorded yet";

export const PROJECT_CONTEXT_CONFIG_REFUSAL = "projectctx: tasks.config.json is not valid JSON, refusing to overwrite it";
