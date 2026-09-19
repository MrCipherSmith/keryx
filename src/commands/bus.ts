// `keryx bus` — the agent bus from a terminal (specification §7.3).
//
//   list [--json]                                   peers and active pause leases
//   log [--since <seq>] [--limit N] [--json]        events
//   send <@name|@all> [--kind …] [--reply-to <id>] <text…>
//   prune                                           gone presence, inactive leases, old segments
//
// D-13: `send` refuses with `use-agent-tool` inside a keryx tool call
// (`KERYX_TOOL_CALL=1`, set only on `shell_exec` children); the agent has its
// own tools for that. `list`, `log` and `prune` stay available there. The
// caller-session variables (`KERYX_SESSION_*`) are deliberately not consulted.
//
// A disabled bus (`KERYX_BUS=off`, shell config `bus.enabled: false`, CI)
// refuses `send` and `prune` with `bus-disabled`; `list` and `log` still read.

import { busEnabled } from "../bus/enabled";
import { BusRefusal, isBusRefusal } from "../bus/errors";
import { holderLivenessFrom, listActiveLeases } from "../bus/leases";
import { cursorAtStart, readEvents } from "../bus/log";
import { resolveBusRoot } from "../bus/paths";
import { classifyPresence, listPresence, type PresenceClassifyOptions } from "../bus/presence";
import { pruneBus } from "../bus/prune";
import type { BusEvent } from "../bus/schema";
import { SENDABLE_KINDS, sendMessage } from "../bus/send";
import { loadShellConfig } from "../lib/shell-config";

export interface BusCommandDeps {
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

/** Exit code for a D-13 refusal: distinct from an ordinary failure. */
export const USE_AGENT_TOOL_EXIT = 2;

export async function busCommand(args: string[]): Promise<void> {
  const code = await runBusCommand(args);
  if (code !== 0) process.exitCode = code;
}

export async function runBusCommand(args: string[], deps: BusCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sub = args[0] ?? "list";
  const rest = args.slice(1);

  if (sub === "--help" || sub === "-h" || sub === "help") {
    out(HELP);
    return 0;
  }

  try {
    if (sub === "send") {
      if (env.KERYX_TOOL_CALL === "1") {
        err("keryx bus: use-agent-tool: `keryx bus send` is refused inside a keryx tool call; use the bus_send tool instead");
        return USE_AGENT_TOOL_EXIT;
      }
      assertEnabled(env, deps);
      return await send(rest, await root(deps), { env, now, deps, out });
    }
    if (sub === "prune") {
      assertEnabled(env, deps);
      const result = await pruneBus(await root(deps), { now, ...deps.liveness });
      if (rest.includes("--json")) {
        out(JSON.stringify({ schemaVersion: 1, ...result }, null, 2));
      } else {
        out(
          `Pruned ${result.presence.length} presence record(s), ${result.leases.length} lease(s), ` +
            `${result.segments.length} rotated segment(s).`,
        );
      }
      return 0;
    }
    if (sub === "list") return await list(rest, deps, { now, out });
    if (sub === "log") return await log(rest, deps, { out, err });
  } catch (error) {
    if (isBusRefusal(error)) {
      err(`keryx bus: ${error.message}`);
      return 1;
    }
    throw error;
  }

  err(`Unknown bus subcommand: ${sub}`);
  out(HELP);
  return 1;
}

function assertEnabled(env: Readonly<Record<string, string | undefined>>, deps: BusCommandDeps): void {
  const shellConfig = deps.shellConfig === undefined ? loadShellConfig() : deps.shellConfig;
  const enablement = busEnabled({ env, shellConfig });
  if (!enablement.enabled) throw new BusRefusal("bus-disabled", enablement.reason);
}

async function root(deps: BusCommandDeps): Promise<string> {
  return deps.root ?? (await resolveBusRoot(deps.cwd ?? process.cwd())).root;
}

/** The value after `flag`, or undefined when the flag is absent; "" when it has no value. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

function positionals(args: readonly string[], valued: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (valued.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--json") continue;
    result.push(arg);
  }
  return result;
}

async function send(
  args: string[],
  busRoot: string,
  ctx: { env: Readonly<Record<string, string | undefined>>; now: () => number; deps: BusCommandDeps; out: (line: string) => void },
): Promise<number> {
  const kind = flagValue(args, "--kind") ?? "notice";
  const replyTo = flagValue(args, "--reply-to");
  const [toLabel, ...words] = positionals(args, ["--kind", "--reply-to"]);
  const body = words.join(" ");
  if (toLabel === undefined || body.length === 0 || kind === "" || replyTo === "") {
    throw new BusRefusal(
      "invalid-event",
      `usage: keryx bus send <@name|@all> [--kind ${SENDABLE_KINDS.join("|")}] [--reply-to <id>] <text…>`,
    );
  }
  const result = await sendMessage(busRoot, {
    toLabel,
    kind,
    body,
    replyTo,
    origin: "cli",
    now: ctx.now,
    liveness: ctx.deps.liveness,
    env: ctx.env,
  });
  if (args.includes("--json")) {
    ctx.out(JSON.stringify({ schemaVersion: 1, seq: result.seq, id: result.id, resolvedTo: result.resolvedTo }, null, 2));
  } else {
    const recipients = result.resolvedTo[0] === "*" ? "everyone" : `${result.resolvedTo.length} instance(s)`;
    ctx.out(`sent #${result.seq} ${result.event.kind} to ${toLabel} (${recipients}) id ${result.id}`);
  }
  return 0;
}

async function list(
  args: string[],
  deps: BusCommandDeps,
  ctx: { now: () => number; out: (line: string) => void },
): Promise<number> {
  const resolved = deps.root !== undefined ? { root: deps.root, kind: "override", projectKey: "" } : await resolveBusRoot(deps.cwd ?? process.cwd());
  const at = ctx.now();
  const classify: PresenceClassifyOptions = { ...deps.liveness, now: at };
  const presence = await listPresence(resolved.root);
  const peers = presence
    .map((record) => ({ record, state: classifyPresence(record, classify), ageMs: at - Date.parse(record.heartbeatAt) }))
    .filter((peer) => peer.state !== "gone");
  const leases = await listActiveLeases(resolved.root, { now: at, holderLiveness: holderLivenessFrom(presence, classify) });

  if (args.includes("--json")) {
    ctx.out(
      JSON.stringify(
        {
          schemaVersion: 1,
          root: resolved.root,
          kind: resolved.kind,
          peers: peers.map(({ record, state, ageMs }) => ({
            name: record.name,
            instanceId: record.instanceId,
            state,
            status: record.status,
            activity: record.activity,
            checkout: record.checkout,
            branch: record.branch,
            surface: record.surface,
            ageMs,
          })),
          leases,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  ctx.out(`Bus: ${resolved.root}`);
  ctx.out("");
  if (peers.length === 0) {
    ctx.out("No live or stale peers.");
  } else {
    ctx.out(pad("NAME", 18) + pad("STATE", 7) + pad("STATUS", 9) + pad("AGE", 7) + pad("BRANCH", 20) + pad("CHECKOUT", 36) + "ACTIVITY");
    for (const { record, state, ageMs } of peers) {
      ctx.out(
        pad(`@${record.name}`, 18) +
          pad(state, 7) +
          pad(record.status, 9) +
          pad(formatAge(ageMs), 7) +
          pad(record.branch ?? "-", 20) +
          pad(record.checkout, 36) +
          record.activity,
      );
    }
  }
  ctx.out("");
  if (leases.length === 0) {
    ctx.out("No active pause leases.");
  } else {
    ctx.out(pad("LEASE", 10) + pad("HOLDER", 18) + pad("SCOPE", 13) + pad("EXPIRES", 22) + "REASON");
    for (const lease of leases) {
      ctx.out(
        pad(lease.leaseId.slice(0, 8), 10) +
          pad(`@${lease.holder.name}`, 18) +
          pad(lease.scope, 13) +
          pad(lease.expiresAt.slice(0, 19).replace("T", " "), 22) +
          lease.reason,
      );
    }
  }
  return 0;
}

async function log(
  args: string[],
  deps: BusCommandDeps,
  ctx: { out: (line: string) => void; err: (line: string) => void },
): Promise<number> {
  const sinceRaw = flagValue(args, "--since");
  const limitRaw = flagValue(args, "--limit");
  const since = sinceRaw === undefined ? 0 : Number(sinceRaw);
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (!Number.isSafeInteger(since) || since < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) {
    ctx.err("Usage: keryx bus log [--since <seq>] [--limit N] [--json]");
    return 1;
  }
  const busRoot = await root(deps);
  let events: BusEvent[] = (await readEvents(busRoot, await cursorAtStart(busRoot))).events.filter((event) => event.seq > since);
  if (limit !== undefined) events = events.slice(-limit);

  if (args.includes("--json")) {
    ctx.out(JSON.stringify({ schemaVersion: 1, events }, null, 2));
    return 0;
  }
  if (events.length === 0) {
    ctx.out("No events.");
    return 0;
  }
  for (const event of events) {
    const reply = event.refs?.replyTo !== undefined ? ` (re ${event.refs.replyTo.slice(0, 8)})` : "";
    const body = event.body === undefined ? "" : `: ${event.body.replace(/\s+/g, " ")}`;
    ctx.out(
      `#${event.seq} ${event.ts.slice(0, 19).replace("T", " ")} @${event.from.name} → ${event.toLabel} ${event.kind}${reply}${body}`,
    );
  }
  return 0;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s.slice(0, n - 1)} ` : s + " ".repeat(n - s.length);
}

const HELP = `keryx bus

The agent bus shared by keryx shells in every worktree of this clone.

Usage:
  keryx bus list [--json]                          Live and stale peers, and active pause leases
  keryx bus log [--since <seq>] [--limit N] [--json]
                                                   Events, oldest first (--since: after that seq; --limit: last N)
  keryx bus send <@name|@all> [--kind notice|question|handoff|reply] [--reply-to <id>] <text…>
                                                   Send a message as "cli" (a reply needs --reply-to)
  keryx bus prune [--json]                         Remove gone presence (>24 h), inactive leases, old log segments

send refuses with use-agent-tool (exit 2) inside a keryx tool call
(KERYX_TOOL_CALL=1); agents use their bus tools. send and prune refuse with
bus-disabled when KERYX_BUS=off, shell config bus.enabled is false, or in CI.
CLI sends are limited to 30 per minute across the clone (rate-limited).
`;
