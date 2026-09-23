// Flow 305 (W5-a): harness payload parsers and the block/allow signal codecs,
// moved from `src/ctx/runtimes.ts` (which re-exports them for its existing
// callers/tests). Pure functions only — no settings-file I/O, no dependency on
// `src/ctx` or `src/security` (import-cycle guard: those zones import THIS
// module, never the reverse).

import type { DecisionCodec, HookAction } from "./types";

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
//
// F10: each SHAPE is its own `DecisionCodec` constant, and a ctx-guard
// surface in `surfaces.ts` picks the one it needs directly — so a NEW adapter
// with, say, cursor's stdout-JSON shape reuses `CURSOR_DECISION_CODEC` on its
// own surface, and a genuinely new shape adds a new constant here, but never
// needs to edit a switch keyed on a growing list of runtime ids. The
// `refusalAction`/`allowAction` switches below still exist ONLY for the
// security CLI's `--runtime <id>` argument path, which decides a shape from a
// bare string at process-invocation time with no `SurfaceAdapter` in hand —
// they now delegate to these same constants rather than duplicating the
// literal `HookAction` shapes a second time.

/** Exit-code signalling: claude, codex, windsurf, the opencode bridge. */
export const EXIT_CODE_DECISION_CODEC: DecisionCodec = {
  refuse: (_runtimeId, message) => ({ exitCode: 2, stderr: `${message}\n` }),
  allow: (_runtimeId) => ({ exitCode: 0 }),
};

/** Cursor: stdout JSON `{ permission, agent_message? }`, always exit 0. */
export const CURSOR_DECISION_CODEC: DecisionCodec = {
  refuse: (_runtimeId, message) => ({
    exitCode: 0,
    stdout: `${JSON.stringify({ permission: "deny", agent_message: message })}\n`,
  }),
  allow: (_runtimeId) => ({ exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n` }),
};

/** Antigravity: stdout JSON `{ allow_tool, deny_reason? }`, always exit 0. */
export const ANTIGRAVITY_DECISION_CODEC: DecisionCodec = {
  refuse: (_runtimeId, message) => ({
    exitCode: 0,
    stdout: `${JSON.stringify({ allow_tool: false, deny_reason: message })}\n`,
  }),
  allow: (_runtimeId) => ({ exitCode: 0, stdout: `${JSON.stringify({ allow_tool: true })}\n` }),
};

/**
 * How a runtime says NO, given the message, resolved by runtime id — kept for
 * the security CLI's `--runtime <id>` argument path (see the module note
 * above); a ctx-guard `SurfaceAdapter` should use its own `decisionCodec`
 * instead of this switch. An unknown id returns the exit-code form, which is
 * the majority shape and fails toward refusing.
 */
export function refusalAction(runtimeId: string, message: string): HookAction {
  switch (runtimeId) {
    case "cursor":
      return CURSOR_DECISION_CODEC.refuse(runtimeId, message);
    case "antigravity":
      return ANTIGRAVITY_DECISION_CODEC.refuse(runtimeId, message);
    default:
      return EXIT_CODE_DECISION_CODEC.refuse(runtimeId, message);
  }
}

/** How a runtime says YES. The other half of the same fact. */
export function allowAction(runtimeId: string): HookAction {
  switch (runtimeId) {
    case "cursor":
      return CURSOR_DECISION_CODEC.allow(runtimeId);
    case "antigravity":
      return ANTIGRAVITY_DECISION_CODEC.allow(runtimeId);
    default:
      return EXIT_CODE_DECISION_CODEC.allow(runtimeId);
  }
}

/** @deprecated Use the surface's own `decisionCodec`, or `refusalAction`/`allowAction` for the CLI's dynamic-id path. Kept only so nothing importing it breaks mid-refactor. */
export const HOOK_DECISION_CODEC: DecisionCodec = { refuse: refusalAction, allow: allowAction };
