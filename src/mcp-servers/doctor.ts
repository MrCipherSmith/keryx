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
import { describeHollow, displayUrl, remoteTargetProblem, resolveHttpHeaders } from "./http-headers";
import { sanitiseForDisplay } from "./tools";
import { isExpired, readCredential, usesOAuth } from "./credentials";
import { OAuthInteractionRequiredError } from "./oauth-provider";
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
  // Case-INSENSITIVELY, because HTTP header names are. `out.Authorization
  // === undefined` was true for a config that wrote `"authorization"` in
  // lowercase, so the report grew a second Authorization row — for a
  // credential that `resolveHttpHeaders` does not send, since the explicit
  // header wins. The operator saw the header listed twice and had no way
  // to tell which of the two was on the wire.
  const alreadyReported = Object.keys(out).some((key) => key.toLowerCase() === "authorization");
  if (tokenVar !== undefined && tokenVar !== "" && !alreadyReported) {
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
  /**
   * Where the OAuth credential store lives. Overridden in tests.
   *
   * Not optional in effect: with no override this reads the real one,
   * and a test that forgets it diagnoses the developer's own tokens.
   */
  readonly configDir?: string | undefined;
  /** Injected in tests so expiry is a fact, not a race against the clock. */
  readonly now?: (() => number) | undefined;
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
    // Healthy means NOTHING NEEDS THE OPERATOR, which is what the exit
    // code says. Three statuses need them and only one of the three is a
    // failure: a server awaiting approval and one whose credential
    // variable is unset are both decisions waiting, and reporting them
    // with exit 0 tells a script — and a person skimming — that the
    // configuration is fine when two commands are outstanding.
    healthy:
      problems.length === 0 &&
      servers.every((s) => s.status !== "failed" && s.status !== "needs_auth" && s.status !== "needs-approval"),
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
    const env = options.env ?? process.env;
    // The SAME list the session dial uses, not a second copy of it.
    const urlIssue = remoteTargetProblem(server.raw, env);
    if (urlIssue !== undefined) {
      return { ...base, status: "needs_auth", toolCount: 0, skipped: [], detail: urlIssue };
    }
    const resolved = resolveHttpHeaders(server, server.raw, env);
    if (!resolved.ok) {
      return {
        ...base,
        status: "needs_auth",
        toolCount: 0,
        skipped: [],
        detail: describeHollow(resolved.hollow),
      };
    }

    // AC5. Diagnosed WITHOUT dialling, but ONLY for a server the
    // operator has explicitly declared an `oauth` block on.
    //
    // `usesOAuth` was the wrong question here, and the first version
    // asked it: it means "OAuth WOULD apply if authentication is
    // needed", which is true of every remote server that declares no
    // credential — including every PUBLIC one. Using it as "must
    // authenticate before dialling" stopped doctor dialling those
    // entirely and reported a working server as needing a login it
    // does not have. An explicit `oauth` block is the operator saying
    // this server does need one; everything else earns its 401 below.
    const declaresOAuth = server.raw.oauth !== undefined && server.raw.oauth !== false;
    if (declaresOAuth && usesOAuth(server.raw)) {
      const stored = readCredential(server.name, server.url ?? "", options.configDir);
      if (stored.problem !== undefined) {
        // A store that cannot be read is not the same as no credential:
        // the token may well be in there, behind a syntax error.
        return { ...base, status: "needs_auth", toolCount: 0, skipped: [], detail: stored.problem };
      }
      const tokens = stored.record?.tokens;
      // Expired WITH a refresh token is not a problem to report: the
      // SDK refreshes it on the dial, with no operator involved.
      if (tokens === undefined || (isExpired(tokens, (options.now ?? Date.now)()) && tokens.refresh_token === undefined)) {
        return {
          ...base,
          status: "needs_auth",
          toolCount: 0,
          skipped: [],
          detail:
            tokens === undefined
              ? `no stored credential; run \`keryx mcp auth ${server.name}\``
              : `stored credential has expired and cannot be refreshed; run \`keryx mcp auth ${server.name}\``,
        };
      }
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
    // The other half of AC5: a server that turned out to want OAuth.
    //
    // For anything without an explicit `oauth` block the 401 IS the
    // discovery — keryx cannot know in advance whether a remote server
    // is public. Reporting it as `failed` with "check the header"
    // sends the operator to edit a config that has nothing wrong with
    // it, when the answer is one command.
    if (base.transport === "http" && needsAuthorisation(error)) {
      return {
        ...base,
        status: "needs_auth",
        toolCount: 0,
        skipped: [],
        detail: `${displayUrl(server.raw.url)} requires authorisation; run \`keryx mcp auth ${server.name}\``,
      };
    }
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
/**
 * Is this failure "you are not authorised", as opposed to "broken"?
 *
 * Two shapes mean it. A 401 is the server saying so. The provider's
 * own refusal is keryx saying so before the wire: the SDK asked for a
 * browser, this process has none, and that is not a network fault.
 *
 * 403 is deliberately NOT here. It means authenticated and not
 * permitted — re-running `keryx mcp auth` grants nothing, and sending
 * the operator through a consent screen that cannot help is worse than
 * telling them their token lacks the scope.
 */
export function needsAuthorisation(error: unknown): boolean {
  if (httpStatusOf(error) === 401) return true;
  return error instanceof OAuthInteractionRequiredError;
}

export function explainConnectFailure(
  transport: "stdio" | "http" | "unknown",
  server: ResolvedMcpServer,
  error: unknown,
): string {
  const message = sanitiseForDisplay(messageOf(error));
  if (transport !== "http") return message;

  // The URL, from the RAW entry and with its query elided. The expanded
  // form carries whatever `${API_KEY}` resolved to.
  const url = displayUrl(server.raw.url);

  // CLASSIFY ON THE CODE, NOT THE MESSAGE.
  //
  // The first version matched regexes against the message text and four of
  // its seven branches could never fire, which a reviewer proved by
  // deleting the whole function and watching 505 tests stay green. The
  // reason is structural: the SDK throws
  // `new StreamableHTTPError(response.status, "Error POSTing to endpoint: " + body)`
  // — the status is on `.code` and is NEVER in the message. So the
  // credentials branch fired only when the SERVER'S RESPONSE BODY happened
  // to contain the word "unauthorized", and the same 401 was classified
  // two different ways depending on what the server wrote.
  const status = httpStatusOf(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return `${url} rejected the credentials it was given (HTTP ${status}). Check the header or bearer_token_env_var.`;
    }
    if (status === 404) return `${url} has no MCP endpoint there (HTTP 404). Check the path.`;
    if (status >= 500) return `${url} answered HTTP ${status} — the server is failing, not the config.`;
    return `${url} answered HTTP ${status}.`;
  }

  // Then the system error code, which is where a socket failure lives.
  const syscall = syscallCodeOf(error);
  if (syscall !== undefined) {
    if (syscall === "ECONNREFUSED") return `nothing is listening at ${url} (${syscall})`;
    if (syscall === "ENOTFOUND" || syscall === "EAI_AGAIN") {
      return `the host in ${url} does not resolve (${syscall})`;
    }
    if (isTlsCode(syscall)) {
      return `the TLS certificate for ${url} was rejected (${syscall})`;
    }
    if (syscall === "ETIMEDOUT") return `${url} did not answer in time (${syscall})`;
    if (syscall === "UnexpectedRedirect") {
      // Bun reports the refusal from `redirect: "error"` as a CODE, so the
      // message branch below could never see it — the third branch on this
      // diff written from a guess at a library's wording and never
      // executed. This is the one failure keryx causes on purpose, and it
      // was reported as "could not be reached", which sends the operator
      // to check a server that is up and answering.
      return `${url} redirected, which keryx does not follow for MCP. Configure the final URL. (${syscall})`;
    }
    return `${url} could not be reached (${syscall})`;
  }

  // Only then the message, and only for the cases that have no code.
  const lower = message.toLowerCase();
  if (lower.includes("unexpected content type")) {
    // The commonest misconfiguration: a URL that serves a web page. The
    // SDK reports it exactly this way and the old regex list had no
    // branch that matched it.
    return `${url} answered, but not with MCP — is that the server endpoint and not a web page? (${message})`;
  }
  if (lower.includes("did not complete the handshake") || lower.includes("did not answer")) {
    return `${url} accepted the connection and never completed the MCP handshake (${message})`;
  }
  if (lower.includes("unable to connect")) {
    // Bun collapses refused and unresolvable into one message with no
    // code. Say both rather than guess.
    return `${url} could not be reached — nothing listening, or the host does not resolve (${message})`;
  }
  if (lower.includes("redirect")) {
    return `${url} redirected, which keryx does not follow for MCP. Configure the final URL. (${message})`;
  }
  return `${url}: ${message}`;
}

/**
 * A TLS failure, by code.
 *
 * This was `code.includes("CERT") || includes("SSL") || includes("TLS")`,
 * which is a guess at OpenSSL's naming, and the mutation sweep showed the
 * branch had never been executed at all. Run against real codes it misses
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and `HOSTNAME_MISMATCH` — the two an
 * operator behind a corporate TLS-intercepting proxy actually gets, which
 * is precisely the case where "could not be reached" sends them to debug
 * the wrong end.
 *
 * The named set first, the substrings after, so an unlisted OpenSSL code
 * still lands somewhere sensible.
 */
const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "HOSTNAME_MISMATCH",
  "EPROTO",
]);

function isTlsCode(code: string): boolean {
  return TLS_CODES.has(code) || code.includes("CERT") || code.includes("SSL") || code.includes("TLS");
}

/** The HTTP status the SDK carries on `StreamableHTTPError.code`. */
export function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" && code >= 100 && code <= 599 ? code : undefined;
}

/** The system error code, on the error or its cause. */
export function syscallCodeOf(error: unknown): string | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
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
