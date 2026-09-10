// `keryx mcp doctor` — what is wrong, per server, without printing secrets.
//
// P0 item 8. Four things, and the fourth is the one no other surface shows:
//
//   1. config problems, per file (`config.ts` already carries them);
//   2. the result of actually connecting, not a guess from the config;
//   3. how many tools the server offered;
//   4. the tools that were dropped, and WHY — a tool skipped for an
//      over-long qualified name is absent from `search_tool` and absent from
//      every other report, so the operator looking for it debugs the server
//      instead of the name.
//
// Redaction is a rule, not a courtesy: specification §2 says expanded values
// never appear in doctor JSON beyond a `set`/`unset` flag. `env` and `headers`
// routinely hold tokens, and `doctor` output is the thing operators paste into
// an issue.

import type {
  McpConfigProblem,
  McpServerSource,
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from "./config";
import type { SkippedTool } from "./catalog";
import { catalogForServer } from "./catalog";
import type { ConnectFn, ServerStatus } from "./manager";
import { describeHollow, resolveHttpHeaders } from "./http-headers";
import type { McpToolDescriptor } from "../mcp-client/client";

/**
 * `not-attempted` is a distinct answer from `failed`.
 *
 * P0 connects stdio only; a `url` server is not broken, it is out of scope
 * this release. Reporting it as `failed` would send the operator to debug a
 * server that was never dialled.
 */
export type DiagnosisStatus = ServerStatus | "not-attempted";

export type Diagnosis = {
  readonly name: string;
  readonly source: McpServerSource;
  readonly file: string;
  readonly transport: "stdio" | "http" | "unknown";
  readonly enabled: boolean;
  readonly status: DiagnosisStatus;
  readonly detail?: string | undefined;
  readonly toolCount: number;
  readonly skipped: SkippedTool[];
  /** Key → whether it resolved to anything. Never the value. See the header. */
  readonly env: Record<string, "set" | "unset">;
  readonly headers: Record<string, "set" | "unset">;
};

export type DoctorReport = {
  readonly problems: McpConfigProblem[];
  readonly servers: Diagnosis[];
  /** True when anything needs the operator: a config problem or a failed dial. */
  readonly healthy: boolean;
};

/** `set` only for a non-empty value: `${MISSING}` expands to "" and is not set. */
export function redactValues(values: Record<string, string> | undefined): Record<string, "set" | "unset"> {
  const out: Record<string, "set" | "unset"> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    out[key] = typeof value === "string" && value.length > 0 ? "set" : "unset";
  }
  return out;
}

/**
 * `set`/`unset` for HEADERS, judged the way the dial judges them.
 *
 * `redactValues` alone is wrong here and the report said so out loud:
 * `Bearer ${NOPE}` expands to `"Bearer "`, which is non-empty, so the
 * headers map read `set` while the detail on the same server read "NOPE is
 * unset". A report that contradicts itself in two adjacent fields teaches
 * the reader to trust neither.
 *
 * The question is the same one `resolveHttpHeaders` answers — would this
 * header be sent — so it is answered by asking that.
 */
export function redactHeaders(
  server: ResolvedMcpServer,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, "set" | "unset"> {
  const out: Record<string, "set" | "unset"> = {};
  const resolution = resolveHttpHeaders(server, server.raw, env);
  const hollow = new Set(resolution.ok ? [] : resolution.hollow.map((h) => h.header.toLowerCase()));

  for (const key of Object.keys(server.headers ?? {})) {
    out[key] = hollow.has(key.toLowerCase()) ? "unset" : "set";
  }
  // `bearer_token_env_var` produces an Authorization header that is not in
  // the config's own `headers`, so it would otherwise be absent from the
  // report entirely — and absent reads as "not configured".
  const tokenVar = server.bearer_token_env_var;
  if (tokenVar !== undefined && tokenVar !== "" && out.Authorization === undefined) {
    out.Authorization = hollow.has("authorization") ? "unset" : "set";
  }
  return out;
}

export function transportOf(server: ResolvedMcpServer): "stdio" | "http" | "unknown" {
  if (typeof server.command === "string" && server.command.length > 0) return "stdio";
  if (typeof server.url === "string" && server.url.length > 0) return "http";
  return "unknown";
}

export type DoctorOptions = {
  /** Diagnose one server. Undefined means all of them. */
  readonly only?: string | undefined;
  readonly connect: ConnectFn;
  readonly connectTimeoutMs?: number | undefined;
  /** Injected so `doctor` does not dial a project server nobody approved. */
  readonly heldForApproval?: ((server: ResolvedMcpServer) => boolean) | undefined;
  /** Overridden in tests; otherwise the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
};

const DEFAULT_DOCTOR_TIMEOUT_MS = 10_000;

/**
 * Diagnose, one server at a time, and never throw.
 *
 * Serial rather than concurrent, unlike `startServers`. `doctor` is run by a
 * person who is already suspicious of one server, and interleaved subprocess
 * output from four dials at once is what makes such a report unreadable. The
 * cost is wall-clock on a run nobody does in a loop.
 *
 * Each connection is CLOSED after listing. `doctor` is diagnostic; leaving
 * four servers running after it prints would leak a process per invocation.
 */
export async function runDoctor(
  config: ResolvedMcpConfig,
  options: DoctorOptions,
): Promise<DoctorReport> {
  const selected =
    options.only === undefined
      ? config.servers
      : config.servers.filter((server) => server.name === options.only);

  const problems = [...config.problems];
  if (options.only !== undefined && selected.length === 0) {
    problems.push({
      file: "(selection)",
      message:
        config.servers.length === 0
          ? `no server named "${options.only}" — no MCP servers are configured at all`
          : `no server named "${options.only}". Configured: ${config.servers.map((s) => s.name).join(", ")}`,
    });
  }

  const servers: Diagnosis[] = [];
  for (const server of selected) {
    servers.push(await diagnose(server, options));
  }

  return {
    problems,
    servers,
    // A held server is not a failure — it is a decision waiting. It must
    // still be visible, which is what `status` carries.
    healthy: problems.length === 0 && servers.every((s) => s.status !== "failed"),
  };
}

async function diagnose(server: ResolvedMcpServer, options: DoctorOptions): Promise<Diagnosis> {
  const base = {
    name: server.name,
    source: server.source,
    file: server.file,
    transport: transportOf(server),
    enabled: server.enabled,
    env: redactValues(server.env),
    headers: redactHeaders(server, options.env ?? process.env),
  } as const;

  if (!server.enabled) {
    return { ...base, status: "disabled", toolCount: 0, skipped: [], detail: "disabled; not dialled" };
  }
  if (options.heldForApproval?.(server) === true) {
    // Never dialled, and that is the answer — not a connection result. A
    // `doctor` that connected anyway would be doing the exact thing the
    // approval gate exists to prevent, in the name of diagnosing it.
    return {
      ...base,
      status: "needs-approval",
      toolCount: 0,
      skipped: [],
      detail: `project server not approved; run \`keryx mcp trust ${server.name}\` after reading what it launches`,
    };
  }
  if (base.transport === "unknown") {
    return {
      ...base,
      status: "not-attempted",
      toolCount: 0,
      skipped: [],
      detail: "sets neither command nor url",
    };
  }

  if (base.transport === "http") {
    // A hollow credential is a CONFIG problem, and saying so is the whole
    // of AC19's second half: dialling with `Bearer ` would produce a 401
    // from somebody else's server, which reads as "their server is broken"
    // rather than "your variable is unset".
    const resolved = resolveHttpHeaders(server, server.raw, options.env ?? process.env);
    if (!resolved.ok) {
      return {
        ...base,
        status: "needs_auth",
        toolCount: 0,
        skipped: [],
        detail: describeHollow(resolved.hollow),
      };
    }
  }

  const timeoutMs =
    server.startup_timeout_sec !== undefined
      ? server.startup_timeout_sec * 1000
      : (options.connectTimeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS);

  let connection;
  try {
    connection = await withTimeout(options.connect(server), timeoutMs, server.name);
  } catch (error) {
    return {
      ...base,
      status: "failed",
      toolCount: 0,
      skipped: [],
      detail: explainConnectFailure(base.transport, server, error),
    };
  }

  try {
    const tools = await withTimeout(connection.listTools(), timeoutMs, server.name);
    const catalog = catalogForServer(server.name, tools as McpToolDescriptor[]);
    return {
      ...base,
      status: "connected",
      toolCount: catalog.entries.length,
      skipped: catalog.skipped,
    };
  } catch (error) {
    // Dialled but could not list: a real and different failure from "would
    // not start", and the message is the only thing that distinguishes them.
    return { ...base, status: "failed", toolCount: 0, skipped: [], detail: messageOf(error) };
  } finally {
    try {
      await connection.close();
    } catch {
      // A close that throws has already lost the process. Reporting it would
      // replace the diagnosis with an error about ending the diagnosis.
    }
  }
}

/**
 * Say WHICH failure, not that there was one.
 *
 * AC7: unreachable, wrong status, a non-MCP endpoint and a TLS problem are
 * four different things an operator does four different things about, and
 * the SDK reports all of them as an exception. Collapsing them into
 * "failed: <whatever the SDK said>" is the shape of report that sends
 * someone to restart a server that is running fine on a URL with a typo.
 */
export function explainConnectFailure(
  transport: "stdio" | "http" | "unknown",
  server: ResolvedMcpServer,
  error: unknown,
): string {
  const message = messageOf(error);
  if (transport !== "http") return message;

  const lower = message.toLowerCase();
  const url = server.raw.url ?? server.url ?? "";

  if (/econnrefused|connection refused|unable to connect|failed to fetch|fetch failed/.test(lower)) {
    return `nothing is listening at ${url} (${message})`;
  }
  if (/enotfound|getaddrinfo|dns/.test(lower)) {
    return `the host in ${url} does not resolve (${message})`;
  }
  if (/certificate|self-signed|self signed|tls|ssl|unable to verify/.test(lower)) {
    return `the TLS certificate for ${url} was rejected (${message})`;
  }
  if (/\b40[13]\b|unauthorized|forbidden/.test(lower)) {
    return `${url} refused the credentials it was given (${message}). Check the header or bearer_token_env_var.`;
  }
  if (/\b(4\d\d|5\d\d)\b|http \d\d\d|status code/.test(lower)) {
    return `${url} answered with an HTTP error (${message})`;
  }
  if (/did not complete the handshake|did not answer/.test(lower)) {
    return `${url} accepted the connection and never completed the MCP handshake (${message})`;
  }
  if (/json|parse|unexpected token|zod|invalid/.test(lower)) {
    // The commonest misconfiguration: a URL that serves a web page.
    return `${url} answered, but not with MCP — is that the server endpoint and not a web page? (${message})`;
  }
  return message;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`server "${name}" did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The human rendering. `--json` prints the report itself, so this is the only formatter. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  if (report.problems.length > 0) {
    lines.push("Config problems:");
    for (const problem of report.problems) {
      lines.push(`  ${problem.file}: ${problem.message}`);
    }
    lines.push("");
  }

  if (report.servers.length === 0) {
    lines.push("No MCP servers configured.");
    return lines.join("\n");
  }

  for (const server of report.servers) {
    const detail = server.detail === undefined ? "" : ` — ${server.detail}`;
    lines.push(`${server.name} [${server.source}] ${server.transport}: ${server.status}${detail}`);
    lines.push(`  file: ${server.file}`);
    if (server.status === "connected") {
      lines.push(`  tools: ${server.toolCount}`);
    }
    for (const skipped of server.skipped) {
      lines.push(`  skipped "${skipped.rawName}": ${skipped.reason}`);
    }
    const unset = Object.entries({ ...server.env, ...server.headers })
      .filter(([, state]) => state === "unset")
      .map(([key]) => key);
    if (unset.length > 0) {
      // Named because an unset `${TOKEN}` is the most common cause of a
      // server that starts and then refuses everything.
      lines.push(`  unset: ${unset.join(", ")}`);
    }
  }

  return lines.join("\n");
}
