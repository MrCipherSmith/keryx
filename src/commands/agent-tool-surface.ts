// The one description of what tools agent mode has (flow 136 / D1 layer 3).
//
// There used to be two: `buildAgentSystemInstruction` (agent.ts) told the model
// about nine tools, and `readlineAgentHelpText` (shell.ts) told the user about
// six — while the registry actually built fifteen. Each list was hand-written, so
// a tool added in one place appeared in neither, and a model that is not told a
// tool exists reaches for `shell_exec` instead. That is D1 layer 3, and it is the
// reason the fix has to be a shared derivation rather than a corrected literal.
//
// Everything here is a pure function of the tool array the session actually
// registered, so the instruction, the help text and the registry cannot disagree
// unless a caller passes a different array — which is what the drift test checks.

import { METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";

/** Read-only filesystem/inspection tools, in the order the agent registers them. */
export const FILESYSTEM_TOOL_NAMES: readonly string[] = ["get_cwd", "list_dir", "read_file"];

/** Tools that pass through the approval gate before they run. */
export const APPROVAL_GATED_TOOL_NAMES: readonly string[] = ["shell_exec", "spawn_subagent"];

/** The interactive question tool — read-risk, but it needs a person to answer. */
export const INTERACTIVE_TOOL_NAMES: readonly string[] = ["ask_user"];

/** Every metaproject operation name, straight from the descriptor source. */
export function metaprojectToolNames(): string[] {
  return METAPROJECT_OPERATIONS.map((op) => op.name);
}

/**
 * The tool names agent mode registers when nothing narrows the set. Used as the
 * default for callers that build an instruction without a session (tests, docs);
 * production callers pass the real registered array through
 * {@link advertisedToolNames}.
 */
export function defaultAgentToolNames(): string[] {
  return [
    ...FILESYSTEM_TOOL_NAMES,
    ...metaprojectToolNames(),
    "shell_exec",
    ...INTERACTIVE_TOOL_NAMES,
    "spawn_subagent",
  ];
}

/** The distinct names of a registered tool array, order preserved. */
export function advertisedToolNames(tools: readonly InteractiveTool[]): string[] {
  return [...new Set(tools.map((tool) => tool.definition.name))];
}

/** Tool names grouped by how the model should think about reaching for them. */
export interface AgentToolSurface {
  /** Every advertised name. */
  all: string[];
  /** Read-only filesystem/inspection tools. */
  filesystem: string[];
  /** keryx metaproject read tools — the project's own precomputed answers. */
  metaproject: string[];
  /** Tools that require approval before they run. */
  gated: string[];
  /** Advertised tools in none of the above groups. */
  other: string[];
}

/**
 * Group advertised tool names. The metaproject group is resolved against the
 * descriptor source rather than a copy of it, so a new operation lands in the
 * right group with no edit here.
 */
export function groupToolNames(names: readonly string[]): AgentToolSurface {
  const metaproject = new Set(metaprojectToolNames());
  const filesystem = new Set(FILESYSTEM_TOOL_NAMES);
  const gated = new Set(APPROVAL_GATED_TOOL_NAMES);
  const surface: AgentToolSurface = { all: [...names], filesystem: [], metaproject: [], gated: [], other: [] };
  for (const name of names) {
    if (filesystem.has(name)) {
      surface.filesystem.push(name);
    } else if (metaproject.has(name)) {
      surface.metaproject.push(name);
    } else if (gated.has(name)) {
      surface.gated.push(name);
    } else {
      surface.other.push(name);
    }
  }
  return surface;
}

/** Render a name list for prose: `a, b and c`; `(none)` when empty. */
export function renderToolList(names: readonly string[]): string {
  if (names.length === 0) {
    return "(none)";
  }
  if (names.length === 1) {
    return names[0] ?? "(none)";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}
