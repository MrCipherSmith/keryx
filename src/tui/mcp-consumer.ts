// `/mcp` — the MCP servers keryx CONNECTS TO.
//
// The other half of D-04's rename, and the reason `/mcp` kept opening the
// installer until now. `mcp-inspector.ts` said so plainly:
//
//   "It is deliberately NOT repointed at the MCP-server consumer: that
//    surface does not exist yet, and a slash command aimed at nothing is
//    worse than one aimed at the old thing."
//
// It exists now. `/mcp` is the consumer view — what keryx is connected
// to, what failed, and what is waiting for `keryx mcp trust`.
// `/integrations` stays the installer view: where keryx ITSELF is
// registered into an editor's config. The two are easy to confuse, which
// is why they are two commands with two captions rather than two tabs.
//
// The model is built by a PURE function. Everything AC3-AC5 asks about —
// what is shown, what is elided, what is neutralised — is a property of
// that value, so it is asserted against the value and not against a
// terminal. The P0/P1 lesson, applied before the fact this time: the
// approval rendering went untested for two phases precisely because it
// only existed inside a TUI callback.

import { displayUrl } from "../mcp-servers/http-headers";
import { sanitiseForDisplay } from "../mcp-servers/tools";
import { transportOf } from "../mcp-servers/doctor";
import type { ResolvedMcpServer } from "../mcp-servers/config";
import type { ServerState } from "../mcp-servers/manager";

export const MCP_CONSUMER_COMMAND = "/mcp";

export function isMcpConsumerCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === MCP_CONSUMER_COMMAND;
}

export type ConsumerRow = {
  readonly name: string;
  readonly source: string;
  readonly transport: string;
  readonly status: string;
  readonly toolCount: number;
  /** Where it points: an elided url, or the command line. Never a secret. */
  readonly target: string;
  /**
   * The variables this server reads, by NAME.
   *
   * The operator needs to know a server is handed `GITHUB_TOKEN`; they
   * gain nothing from seeing the token and lose everything if the screen
   * is shared. Same rule as the trust prompt.
   */
  readonly credentials: readonly string[];
  /** One line of why, when there is a why. Already safe to print. */
  readonly detail: string | undefined;
  /** What the operator should DO, when there is something. */
  readonly action: string | undefined;
};

export type ConsumerModel = {
  readonly rows: readonly ConsumerRow[];
  readonly problems: readonly string[];
  /** Shown when there is nothing at all, with the files that were read. */
  readonly emptyHint: string | undefined;
};

/** Variable names a server would read, from the RAW entry. Never values. */
function credentialNames(server: ResolvedMcpServer): string[] {
  const names = new Set<string>();
  const raw = server.raw;
  if (typeof raw.bearer_token_env_var === "string" && raw.bearer_token_env_var !== "") {
    names.add(raw.bearer_token_env_var);
  }
  for (const value of Object.values(raw.headers ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1] as string);
  }
  for (const value of Object.values(raw.env ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1] as string);
  }
  if (typeof raw.url === "string") {
    for (const match of raw.url.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1] as string);
  }
  return [...names].sort();
}

/**
 * What the row points at, safe to print.
 *
 * `displayUrl` for a remote server — the same function `keryx mcp list`
 * and the trust prompt use, and for the same reason: an operator may
 * write the credential into the url literally, and 0.2.91 shipped a
 * `list` that printed it. A third surface repeating that would be the
 * third time.
 *
 * For stdio it is the RAW command line, so `--token=${GITHUB_TOKEN}`
 * shows the variable rather than its value.
 */
function targetOf(server: ResolvedMcpServer): string {
  const raw = server.raw;
  if (typeof raw.url === "string" && raw.url.length > 0) return displayUrl(raw.url);
  return [raw.command, ...(raw.args ?? [])].filter(Boolean).join(" ");
}

/**
 * Join the configured servers to their live states.
 *
 * Config-first, so a server that is configured and has no state yet
 * appears as `connecting` rather than vanishing — the same rule the
 * runtime follows for its own initial states, and for the same reason: a
 * server the operator configured and cannot see anywhere reads as one
 * keryx never noticed.
 */
export function buildConsumerModel(input: {
  readonly configured: readonly ResolvedMcpServer[];
  readonly states: readonly ServerState[];
  readonly problems: readonly { file: string; message: string }[];
  readonly userFile: string;
  readonly projectFile: string;
}): ConsumerModel {
  const stateByName = new Map(input.states.map((s) => [s.name, s]));

  const rows: ConsumerRow[] = input.configured.map((server) => {
    const state = stateByName.get(server.name);
    const status = state?.status ?? (server.enabled ? "connecting" : "disabled");

    // SANITISED. `ServerState.error` carries the message the SDK produced,
    // which for an HTTP failure embeds the server's own response body
    // verbatim. `doctor` sanitises its copy and this one did not — the
    // asymmetry P1's security reviewer recorded as unreachable "until the
    // surface that would display it exists". This is that surface, so it
    // is reachable now, and it is handled here rather than left for the
    // round after.
    const detail = state?.error === undefined ? undefined : sanitiseForDisplay(state.error);

    return {
      name: server.name,
      source: server.source,
      transport: transportOf(server),
      status,
      toolCount: state?.toolCount ?? 0,
      target: targetOf(server),
      credentials: credentialNames(server),
      detail,
      action:
        status === "needs-approval"
          ? `keryx mcp trust ${server.name}`
          : status === "needs_auth"
            ? "set the variable named above, then restart the session"
            : undefined,
    };
  });

  return {
    rows,
    problems: input.problems.map((p) => `${p.file}: ${sanitiseForDisplay(p.message)}`),
    emptyHint:
      rows.length > 0
        ? undefined
        : `No MCP servers configured.\n  user:    ${input.userFile}\n  project: ${input.projectFile}`,
  };
}

/** One line per row, for a surface that renders text. */
export function formatConsumerRow(row: ConsumerRow): string {
  const tags = [row.source, row.transport, row.status].join(" ");
  const tools = row.status === "connected" ? ` — ${row.toolCount} tool(s)` : "";
  const creds = row.credentials.length > 0 ? `  [reads ${row.credentials.join(", ")}]` : "";
  return `${row.name} (${tags})${tools}  ${row.target}${creds}`;
}
