// `/bus` text-command parsing (flow 273 T7; specification §7.2).
//
// Pure parsing only, kept out of `tui-shell.ts` so it is testable without a
// renderer — same idiom as `busy-dispatch.ts` and `tui-session-lease.ts`. The
// readline surface (`commands/shell.ts`) parses its own `/bus` line the same
// way in its own module; this one is the TUI's.

export const BUS_COMMAND = "/bus";

export type ParsedBusCommand =
  | { kind: "modal" }
  | { kind: "send"; toLabel: string; text: string }
  | { kind: "ask"; toLabel: string; text: string }
  | { kind: "reply"; id: string; text: string }
  | { kind: "name"; name: string }
  | { kind: "error"; reason: string };

const SEND_USAGE = "usage: /bus send @<name> <text>  (or /bus @<name> <text>)";
const ASK_USAGE = "usage: /bus ask @<name> <text>";
const REPLY_USAGE = "usage: /bus reply <id> <text>";
const NAME_USAGE = "usage: /bus name <new-name>";

/** `line` strips its own `/bus` token first — anything else is the caller's business. */
function afterCommand(line: string): string {
  return line.trim().replace(/^\/bus\b/, "").trim();
}

/**
 * Parse a `/bus` line (specification §7.2): bare `/bus` opens the modal;
 * `/bus @name text` and `/bus send @name text` are the same `notice`; `ask`
 * sends a `question`; `reply <id> text` needs the id of a message this
 * instance has actually seen (the caller resolves that, this only shapes the
 * text); `name <new>` renames. `pause`/`resume`/`override` are not part of
 * this phase (P4, per `src/bus/leases.ts`) and fall through to the unknown-
 * subcommand refusal.
 */
export function parseBusCommand(line: string): ParsedBusCommand {
  const rest = afterCommand(line);
  if (rest.length === 0) {
    return { kind: "modal" };
  }
  const spaceIndex = rest.indexOf(" ");
  const first = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
  const tail = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1).trim();

  if (first.startsWith("@")) {
    if (tail.length === 0) return { kind: "error", reason: SEND_USAGE };
    return { kind: "send", toLabel: first, text: tail };
  }
  if (first === "send") {
    const parsed = /^(@\S+)\s+([\s\S]+)$/.exec(tail);
    if (parsed === null) return { kind: "error", reason: SEND_USAGE };
    return { kind: "send", toLabel: parsed[1] as string, text: parsed[2] as string };
  }
  if (first === "ask") {
    const parsed = /^(@\S+)\s+([\s\S]+)$/.exec(tail);
    if (parsed === null) return { kind: "error", reason: ASK_USAGE };
    return { kind: "ask", toLabel: parsed[1] as string, text: parsed[2] as string };
  }
  if (first === "reply") {
    const parsed = /^(\S+)\s+([\s\S]+)$/.exec(tail);
    if (parsed === null) return { kind: "error", reason: REPLY_USAGE };
    return { kind: "reply", id: parsed[1] as string, text: parsed[2] as string };
  }
  if (first === "name") {
    const name = tail.split(/\s+/)[0] ?? "";
    if (name.length === 0) return { kind: "error", reason: NAME_USAGE };
    return { kind: "name", name };
  }
  return { kind: "error", reason: `unknown /bus subcommand "${first}"` };
}
