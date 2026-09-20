// `/bus` text-command parsing (flow 273 T7, flow 275 T7; specification §7.2).
//
// Pure parsing only, kept out of `tui-shell.ts` so it is testable without a
// renderer — same idiom as `busy-dispatch.ts` and `tui-session-lease.ts`. The
// readline surface (`commands/shell.ts`) parses its own `/bus` line the same
// way in its own module; this one is the TUI's.

import { LEASE_SCOPES, type LeaseScope } from "../bus/schema";

export const BUS_COMMAND = "/bus";

export type ParsedBusCommand =
  | { kind: "modal" }
  | { kind: "send"; toLabel: string; text: string }
  | { kind: "ask"; toLabel: string; text: string }
  | { kind: "reply"; id: string; text: string }
  | { kind: "name"; name: string }
  /** `/bus pause [@name|@all] [--scope turns|git-publish|advisory] [--ttl 30m] reason…` (specification §4.3, §7.2). `@all`/`turns` are the defaults when omitted. */
  | { kind: "pause"; toLabel: string; scope: LeaseScope; ttlMs: number | undefined; reason: string }
  /** `/bus resume [leaseId]` — the caller resolves the default (this instance's own lease) when `leaseId` is undefined. */
  | { kind: "resume"; leaseId: string | undefined }
  /** `/bus override [leaseId]` — the caller resolves the default (the lease holding this instance) when `leaseId` is undefined. */
  | { kind: "override"; leaseId: string | undefined }
  | { kind: "error"; reason: string };

const SEND_USAGE = "usage: /bus send @<name> <text>  (or /bus @<name> <text>)";
const ASK_USAGE = "usage: /bus ask @<name> <text>";
const REPLY_USAGE = "usage: /bus reply <id> <text>";
const NAME_USAGE = "usage: /bus name <new-name>";
const PAUSE_USAGE =
  "usage: /bus pause [@name|@all] [--scope turns|git-publish|advisory] [--ttl 30m] <reason>";

function isLeaseScope(value: string): value is LeaseScope {
  return (LEASE_SCOPES as readonly string[]).includes(value);
}

/**
 * `30m`/`90s`/`4h`/`2d` → milliseconds, or `undefined` for anything else
 * (including a bare number, deliberately — a unit-less TTL is ambiguous and
 * refused rather than guessed). Range validation (1 min .. 4 h) is
 * `createPauseLease`'s job (`../bus/pause.ts`), not this pure syntax parser's.
 */
function parseTtlArg(value: string): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  return amount * unitMs;
}

/**
 * `/bus pause`'s own tail (after the leading `pause` token has already been
 * stripped): an optional `@name`/`@all` address, then `--scope`/`--ttl`
 * flags in either order, both optional and consumed only from the FRONT —
 * the first token that is not a recognized flag ends flag-parsing and
 * everything from there to the end of the line, verbatim, is the reason.
 */
function parsePauseArgs(tail: string): ParsedBusCommand {
  let rest = tail;
  let toLabel = "@all";
  const addr = /^(@\S+)\s*/.exec(rest);
  if (addr !== null) {
    toLabel = addr[1] as string;
    rest = rest.slice(addr[0].length);
  }
  let scope: LeaseScope = "turns";
  let ttlMs: number | undefined;
  // At most one `--scope` and one `--ttl`, either order — two passes covers both.
  for (let i = 0; i < 2; i++) {
    const scopeFlag = /^--scope\s+(\S+)\s*/.exec(rest);
    if (scopeFlag !== null) {
      const value = scopeFlag[1] as string;
      if (!isLeaseScope(value)) {
        return { kind: "error", reason: `unknown --scope "${value}" (${LEASE_SCOPES.join("|")})` };
      }
      scope = value;
      rest = rest.slice(scopeFlag[0].length);
      continue;
    }
    const ttlFlag = /^--ttl\s+(\S+)\s*/.exec(rest);
    if (ttlFlag !== null) {
      const raw = ttlFlag[1] as string;
      const parsed = parseTtlArg(raw);
      if (parsed === undefined) {
        return { kind: "error", reason: `invalid --ttl "${raw}" (e.g. 30m, 1h, 4h)` };
      }
      ttlMs = parsed;
      rest = rest.slice(ttlFlag[0].length);
      continue;
    }
    break;
  }
  const reason = rest.trim();
  if (reason.length === 0) {
    return { kind: "error", reason: PAUSE_USAGE };
  }
  return { kind: "pause", toLabel, scope, ttlMs, reason };
}

/** `line` strips its own `/bus` token first — anything else is the caller's business. */
function afterCommand(line: string): string {
  return line.trim().replace(/^\/bus\b/, "").trim();
}

/**
 * Parse a `/bus` line (specification §7.2): bare `/bus` opens the modal;
 * `/bus @name text` and `/bus send @name text` are the same `notice`; `ask`
 * sends a `question`; `reply <id> text` needs the id of a message this
 * instance has actually seen (the caller resolves that, this only shapes the
 * text); `name <new>` renames; `pause`/`resume`/`override` (flow 275, agent
 * bus P4, specification §4.3/§7.2) create/end/release a pause lease — the
 * caller (`tui-shell.ts`'s `runBusCommand`) resolves `resume`/`override`'s
 * default `leaseId` and calls `BusClient.pause`/`resume`/`override`.
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
  if (first === "pause") {
    return parsePauseArgs(tail);
  }
  if (first === "resume") {
    const leaseId = tail.split(/\s+/)[0];
    return { kind: "resume", leaseId: leaseId !== undefined && leaseId.length > 0 ? leaseId : undefined };
  }
  if (first === "override") {
    const leaseId = tail.split(/\s+/)[0];
    return { kind: "override", leaseId: leaseId !== undefined && leaseId.length > 0 ? leaseId : undefined };
  }
  return { kind: "error", reason: `unknown /bus subcommand "${first}"` };
}
