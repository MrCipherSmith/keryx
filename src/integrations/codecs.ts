// Flow 305 (W5-a): harness payload parsers and the block/allow signal codecs,
// moved from `src/ctx/runtimes.ts` (which re-exports them for its existing
// callers/tests). Pure functions only — no settings-file I/O, no dependency on
// `src/ctx` or `src/security` (import-cycle guard: those zones import THIS
// module, never the reverse).

import type { DecisionCodec } from "./types";

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

// Gemini CLI hooks (https://geminicli.com/docs/hooks/reference/):
// { tool_name:"run_shell_command", tool_input.command }. Same envelope shape
// as `parseToolInputCommand`, but Gemini CLI's shell tool is named
// `run_shell_command`, not `Bash` — a distinct codec rather than widening
// `parseToolInputCommand`'s check, since that one is pinned by existing tests
// against the literal `"Bash"` tool name.
export function parseRunShellCommandInput(payload: string): string | null {
  const record = parseJson(payload);
  if (!record || record.tool_name !== "run_shell_command") return null;
  const input = record.tool_input;
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

// Kiro hooks (`.kiro/hooks/keryx-ctx-guard.json`): stdin field names are
// THIRD-PARTY ONLY (see surfaces-w5b.ts riskNotes) — accept `tool_input.command`
// (mirroring the documented shape other harnesses use) and tolerate a bare
// top-level `command`, so a slightly different real payload still parses.
// Fail-open (null) for anything else.
export function parseKiroCommand(payload: string): string | null {
  const record = parseJson(payload);
  if (!record) return null;
  const input = record.tool_input;
  if (typeof input === "object" && input !== null) {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  const topLevel = record.command;
  return typeof topLevel === "string" ? topLevel : null;
}

// GitHub Copilot agent hooks (https://docs.github.com/en/copilot/reference/hooks-reference):
// { toolName, toolArgs: { command } } — `toolArgs` is documented as an
// object, but tolerate it arriving as a JSON string too (some hook runners
// stringify nested payloads before delivering them over stdin).
export function parseCopilotToolArgsCommand(payload: string): string | null {
  const record = parseJson(payload);
  if (!record) return null;
  let toolArgs = record.toolArgs;
  if (typeof toolArgs === "string") {
    try {
      toolArgs = JSON.parse(toolArgs) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof toolArgs !== "object" || toolArgs === null) return null;
  const command = (toolArgs as Record<string, unknown>).command;
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
// F10/R2-F1: each SHAPE is its own `DecisionCodec` constant, and a ctx-guard
// surface in `surfaces.ts` picks the one it needs directly — so a NEW adapter
// with, say, cursor's stdout-JSON shape reuses `CURSOR_DECISION_CODEC` on its
// own surface, and a genuinely new shape adds a new constant here, but never
// needs to edit a switch keyed on a growing list of runtime ids. Resolving a
// SHAPE from a bare runtime id (the ctx native-search refusal in
// `src/ctx/hook.ts`, and the security CLI's `--runtime <id>` argument path,
// neither of which has a `SurfaceAdapter` in hand) is `registry.ts`'s job now
// — `decisionCodecFor`/`refusalAction`/`allowAction` there read
// `HarnessAdapter.decisionCodec`, so this module never re-lists which id maps
// to which shape a second time. This file stays a leaf: it may be imported by
// the registry, but must never import it back (cycle guard, module header).

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
 * GitHub Copilot agent: refuse via exit 2 + stdout
 * `{"permissionDecision":"deny","permissionDecisionReason":<message>}` (also
 * mirrored on stderr); allow via plain exit 0 with no stdout. `src/ctx/hook.ts`'s
 * escape-reason stderr note only fires when `allow()` produced no `stdout`
 * (see `runtimeFromSurface` in `src/ctx/runtimes.ts`), which this allow shape
 * satisfies.
 */
export const COPILOT_DECISION_CODEC: DecisionCodec = {
  refuse: (_runtimeId, message) => ({
    exitCode: 2,
    stdout: `${JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: message })}\n`,
    stderr: `${message}\n`,
  }),
  allow: (_runtimeId) => ({ exitCode: 0 }),
};

