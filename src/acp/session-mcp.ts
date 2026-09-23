// Client-supplied MCP servers for one ACP session (flow 287, T7–T9; AC3–AC6).
//
// An ACP client (Zed, first) forwards the MCP servers configured in ITS OWN
// settings on every `session/new` and `session/load`. This module turns that
// list into running servers and a tool pair for the session's turns — through
// the machinery `keryx shell` already uses for its configured servers, not a
// second copy of it:
//
//   - `startServers` (`../mcp-servers/manager.ts`): bounded, concurrent dials
//     that never throw — a server that will not start becomes a `failed` state
//     with its reason, and the others still connect (AC5).
//   - `defaultConnect` (`../mcp-servers/runtime.ts`): the one dial procedure
//     the shell and `keryx mcp doctor` share, which spawns through
//     `connectStdioMcpServer` (`../mcp-client/client.ts`) with the child's
//     stderr piped and discarded, and builds the child's environment with
//     `buildMcpChildEnv` (`../mcp-servers/spawn-env.ts`) — keryx's own
//     credential-SHAPED names stripped, every variable keryx itself loaded
//     from its saved config stripped BY NAME too, the entry's `env` applied
//     on top of both. One strip, used by every surface that launches an MCP
//     server — this module no longer keeps its own copy of it.
//   - `createMcpInteractiveTools` (`../mcp-servers/tools.ts`): the stable
//     `search_tool`/`use_tool` pair. `use_tool` is `risk: "destructive"`, so
//     every call goes through the agent's own approval branch — which in an ACP
//     session is `session/request_permission` (AC4). There is no approval hook
//     here, by the same rule (D-05) that keeps one out of the shell's pair.
//
// NO TRUST GATE, deliberately. `keryx shell` holds back PROJECT-scoped servers
// until `keryx mcp trust`, because a committed config is code a repository's
// author wrote and cloning is not consent to run it. These entries come from
// the operator's own editor settings, delivered by the client the operator
// launched — the same standing as a user-global `keryx mcp` entry, which the
// shell starts without asking.
//
// SECRETS (AC6). ACP carries credentials in exactly these fields: an `env`
// value (the operator's real Zed config held a GitHub token and an API key
// there) or an http/sse `headers` value. They go to the child process and
// nowhere else: nothing here logs an entry, the `raw` copy every human-readable
// surface prints from carries the variable NAMES only, and every failure reason
// that reaches the client or stderr is passed through `scrub` first — a
// spawn error or a server's own error text could otherwise echo one back.

import { createHash } from "node:crypto";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { mergeCatalogs, type ServerCatalog } from "../mcp-servers/catalog";
import type { ResolvedMcpServer } from "../mcp-servers/config";
import { closeServers, startServers, type ConnectFn, type ServerState } from "../mcp-servers/manager";
import { CLOSE_GRACE_MS, defaultConnect, KILL_GRACE_MS, within } from "../mcp-servers/runtime";
import { createMcpInteractiveTools } from "../mcp-servers/tools";
import { AcpError, invalidParams } from "./jsonrpc";

/** One entry keryx did not start, and why. Never carries a secret (see `scrub`). */
export interface AcpMcpServerProblem {
  readonly name: string;
  readonly reason: string;
}

/** A `mcpServers` list, validated and split. */
export interface ParsedAcpMcpServers {
  /** stdio entries to start, in the shape the shared dial procedure takes. */
  readonly stdio: readonly ResolvedMcpServer[];
  /** Entries refused before any dial: http/sse, a stdio entry with no command, a duplicate name. */
  readonly refused: readonly AcpMcpServerProblem[];
  /** Every `env` and `headers` value in the list — what `scrub` removes from any text leaving keryx. */
  readonly secrets: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads `{name, value}[]` (ACP's `EnvVariable`/`HttpHeader`) into a map.
 * `undefined` = malformed. Every value is recorded as a secret EVEN WHEN the
 * list is malformed — a half-valid entry is still an operator's credential.
 */
function readNameValueList(raw: unknown, secrets: string[]): Record<string, string> | undefined {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  let ok = true;
  for (const item of raw) {
    if (!isRecord(item)) {
      ok = false;
      continue;
    }
    const value = item["value"];
    if (typeof value === "string" && value.length > 0) {
      secrets.push(value);
    }
    const name = item["name"];
    if (typeof name !== "string" || name.length === 0 || typeof value !== "string") {
      ok = false;
      continue;
    }
    out[name] = value;
  }
  return ok ? out : undefined;
}

/**
 * Validates `mcpServers` from `session/new`/`session/load`.
 *
 * WHAT IS "PER ENTRY" (AC5). Two different failures, two different answers:
 *
 *   - A list that is not a list, or an entry that is not an object or has no
 *     string `name`, is a request that does not match the ACP schema. That is
 *     `-32602` for the whole call — there is no entry to name in a report, and
 *     a client sending it has a bug worth surfacing, not a server to skip.
 *   - A well-formed entry keryx will not start — `http`/`sse` (keryx advertises
 *     `mcpCapabilities: {http: false, sse: false}`), an unknown `type`, a stdio
 *     entry with no `command` or malformed `args`/`env`, a name used twice — is
 *     refused PER ENTRY: the session is still created, every other entry is
 *     still started, and the refusal is reported with the entry's name and the
 *     reason, exactly as a server that fails to start is. Failing the whole
 *     `session/new` instead would reproduce the defect this flow fixes: Zed
 *     forwards every server in its settings, so one http server there would
 *     make keryx unusable again.
 */
export function parseAcpMcpServers(method: string, raw: unknown): ParsedAcpMcpServers {
  if (raw === undefined || raw === null) {
    return { stdio: [], refused: [], secrets: [] };
  }
  if (!Array.isArray(raw)) {
    const error = invalidParams(`${method}: mcpServers must be an array`, { received: typeof raw });
    throw new AcpError(error.code, error.message, error.data);
  }
  const stdio: ResolvedMcpServer[] = [];
  const refused: AcpMcpServerProblem[] = [];
  const secrets: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry["name"] !== "string" || entry["name"].length === 0) {
      // No `received` echo: the entry may be carrying credentials.
      const error = invalidParams(`${method}: mcpServers[${index}] must be an object with a non-empty string name`, {
        index,
      });
      throw new AcpError(error.code, error.message, error.data);
    }
    const name = entry["name"];
    const type = entry["type"];
    if (type === "http" || type === "sse") {
      readNameValueList(entry["headers"], secrets);
      refused.push({
        name,
        reason:
          `not started: keryx does not connect ${type} MCP servers over ACP (it advertises ` +
          "mcpCapabilities {http: false, sse: false}); only stdio servers are started",
      });
      return;
    }
    if (type !== undefined && type !== "stdio") {
      refused.push({ name, reason: `not started: unknown MCP transport type ${JSON.stringify(type)}` });
      return;
    }
    const env = readNameValueList(entry["env"], secrets);
    if (seen.has(name)) {
      refused.push({ name, reason: "not started: another entry in this mcpServers list already uses this name" });
      return;
    }
    seen.add(name);
    const command = entry["command"];
    if (typeof command !== "string" || command.length === 0) {
      refused.push({ name, reason: "not started: a stdio MCP server entry needs a non-empty command" });
      return;
    }
    const rawArgs = entry["args"] ?? [];
    if (!Array.isArray(rawArgs) || !rawArgs.every((arg): arg is string => typeof arg === "string")) {
      refused.push({ name, reason: "not started: args must be a list of strings" });
      return;
    }
    if (env === undefined) {
      refused.push({ name, reason: "not started: env must be a list of {name, value} strings" });
      return;
    }
    stdio.push({
      name,
      // No ACP source exists in `McpServerSource`; "user" is the standing these
      // entries have (the operator's own settings, see the header).
      source: "user",
      projectLocal: false,
      file: `acp:${method}`,
      enabled: true,
      command,
      args: rawArgs,
      env,
      // No `cwd` here: the caller runs each server in the session's RESOLVED
      // project root, which is only known once the session exists.
      // Printed from, never executed: variable NAMES only (AC6).
      raw: {
        command,
        args: rawArgs,
        env: Object.fromEntries(Object.keys(env).map((key) => [key, "<redacted>"])),
      },
    });
  });
  return { stdio, refused, secrets };
}

/**
 * The shortest value `scrub` treats as a secret.
 *
 * `env` also carries plain settings — `DEBUG=1`, `LOG_LEVEL=info`, a port —
 * and replacing every "1" in a reason or a tool result turned "15000ms" into
 * "<redacted>5000ms": text nobody can read, protecting nothing. Every
 * credential format these entries realistically carry (GitHub tokens, API
 * keys, bearer tokens) is far longer than this. The trade is explicit: a
 * value shorter than 8 characters is not scrubbed.
 */
export const MIN_SCRUBBED_SECRET_LENGTH = 8;

/**
 * Replace every secret occurring in `text`, in its raw form AND its
 * JSON-escaped form.
 *
 * The tool pair serialises a server's result with `JSON.stringify` before
 * anything sees it, so a value containing `"`, `\` or a control character
 * appears escaped (`db"pass\word` → `db\"pass\\word`) and the raw form never
 * matches. Scrubbing both forms covers both kinds of text this sees: the
 * serialised tool results (escaped) and plain error and failure messages
 * (raw). Longest first, so one secret containing another is removed whole.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SCRUBBED_SECRET_LENGTH) continue;
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  let out = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    out = out.split(form).join("<redacted>");
  }
  return out;
}

/**
 * Identifies a running set by what it was started from (flow 287): two
 * `session/new` calls carrying the same list share one set of processes.
 * Hashed so the key itself carries no env value.
 */
export function acpMcpSetKey(parsed: ParsedAcpMcpServers): string {
  const canonical = {
    stdio: parsed.stdio.map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      cwd: server.cwd ?? null,
      env: Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    })),
    refused: parsed.refused,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The running servers of one ACP session. */
export interface AcpSessionMcp {
  /** Settles once every dial (including a `revive`) has connected or failed. Never rejects. */
  readonly ready: Promise<void>;
  /** The `search_tool`/`use_tool` pair, or nothing when this session has no stdio server. */
  readonly tools: readonly InteractiveTool[];
  /** Refusals known before any dial (http/sse, malformed entries). Scrubbed. */
  readonly refused: readonly AcpMcpServerProblem[];
  /** Servers that were dialled and did not start. Complete once `ready` has settled. Scrubbed. */
  failed(): readonly AcpMcpServerProblem[];
  /**
   * Redial every server KNOWN to be dead: it failed to start, or its
   * connection reports the transport closed (the process exited). Called when
   * another session binds to this running set, so a new thread recovers a
   * server the way it did when every thread dialled its own. Never judged by
   * timing: many stdio servers answer one request at a time, so a server busy
   * in another thread's long call is slow, not dead, and redialling it would
   * close the connection under that call.
   */
  revive(): void;
  /** Stops every server this session started. Idempotent. */
  close(): Promise<void>;
}

export interface StartAcpSessionMcpOptions {
  /**
   * The parent environment the child's is derived from. `process.env`
   * otherwise. Credential-shaped names and keryx's own saved-config names are
   * stripped downstream, inside `defaultConnect` → `buildMcpChildEnv` — not
   * here; see that function's doc comment.
   */
  readonly env?: Record<string, string | undefined>;
  /** Overridden in tests; the shared dial procedure otherwise. */
  readonly connect?: ConnectFn;
}

/** Start `parsed.stdio`. Returns at once; the dials run in the background. */
export function startAcpSessionMcp(parsed: ParsedAcpMcpServers, options: StartAcpSessionMcpOptions = {}): AcpSessionMcp {
  const refused = parsed.refused.map((problem) => ({ name: problem.name, reason: scrub(problem.reason, parsed.secrets) }));
  if (parsed.stdio.length === 0) {
    return {
      ready: Promise.resolve(),
      tools: [],
      refused,
      failed: () => [],
      revive: () => {},
      close: async () => {},
    };
  }

  // Aborted by `close()`: a dial still in its handshake has no connection to
  // close yet, and this is the only way to reach its child process.
  const dialling = new AbortController();
  // The kills an abort starts — awaited by `close()`, so "stopped" means the
  // child is gone rather than signalled (see `runtime.ts`'s `KILL_GRACE_MS`).
  const kills: Array<Promise<void>> = [];
  const env = options.env ?? process.env;
  const connect: ConnectFn = options.connect ?? ((server) => defaultConnect(server, env, dialling.signal, kills));

  let states: readonly ServerState[] = parsed.stdio.map((server) => ({
    name: server.name,
    status: "connecting" as const,
    toolCount: 0,
  }));
  let catalog: ServerCatalog = mergeCatalogs([]);
  let ready: Promise<void> = startServers(parsed.stdio, connect)
    .then((result) => {
      states = result.servers;
      catalog = result.catalog;
    })
    .catch(() => {
      // `startServers` is documented never to reject; if it ever does, every
      // server stays `connecting` — visible to `search_tool`, not a crash.
    });

  // Each connection closed at most once, across the prompt sweep and the late one.
  const closed = new WeakSet<object>();
  const closeUnclosed = async (): Promise<void> => {
    const fresh = states.filter((state) => state.connection !== undefined && !closed.has(state.connection));
    for (const state of fresh) closed.add(state.connection as object);
    await closeServers(fresh);
  };

  /**
   * Dead by the connection's own record (`isClosed`: the transport closed),
   * or never started. A connected server whose connection cannot tell is
   * treated as alive.
   */
  const knownDead = (state: ServerState | undefined): boolean =>
    state === undefined ||
    state.status === "failed" ||
    (state.status === "connected" && state.connection?.isClosed?.() === true);

  let closing: Promise<void> | undefined;
  return {
    get ready() {
      return ready;
    },
    tools: createMcpInteractiveTools({
      catalog: () => catalog,
      servers: () => states,
      // Scrubbed where the text is produced — after serialisation, before
      // sanitising and truncation — not on the finished output: a secret the
      // truncation cap cuts in two no longer matches afterwards.
      redact: (text) => scrub(text, parsed.secrets),
    }),
    refused,
    failed: () =>
      states
        .filter((state) => state.status === "failed")
        .map((state) => ({ name: state.name, reason: `failed to start: ${scrub(state.error ?? "no reason given", parsed.secrets)}` })),
    revive: () => {
      if (closing !== undefined) return;
      ready = ready
        .then(async () => {
          if (closing !== undefined) return;
          const stale: ResolvedMcpServer[] = [];
          for (const server of parsed.stdio) {
            const state = states.find((candidate) => candidate.name === server.name);
            if (!knownDead(state)) continue;
            stale.push(server);
            // Release what is left of a dead connection (a no-op for the SDK
            // once its transport has closed) so nothing holds its pipes.
            if (state?.connection !== undefined && !closed.has(state.connection)) {
              closed.add(state.connection);
              void state.connection.close().catch(() => {});
            }
          }
          if (stale.length === 0 || closing !== undefined) return;
          const result = await startServers(stale, connect);
          const names = new Set(stale.map((server) => server.name));
          // Recorded even if a close began meanwhile: `close()` sweeps `states`
          // after this settles, so a redial that landed late is still stopped.
          states = [...states.filter((state) => !names.has(state.name)), ...result.servers].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
          catalog = mergeCatalogs([
            {
              entries: catalog.entries.filter((entry) => !names.has(entry.server)),
              skipped: catalog.skipped.filter((skip) => !names.has(skip.server)),
            },
            result.catalog,
          ]);
        })
        .catch(() => {});
    },
    close: () =>
      (closing ??= (async () => {
        // The shell runtime's own shutdown budget (`runtime.ts` `closeNow`):
        // abort the dials, give the ones about to land a short grace, close
        // what is connected (the SDK's close is itself bounded: stdin end,
        // then SIGTERM after 2s, then SIGKILL), and wait — bounded — for the
        // kills the abort started. A dial landing after all that is still
        // closed, just not awaited.
        dialling.abort();
        await within(ready, CLOSE_GRACE_MS);
        await closeUnclosed();
        await within(Promise.all(kills), KILL_GRACE_MS);
        void ready.then(closeUnclosed).catch(() => {});
      })()),
  };
}
