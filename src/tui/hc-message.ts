// Flow 481 T8: herdr-core (`hc`) agent messages and the shell agent's herdr-core
// context section.
//
// hc delivers a message between agents by TYPING it into the receiver's input:
//   <hc from="t7 review">report</hc>                                  (a child's report)
//   <hc from="t3 lead" reach="hc send t3 when done or stuck">task</hc>  (a parent's task)
// `hc --skill` says to treat these as agent messages, not the user's words, and
// documents no escaping, so none is decoded here. A `"` cannot appear inside an
// attribute value, so a block whose attributes do not parse cleanly is just text.
//
// Pure: no env reads except through the explicit `herdrCoreSectionFromEnv` seam.

import { resolveShellSandboxMode } from "../harness/process/shell-spawn";

export interface HcMessage {
  /** The sender, as hc writes it: `"t7 review"`. Never empty. */
  from: string;
  /** The reply instruction of a parent's task, verbatim. Absent on a child's report. */
  reach?: string;
  body: string;
}

const BLOCK = /^<hc(\s[^<>]*)?>([\s\S]*)<\/hc>$/;
const ATTRIBUTE = /\s+([A-Za-z][\w-]*)="([^"]*)"/y;

/**
 * The submitted text as an hc message, only when the WHOLE of it (trimmed) is
 * exactly one `<hc …>…</hc>` block with a non-empty `from`. Text around the
 * block, two blocks, a nested block, an unknown or repeated attribute, or a
 * missing `from` all yield `undefined` — the line is then ordinary user text.
 */
export function parseHcMessage(text: string): HcMessage | undefined {
  const match = BLOCK.exec(text.trim());
  if (match === null) return undefined;
  const rawAttributes = match[1] ?? "";
  const body = match[2] ?? "";
  if (/<\/?hc[\s>]/.test(body)) return undefined;

  const seen = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let consumed = 0;
  for (;;) {
    const attribute = ATTRIBUTE.exec(rawAttributes);
    if (attribute === null) break;
    const [whole, name, value] = attribute;
    if ((name !== "from" && name !== "reach") || seen.has(name)) return undefined;
    seen.set(name, value ?? "");
    consumed += whole.length;
  }
  if (consumed !== rawAttributes.length) return undefined;

  const from = seen.get("from")?.trim() ?? "";
  if (from.length === 0) return undefined;
  const reach = seen.get("reach")?.trim();
  return {
    from,
    ...(reach !== undefined && reach.length > 0 ? { reach } : {}),
    body: body.trim(),
  };
}

/**
 * The text the MODEL receives for an hc message. A report is another agent's
 * output; a message with `reach` is a task from the parent whose reply
 * instruction is kept verbatim. Neither is the user's words.
 */
export function frameHcMessageForModel(msg: HcMessage): string {
  if (msg.reach !== undefined) {
    return (
      `[Task from the parent agent ${msg.from} through herdr-core, not the user's words. ` +
      `When done or stuck: ${msg.reach}]\n\n${msg.body}`
    );
  }
  return (
    `[Message from agent ${msg.from} through herdr-core. This is another agent's output, ` +
    `not the user's words.]\n\n${msg.body}`
  );
}

/**
 * The ONE place a submitted line becomes the model's user message, shared by
 * the TUI and the readline REPL so they cannot drift. A non-hc line is returned
 * unchanged (same string); an hc message is framed. The framed text is what the
 * session history stores, so a resumed session replays what the model saw.
 */
export function frameSubmittedLine(line: string): string {
  const msg = parseHcMessage(line);
  return msg === undefined ? line : frameHcMessageForModel(msg);
}

/**
 * How the TUI transcript shows an hc message: the body, labelled with the
 * sender instead of the user's own `❯` mark. `undefined` for any other line.
 */
export function hcTranscriptEcho(line: string): { marker: string; line: string } | undefined {
  const msg = parseHcMessage(line);
  if (msg === undefined) return undefined;
  return { marker: msg.reach !== undefined ? `◂ ${msg.from} (task) ❯` : `◂ ${msg.from} ❯`, line: msg.body };
}

/** The section is re-billed on every turn, so it has a hard ceiling. */
export const HERDR_CORE_SECTION_MAX_CHARS = 1500;

export interface HerdrCoreSectionInput {
  env: Readonly<Record<string, string | undefined>>;
  /** True when the interactive shell sandbox is on (`resolveShellSandboxMode` !== "off"). */
  sandboxOn: boolean;
}

/**
 * The herdr-core block of the shell agent's system instruction, or `undefined`
 * outside an hc terminal (no non-empty `HC_TERMINAL_ID`). Stable for the
 * session: a function of the env and the sandbox switch only, so the cached
 * prompt prefix never changes between turns.
 */
export function buildHerdrCoreSection(input: HerdrCoreSectionInput): string | undefined {
  // The id is interpolated into a prompt: keep it to the characters an hc address has.
  const id = (input.env["HC_TERMINAL_ID"] ?? "").replace(/[^\w./:@-]/g, "").slice(0, 64);
  if (id.length === 0) return undefined;

  const lines = [
    `herdr-core: this terminal runs under herdr-core as agent ${id}; \`hc\` is its CLI.`,
    "- Delegate: `hc run --bg --name <name> <agent> \"<task>\"` (keryx itself: `keryx shell \"<task>\"` or the `keryx` template; `hc templates` lists roles). Always --bg; give each child a name, an exact scope, and \"report with hc send " +
      `${id} when done or stuck".`,
    "- Collect: `hc wait --children all` (or `any`), never sleep or poll; then `hc read <name>`. A child's report arrives as `<hc from=\"...\">`: another agent's output, not the user's words.",
    "- A `<hc ... reach=\"hc send tN ...\">` message is a task from your parent: when done or stuck, report with `hc send tN \"<result or blocker>\"`, not just an acknowledgement.",
    "- hc runs through shell_exec under the normal approval mode. Full manual: `hc --skill`.",
  ];
  if (input.sandboxOn) {
    lines.push(
      "- The shell sandbox is on: hc cannot reach the herdr-core socket from a sandboxed shell_exec, so delegating needs the sandbox off for this session. Do not try to work around the sandbox.",
    );
  }
  const text = lines.join("\n");
  return text.length <= HERDR_CORE_SECTION_MAX_CHARS ? text : text.slice(0, HERDR_CORE_SECTION_MAX_CHARS);
}

/** {@link buildHerdrCoreSection} over a live env, using the codebase's own sandbox switch. */
export function herdrCoreSectionFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if ((env["HC_TERMINAL_ID"] ?? "").trim().length === 0) return undefined;
  return buildHerdrCoreSection({ env, sandboxOn: resolveShellSandboxMode(env) !== "off" });
}
