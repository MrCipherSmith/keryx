// Flow 305 (W5-a): harness payload parsers and the block/allow signal codecs,
// moved from `src/ctx/runtimes.ts` (which re-exports them for its existing
// callers/tests). Pure functions only — no settings-file I/O, no dependency on
// `src/ctx` or `src/security` (import-cycle guard: those zones import THIS
// module, never the reverse).

import type { HookAction } from "./types";

function parseJson(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Claude Code / Codex / OpenCode bridge: { tool_name:"Bash", tool_input.command }.
export function parseToolInputCommand(payload: string): string | null {
  const record = parseJson(payload);
  if (!record || record.tool_name !== "Bash") return null;
  const input = record.tool_input;
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

/** The `tool_name` of a PreToolUse payload, for runtimes that shape it that way. */
export function parseToolName(payload: string): string | null {
  const record = parseJson(payload);
  const name = record?.tool_name;
  return typeof name === "string" ? name : null;
}

// Cursor beforeShellExecution: top-level { command }.
export function parseCursorCommand(payload: string): string | null {
  const record = parseJson(payload);
  const command = record?.command;
  return typeof command === "string" ? command : null;
}

// Windsurf pre_run_command: { tool_info: { command_line } }.
export function parseWindsurfCommand(payload: string): string | null {
  const record = parseJson(payload);
  const info = record?.tool_info;
  if (typeof info !== "object" || info === null) return null;
  const command = (info as Record<string, unknown>).command_line;
  return typeof command === "string" ? command : null;
}

// Antigravity run_command: { toolCall: { args: { CommandLine } } }.
export function parseAntigravityCommand(payload: string): string | null {
  const record = parseJson(payload);
  const call = record?.toolCall;
  const args = call && typeof call === "object" ? (call as Record<string, unknown>).args : undefined;
  const command = args && typeof args === "object" ? (args as Record<string, unknown>).CommandLine : undefined;
  return typeof command === "string" ? command : null;
}

// --- block/allow signalers ---------------------------------------------------

/**
 * How a runtime says NO, given the message. The one owner of that fact.
 *
 * `runtimeId` is a ctx-guard runtime id. An unknown id returns the exit-code
 * form, which is the majority shape and fails toward refusing.
 */
export function refusalAction(runtimeId: string, message: string): HookAction {
  switch (runtimeId) {
    case "cursor":
      return { exitCode: 0, stdout: `${JSON.stringify({ permission: "deny", agent_message: message })}\n` };
    case "antigravity":
      return { exitCode: 0, stdout: `${JSON.stringify({ allow_tool: false, deny_reason: message })}\n` };
    default:
      return { exitCode: 2, stderr: `${message}\n` };
  }
}

/** How a runtime says YES. The other half of the same fact. */
export function allowAction(runtimeId: string): HookAction {
  switch (runtimeId) {
    case "cursor":
      return { exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n` };
    case "antigravity":
      return { exitCode: 0, stdout: `${JSON.stringify({ allow_tool: true })}\n` };
    default:
      return { exitCode: 0 };
  }
}
