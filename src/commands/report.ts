// `keryx report --to @name [--from <name>] "<text>"` — a one-way report from a
// process that is not a keryx shell (another agent CLI, a script) to one live
// keryx shell, over the agent bus (flow 486, L4).
//
// What this is and is not:
//
// - It runs from any process in the clone and resolves the bus the way
//   `keryx bus` does (`resolveBusRoot`). It never joins presence.
// - It writes ONE bus event, origin `external`, kind `notice`, sender name
//   `--from` (sanitized, default `external`, reserved names refused) and a
//   random per-process instanceId. The event has no CLI-only fields, so a
//   later external bus peer writes exactly the same record.
// - The bus record is NOT authenticated. Any process of the same user can
//   append any line to the log, with any sender name. `external` origin and
//   the receiving banner (`EXTERNAL_REPORT_BANNER`) say "unverified"; they do
//   not verify anything. Do not treat this command as a trust boundary.
// - It cannot pause, resume or override: the schema refuses those kinds from
//   an external origin, and this command only ever sends a notice.
// - Refusals exit non-zero with a named message and write nothing: bus
//   disabled, unknown / not-live name, `@all`, a body over MAX_BODY_BYTES,
//   the per-sender-name rate limit, and a keryx tool call (KERYX_TOOL_CALL=1,
//   the refusal `keryx bus send` gives; agents use `bus_send`).

import { randomUUID } from "node:crypto";
import { busEnabled } from "../bus/enabled";
import { BusRefusal, isBusRefusal } from "../bus/errors";
import { resolveBusRoot } from "../bus/paths";
import type { PresenceClassifyOptions } from "../bus/presence";
import { isAssignableBusName, MAX_BODY_BYTES, RESERVED_BUS_NAMES } from "../bus/schema";
import { EXTERNAL_RATE_LIMIT_PER_MINUTE, sendMessage } from "../bus/send";
import { loadShellConfig } from "../lib/shell-config";

export interface ReportCommandDeps {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** The loaded shell config; defaults to `loadShellConfig()`. */
  shellConfig?: object | null;
  /** Bus root override (tests); defaults to `resolveBusRoot(cwd)`. */
  root?: string;
  now?: () => number;
  /** D-09 inputs (tests); defaults to this host and `processIsAlive`. */
  liveness?: Omit<PresenceClassifyOptions, "now">;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Same exit code `keryx bus send` uses for the inside-a-tool-call refusal. */
export const REPORT_USE_AGENT_TOOL_EXIT = 2;

export const DEFAULT_REPORT_SENDER = "external";

const USAGE = 'usage: keryx report --to @name [--from <name>] "<text>"';

export async function reportCommand(args: string[]): Promise<void> {
  const code = await runReportCommand(args);
  if (code !== 0) process.exitCode = code;
}

/** Lower-case, `[a-z0-9-]` only, at most 32 characters; `external` when nothing is left. */
export function sanitizeReportSender(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return cleaned.length === 0 ? DEFAULT_REPORT_SENDER : cleaned;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined ? "" : value;
}

export async function runReportCommand(args: string[], deps: ReportCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    out(HELP);
    return 0;
  }
  if (env.KERYX_TOOL_CALL === "1") {
    err("keryx report: use-agent-tool: `keryx report` is refused inside a keryx tool call; use the bus_send tool instead");
    return REPORT_USE_AGENT_TOOL_EXIT;
  }

  try {
    const to = flagValue(args, "--to");
    const fromRaw = flagValue(args, "--from");
    const words: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i] as string;
      if (arg === "--to" || arg === "--from") {
        i += 1;
        continue;
      }
      words.push(arg);
    }
    const body = words.join(" ");
    if (to === undefined || to === "" || fromRaw === "" || body.length === 0) {
      throw new BusRefusal("invalid-event", USAGE);
    }
    if (to === "@all") {
      throw new BusRefusal("invalid-event", "a report goes to one named shell, not @all");
    }
    if (!/^@[a-z0-9][a-z0-9-]{0,31}$/.test(to)) {
      throw new BusRefusal("unknown-recipient", `address ${JSON.stringify(to)} must be @<name>`);
    }
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > MAX_BODY_BYTES) {
      throw new BusRefusal(
        "body-too-large",
        `the report is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}. Put the text in a file and send its path instead`,
      );
    }
    const sender = fromRaw === undefined ? DEFAULT_REPORT_SENDER : sanitizeReportSender(fromRaw);
    if (RESERVED_BUS_NAMES.includes(sender) || !isAssignableBusName(sender)) {
      throw new BusRefusal("reserved-name", `"${sender}" is reserved; pick another --from name`);
    }

    const shellConfig = deps.shellConfig === undefined ? loadShellConfig() : deps.shellConfig;
    const enablement = busEnabled({ env, shellConfig });
    if (!enablement.enabled) throw new BusRefusal("bus-disabled", enablement.reason);
    const root = deps.root ?? (await resolveBusRoot(deps.cwd ?? process.cwd())).root;

    const result = await sendMessage(root, {
      toLabel: to,
      kind: "notice",
      body,
      origin: "external",
      from: { instanceId: randomUUID(), name: sender, origin: "external" },
      now,
      liveness: deps.liveness,
      env,
    });
    out(`reported #${result.seq} to ${to} as @${sender} (external, unverified) id ${result.id}`);
    return 0;
  } catch (error) {
    if (isBusRefusal(error)) {
      err(`keryx report: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const HELP = `keryx report

Send a one-way report to one live keryx shell over the agent bus.

Usage:
  keryx report --to @name [--from <name>] "<text>"

The report is delivered as an external, unverified notice: the receiving agent
is told it is an external agent's report and not the user's words. --from names
the sender (lower-case letters, digits, dashes; default "${DEFAULT_REPORT_SENDER}"). The bus is not
authenticated: any process of the same user can write to it, so the name proves
nothing.

Refused with a non-zero exit, writing nothing: bus disabled, unknown or not-live
name, @all, text over ${MAX_BODY_BYTES} bytes (put it in a file and send the path), more than
${EXTERNAL_RATE_LIMIT_PER_MINUTE} reports per minute from one sender name, and use inside a keryx tool call.
`;
