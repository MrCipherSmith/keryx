// The `keryx serve` listener (flow 128 / roadmap R4b).
//
// This is the first thing in keryx that can be reached from outside the
// operator's terminal, so the shape is deliberately conservative:
//
//   * Startup preconditions are resolved by a PURE function
//     (`resolveServeStartup`) that returns before anything binds. `Bun.serve`
//     appears exactly once in this file and is reachable only after that
//     function returned `ok`. `refused` is therefore terminal by construction,
//     not by discipline. The one exception is stated rather than hidden: if
//     `Bun.serve` succeeds but reports no usable port, the socket is closed and
//     the outcome is still `refused` — a bind that happened and was undone, not
//     a degraded listen. No caller ever receives a listener it was refused.
//
//   * Authentication runs BEFORE the URL is inspected. An unauthenticated
//     caller gets one fixed 401 on every path and every method, so it cannot
//     learn which paths exist (api-protocol.md §Principles, "Silent to
//     strangers").
//
//   * The route table is a closed, exact-match enumeration of two entries. Not
//     a prefix match and not a pattern — see
//     .metaproject/memory/lessons/allowlist-not-a-boundary.md, where a check
//     against a raw string turned out not to be a boundary at all.
//
// What this slice deliberately cannot do: run a turn, execute a tool, write
// anything, or accept a secret. Both routes are reads. `pendingApprovals` is a
// constant 0 because nothing in this slice can create one.

import type { Server } from "bun";
import { emitProjectsJson, listProjects } from "./project-registry";
import { isLoopbackAddress, type ServeConfig } from "./serve-config";
import {
  readServeCredential,
  verifyServeToken,
  type ServeCredentialRecord,
  type ServeCredentialResult,
} from "./serve-credential";

/** specification.md §"Process and state machine". */
export type ServeState = "stopped" | "configured" | "listening" | "draining" | "refused";

export type ServeRefusalReason =
  | "no-configuration"
  | "disabled"
  | "no-credential"
  | "unreadable-credential"
  | "non-loopback-not-acknowledged"
  /** The configuration names a credential store this release does not implement. */
  | "unsupported-credential-store"
  /** The address was acceptable but the kernel would not give us the socket. */
  | "bind-failed";

export interface ServeStartupOk {
  ok: true;
  config: ServeConfig;
  credential: ServeCredentialRecord;
  /** True when the bind address is reachable beyond loopback. */
  nonLoopback: boolean;
}

export interface ServeStartupRefused {
  ok: false;
  state: "refused";
  reason: ServeRefusalReason;
  message: string;
}

export type ServeStartup = ServeStartupOk | ServeStartupRefused;

export interface ServeStartupInput {
  config: ServeConfig | null;
  credential: ServeCredentialResult;
}

function refuse(reason: ServeRefusalReason, message: string): ServeStartupRefused {
  return { ok: false, state: "refused", reason, message };
}

/**
 * Decide whether the server may start. Pure: it opens nothing.
 *
 * Every refusal is terminal. specification.md is explicit that `refused` "is a
 * terminal startup outcome, never a degraded listen", so there is no partial
 * success and no warn-and-continue branch anywhere below.
 */
export function resolveServeStartup(input: ServeStartupInput): ServeStartup {
  const { config, credential } = input;

  if (config === null) {
    return refuse(
      "no-configuration",
      "no serve configuration was found. Run `keryx serve config init` to create one.",
    );
  }
  if (!config.enabled) {
    return refuse(
      "disabled",
      // `config set`, not `config init`. This state is reachable ONLY when a
      // configuration exists, so `config init` refuses — and `--force` would
      // make the instruction succeed by resetting bind, port and profile.
      "the serve configuration is present but disabled. Run `keryx serve config set --enable` to enable it.",
    );
  }
  if (config.credentialRef.store !== "auth-json") {
    // The schema allows `os-credential-store`; nothing in this release reads
    // it. Accepting the value and quietly authenticating against the file store
    // would leave the operator believing their token lives in the OS keychain.
    return refuse(
      "unsupported-credential-store",
      `credentialRef.store "${config.credentialRef.store}" is not implemented in this release; only "auth-json" is supported.`,
    );
  }
  if (credential.status === "unreadable") {
    return refuse(
      "unreadable-credential",
      `${credential.message}. Inspect it, then run \`keryx serve token rotate\`.`,
    );
  }
  if (credential.status === "absent") {
    return refuse(
      "no-credential",
      "no serve credential exists. Run `keryx serve token issue` — the token is printed once and never again.",
    );
  }
  if (credential.record.id !== config.credentialRef.id) {
    // The configuration names a credential that is not the one in the store.
    // Authenticating with a different credential than the operator configured
    // is exactly the kind of "close enough" that makes an audit trail useless.
    return refuse(
      "no-credential",
      "the configured credential reference does not match the credential in the store. Run `keryx serve token rotate` to re-issue and re-point it.",
    );
  }

  const nonLoopback = !isLoopbackAddress(config.bind.address);
  if (nonLoopback && config.bind.acknowledgeNonLoopback !== true) {
    return refuse(
      "non-loopback-not-acknowledged",
      // Same reason as `disabled` above: a configuration exists on this branch
      // by construction, so the instruction has to be the non-destructive one.
      "the configured bind address is reachable beyond loopback. Run `keryx serve config set --bind <addr> --acknowledge-non-loopback` to acknowledge it explicitly; there is no TLS in this release.",
    );
  }

  return { ok: true, config, credential: credential.record, nonLoopback };
}

// ---------------------------------------------------------------------------
// CLI status projection
// ---------------------------------------------------------------------------

export interface ServeStatusReport {
  /**
   * `listening` and `draining` are absent by design: this slice writes no PID
   * file and opens no control socket, so a separate CLI process cannot honestly
   * claim a listener is up. Those two states are reported by the running
   * process over `GET /v1/status`, which is the only place they are knowable.
   */
  state: "stopped" | "configured" | "refused";
  reason?: ServeRefusalReason;
  message?: string;
  bind?: { address: string; port: number };
  profile?: string;
  nonLoopback: boolean;
  /** Always 0 in this slice: nothing here can create an approval. */
  pendingApprovals: 0;
}

/**
 * What `keryx serve status` reports.
 *
 * Nothing configured, and a configuration that is present but disabled, are both
 * `stopped` — that is the honest answer to "is there a listener", and AC1
 * requires it of a fresh install. A configuration that intends to run but
 * cannot is `refused`, with the reason.
 */
export function describeServeStatus(input: ServeStartupInput): ServeStatusReport {
  const { config } = input;
  if (config === null || !config.enabled) {
    return { state: "stopped", nonLoopback: false, pendingApprovals: 0 };
  }
  const startup = resolveServeStartup(input);
  const nonLoopback = !isLoopbackAddress(config.bind.address);
  const shared = {
    bind: { address: config.bind.address, port: config.bind.port },
    profile: config.profile,
    nonLoopback,
    pendingApprovals: 0 as const,
  };
  if (!startup.ok) {
    return { state: "refused", reason: startup.reason, message: startup.message, ...shared };
  }
  return { state: "configured", ...shared };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export interface ServeContext {
  config: ServeConfig;
  /**
   * Resolved PER REQUEST, not captured at startup.
   *
   * security-policy.md requires revocation to take effect "immediately for new
   * [requests]" and rotation not to "silently keep both valid". With the record
   * closed over at startup neither held: a security review revoked the
   * credential, watched the store on disk go to `active: null`, and the
   * attacker's token kept returning 200 for the life of the process. Rotation
   * was worse — the old token worked and the new one did not.
   *
   * Fail-closed in the other direction too: `absent` and `unreadable` both deny.
   * Deleting the store is not a way to keep the last-known-good credential
   * alive, and it is not a way to turn authentication off.
   */
  resolveCredential: () => ServeCredentialResult;
  nonLoopback: boolean;
  /** The port actually bound, which is not `config.bind.port` when it was 0. */
  boundPort: number;
  /** Overrides the user-global config directory. Tests only. */
  dir?: string | undefined;
  state: () => ServeState;
}

/** The complete route surface of this slice. Exact match, closed set. */
const ROUTES = new Set(["/v1/status", "/v1/projects"]);

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify({ error: { code, message } })}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/**
 * One fixed 401 for every authentication failure.
 *
 * api-protocol.md: "No distinction between 'no token', 'malformed token', and
 * 'wrong token'". The body names nothing that exists, and the response is
 * identical on every path so a stranger cannot probe the route table with it.
 */
function unauthorized(): Response {
  return errorResponse(401, "unauthorized", "Unauthorized.", { "www-authenticate": "Bearer" });
}

/**
 * Extract the bearer value, or "" when there is nothing usable.
 *
 * Returning "" rather than a sentinel keeps every failure on ONE code path
 * through the hash-and-compare below, so a missing header costs the same work
 * as a wrong token.
 */
function bearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (header === null) {
    return "";
  }
  const space = header.indexOf(" ");
  if (space < 0) {
    return "";
  }
  if (header.slice(0, space).toLowerCase() !== "bearer") {
    return "";
  }
  return header.slice(space + 1).trim();
}

/**
 * Collapse R4a's terminal-facing registry warnings into bounded codes.
 *
 * An ALLOWLIST, not a redaction pass: a substring filter over the message would
 * have to anticipate every path shape R4a might quote, and the one it missed
 * would be the one that shipped. Anything unrecognised becomes the opaque
 * `registry-warning`, so a warning added upstream cannot leak by default.
 */
export function summarizeRegistryWarnings(messages: readonly string[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const code = message.includes("malformed entr")
      ? "registry-entries-dropped"
      : message.includes("is malformed") || message.includes("is unreadable")
        ? "registry-unreadable"
        : "registry-warning";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([code, count]) => ({ code, count }));
}

/**
 * The whole request surface.
 *
 * Exported separately from the listener so every response can be asserted
 * without binding a socket, and so the listener and the tests exercise the same
 * function rather than two implementations of the same rules.
 */
export function handleServeRequest(request: Request, ctx: ServeContext): Response {
  // (1) Authenticate FIRST. The URL is not even parsed until this passes, so
  // there is no branch on it that could differ for an unauthenticated caller.
  const credential = ctx.resolveCredential();
  if (credential.status !== "ok" || !verifyServeToken(bearerToken(request), credential.record)) {
    return unauthorized();
  }

  // (2) A draining server accepts no new request. After authentication, so the
  // 503 is not an oracle for a stranger.
  //
  // Unreachable through the real listener today — see drain(); the window
  // between the state flip and the close is empty while every route is
  // synchronous. Kept because it is the correct answer once one is not, and
  // because the alternative is a server that serves a request it has already
  // decided to stop serving.
  if (ctx.state() === "draining") {
    return errorResponse(503, "draining", "The server is draining.");
  }

  const pathname = new URL(request.url).pathname;
  if (!ROUTES.has(pathname)) {
    return errorResponse(404, "not-found", "Not found.");
  }
  if (request.method !== "GET") {
    return errorResponse(405, "method-not-allowed", "Method not allowed.", { allow: "GET" });
  }

  if (pathname === "/v1/status") {
    // Framed the same way as every other response in this file — one JSON
    // document plus a trailing newline. `Response.json` omits the newline, so
    // the two routes disagreed about their own framing.
    return new Response(
      `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          state: ctx.state(),
          bind: { address: ctx.config.bind.address, port: ctx.boundPort },
          profile: ctx.config.profile,
          nonLoopback: ctx.nonLoopback,
          // Constant by construction: this slice has no approval machinery. It
          // is reported so a transport can render the field from day one.
          pendingApprovals: 0,
        },
        null,
        2,
      )}\n`,
      { headers: JSON_HEADERS },
    );
  }

  // /v1/projects — the R4a projection verbatim. Reimplementing it here would
  // create a second answer to "which projects exist", and the two would drift.
  //
  // The WARNINGS are not forwarded verbatim. R4a composes them for a terminal
  // and quotes the absolute path of the user-global registry — so a route that
  // is otherwise addressing-only was disclosing the operator's home directory
  // and OS username to any authenticated caller, which security-policy.md
  // §Data minimization forbids. Project paths stay: those ARE the addressing
  // the registration schema defines.
  const raw: string[] = [];
  const entries = listProjects(ctx.dir, (message) => raw.push(message));
  const payload = JSON.parse(emitProjectsJson(entries, [])) as Record<string, unknown>;
  payload.warnings = summarizeRegistryWarnings(raw);
  return new Response(`${JSON.stringify(payload, null, 2)}\n`, { headers: JSON_HEADERS });
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

export interface ServeListener {
  /** The port actually bound. Differs from the configured port when it was 0. */
  port: number;
  address: string;
  state(): ServeState;
  /** Enter `draining`, refuse new requests, close, release the port. */
  drain(): Promise<void>;
}

export type StartServeOutcome = { ok: true; listener: ServeListener } | ServeStartupRefused;

export interface StartServeInput extends ServeStartupInput {
  /** Overrides the user-global config directory (registry + credential store). */
  dir?: string | undefined;
}

/**
 * Bind, or refuse.
 *
 * `Bun.serve` is called on exactly one line in this module, and that line is
 * unreachable until `resolveServeStartup` has returned `ok`. There is no path
 * that opens a socket and then reports a problem.
 */
export async function startServeListener(input: StartServeInput): Promise<StartServeOutcome> {
  const startup = resolveServeStartup(input);
  if (!startup.ok) {
    return startup;
  }

  let state: ServeState = "configured";
  // Bun wants a bare host, not a bracketed IPv6 literal.
  const hostname = startup.config.bind.address.replace(/^\[|\]$/g, "");
  // Resolved after the bind, because a configured port of 0 means "the OS
  // chooses" and the caller needs to be told which one it chose.
  let boundPort = 0;

  let server: Server<undefined>;
  try {
    server = Bun.serve({
      hostname,
      port: startup.config.bind.port,
      fetch: (request) =>
        handleServeRequest(request, {
          config: startup.config,
          // Re-read on every request so `token revoke` and `token rotate` reach
          // a listener that is already running.
          resolveCredential: () => readServeCredential(input.dir),
          nonLoopback: startup.nonLoopback,
          boundPort,
          dir: input.dir,
          state: () => state,
        }),
    });
  } catch (error) {
    // A bind failure is still a refusal to start, not a degraded listen: the
    // process must not fall back to another port, because the operator would
    // then be told the server is up at an address nothing is reachable on.
    return refuse(
      "bind-failed",
      `could not bind ${hostname}:${startup.config.bind.port}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof server.port !== "number" || server.port <= 0) {
    // Defensive: a listener whose port cannot be reported is a listener the
    // operator cannot be told about, which is worse than not starting.
    await server.stop(true);
    return refuse("bind-failed", "the listener reported no bound port");
  }
  boundPort = server.port;
  state = "listening";

  return {
    ok: true,
    listener: {
      port: boundPort,
      address: startup.config.bind.address,
      state: () => state,
      async drain(): Promise<void> {
        if (state === "stopped") {
          return;
        }
        // The state flips BEFORE the close. In this release that window is
        // EMPTY BY CONSTRUCTION — `handleServeRequest` is synchronous and
        // `stop(true)` force-closes, so no request can be dispatched between
        // the two lines, and a mutation check confirmed removing this
        // assignment broke nothing until a test was added that observes it.
        // It is set anyway because the 503 branch it feeds becomes reachable
        // the moment a route does asynchronous work, which is the next slice.
        state = "draining";
        await server.stop(true);
        state = "stopped";
      },
    },
  };
}
