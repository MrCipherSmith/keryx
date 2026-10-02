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
//   * Two principals, two route tables (flow 376, remote control). The serve
//     bearer credential reaches the routes above and NOTHING under
//     `/v1/remote/`. The local shell token (a separate secret, created by the
//     process that owns the Telegram bot, read by shells on the same machine)
//     reaches ONLY the exact `/v1/remote/*` paths of the table below and nothing else.
//     `/v1/remote/*` deliberately does NOT also require the serve bearer: the
//     shell is a local, same-user process that must not hold the credential
//     that can run turns and answer approvals, and a route that needed both
//     secrets would force exactly that. Which principal a caller is falls out
//     of WHICH token verified, before the URL is read, so the fixed 401 for a
//     stranger is unchanged. A principal asking for a path outside its own
//     table gets the ordinary 404 — the same answer as a path that does not
//     exist — and a remote caller must also arrive over a loopback connection.
//     A listener with no remote surface cannot authenticate a shell token at
//     all, so a plain `keryx serve` behaves exactly as before.
//
// What this slice deliberately cannot do: run a turn, execute a tool, write
// anything, or accept a secret. Both routes are reads. (R4d, flow 369, later added
// the approval routes and made `pendingApprovals` real.)

import type { Server } from "bun";
import {
  compareProfiles,
  localBaselineProfile,
  REMOTE_PROFILE_NAMES,
  resolveRemoteProfile,
} from "../harness/policy/profiles";
import type { PolicyProfile } from "../harness/policy/types";
import { emitProjectsJson, listProjects } from "./project-registry";
import { createApprovalBroker, createConsumerRegistry, type ApprovalBroker, type ApprovalConsumers } from "./serve-approvals-broker";
import {
  answerApproval,
  countPending,
  isApprovalId,
  listApprovals,
  readApproval,
  reconcileApprovals,
  toPublicApproval,
  type ApprovalView,
} from "./serve-approvals-store";
import { AuthFailureThrottle } from "./serve-throttle";
import { isServerFault, readTurnEvents, readTurnRecord } from "./serve-turn-store";
import {
  resolveProject,
  type SubmitOutcome,
  type TurnRequest,
  validateTurnRequest,
} from "./serve-turn";
import {
  isLoopbackAddress,
  serveConfigAdvice,
  type ServeConfig,
  type ServeConfigState,
} from "./serve-config";
import {
  readServeCredential,
  verifyServeToken,
  type ServeCredentialRecord,
  type ServeCredentialResult,
} from "./serve-credential";

/**
 * The largest request body accepted, enforced before parsing semantics.
 *
 * Declared HERE, in the transport, because it bounds an HTTP request body — a
 * framing artefact — and it is enforced twice in this file, against
 * `content-length` and against the byte length of the raw text. It used to live
 * in `serve-turn.ts` one line above `MAX_PROMPT_CHARS`, which is a genuine
 * domain bound on the prompt; the two read as a pair, which is how the framing
 * one ended up in the run module. The review that found it put it plainly: the
 * claim "no HTTP concept crosses inward" survived literally, and the direction
 * of travel was the one the claim exists to prevent.
 */
export const MAX_TURN_BODY_BYTES = 128 * 1024;

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
  /** The configuration names a policy profile this release does not implement. */
  | "unknown-profile"
  /**
   * The remote profile would grant something the local profile withholds.
   *
   * specification.md AC-04 and security-policy.md §"Remote policy profile":
   * "a resolution that would widen is a startup `refused`, not a warning and not
   * a downgrade". Terminal like every other refusal here — no socket is bound.
   */
  | "widening-profile"
  /** The address was acceptable but the kernel would not give us the socket. */
  | "bind-failed";

export interface ServeStartupOk {
  ok: true;
  config: ServeConfig;
  credential: ServeCredentialRecord;
  /** True when the bind address is reachable beyond loopback. */
  nonLoopback: boolean;
  /**
   * The RESOLVED remote profile, not the name.
   *
   * Returned rather than re-resolved by the caller, so there is exactly one
   * resolution per startup and no way for the profile a turn runs under to
   * differ from the one that was checked for widening.
   */
  profile: PolicyProfile;
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
  /**
   * What is actually on disk, when the caller knows.
   *
   * `config === null` covers three different situations — nothing configured, a
   * file that does not match the schema, and a file that could not be read —
   * and they need three different instructions. Without this the refusal said
   * "no serve configuration was found. Run `keryx serve config init`" for all
   * three, and after `config init` learned to refuse over an unreadable file
   * that instruction failed when followed. Defaults to `absent`, which is what
   * a caller that genuinely has no file passes.
   */
  configState?: ServeConfigState;
  /**
   * Overrides the local profile the remote one is compared against. Tests only.
   *
   * Every profile this release ships resolves at or below the local baseline, so
   * without this seam the widening branch has no reachable input and AC-04 would
   * be asserted against `compareProfiles` alone — a unit test standing in for
   * the startup refusal it is supposed to prove. The branch becomes reachable in
   * production the moment the baseline is tightened or a wider remote profile is
   * added, which is exactly when it must already have been proven.
   *
   * The production call sites pass nothing, and `serve-server.test.ts` holds a
   * source-level guard asserting that no non-test file supplies it — because a
   * seam that can lower the ceiling is a seam worth watching.
   */
  localBaseline?: () => PolicyProfile;
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
    // The message comes from `serveConfigAdvice`, which is the one place that
    // decides what to tell an operator about an unusable configuration. A
    // literal here is how two sites drifted into naming a command that refuses.
    return refuse("no-configuration", serveConfigAdvice(input.configState ?? "absent"));
  }
  if (!config.enabled) {
    // `config set`, not `config init`. This state is reachable ONLY when a
    // configuration exists, so `config init` refuses — and `--force` would make
    // the instruction succeed by resetting bind, port and profile.
    return refuse("disabled", serveConfigAdvice("valid"));
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
      //
      // The CONFIGURED address, not a `<addr>` placeholder. The placeholder made
      // this the one instruction the class guard could not execute verbatim —
      // `serve.recovery.test.ts` had to substitute an address before running it,
      // so the suite proved a command it wrote itself rather than the one the
      // operator is handed. The address is in hand here; printing it costs
      // nothing and makes the instruction copy-pasteable.
      `the configured bind address is reachable beyond loopback. Run \`keryx serve config set --bind ${config.bind.address} --acknowledge-non-loopback\` to acknowledge it explicitly; there is no TLS in this release.`,
    );
  }

  // The profile resolves LAST, and deliberately so. R4b carried the name and
  // resolved nothing, because nothing in that slice ran a turn; this slice runs
  // turns, so the name has to become a posture at startup — where a widening
  // resolution can still be refused, rather than being discovered by the first
  // request that gets more than it should.
  //
  // Placed after the checks that already existed rather than ahead of them. In a
  // configuration with two faults both refusals are terminal and neither is
  // unsafe, so the order decides only which one the operator is told about — and
  // quietly moving the non-loopback refusal, which has its own proven
  // instruction and its own test, is not a change this slice needs to make.
  const remoteProfile = resolveRemoteProfile(config.profile);
  if (remoteProfile === null) {
    return refuse(
      "unknown-profile",
      // Names the valid set: the operator has to type one of them, and an error
      // that says only "invalid" leaves them guessing. The set is schema
      // vocabulary, not operator data, so printing it discloses nothing.
      `profile "${config.profile}" is not implemented in this release; valid profiles are ${REMOTE_PROFILE_NAMES.join(", ")}. Run \`keryx serve config set --profile remote-restricted\``,
    );
  }
  const comparison = compareProfiles((input.localBaseline ?? localBaselineProfile)(), remoteProfile);
  if (!comparison.ok) {
    return refuse(
      "widening-profile",
      // The FIELDS that widen, not merely the fact. An operator told only "too
      // permissive" has to guess which of eight; the field names are schema
      // vocabulary and disclose nothing about the host.
      `profile "${config.profile}" would grant more than the local profile allows (${comparison.widened.join(", ")}). Run \`keryx serve config set --profile remote-restricted\``,
    );
  }

  return { ok: true, config, credential: credential.record, nonLoopback, profile: remoteProfile };
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
  /** Read from the approval store by the running listener; a CLI process reports 0. */
  pendingApprovals: number;
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
    pendingApprovals: 0,
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
  /**
   * Who is calling, for the failed-authentication throttle only.
   *
   * Resolved by the listener from the connection, never from a header. An
   * `X-Forwarded-For` would let a caller pick its own throttle bucket, which is
   * the same class of mistake as reading an origin out of a request body.
   */
  peer?: string;
  /**
   * The failed-authentication throttle (D4).
   *
   * Optional so every existing synthetic context keeps working unthrottled —
   * `handleServeRequest` is called directly by a large suite, and a required
   * field would have meant editing every one of those call sites into agreeing
   * with a control they are not testing.
   */
  throttle?: AuthFailureThrottle;
  /**
   * Submit a validated turn. Absent means this listener cannot execute one.
   *
   * Injected rather than assembled here, and for two reasons. The adapter
   * "depends inward" — no HTTP type may appear in a harness contract, and the
   * cleanest way to hold that is for this module to know nothing about
   * providers, models or run assembly. And the offline fake transport
   * specification.md §Testability requires is then a function rather than a
   * network fixture.
   */
  submitTurn?: (request: TurnRequest, project: string) => Promise<SubmitOutcome>;
  /**
   * The approval side (R4d). Absent, the approval routes still answer from the
   * store; only the consumer bookkeeping and the visibility filter are missing.
   */
  approvals?: ServeApprovalsRuntime;
  /**
   * The remote-control surface (flow 376). Absent, `/v1/remote/*` does not exist
   * for anyone and no shell token can authenticate.
   */
  remote?: ServeRemoteSurface;
  /** Turns off the transport's idle timeout for the current request (event streams). */
  untimed?: () => void;
}

export interface ServeApprovalsRuntime {
  /** Touched when a caller lists approvals, reads an event stream, or submits a streaming turn. */
  consumers: ApprovalConsumers;
  /** Wakes a waiting turn after an in-process answer. */
  wake: () => void;
  /** Whether this token may see the approval. Absent means every approval. */
  canSee?: (view: ApprovalView) => boolean;
}

/**
 * What a submission did. Re-exported, NOT re-declared.
 *
 * This was a second structural copy of `SubmitOutcome`, and the comment on the
 * original said so — "Mirrors `SubmitTurnOutcome` in `serve-server.ts`". The
 * round that removed a second copy of the rank tables and a third copy of the
 * comment stripper left the submission contract mirrored, and drift was caught
 * in one direction only: a variant added HERE grew a route branch no runner
 * could reach, with nothing to say so. `serve-turn.ts` imports nothing from this
 * module, so there was never a cycle preventing the single declaration.
 */
export type { SubmitOutcome as SubmitTurnOutcome } from "./serve-turn";

/**
 * The complete route surface, as a closed enumeration.
 *
 * Two shapes now: fixed paths, and the three turn routes that carry an id. The
 * id-bearing ones are matched by SEGMENT COUNT AND POSITION, never by prefix —
 * `.metaproject/memory/lessons/allowlist-not-a-boundary.md` is exactly a check
 * against a raw string standing in for a check against structure, and a
 * `startsWith("/v1/turns/")` here would match `/v1/turns/../../anything`.
 *
 * The id itself is validated by `isTurnId` before it can become a path; matching
 * only decides WHICH route, never whether the id is acceptable.
 */
const FIXED_ROUTES = new Set(["/v1/status", "/v1/projects", "/v1/turns", "/v1/approvals"]);

/**
 * The shell channel's routes (the SECOND route table, reachable by the local
 * shell token only). Every entry is one exact path `/v1/remote/<name>`; the id of
 * a session is never in the path, so there is nothing to prefix-match and
 * nothing a `..` could climb out of. The value is the one method the route takes.
 *
 * A Map, not an object: `Object.hasOwn`-style lookups on a plain object answer
 * for `constructor` and `__proto__`, which is a route table that is not closed.
 */
const REMOTE_ROUTES: ReadonlyMap<string, "GET" | "POST"> = new Map([
  ["register", "POST"],
  ["deregister", "POST"],
  ["heartbeat", "POST"],
  ["reply", "POST"],
  ["approval", "POST"],
  ["approval-result", "POST"],
  ["prompt", "POST"],
  ["state", "POST"],
  ["ack", "POST"],
  ["approval-ack", "POST"],
  ["stream", "GET"],
  // The channels plane (flow 377): connect Telegram, test it, disconnect it.
  ["channels-status", "GET"],
  ["channels-pair", "POST"],
  ["channels-pairing", "GET"],
  ["channels-cancel", "POST"],
  ["channels-reload", "POST"],
  ["channels-test", "POST"],
  ["channels-disconnect", "POST"],
]);

export type RemoteRouteName =
  | "register"
  | "deregister"
  | "heartbeat"
  | "reply"
  | "approval"
  | "approval-result"
  | "prompt"
  | "state"
  | "ack"
  | "approval-ack"
  | "stream"
  | "channels-status"
  | "channels-pair"
  | "channels-pairing"
  | "channels-cancel"
  | "channels-reload"
  | "channels-test"
  | "channels-disconnect";

/**
 * What the listener needs from the remote-control side. A structural interface
 * declared HERE so `lib` never imports `src/remote` (the dependency points the
 * other way: `src/remote` implements it and `commands/serve.ts` composes).
 */
export interface ServeRemoteSurface {
  /** Constant-time check of a presented bearer value against the local shell token. */
  verifyShellToken(presented: string): boolean;
  /**
   * Handle one authenticated, loopback, method-checked remote request. Owns body
   * limits and id validation. `untimed` asks the transport not to idle-close a
   * long-lived response (the event stream).
   */
  handle(route: RemoteRouteName, request: Request, io: { untimed: () => void }): Promise<Response>;
  /** End every open stream; called before the listener closes. */
  close?(): Promise<void> | void;
}

type RouteMatch =
  | { route: "fixed"; pathname: string }
  | { route: "remote"; name: RemoteRouteName }
  | { route: "approval"; approvalId: string }
  | { route: "turn"; turnId: string }
  | { route: "turn-events"; turnId: string }
  | { route: "none" };

function matchRoute(pathname: string): RouteMatch {
  if (FIXED_ROUTES.has(pathname)) {
    return { route: "fixed", pathname };
  }
  const segments = pathname.split("/");
  // ["", "v1", "remote", "<name>"] — the name must be one of the closed table above.
  if (segments.length === 4 && segments[1] === "v1" && segments[2] === "remote" && REMOTE_ROUTES.has(segments[3] ?? "")) {
    return { route: "remote", name: segments[3] as RemoteRouteName };
  }
  // ["", "v1", "turns", "<id>"] and ["", "v1", "turns", "<id>", "events"].
  if (segments.length === 4 && segments[1] === "v1" && segments[2] === "turns") {
    return { route: "turn", turnId: segments[3] ?? "" };
  }
  if (segments.length === 4 && segments[1] === "v1" && segments[2] === "approvals") {
    return { route: "approval", approvalId: segments[3] ?? "" };
  }
  if (segments.length === 5 && segments[1] === "v1" && segments[2] === "turns" && segments[4] === "events") {
    return { route: "turn-events", turnId: segments[3] ?? "" };
  }
  return { route: "none" };
}

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
 * `POST /v1/turns` — the only route that can cause agent execution.
 *
 * The order below is `security-policy.md` §"Required decision path", steps 1
 * and 3 through 6. Step 2 (authentication) already ran in the caller, before
 * the URL was parsed. The order is the control: the same checks in a different
 * sequence is a finding, which is why each one says what it is.
 */
async function submitTurn(request: Request, ctx: ServeContext): Promise<Response> {
  // (1) Bound the body and the content type BEFORE parsing semantics. A
  // declared length beyond the bound is refused without reading the body at
  // all, so an oversized request costs nothing to refuse.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_TURN_BODY_BYTES) {
    return errorResponse(413, "too-large", "The request body exceeds the configured bound.");
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(400, "invalid-request", "Content-Type must be application/json.");
  }

  const raw = await request.text();
  // Checked again against the ACTUAL bytes: a chunked request declares no
  // length, so the header check above is an optimisation and this is the bound.
  if (Buffer.byteLength(raw, "utf8") > MAX_TURN_BODY_BYTES) {
    return errorResponse(413, "too-large", "The request body exceeds the configured bound.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "invalid-request", "The request body is not valid JSON.");
  }

  const validated = validateTurnRequest(parsed);
  if (!validated.ok) {
    return errorResponse(validated.problem.status, validated.problem.code, validated.problem.message);
  }

  // (4) Resolve the session identity-first from the declared project. Never
  // infer. An unknown project fails rather than falling back to "the obvious
  // one" — the failure mode that made helyx cross-link transports between
  // projects.
  const project = resolveProject(validated.request.project, ctx.dir);
  if (!project.ok) {
    return errorResponse(404, project.code, project.message);
  }

  const submit = ctx.submitTurn;
  if (submit === undefined) {
    // No runner wired. A 503 rather than a 500: the surface is up and the
    // request was well-formed; this install simply cannot execute a turn.
    return errorResponse(503, "unavailable", "Turn execution is not available on this listener.");
  }

  if (validated.request.stream === true) {
    ctx.approvals?.consumers.touch();
  }
  const outcome = await submit(validated.request, project.project);
  if (outcome.kind === "duplicate") {
    // (AC7) A repeated idempotency key returns the ORIGINAL turnId and starts
    // nothing. 200 rather than 202: nothing was accepted, because nothing new
    // happened.
    return new Response(
      `${JSON.stringify({ schemaVersion: "1.0.0", turnId: outcome.turnId, sessionId: outcome.sessionId, duplicate: true }, null, 2)}\n`,
      { status: 200, headers: JSON_HEADERS },
    );
  }
  if (outcome.kind === "rejected") {
    // (5) The prompt was rejected by the security scan. The body states that it
    // was rejected and NOTHING about what matched — naming the detector or the
    // matched span would turn this route into an oracle for the scanner.
    return errorResponse(422, "prompt-rejected", "The prompt was rejected.");
  }
  if (outcome.kind === "unavailable") {
    // The idempotency key names a turn whose record this process cannot read.
    // Answered as a server failure rather than as a duplicate, because the
    // duplicate answer would have to carry a session id it does not have — and
    // `sessionId: ""` on a 200 is a null record standing in for a stated
    // failure, on the one path that reaches a success status. The reason is not
    // echoed, for the same reason no other 500 on this surface echoes one.
    return errorResponse(500, "record-unreadable", "The durable record for this turn could not be read.");
  }

  // 202: accepted. api-protocol.md is explicit that "an accepted turn is not a
  // permitted turn" — classification happens inside the run loop and the turn
  // may still terminate in a denial, which the result will say.
  return new Response(
    `${JSON.stringify({ schemaVersion: "1.0.0", turnId: outcome.turnId, sessionId: outcome.sessionId }, null, 2)}\n`,
    { status: 202, headers: JSON_HEADERS },
  );
}


const MAX_APPROVAL_LIST = 50;
const MAX_ANSWER_BODY_BYTES = 1024;

/** The one 404 for an id that does not exist, is not an id, or is not the caller's to see. */
function approvalNotFound(): Response {
  return errorResponse(404, "not-found", "Not found.");
}

function visibleTo(ctx: ServeContext, view: ApprovalView): boolean {
  return ctx.approvals?.canSee === undefined || ctx.approvals.canSee(view);
}

/**
 * `GET /v1/approvals` — pending approvals the token may see.
 *
 * Reading this is what counts as a consumer being attached. `?state=all` adds the
 * most recent resolved ones, bounded.
 */
function listApprovalsRoute(request: Request, ctx: ServeContext): Response {
  ctx.approvals?.consumers.touch();
  const includeResolved = new URL(request.url).searchParams.get("state") === "all";
  const visible = listApprovals(ctx.dir, { now: new Date() }).filter(
    (view) => visibleTo(ctx, view) && (includeResolved || view.state === "pending"),
  );
  const bounded = visible.slice(-MAX_APPROVAL_LIST).map(toPublicApproval);
  return new Response(`${JSON.stringify({ schemaVersion: "1.0.0", approvals: bounded }, null, 2)}\n`, {
    headers: JSON_HEADERS,
  });
}

/**
 * `POST /v1/approvals/{id}` — answer exactly one approval.
 *
 * Order is the control. Id shape and body are checked before anything is read from
 * the store, so a malformed request changes no state; visibility comes before the
 * self-grant check so a caller cannot use the 403 to learn that an id exists.
 */
async function answerApprovalRoute(request: Request, approvalId: string, ctx: ServeContext): Promise<Response> {
  if (!isApprovalId(approvalId)) {
    return approvalNotFound();
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BODY_BYTES) {
    return errorResponse(413, "too-large", "The request body exceeds the configured bound.");
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return errorResponse(400, "invalid-request", "Content-Type must be application/json.");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_ANSWER_BODY_BYTES) {
    return errorResponse(413, "too-large", "The request body exceeds the configured bound.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "invalid-request", "The request body is not valid JSON.");
  }
  // Exactly {decision}. An extra field is refused rather than ignored: it is how a
  // caller would ask for a session grant or different arguments, and an answer is
  // never either.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    ((parsed as Record<string, unknown>).decision !== "allow" && (parsed as Record<string, unknown>).decision !== "deny")
  ) {
    return errorResponse(400, "invalid-request", 'The body must be exactly {"decision":"allow"|"deny"}.');
  }
  const decision = (parsed as { decision: "allow" | "deny" }).decision;

  const found = readApproval(approvalId, ctx.dir);
  if (!found.ok || !visibleTo(ctx, found.value)) {
    return approvalNotFound();
  }
  // A turn that raised the approval declares itself; it may not answer it. The
  // token is one credential, so this cannot stop a caller that lies about who it
  // is: the turn's own tools hold no token, and that is what keeps the rule true.
  if (request.headers.get("x-keryx-turn") === found.value.turnId) {
    return errorResponse(403, "forbidden", "A turn cannot answer an approval it raised.");
  }

  const outcome = answerApproval(approvalId, decision, "remote-token", ctx.dir);
  if (outcome.kind === "not-found") {
    return approvalNotFound();
  }
  if (outcome.kind === "expired") {
    return errorResponse(410, "expired", "The approval expired and was denied.");
  }
  if (outcome.kind === "applied") {
    ctx.approvals?.wake();
  }
  return new Response(
    `${JSON.stringify(
      { schemaVersion: "1.0.0", approvalId, state: outcome.view.state, replay: outcome.kind === "replay" },
      null,
      2,
    )}\n`,
    { headers: JSON_HEADERS },
  );
}

/**
 * `GET /v1/turns/{turnId}/events` — server-sent events, replayed from the record.
 *
 * There is no live-pipe path and no separate replay path. Every caller reads the
 * durable record from a cursor, which is what makes "re-attachment never
 * re-executes anything" true by construction rather than by discipline: this
 * function cannot run a turn, because reading a file is all it does.
 *
 * `Last-Event-ID` is the standard SSE resume header and carries the `seq` of the
 * last event the client saw. Absent, the stream starts from the beginning.
 */
function streamTurnEvents(request: Request, turnId: string, ctx: ServeContext): Response {
  const header = request.headers.get("last-event-id");
  const parsed = header === null ? Number.NaN : Number(header);
  // A malformed cursor replays from the beginning rather than being refused.
  // The client asking for a resume it cannot express correctly is better served
  // by too much history than by an error it cannot act on — and a duplicate
  // event is harmless here, because events carry no side effect.
  const after = Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;

  ctx.approvals?.consumers.touch();
  const events = readTurnEvents(turnId, after, ctx.dir);
  if (!events.ok) {
    // 500, and the line below says so. This comment opened with "200 with an
    // empty body" and a reviewer read the first clause as a description of the
    // current behaviour and filed it as a live defect — a false finding that
    // cost a round to disprove, from prose that was accurate and badly ordered.
    //
    // What it means: answering 200 with an empty body would be the silent
    // truncation §Bounds forbids, telling a caller the turn produced nothing
    // when the truth is that this process could not read the record. That WAS
    // the behaviour, past roughly 6 500 events, and it is why the bound the
    // store reads at is now its own.
    return errorResponse(500, "record-unreadable", "The durable record for this turn could not be read.");
  }
  const body = events.value.map((event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`).join("");

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // A replayed stream must not be cached by anything between here and the
      // client: a cached event stream is a client stuck at a cursor forever.
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

/**
 * The whole request surface.
 *
 * Exported separately from the listener so every response can be asserted
 * without binding a socket, and so the listener and the tests exercise the same
 * function rather than two implementations of the same rules.
 */
export async function handleServeRequest(request: Request, ctx: ServeContext): Promise<Response> {
  // The error boundary, outermost. Every writer this surface reaches is
  // documented as propagating what the write throws — EACCES, ENOSPC, EROFS —
  // and there was nothing between them and Bun's default handler, which renders
  // the message and the stack into the response body. That body carries the
  // absolute home-directory path this very surface was hardened to stop
  // disclosing on the projects route.
  //
  // Nothing from the error reaches the caller. Not the message, not the code,
  // not a correlation id — this release has no log to correlate against, and an
  // id nobody can look up is a string that only tells an attacker that
  // something specific went wrong.
  try {
    return await routeServeRequest(request, ctx);
  } catch (cause) {
    return internalErrorResponse(cause);
  }
}

/**
 * The one answer to "something in this process broke while handling a request".
 *
 * Two boundaries reach it and they must not drift: this function's caller above
 * catches what the handler throws, and the `error` hook on `Bun.serve` catches
 * what escapes the handler — a rejection raised while the response is being
 * produced, or anything Bun itself raises. They were byte-identical copies, and
 * only one of them had a test.
 *
 * Nothing from the error reaches the CALLER. Not the message, not the code, not
 * a correlation id — this release has no log to correlate against, and an id
 * nobody can look up is a string that only tells an attacker that something
 * specific went wrong. Through `errorResponse`, so the body is the same
 * `{error: {code, message}}` document as every other error on this surface; a
 * hand-rolled shape
 * here meant a client reading `error.code` got `undefined` on the one response
 * class that means the server broke.
 *
 * The operator is a different audience: this is their own process, on their own
 * terminal, and the fault class — a throwing writer — is one that can burn an
 * idempotency key and strand a durable record with no other signal anywhere.
 */
export function internalErrorResponse(cause: unknown): Response {
  console.error(`keryx serve: request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  return errorResponse(500, "internal-error", "The request could not be completed.");
}

async function routeServeRequest(request: Request, ctx: ServeContext): Promise<Response> {
  // (1) Authenticate FIRST. The URL is not even parsed until this passes, so
  // there is no branch on it that could differ for an unauthenticated caller.
  //
  // The throttle is consulted only on the FAILURE path, and that order is the
  // control rather than an implementation detail: security-policy.md requires
  // that an authenticated caller is never throttled, and a throttle checked
  // before authentication would refuse the operator's own valid token because
  // someone else had been guessing from the same address. There is no code path
  // from a successful verification into the throttle at all.
  //
  // Both secrets are always checked, in the same order, whichever one the caller
  // holds, so which principal answered is not visible in the work done. A
  // listener without a remote surface has no second secret and checks only the
  // first, exactly as before.
  const presented = bearerToken(request);
  const credential = ctx.resolveCredential();
  const isServeCaller = credential.status === "ok" && verifyServeToken(presented, credential.record);
  const isShellCaller = ctx.remote !== undefined && ctx.remote.verifyShellToken(presented) && !isServeCaller;
  if (!isServeCaller && !isShellCaller) {
    const peer = ctx.peer;
    if (ctx.throttle !== undefined && peer !== undefined) {
      // Already serving a cooldown: refuse WITHOUT recording, so a client
      // retrying in a loop cannot extend its own ban indefinitely and the
      // cooldown stays a cooldown.
      const standing = ctx.throttle.check(peer);
      const verdict = standing.throttled ? standing : ctx.throttle.recordFailure(peer);
      if (verdict.throttled) {
        return errorResponse(429, "too-many-requests", "Too many requests.", {
          "retry-after": String(verdict.retryAfterSeconds ?? 60),
        });
      }
    }
    return unauthorized();
  }

  // (2) A draining server accepts no new request. After authentication, so the
  // 503 is not an oracle for a stranger.
  //
  // Reachable now: `POST /v1/turns` does asynchronous work, so the window
  // between the state flip in `drain()` and the close is no longer empty. R4b's
  // comment here recorded it as unreachable-but-correct; this slice is the one
  // that made it reachable.
  if (ctx.state() === "draining") {
    return errorResponse(503, "draining", "The server is draining.");
  }

  const pathname = new URL(request.url).pathname;
  const matched = matchRoute(pathname);

  // The shell principal has its own table and no other. Anything outside it —
  // including every route the serve credential reaches — answers the ordinary
  // 404, before the method is looked at, so the answer does not say which of
  // those paths exist. A shell caller must also have connected over loopback,
  // judged from the connection (`ctx.peer`), never from a header.
  if (isShellCaller) {
    if (matched.route !== "remote" || ctx.remote === undefined) {
      return errorResponse(404, "not-found", "Not found.");
    }
    if (ctx.peer === undefined || !isLoopbackAddress(ctx.peer)) {
      return unauthorized();
    }
    if (request.method !== REMOTE_ROUTES.get(matched.name)) {
      return errorResponse(405, "method-not-allowed", "Method not allowed.", { allow: REMOTE_ROUTES.get(matched.name) ?? "POST" });
    }
    return ctx.remote.handle(matched.name, request, { untimed: ctx.untimed ?? (() => undefined) });
  }
  // The serve credential has no remote routes: they are not in its table.
  if (matched.route === "none" || matched.route === "remote") {
    return errorResponse(404, "not-found", "Not found.");
  }

  // `POST /v1/turns` is the one route that is not a GET. Method checking stays
  // per-route rather than a single "GET or 405", because a surface with one
  // mutating route and five read routes must not answer 405 for the mutating one
  // and must not accept POST on the reads.
  if (matched.route === "fixed" && pathname === "/v1/turns") {
    if (request.method !== "POST") {
      return errorResponse(405, "method-not-allowed", "Method not allowed.", { allow: "POST" });
    }
    return submitTurn(request, ctx);
  }
  if (matched.route === "approval") {
    if (request.method !== "POST") {
      return errorResponse(405, "method-not-allowed", "Method not allowed.", { allow: "POST" });
    }
    return answerApprovalRoute(request, matched.approvalId, ctx);
  }
  if (request.method !== "GET") {
    return errorResponse(405, "method-not-allowed", "Method not allowed.", { allow: "GET" });
  }

  if (pathname === "/v1/approvals") {
    return listApprovalsRoute(request, ctx);
  }

  if (matched.route === "turn" || matched.route === "turn-events") {
    // The id is constrained BEFORE it becomes a path, and an unknown turn and a
    // malformed one answer identically: api-protocol.md requires a 404 for an
    // unknown id and a 403 for one the token may not reach to be
    // indistinguishable, and the same reasoning covers "not an id at all".
    const record = readTurnRecord(matched.turnId, ctx.dir);
    if (!record.ok) {
      // "There is no such turn" and "I could not read the turn there is" are
      // different answers and used to be the same one: an oversized `turn.json`
      // 404'd for a turn that existed.
      //
      // Which reason means which is `isServerFault`'s to decide, not this
      // route's. Enumerating them here is what let `not-regular` — a `turn.json`
      // that is a directory or a symlink — answer "Not found" while every other
      // reader of the same taxonomy called it a failure.
      if (isServerFault(record.reason)) {
        return errorResponse(500, "record-unreadable", "The durable record for this turn could not be read.");
      }
      return errorResponse(404, "not-found", "Not found.");
    }
    if (matched.route === "turn-events") {
      return streamTurnEvents(request, matched.turnId, ctx);
    }
    if (record.value.result === undefined) {
      // Accepted and running. api-protocol.md: the terminal result is
      // "available after the turn reaches a terminal state".
      return errorResponse(409, "turn-in-progress", "The turn has not reached a terminal state.");
    }
    return new Response(`${JSON.stringify(record.value.result, null, 2)}\n`, { headers: JSON_HEADERS });
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
          pendingApprovals: countPending(ctx.dir, undefined, new Date()),
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
  /**
   * The remote-control surface, or absent. Absent is a plain `keryx serve`: no
   * shell token can authenticate and `/v1/remote/*` answers 404. Passed in by
   * the composition root, never imported here (see `ServeRemoteSurface`).
   */
  remote?: ServeRemoteSurface | undefined;
  /**
   * How the turn runner is assembled for this listener.
   *
   * REQUIRED, and that is the fix rather than an inconvenience. `submitTurn` was
   * an optional field on `ServeContext` that production simply never set:
   * `createSubmitTurn` had zero production callers, so a `keryx serve` the CLI
   * could start answered every submission with 503 — while nine of the twelve
   * criteria that were supposed to prove otherwise had been verified through
   * `handleServeRequest` with a runner the test fixture injected. Optional plus
   * a caller who forgets is indistinguishable from absent.
   *
   * It stays a parameter rather than becoming an import because of the
   * dependency direction this module holds: no provider, model or run-assembly
   * concept appears here, and none may. `serve-runner.ts` owns the assembly and
   * `commands/serve.ts` is the composition root that passes it. What changed is
   * that omitting it no longer typechecks.
   */
  makeSubmitTurn: (
    profile: PolicyProfile,
    dir: string | undefined,
    runtime?: ServeRuntime,
  ) => (request: TurnRequest, project: string) => Promise<SubmitOutcome>;
}

/** What the listener hands to the runner, plus the runner's own test seam. */
export interface ServeRuntime {
  /** The approval broker of this process. Absent, an `ask` stays the release-boundary deny. */
  approvals?: ApprovalBroker;
  /** TESTS ONLY. See `assembleSubmitTurn`. */
  containmentAvailable?: () => boolean;
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

  // One throttle per listener. Its lifetime is the process's, so a restart
  // clears every cooldown — which is correct: a restart is an operator action,
  // and persisting a ban across one would mean an operator could lock themselves
  // out of a server they control by fixing it and turning it back on.
  const throttle = new AuthFailureThrottle();

  // The runner, assembled here rather than left to the caller. `startup.profile`
  // is the profile the startup path already resolved and compared against the
  // local baseline, so the listener cannot run turns under a profile that was
  // never checked.
  //
  const consumers = createConsumerRegistry();
  const approvals = createApprovalBroker({
    dir: input.dir,
    expirySeconds: startup.config.approval.expirySeconds,
    maxPending: startup.config.approval.maxPendingPerSession,
    requireConsumer: startup.config.approval.requireConsumer ?? true,
    hasConsumer: () => consumers.attached(),
  });
  const submitTurn = input.makeSubmitTurn(startup.profile, input.dir, { approvals });

  let server: Server<undefined>;
  try {
    server = Bun.serve({
      hostname,
      port: startup.config.bind.port,
      fetch: (request, self) =>
        handleServeRequest(request, {
          config: startup.config,
          // Re-read on every request so `token revoke` and `token rotate` reach
          // a listener that is already running.
          resolveCredential: () => readServeCredential(input.dir),
          nonLoopback: startup.nonLoopback,
          boundPort,
          dir: input.dir,
          state: () => state,
          // From the CONNECTION, never from a header. `X-Forwarded-For` would
          // let a caller choose its own throttle bucket, which is the same
          // mistake as reading an origin out of a request body.
          peer: self.requestIP(request)?.address ?? "unknown",
          throttle,
          submitTurn,
          approvals: { consumers, wake: () => approvals.wake() },
          ...(input.remote === undefined ? {} : { remote: input.remote }),
          // A stream outlives Bun's idle timeout; the remote surface opts the one
          // request out of it, not the listener.
          untimed: () => self.timeout(request, 0),
        }),
      // The second half of the boundary, and the SAME function as the first.
      // Without it, Bun's default error page answers, carrying the message and
      // the stack. It was a byte-identical copy of the handler's own catch and
      // nothing tested it, so the two could drift apart with the suite green —
      // which is how the previous drift happened, one of them emitting
      // `{schemaVersion, error, message}` against api-protocol.md's
      // `{error: {code, message}}`.
      error: internalErrorResponse,
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

  // Approvals (R4d): a pending record whose turn is not running in THIS process is
  // resolved as an expired deny, and its call is never re-executed. Only after a
  // successful bind: a second `keryx serve` that fails to bind must not settle the
  // records of the listener that is running. Nothing is awaited between the bind and
  // here, so no request has been handled yet and every pending record qualifies.
  try {
    reconcileApprovals(input.dir, { isTurnLive: () => false });
  } catch (error) {
    console.error(`keryx serve: approval reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
        // Streams are closed first: `stop(true)` would drop them anyway, but the
        // remote surface must settle what it holds (pending acks, approvals).
        try {
          await input.remote?.close?.();
        } catch (error) {
          console.error(`keryx serve: remote surface did not close cleanly: ${error instanceof Error ? error.message : String(error)}`);
        }
        await server.stop(true);
        state = "stopped";
      },
    },
  };
}
