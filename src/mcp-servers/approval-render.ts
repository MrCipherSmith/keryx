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
 * Cap on a SINGLE argument's rendered value.
 *
 * Per value, not per payload, and that distinction is the real fix for
 * F-033. A single budget over the whole pretty-printed object let one
 * argument consume the space of the others: a reviewer measured
 *
 *   { reason: <4 080 chars of reassurance>,
 *     path: "/home/victim/.ssh/authorized_keys",
 *     content: "ssh-rsa AAAA... attacker@host" }
 *
 * rendering with neither `path` nor `content` on screen — the operator
 * saw the reassurance, "arguments truncated", and `[y/N]`, and approving
 * ran the real call. No model collusion needed: `tool_input`'s schema is
 * the UNTRUSTED SERVER'S OWN, so it can publish a required 4 000-char
 * `justification` and every call it induces arrives pre-overflowed.
 *
 * Moving the tool name above the payload (the first fix) stopped the
 * NAME being hidden and left the arguments hideable. For `use_tool` the
 * arguments are the only thing that says what the call will do.
 */
export const MAX_ARGUMENT_CHARS = 400;

/**
 * Most arguments listed individually before the tail is summarised.
 *
 * Every key is worth a line; a payload with hundreds of them is not a
 * call an operator can read anyway, and the count is the honest thing to
 * show at that point.
 */
export const MAX_ARGUMENT_KEYS = 40;

/**
 * The longest an identifier may be on screen.
 *
 * The FQN pattern caps a REAL name at 64 characters, so anything longer
 * cannot be a call that resolves — it can only be a display attack. A
 * 200 000-character `tool_name` otherwise becomes one 200 000-character
 * line, scrolling the title and the server away.
 */
export const MAX_IDENTIFIER_CHARS = 80;

/**
 * Sanitise a NAME, which is a stricter job than sanitising a message.
 *
 * `sanitiseForDisplay` deliberately keeps `\n`, and that is right for an
 * error message: multi-line errors are legitimate and flattening every
 * honest one to defuse a hostile one is the wrong trade. It is wrong for
 * an identifier. A `tool_name` containing forty newlines plus a
 * plausible `  server: docs` / `  tool:   search_docs` renders a
 * COMPLETE, correctly-shaped, benign-looking approval prompt, with the
 * real tool name forty rows above the fold — and the last thing before
 * `[y/N]` is the attacker's text.
 *
 * The call would not resolve afterwards (the FQN pattern forbids `\n`),
 * which is not much comfort: what it buys is an arbitrary convincing
 * write to the approval surface, and N harmless-looking prompts is how
 * an operator is desensitised before a real one.
 *
 * So: no line breaks, no control characters, and bounded.
 */
export function sanitiseIdentifier(raw: string, cap: number = MAX_IDENTIFIER_CHARS): string {
  const flattened = sanitiseForDisplay(raw).replace(/[\r\n\u2028\u2029\u0085]/g, "\uFFFD");
  return flattened.length > cap ? `${flattened.slice(0, cap)}…` : flattened;
}

/** Everything after the first separator, so `a__b__c` is tool `b__c` on `a`. */
export function splitFqn(fqn: string): { server: string; tool: string } {
  const at = fqn.indexOf(FQN_SEPARATOR);
  if (at <= 0) {
    // Unqualified. Reported as unknown rather than guessed: a name with no
    // server is a call this UI cannot attribute, and inventing an
    // attribution is worse than admitting there is none.
    return { server: "(unknown)", tool: fqn };
  }
  const tool = fqn.slice(at + FQN_SEPARATOR.length);
  // `a__` has a separator and nothing after it. An empty tool renders a
  // blank `tool:` line and a subtitle reading " on a", which says less
  // than admitting the name is unusable.
  return tool === "" ? { server: "(unknown)", tool: fqn } : { server: fqn.slice(0, at), tool };
}

/**
 * One line per argument, each with its OWN budget.
 *
 * The guarantee: every top-level key the call carries appears on screen,
 * whatever any other key does. A long value is elided in place, so the
 * operator still sees that the key EXISTS and what it starts with.
 *
 * Each line is sanitised, because the values are the model's text on
 * their way to a terminal and a `\r` in one would let it redraw the line
 * above — which on this screen is another argument, or the tool name.
 * Line breaks inside a value are flattened for the same reason a name is
 * flattened: a value that can add rows can forge them.
 */
function renderArguments(args: Record<string, unknown>): { lines: string[]; truncated: boolean } {
  const keys = Object.keys(args);
  if (keys.length === 0) return { lines: ["{}"], truncated: false };

  let truncated = false;
  const lines: string[] = [];
  for (const key of keys.slice(0, MAX_ARGUMENT_KEYS)) {
    let value: string;
    try {
      value = JSON.stringify(args[key]) ?? "undefined";
    } catch {
      // Circular or otherwise unserialisable. The KEY still shows, which
      // is the property this function exists for.
      value = "(unserialisable)";
    }
    if (value.length > MAX_ARGUMENT_CHARS) {
      value = `${value.slice(0, MAX_ARGUMENT_CHARS)}…`;
      truncated = true;
    }
    lines.push(sanitiseIdentifier(`${JSON.stringify(key)}: ${value}`, MAX_ARGUMENT_CHARS + 120));
  }
  if (keys.length > MAX_ARGUMENT_KEYS) {
    truncated = true;
    lines.push(`… and ${keys.length - MAX_ARGUMENT_KEYS} more argument(s)`);
  }
  return { lines, truncated };
}

/**
 * Describe a `use_tool` call for an approval prompt.
 *
 * `inputJson` is the raw tool input as the agent loop hands it over. It is
 * parsed defensively: this runs on a path where refusing to render would
 * mean refusing to ask, and an approval prompt that fails to draw is an
 * approval that silently does not happen.
 */
export function describeUseToolApproval(
  inputJson: string,
  /**
   * The authoritative split, from the catalog that will execute the call.
   *
   * Optional, and when it is absent the fallback below GUESSES by
   * splitting on the first separator — which a reviewer showed
   * misattributes whenever a server name legally contains `__`. A
   * project config may define `github__notes`; its tool `exfil` has the
   * valid FQN `github__notes__exfil`, resolves correctly, and the
   * guessing prompt said `server: github` / `tool: notes__exfil`,
   * crediting a project-supplied server's call to the operator's own
   * user-scoped `github`.
   *
   * The executed call resolves by EXACT match against the catalog
   * (`resolveFqn`), so the prompt does too when it can. A string split
   * and an exact lookup are two answers to one question, and this module
   * should not be the one holding the second.
   */
  resolve?: (fqn: string) => { server: string; tool: string } | undefined,
): ToolApprovalDescription {
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
  // The catalog first, the guess only if it has nothing. A name the
  // catalog cannot resolve is a call that will not execute either, so
  // the guess is only ever labelling a prompt for a doomed call.
  const { server, tool } = resolve?.(fqn) ?? splitFqn(fqn);

  const args =
    typeof parsed.tool_input === "object" && parsed.tool_input !== null
      ? (parsed.tool_input as Record<string, unknown>)
      : {};

  const { lines: argumentLines, truncated } = renderArguments(args);

  return {
    title: "Approve MCP tool call?",
    // `sanitiseIdentifier`, not `sanitiseForDisplay`: these are NAMES,
    // and a name that can contain a line break can forge the prompt.
    server: sanitiseIdentifier(server),
    tool: sanitiseIdentifier(tool),
    fqn: sanitiseIdentifier(fqn),
    argumentLines,
    argumentsTruncated: truncated,
    rememberable: false,
  };
}

/**
 * The exact lines a text surface prints, in order.
 *
 * Separated from the printing so the PROMPT is testable and not only the
 * description. The mutation sweep forced this: with the branch inlined
 * in `shell.ts`, inverting `if (meta?.destructive === true)` survived,
 * because nothing in the suite drives the readline approval path at all
 * — every test stubs `requestApproval` wholesale. The same is quietly
 * true of the `apply_patch` and elicitation branches beside it.
 *
 * What remains untested in the caller is the `[y/N]` read, which is
 * identical in all four branches.
 */
export function renderUseToolApprovalLines(
  description: ToolApprovalDescription,
  meta?: { readonly destructive?: boolean | undefined },
): string[] {
  const lines = [
    description.title,
    // The server and the tool FIRST, on their own lines, above anything
    // the model wrote — so nothing in the payload can push them out of
    // view, because they are not in the payload. F-033.
    `  server: ${description.server}`,
    `  tool:   ${description.tool}`,
    ...description.argumentLines.map((line) => `  ${line}`),
  ];
  if (description.argumentsTruncated) {
    lines.push(`  … some values elided at ${MAX_ARGUMENT_CHARS} characters each`);
  }
  if (meta?.destructive === true) {
    lines.push("  this tool is treated as destructive — it is a third party's code");
  }
  return lines;
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

/**
 * The whole readline prompt: print it, read the answer, return the verdict.
 *
 * Extracted because a reviewer proved the decision had NO behavioural
 * coverage at all. Inverting `if (!approved)` — so that typing `y`
 * DENIES and typing anything else APPROVES and executes — left the full
 * 9 158-test suite green. So did replacing the description with
 * `describeUseToolApproval("null")`, and so did commenting the branch
 * out entirely and restoring F-032.
 *
 * `approval-wiring.test.ts` "covered" this by comparing character
 * offsets of two string literals in the file's source text. That is the
 * pattern this repository has now caught four times — an invariant that
 * asserts a SENTENCE appears rather than that the property holds — and
 * the previous extraction moved only the LINE BUILDING behind a
 * harness, leaving the part that decides whether a third party runs
 * exactly as exposed as before.
 *
 * IO is injected, so a test drives the real function with a real answer
 * and asserts the real verdict.
 */
export type ApprovalIo = {
  readonly out: (text: string) => void;
  readonly readLine: () => Promise<string | undefined>;
};

export type ApprovalVerdict = false | true | { approved: true; fingerprint: string };

/** `y` / `yes`, case-insensitive, and nothing else. Never "always". */
export function isApprovalYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

export async function promptUseToolApproval(
  io: ApprovalIo,
  input: string,
  meta: { readonly destructive?: boolean | undefined; readonly fingerprint?: string | undefined } | undefined,
  resolve?: (fqn: string) => { server: string; tool: string } | undefined,
  style?: { yellow: (t: string) => string; dim: (t: string) => string; green: (t: string) => string; red: (t: string) => string },
  gutter = "",
): Promise<ApprovalVerdict> {
  const paint = style ?? { yellow: (t) => t, dim: (t) => t, green: (t) => t, red: (t) => t };
  const described = describeUseToolApproval(input, resolve);
  const lines = renderUseToolApprovalLines(described, meta);

  io.out("\n");
  for (const [index, line] of lines.entries()) {
    io.out(`${gutter}${index === 0 ? paint.yellow(line) : paint.dim(line)}\n`);
  }
  // No `A=always`: the grant pattern would be a qualified tool name the
  // MODEL supplied, written into the operator's permission file.
  io.out(`\n${gutter}${paint.dim("[y/N] ")}`);

  const answer = (await io.readLine()) ?? "";
  const approved = isApprovalYes(answer);
  io.out(approved ? paint.green("approved\n") : paint.red("denied\n"));
  if (!approved) return false;
  return meta?.fingerprint !== undefined ? { approved: true, fingerprint: meta.fingerprint } : true;
}

/**
 * The TUI's choice-dock answer, mapped to a verdict.
 *
 * One line, extracted for the same reason as the readline prompt: a
 * reviewer inverted `return id === "allow"` — so that choosing "Deny"
 * APPROVES — and the full suite stayed green. The dock itself needs a
 * terminal; this decision does not, and it is the half that matters.
 *
 * Anything that is not exactly the allow id is a refusal. A dock that
 * returns undefined (dismissed, or re-entered while another prompt is
 * open) must therefore deny, which is the fail-closed direction.
 */
export const APPROVAL_ALLOW_ID = "allow";

export function isDockApproval(id: string | undefined): boolean {
  return id === APPROVAL_ALLOW_ID;
}
