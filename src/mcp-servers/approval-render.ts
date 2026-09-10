// What an operator is shown before a third-party MCP tool is called.
//
// Two review findings, deferred from P0 to here by operator decision, and
// they ask for the same thing:
//
//   F-032 — `use_tool` fell through to `evaluateShellApproval`, so the TUI
//   drew it as a shell command and offered "Always allow" with an exact
//   match. Not an approval bypass (auto-approve gates on `!destructive`
//   and `use_tool` is unconditionally destructive), but the permission
//   store then accepts MODEL-CONTROLLED text as a grant pattern.
//
//   F-033 — the readline prompt truncated any non-`shell_exec` tool input
//   at 117 characters, and `use_tool`'s schema does not constrain JSON key
//   order. A call whose first key is a reassuring `reason` shows the
//   operator the reassurance and puts the tool name and the destructive
//   arguments past the cut. `apply_patch` is deliberately rendered
//   untruncated at that same call site for exactly this reason, and the
//   Codex elicitation has its own branch too. `use_tool` had neither.
//
// So this module is the branch `use_tool` was missing, and it is a MODULE
// rather than two branches because the two surfaces that need it — the
// readline shell and the TUI — had already drifted once. It returns a
// value and touches no terminal, which is what lets the class table next
// door test it at all.
//
// The rule it exists to enforce: the operator must be able to see WHICH
// SERVER, WHICH TOOL, and WHAT ARGUMENTS, and no ordering of keys chosen
// by the model may push any of those three out of view.

import { parseJsonTolerant } from "./config";
import { sanitiseForDisplay } from "./tools";

/** How a qualified name splits. `server__tool`, per the catalog. */
export const FQN_SEPARATOR = "__";

export type ToolApprovalDescription = {
  /** `Approve MCP tool call?` — the headline, never the raw JSON. */
  readonly title: string;
  /** The server the call goes to. `(unknown)` when the name is unqualified. */
  readonly server: string;
  /** The tool on that server, unqualified. */
  readonly tool: string;
  /** The qualified name as the model wrote it. */
  readonly fqn: string;
  /** Argument lines, pretty-printed, each already safe to print. */
  readonly argumentLines: readonly string[];
  /** True when the arguments were elided; the caller says so in its own idiom. */
  readonly argumentsTruncated: boolean;
  /**
   * Whether an "always allow" option may be offered.
   *
   * ALWAYS false for an MCP call, and the field exists rather than being
   * implied so a caller cannot forget: the grant pattern would be a
   * qualified tool name the model supplied, stored in the operator's
   * permission file. F-032.
   */
  readonly rememberable: false;
};

/**
 * Cap on the rendered arguments.
 *
 * Generous, and applied to the ARGUMENTS only — never to the tool name,
 * which is rendered separately above them and can therefore not be pushed
 * out of view by anything the model puts in the payload. That separation
 * is the whole fix for F-033; the number is secondary.
 */
export const MAX_ARGUMENT_CHARS = 4_000;

/** Everything after the first separator, so `a__b__c` is tool `b__c` on `a`. */
export function splitFqn(fqn: string): { server: string; tool: string } {
  const at = fqn.indexOf(FQN_SEPARATOR);
  if (at <= 0) {
    // Unqualified. Reported as unknown rather than guessed: a name with no
    // server is a call this UI cannot attribute, and inventing an
    // attribution is worse than admitting there is none.
    return { server: "(unknown)", tool: fqn };
  }
  return { server: fqn.slice(0, at), tool: fqn.slice(at + FQN_SEPARATOR.length) };
}

/**
 * Describe a `use_tool` call for an approval prompt.
 *
 * `inputJson` is the raw tool input as the agent loop hands it over. It is
 * parsed defensively: this runs on a path where refusing to render would
 * mean refusing to ask, and an approval prompt that fails to draw is an
 * approval that silently does not happen.
 */
export function describeUseToolApproval(inputJson: string): ToolApprovalDescription {
  let parsed: { tool_name?: unknown; tool_input?: unknown } = {};
  try {
    // `parseJsonTolerant`, not bare `JSON.parse` — the module invariant
    // in `invariants.test.ts` requires it of every production file here,
    // and caught this one. The rule was written for config files, where a
    // BOM sent a reader into a catch that reset the map; a tool payload
    // has no such history. Satisfied rather than exempted, because the
    // tolerant parser is strictly more permissive and costs nothing, and
    // an exemption is a hole someone later has to re-justify.
    const value: unknown = parseJsonTolerant(inputJson);
    if (typeof value === "object" && value !== null) {
      parsed = value as { tool_name?: unknown; tool_input?: unknown };
    }
  } catch {
    // Unparseable input still gets a prompt. It cannot name the tool, and
    // saying so is the honest rendering — the alternative is no prompt.
  }

  const fqn = typeof parsed.tool_name === "string" && parsed.tool_name.length > 0 ? parsed.tool_name : "(unnamed)";
  const { server, tool } = splitFqn(fqn);

  const args =
    typeof parsed.tool_input === "object" && parsed.tool_input !== null
      ? (parsed.tool_input as Record<string, unknown>)
      : {};

  let rendered: string;
  try {
    rendered = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    // A circular or otherwise unserialisable payload. Still prompt.
    rendered = "(arguments could not be rendered)";
  }

  const truncated = rendered.length > MAX_ARGUMENT_CHARS;
  const body = truncated ? rendered.slice(0, MAX_ARGUMENT_CHARS) : rendered;

  return {
    title: "Approve MCP tool call?",
    server: sanitiseForDisplay(server),
    tool: sanitiseForDisplay(tool),
    fqn: sanitiseForDisplay(fqn),
    // Sanitised, then split. The arguments are the model's text on their
    // way to a terminal, and a `\r` in them would let a call redraw the
    // line above it — which on this screen is the line naming the tool.
    argumentLines: sanitiseForDisplay(body).split("\n"),
    argumentsTruncated: truncated,
    rememberable: false,
  };
}

/**
 * The one-line summary, for a surface with a single line to give.
 *
 * The TUI's choice dock has a subtitle, and the subtitle is what an
 * operator reads first. It names the tool and the server and NOTHING the
 * model supplied, so there is no prefix a payload can hide behind.
 */
export function summariseUseToolApproval(description: ToolApprovalDescription): string {
  return `${description.tool} on ${description.server}`;
}

/** True when this tool must use the MCP renderer rather than the shell one. */
export function isMcpToolCall(tool: string): boolean {
  return tool === "use_tool";
}
