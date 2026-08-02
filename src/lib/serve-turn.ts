// Turn submission: validate, refuse, or run (flow 131 / R4c).
//
// The order below is `security-policy.md` §"Required decision path", and it is
// the order rather than the set that is the control — the same nine checks in a
// different sequence is a finding. Steps 1 and 2 (body bound, authentication)
// live in `serve-server.ts`, because they happen before a body is parsed at all.
// This module owns 3 through 6, and hands 7 to the harness unchanged.
//
// What this module deliberately does NOT do:
//
//   * classify anything. The policy engine decides `allow`/`ask`/`deny`; a
//     transport that reclassifies is a second policy engine, and the two
//     disagree the first time either changes.
//   * present an `ask` as approvable. Approvals are R4d. Here an `ask`
//     terminates in a recorded denial — written as a stated boundary rather
//     than emerging from there being no approval store, because an accident
//     stops holding the moment the store lands.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "../harness/config";
import type { PolicyDecision, PolicyProfile } from "../harness/policy/types";
import type { NormalizedEvent, ProviderPort } from "../harness/provider/types";
import { type HarnessRunOutput, runOffline, type RunDeps } from "../harness/run/run";
import { ToolRegistry } from "../harness/tool/registry";
import type { ToolExecutorPort, ToolInvocation, ToolResult } from "../harness/tool/types";
import type { HarnessRunInput } from "../harness/types";
import { createSecurityService } from "../security/service";
import type { SecurityService } from "../security/types";
import { listProjects } from "./project-registry";
import {
  appendTurnEvent,
  claimIdempotencyKey,
  createTurnRecord,
  finishTurn,
  readTurnRecord,
  releaseIdempotencyKey,
  type StreamEvent,
  type StreamEventKind,
  type TurnReadFailure,
  type TurnResult,
} from "./serve-turn-store";

/**
 * The origin this release stamps.
 *
 * `turn-result.schema.json` pins the shape to `local-tty | remote:<slug>`.
 * Assigned here from the fact that the request arrived over HTTP — never read
 * from content, which is why `origin` is not a field of the request type below
 * and is REFUSED by validation rather than accepted and overwritten. Accepting
 * and overwriting would mean a body claiming `local-tty` is a body the server
 * parsed and then chose to ignore; refusing means it was never a legal request.
 */
export const REMOTE_ORIGIN = "remote:http";

/** The largest prompt accepted. Separate bound, separate status code (413). */
export const MAX_PROMPT_CHARS = 32_000;

export interface TurnRequest {
  schemaVersion: "1.0.0";
  project: string;
  sessionId?: string;
  prompt: string;
  stream?: boolean;
  idempotencyKey?: string;
}

export type TurnRequestProblem =
  | { status: 400; code: "invalid-request"; message: string }
  | { status: 413; code: "too-large"; message: string };

export type TurnRequestOutcome = { ok: true; request: TurnRequest } | { ok: false; problem: TurnRequestProblem };

/** Every field `turn-request.schema.json` declares. Anything else is refused. */
const ALLOWED_FIELDS = new Set(["schemaVersion", "project", "sessionId", "prompt", "stream", "idempotencyKey"]);

/**
 * Validate a parsed body against `turn-request.schema.json`.
 *
 * Closed: an unknown property is a `400`, not an ignored extra. The schema says
 * `additionalProperties: false` and it says so for one field in particular —
 * `origin` is "deliberately absent: it is stamped by the server from the
 * authenticated connection and can never be supplied by a caller". A validator
 * that ignored unknown keys would accept a body claiming an origin and merely
 * fail to read it, which is a weaker property and a harder one to test.
 */
export function validateTurnRequest(body: unknown): TurnRequestOutcome {
  const problem = (message: string): TurnRequestOutcome => ({
    ok: false,
    problem: { status: 400, code: "invalid-request", message },
  });

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return problem("The request body must be a JSON object.");
  }
  const value = body as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) {
      // Named, because the caller has to fix it and the field NAME is their own
      // input echoed back — but only the name, only when it is short enough to
      // be a field name rather than a payload, and only over an ALLOWLISTED
      // alphabet.
      //
      // The length bound alone was not enough. `JSON.stringify` does not escape
      // `<`, `/` or `>`, so this was the one unbounded-alphabet reflection on
      // the surface: a key of `</script><b>` came back verbatim in the body.
      // Not an XSS here — the content type is `application/json` and the value
      // is the caller's own input — but any transport that renders an error
      // body into HTML inherits it, and there is no reason a JSON field name
      // needs a character outside this set.
      return problem(`Unknown field: ${describeFieldName(key)}.`);
    }
  }
  if (value.schemaVersion !== "1.0.0") {
    return problem('Field "schemaVersion" must be "1.0.0".');
  }
  if (typeof value.project !== "string" || value.project.length === 0) {
    return problem('Field "project" is required and must be a non-empty string.');
  }
  if (typeof value.prompt !== "string" || value.prompt.length === 0) {
    return problem('Field "prompt" is required and must be a non-empty string.');
  }
  if (value.prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      problem: { status: 413, code: "too-large", message: "The prompt exceeds the configured bound." },
    };
  }
  if (value.sessionId !== undefined && !isUuid(value.sessionId)) {
    return problem('Field "sessionId" must be a uuid.');
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    return problem('Field "stream" must be a boolean.');
  }
  if (
    value.idempotencyKey !== undefined &&
    (typeof value.idempotencyKey !== "string" ||
      value.idempotencyKey.length === 0 ||
      value.idempotencyKey.length > 200)
  ) {
    return problem('Field "idempotencyKey" must be a string of 1..200 characters.');
  }

  const request: TurnRequest = {
    schemaVersion: "1.0.0",
    project: value.project,
    prompt: value.prompt,
  };
  if (typeof value.sessionId === "string") {
    request.sessionId = value.sessionId;
  }
  if (typeof value.stream === "boolean") {
    request.stream = value.stream;
  }
  if (typeof value.idempotencyKey === "string") {
    request.idempotencyKey = value.idempotencyKey;
  }
  return { ok: true, request };
}

/** A field name as it may be echoed: allowlisted alphabet, bounded length. */
function describeFieldName(key: string): string {
  if (key.length > 64) {
    return "(oversized)";
  }
  return /^[A-Za-z0-9_$-]+$/.test(key) ? key : "(unprintable)";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

// ---------------------------------------------------------------------------
// Session addressing (spec AC-11)
// ---------------------------------------------------------------------------

export type ProjectResolution =
  | { ok: true; project: string }
  | { ok: false; code: "unknown-project"; message: string };

/**
 * Resolve the declared project against the user-global registry. Exact match.
 *
 * IDENTITY-FIRST, and every part of that is load-bearing. The caller declares
 * the project it means; the server finds the registration whose path matches
 * exactly; there is no fallback. Not to the only registered project, not to the
 * most recently used one, not to the one whose session is idle.
 *
 * helyx shipped timing-based pairing first and had to replace it after
 * transports cross-linked between projects under concurrent sessions — a bug
 * whose symptom is one project's prompt running under another project's profile.
 * That is the whole reason this function refuses rather than guesses.
 *
 * The comparison is on the RESOLVED path, so `/tmp/p` and `/tmp/./p` are the
 * same project, while a path that does not resolve to a registration is
 * unknown even if it is a prefix or a child of one.
 */
export function resolveProject(declared: string, dir?: string): ProjectResolution {
  const wanted = path.resolve(declared);
  for (const entry of listProjects(dir, () => {})) {
    if (path.resolve(entry.path) === wanted) {
      return { ok: true, project: entry.path };
    }
  }
  return {
    ok: false,
    code: "unknown-project",
    // Says nothing about which projects DO exist: api-protocol.md requires an
    // unknown session and an unreachable one to be indistinguishable, and the
    // same reasoning applies to projects.
    message: "The declared project is not registered on this install.",
  };
}

// ---------------------------------------------------------------------------
// Running the turn
// ---------------------------------------------------------------------------

export interface RunTurnInput {
  request: TurnRequest;
  /**
   * Where the security scanner is rooted. The INSTALL, never the declared
   * project — see `scanPrompt`.
   */
  scanRoot: string;
  /** The resolved absolute project path — already checked against the registry. */
  project: string;
  /** The resolved remote profile from startup. Never re-resolved here. */
  profile: PolicyProfile;
  provider: ProviderPort;
  providerName: string;
  model: string;
  /** Overrides the user-global config directory. */
  dir?: string | undefined;
  clock?: () => string;
  /**
   * The turn's own id, when the caller already minted one.
   *
   * Separate from `newId` deliberately. `createSubmitTurn` mints the turn id
   * before the run so it can claim the idempotency key against it, and it used
   * to hand that id back as `newId: () => turnId` — a CONSTANT seam. Every id
   * minted through the seam then collided: the session id and the approval id
   * were the turn id, and the 202 reported a `sessionId` that was really the
   * turnId. The test asserted both were uuid-shaped and never that they differ.
   */
  turnId?: string;
  /**
   * Called once, immediately before the provider can be invoked.
   *
   * The boundary between "this turn did nothing" and "this turn had an effect".
   * `createSubmitTurn` releases the idempotency claim only for failures on the
   * near side of it — see the catch there for what happened when it released
   * for all of them.
   */
  onEffect?: () => void;
  /** Injected so a test can pin ids; production mints uuids. */
  newId?: () => string;
  /**
   * Whether OS containment can be applied on this host.
   *
   * Injected rather than probed here so the refusal is testable without an
   * unavailable launcher, and so this module has no opinion about how
   * containment is detected — that belongs with the sandbox.
   */
  containmentAvailable?: () => boolean;
  /**
   * The tools a remote turn may call. EMPTY by default, and that is the whole
   * posture of this slice: a remote turn that registers no tools cannot execute
   * one, so the `denyingExecutor` below is a floor rather than a control.
   *
   * Injected so the `ask` path has a reachable input under test — without a
   * registered tool the run produces no policy decision at all, and AC5 would
   * be a claim about a branch nothing can enter.
   */
  toolRegistry?: ToolRegistry;
}

/**
 * The terminal result could not be written to the durable record.
 *
 * Typed rather than a bare `Error` so a caller CAN tell it from a filesystem
 * throw. None does: `createSubmitTurn` catches every throw the same way, and
 * the round that introduced this class said in this docstring that it already
 * discriminated. It did not, and writing down a discrimination nobody performs
 * is how the next reader concludes the 500 path distinguishes two faults that
 * it answers identically.
 *
 * The type earns its place anyway — `terminate` throwing on a failed write is
 * how the boolean from `finishTurn` stopped being discarded, and a named class
 * is what makes that legible at the throw site — but the branch is hypothetical
 * until something branches.
 *
 * Carries the turn id and nothing else: the message reaches no response body —
 * the route answers a bare 500 — but a turn id in an exception that might one
 * day be logged is the operator's own identifier, not caller data.
 */
export class TurnRecordUnwritableError extends Error {
  constructor(readonly turnId: string) {
    super(`the durable record for turn ${turnId} could not be written`);
    this.name = "TurnRecordUnwritableError";
  }
}

export interface RunTurnOutput {
  turnId: string;
  sessionId: string;
  result: TurnResult;
}

/** A tool executor that refuses. Remote turns register no tools in this slice. */
const denyingExecutor: ToolExecutorPort = {
  invoke: async (invocation: ToolInvocation): Promise<ToolResult> => {
    throw new Error(`no tool executor is configured for a remote turn: ${invocation.call.toolName}`);
  },
};

/**
 * Scan a prompt as untrusted content.
 *
 * TWO scoping decisions, and the AC10 inventory assertion forced both.
 *
 * `redact`, not `check`. `check` routes through `analyze`, which persists
 * incident state and a security-state file. `redact` runs the same detectors and
 * resolves the same decision without persisting a report.
 *
 * And `scanRoot` is the INSTALL directory, not the declared project. `redact`
 * still needs an HMAC key to hash finding values, and it creates one under
 * `<root>/.metaproject/data/security/` on first use — so scanning against the
 * project wrote into the project, which spec AC-14/15 forbid of every route on
 * this surface. The inventory assertion caught it.
 *
 * Scoping to the install is also the better answer on its own terms: the prompt
 * is untrusted content arriving at the INSTALL boundary, not project content. If
 * the scan were project-scoped, a remote caller would choose which project's
 * security configuration governs the scan of their own prompt by naming that
 * project — so the laxest configuration on the machine would decide. One
 * install, one scanning policy, chosen by the operator rather than by the
 * caller.
 */
export async function scanPrompt(scanRoot: string, prompt: string): Promise<{ rejected: boolean }> {
  try {
    // `untrusted-external` is the source vocabulary's name for exactly this:
    // content that arrived from outside the operator's own machine.
    const { findings } = await createSecurityService(scanRoot).redact(prompt, { source: "untrusted-external" });
    // Any finding that would block or need approval stops conversion into a
    // turn. security-policy.md: "A prompt-injection or secret finding stops
    // conversion into a turn." `redact` and `warn` do not stop it, and the
    // reason differs for each — the previous version of this comment gave one
    // reason for both and it was false for `redact`.
    //
    // `warn` is advisory by definition, so passing it is the whole point.
    //
    // `redact` passes UNREDACTED. This function destructures `{ findings }` and
    // throws the `redacted` string away, and `runRemoteTurn` sends
    // `input.request.prompt` — the original — to the provider. The default PII
    // policy action is `redact`, so that is the common case, not a corner. It is
    // not a policy violation on its face: step 9 and §"Data minimization" govern
    // what leaves toward the CALLER, and the outbound side does redact. But the
    // old comment claimed the inbound redaction was applied here, and it was
    // not — a false claim in a security comment is how the next reader stops
    // looking. The prompt is not persisted, so nothing survives the turn.
    //
    // AND a prompt-injection finding stops it whatever action the gate assigned,
    // which is not the same rule and has to be stated separately. Every
    // injection detector scores 0.35 to 0.45; the default `gate.minConfidence`
    // is 0.5; so `buildFinding` downgraded every injection finding to `warn` and
    // this line let all four canonical injection prompts through with
    // `rejected: false` while an AWS key was correctly rejected. Step 5 of the
    // required decision path worked for the secret class and was inert for the
    // injection class — on the one surface that can cause agent execution from
    // outside the operator's terminal.
    //
    // Hardcoded HERE and configurable everywhere else, and the difference is
    // which document governs.
    //
    // `resolve.ts` §7a keeps a lone injection at `warn` and escalates only with
    // a corroborating egress signal. That is a real decision, tested, and right
    // for content scanning: the detectors miss 12 of 14 canonical evasions and
    // fire on 3.3% of ordinary prose, so a hard gate on them alone is wrong in
    // both directions. On the agent-hook surface an operator who disagrees
    // lowers `policies.promptInjection.minConfidence` and the declared action
    // applies — that is the mechanism, and a round of this review was spent
    // learning not to override it from a CLI.
    //
    // This surface is not that surface. `security-policy.md` states, for remote
    // entry specifically, that "a prompt-injection or secret finding stops
    // conversion into a turn" — a requirement of the specification rather than
    // a default an operator tunes. A configurable version of it would be an
    // operator-defeatable spec requirement, which is not a knob this release
    // offers on the one surface reachable from outside the machine.
    //
    // Nor is it reconfigurable away: the scan root is the install directory,
    // which never receives a `security.config.json`, so an operator could not
    // have tightened this even knowing about it.
    const blocking = findings.some(
      (finding) =>
        finding.action === "block" ||
        finding.action === "require-approval" ||
        finding.category === "prompt-injection",
    );
    return { rejected: blocking };
  } catch {
    // Fail closed. A scanner that errored has not cleared this prompt, and the
    // one thing that must not happen is a prompt reaching the run loop because
    // the check crashed.
    return { rejected: true };
  }
}

/**
 * Redact one outbound string. Never throws; a failure redacts everything.
 *
 * Takes the turn's ONE service rather than constructing one per call. This is
 * called for every `assistant.delta`, and a fresh service reloaded the security
 * config and the HMAC key on each one: 80 microseconds per event, two thirds of
 * the whole per-event cost, on a path that wiring the runner into production had
 * just made hot. The service memoises both per instance, so one instance per
 * turn pays for them once.
 */
async function redactOut(security: SecurityService, text: string): Promise<string> {
  if (text.length === 0) {
    return text;
  }
  try {
    const { redacted } = await security.redact(text, { source: "generated" });
    return redacted;
  } catch {
    // `requiredControls.redactionFailure` is pinned to `deny` by the frozen
    // profile schema. The outbound equivalent of denying is emitting nothing
    // rather than emitting something unredacted.
    return "[redacted: the redaction pass failed]";
  }
}

/**
 * Run one remote turn to a terminal state, writing the durable record as it goes.
 *
 * Every event is appended BEFORE it could be streamed, so a client attaching at
 * any moment — including after a restart — sees the same sequence as one that
 * was attached throughout. The stream is a view; this is the thing.
 */
export async function runRemoteTurn(input: RunTurnInput): Promise<RunTurnOutput> {
  const scanRoot = input.scanRoot;
  // ONE for the whole turn. See `redactOut`.
  const security = createSecurityService(scanRoot);
  const newId = input.newId ?? (() => randomUUID());
  const clock = input.clock ?? (() => new Date().toISOString());
  const turnId = input.turnId ?? newId();
  const sessionId = input.request.sessionId ?? newId();
  const startedAt = clock();
  let seq = 0;

  createTurnRecord(
    { turnId, sessionId, project: input.project, origin: REMOTE_ORIGIN, startedAt },
    input.dir,
  );

  // True once the backlog bound has refused an append. The record has stopped
  // growing, which is a different thing from the turn ending, and the terminal
  // event says which of the two happened.
  let bounded = false;

  const emit = (kind: StreamEventKind, extra: Partial<StreamEvent> = {}): void => {
    const event: StreamEvent = { schemaVersion: "1.0.0", turnId, seq, kind, at: clock(), ...extra };
    if (appendTurnEvent(event, input.dir)) {
      seq += 1;
      return;
    }
    // The backlog bound. api-protocol.md §Bounds: the stream is CLOSED with a
    // terminal event rather than truncated silently. This return used to be the
    // whole handling — the `false` was discarded, so past the bound every later
    // event was dropped INCLUDING `terminate()`'s `turn.finished`, and the
    // stream just stopped. A client waiting for a terminal event waited forever.
    bounded = true;
  };

  /**
   * An event the bound may not refuse.
   *
   * The backlog bound exists to stop a chatty turn growing the record without
   * limit, and `assistant.delta` is what it is for. It is not for the events
   * that carry the turn's ACCOUNT OF ITSELF — the closing event, and the
   * approval pair whose absence would make the stream and the result disagree.
   * Those are a fixed, tiny number per turn and dropping them costs the
   * property the bound was written to protect.
   */
  const emitForced = (kind: StreamEventKind, extra: Partial<StreamEvent> = {}): void => {
    appendTurnEvent(
      { schemaVersion: "1.0.0", turnId, seq, kind, at: clock(), ...extra },
      input.dir,
      { force: true },
    );
    seq += 1;
  };

  /**
   * The closing event.
   *
   * Marked so a reader can tell a stream that ended from one that was cut
   * short: `terminal` says the stream is over, `text` says why there is less of
   * it than the turn produced.
   */
  const emitTerminal = (): void => {
    emitForced("turn.finished", {
      terminal: true,
      ...(bounded
        ? {
            text: "the event backlog bound was reached; earlier events are complete, later ones were not recorded",
          }
        : {}),
    });
  };

  const terminate = (
    outcome: TurnResult["outcome"],
    reasonCode: string,
    text?: string,
    approvals?: TurnResult["approvals"],
  ): RunTurnOutput => {
    const result: TurnResult = {
      schemaVersion: "1.0.0",
      turnId,
      sessionId,
      origin: REMOTE_ORIGIN,
      outcome,
      reasonCode,
      startedAt,
      finishedAt: clock(),
      ...(text !== undefined ? { text } : {}),
      ...(approvals !== undefined ? { approvals } : {}),
    };
    emitTerminal();
    if (!finishTurn(turnId, result, input.dir)) {
      // The boolean, acted on. It used to be discarded, so an unreadable or
      // malformed `turn.json` left this function returning `completed` while
      // nothing was written — the caller was answered 202 and every later read
      // of that turn answered 404, 409 or 500 forever. The signature said the
      // failure was reported and the code threw the report away.
      //
      // A throw rather than a degraded return, because there is no honest
      // success to report: the durable record IS the turn, and a turn whose
      // record does not carry its result has not finished in any sense a client
      // can observe. `createSubmitTurn` releases the idempotency claim on the
      // way out and the route answers 500.
      throw new TurnRecordUnwritableError(turnId);
    }
    return { turnId, sessionId, result };
  };

  emit("turn.started");

  // AC-12 / spec §Containment. Checked HERE rather than inside the run loop,
  // because the requirement is that the turn is refused — not that it starts and
  // then fails. A turn that began is a turn whose evidence says it began.
  if (input.profile.requiredControls.isolation === "required-fail-closed") {
    const available = input.containmentAvailable ?? (() => false);
    if (!available()) {
      return terminate("refused", "containment-unavailable");
    }
  }

  const runInput: HarnessRunInput = {
    schemaVersion: 1,
    request: input.request.prompt,
    projectRoot: input.project,
    role: "build",
    policy: input.profile.profileId,
    budget: { maxSeconds: 300, maxToolCalls: 0, maxRetries: 1 },
    sessionId,
    provider: input.providerName,
    model: input.model,
    // Headless by declaration as well as by `deps.interactive`. The S3
    // fail-closed posture depends on this being honest: nobody is present to
    // answer an `ask`.
    nonInteractive: true,
    transport: "rpc",
    credentialRef: `${input.providerName}-local`,
  };
  const config: HarnessConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultRole: "build",
    defaultProvider: input.providerName,
    defaultModel: input.model,
    policyProfile: input.profile.profileId,
    limits: { maxRunSeconds: 300, maxConcurrentChildren: 1, maxToolOutputBytes: 65_536, maxRetries: 1 },
  };
  let idCounter = 0;
  const deps: RunDeps = {
    provider: input.provider,
    toolRegistry: input.toolRegistry ?? new ToolRegistry(),
    toolExecutor: denyingExecutor,
    // The profile resolved and CHECKED at startup, passed through unchanged.
    // Re-resolving here would allow the profile a turn runs under to differ
    // from the one the non-weakening check cleared.
    policyProfile: input.profile,
    clock,
    idSeq: () => `${turnId}-${idCounter++}`,
    // Headless. The S3 fail-closed posture depends on this being honest: an
    // `interactive: true` remote turn would be claiming a human is present to
    // answer, and there is not one.
    interactive: false,
  };

  let events: NormalizedEvent[] = [];
  let decisions: PolicyDecision[] = [];
  let summary = "";
  let runStatus: HarnessRunOutput["status"] = "completed";
  let runGate: string | undefined;
  let unresolvedBlockerIds: string[] = [];
  try {
    // The provider is about to be invoked, which is the point after which this
    // turn has HAD AN EFFECT: it may bill, it may reach the network, and its
    // output is about to be appended to a durable record. `createSubmitTurn`
    // reads this to decide whether a later throw may release the idempotency
    // claim, and everything from here on may not.
    //
    // Set BEFORE the call rather than after it, deliberately. `runOffline`
    // catches its own provider failures and returns a terminal `failed` instead
    // of throwing, so "after" would look identical for a run that never reached
    // the provider and one that was billed and then failed to record. The one
    // function call of window this costs is a claim burned on a turn that did
    // nothing; the alternative is a billed turn re-run on retry.
    input.onEffect?.();
    const run = await runOffline(runInput, config, deps);
    events = run.events;
    decisions = run.decisions;
    // `summary` is the terminal document's assistant text. There is no `text`
    // field on `HarnessRunOutput`; assuming one is how the first version of
    // this line compiled against a shape that does not exist.
    summary = run.output.summary ?? "";
    // The other three fields the run reports, which this function used to
    // discard. It read `summary` and then terminated with a hardcoded
    // `("completed", "ok")`, so a run that FAILED was recorded as a success —
    // and on a stock install that is the ordinary case, because a config
    // directory with no saved provider makes the harness refuse at startup:
    //
    //   outcome: "completed"  reasonCode: "ok"
    //   text:    "Startup blocked: missing required provider precondition(s): model."
    //
    // The record contradicted itself and `outcome` is the field a client
    // branches on. Worse, the socket test written to prove the listener runs
    // turns asserts `outcome === "completed"` — so the capability assertion was
    // satisfied by a failure, because the failure was recorded as a success one
    // layer below the assertion.
    runStatus = run.output.status;
    runGate = run.output.gate?.status;
    unresolvedBlockerIds = run.output.unresolvedBlockerIds ?? [];
  } catch (error) {
    // Never let a provider or run failure escape as an exception: it becomes a
    // terminal `failed` result with a stable slug and no provider error body,
    // which api-protocol.md §"Error contract" requires.
    void error;
    return terminate("failed", "run-failed");
  }

  // An action that needed approval terminates in a recorded denial (D3).
  //
  // Detected through `headless-fail-closed`, and the reason is a finding rather
  // than a preference. The FIRST version of this checked `decision === "ask"`
  // and could never fire: `src/harness/policy/engine.ts` step 6 already turns an
  // `ask` into a `deny` whenever the context is non-interactive, and a remote
  // turn is non-interactive by construction (nobody is present to answer). So
  // the transport never sees an `ask` at all.
  //
  // That makes the D3 boundary REAL but enforced one layer deeper than this
  // module: the policy engine fails it closed, and the transport's job is to
  // REPORT that rather than to create it. Reporting matters — without it the
  // turn ends `completed` with nothing having happened, and the operator is
  // never told that their request needed an approval this release cannot ask
  // for.
  //
  // Both conditions are kept. `headless-fail-closed` is the reachable one
  // today; `decision === "ask"` becomes reachable the moment an interactive
  // remote context exists, which is exactly when it must already be handled.
  //
  // Read from the run's POLICY DECISIONS, not its provider events: the decision
  // trail is where classification is recorded, and a provider event stream has
  // no opinion about policy at all.
  const asked = decisions.some(
    (decision) => decision.decision === "ask" || decision.matchedRules.includes("headless-fail-closed"),
  );

  // Accumulated while streaming, and used for the terminal result when the run
  // produced no `summary`. The completion gate does not always write one — with
  // no tools registered it wrote an empty string — and a turn result whose
  // `text` is empty while the stream carried the whole answer is a result that
  // contradicts its own stream. Found by asserting the positive control.
  let assistantText = "";
  for (const event of events) {
    if (event.kind === "text_delta" && typeof event.text === "string") {
      const redacted = await redactOut(security, event.text);
      assistantText += redacted;
      emit("assistant.delta", { text: redacted });
    }
  }

  if (asked) {
    // Visible in BOTH surfaces, which is what AC5 asks: the stream carries the
    // pending-then-denied pair so a client watching live sees why the turn
    // ended, and the result carries the same resolution so a client that only
    // polls sees it too. A denial visible in one and not the other is a turn
    // whose two accounts of itself disagree.
    const approvalId = newId();
    // FORCED past the bound, like the terminal event and for the same reason.
    // The comment above states the invariant — the denial must be visible in
    // BOTH surfaces, because a turn whose two accounts of itself disagree is
    // the failure this pair exists to prevent — and past the window the bound
    // refused these two while `terminate`'s `approvals` array still reached
    // `turn.json`. The stream then said nothing about a denial the result
    // recorded. Unreachable today, because this slice registers no tools and
    // `asked` cannot be true in production; reachable the moment R4d lands one,
    // which is the same slice that makes approvals real.
    emitForced("approval.pending", { approvalId });
    emitForced("approval.resolved", { approvalId, resolution: "denied" });
    return terminate("denied", "approvals-not-implemented-in-this-release", undefined, [
      { approvalId, resolution: "denied" },
    ]);
  }

  // `summary` is redacted here; `assistantText` already is, delta by delta.
  const text = summary.length > 0 ? await redactOut(security, summary) : assistantText;

  // The run's own verdict, mapped rather than assumed. `terminate("completed",
  // "ok")` used to be unconditional here, so a harness that reported `failed`
  // with a blocked gate produced a record saying the turn succeeded — the
  // ordinary case on an install with no provider configured.
  //
  // Total over `HarnessRunOutput["status"]` with no default arm: a status this
  // function does not recognise is a status it cannot map, and inventing
  // `completed` for it is exactly the defect. TypeScript makes the switch
  // exhaustive, so a new status is a compile error rather than a silent success.
  return terminate(...outcomeOf(runStatus, runGate, unresolvedBlockerIds), text);
}

/**
 * The turn outcome and reason for a harness run's terminal state.
 *
 * `blocked` and `failed` are distinct: the first means the completion gate
 * refused the run, which an operator fixes by satisfying the blocker, and the
 * second means the run itself broke. Collapsing them — or collapsing either
 * into `completed` — is what made a stock install report success.
 *
 * The blocker ids travel in the reason code because they are the actionable
 * part: `startup-blocked` alone tells an operator nothing, and
 * `startup-blocked:blocker:startup` names what to satisfy. They are harness
 * vocabulary, not caller data, so they are safe in a result a caller reads.
 */
export function outcomeOf(
  status: HarnessRunOutput["status"],
  gate: string | undefined,
  unresolvedBlockerIds: readonly string[],
): [TurnResult["outcome"], string] {
  const blockers = unresolvedBlockerIds.length > 0 ? `:${unresolvedBlockerIds.join(",")}` : "";
  switch (status) {
    case "completed":
      // A completed run whose GATE did not pass is not a completed turn. The
      // gate is the harness's own statement about whether the work is
      // acceptable, and a transport that reports success over a refused gate is
      // reporting the absence of an exception.
      return gate !== undefined && gate !== "pass"
        ? ["failed", `completion-gate-${gate}${blockers}`]
        : ["completed", "ok"];
    case "blocked":
      return ["failed", `startup-blocked${blockers}`];
    case "failed":
      return ["failed", `run-failed${blockers}`];
    case "cancelled":
      return ["cancelled", "run-cancelled"];
    case "paused":
    case "in-progress":
      // Neither is terminal, and a turn that returns from `runOffline` in one of
      // them has not finished. Reported as a failure rather than held open:
      // this release has no resume path for a remote turn, so "still running"
      // would be a state nothing can ever leave.
      return ["failed", `run-not-terminal-${status}`];
  }
}

/** What a submission did. Mirrors `SubmitTurnOutcome` in `serve-server.ts`. */
export type SubmitOutcome =
  | { kind: "accepted"; turnId: string; sessionId: string }
  | { kind: "duplicate"; turnId: string; sessionId: string }
  | { kind: "rejected" }
  /**
   * The store could not answer. Added because the union had no way to say so:
   * a key whose record was unreadable was answered as a duplicate carrying
   * `sessionId: ""` — a null record standing in for a stated failure, on the
   * one path that reaches a 200. The route turns this into a 500.
   */
  | { kind: "unavailable"; reason: TurnReadFailure };

export interface SubmitDeps {
  profile: PolicyProfile;
  provider: ProviderPort;
  providerName: string;
  model: string;
  /** The install directory: the config root, the turn store, and the scan root. */
  dir: string;
  containmentAvailable?: () => boolean;
  clock?: () => string;
  newId?: () => string;
  toolRegistry?: ToolRegistry;
}

/**
 * The one submission pipeline: claim, scan, run.
 *
 * Assembled here rather than in the route, and rather than being left to each
 * caller to compose, because the ORDER is the control. The first version of this
 * slice left the scan as an exported function the route was expected to call,
 * and the route did not call it — so `security-policy.md` step 5 was implemented
 * and unreachable, which is indistinguishable from absent. A caller that gets a
 * turn runner gets the scan with it.
 *
 * Order, and why each step is where it is:
 *
 *   1. scan the prompt — first, and before anything durable exists. A rejected
 *      prompt must leave no turn behind AND no claim behind.
 *   2. claim the idempotency key — after the scan, immediately before the
 *      record. Claiming first is what the first version did, and it made a
 *      422-rejected prompt POISON its key permanently: every later submission
 *      of the corrected prompt returned `200 {duplicate: true, sessionId: ""}`
 *      pointing at a turnId whose record 404s forever, and the legitimate
 *      prompt never ran. There is no release path for a claim, so a claim taken
 *      before a step that can fail is a key burned for good.
 *   3. run.
 *
 * And every step after the claim RELEASES it on failure. Reordering alone was
 * not enough and the first attempt at this stopped there: `createTurnRecord`,
 * both event appends and `finishTurn` all reach writers documented as
 * propagating what the write throws, so an ENOSPC or an EROFS after the claim
 * burned the key exactly as a 422 used to — a later submission of the same key
 * answered `200 {duplicate: true, sessionId: ""}` naming a turn that does not
 * exist, forever, and clearing the fault did not help. The fix moved one member
 * of that class and left four.
 *
 * The window this leaves is stated rather than hidden, and it is smaller than
 * the first version of this comment claimed. Measured with eight concurrent
 * same-key submissions through the real runner: one accepted, seven duplicates,
 * one record on disk, no empty session ids. `claimIdempotencyKey` reads and
 * writes with no `await` between, and the run is synchronous through
 * `createTurnRecord`, so the check-then-write is atomic against any in-process
 * writer. Across two processes it is not, and that is recorded where the claim
 * is written rather than here.
 */
export function createSubmitTurn(deps: SubmitDeps): (request: TurnRequest, project: string) => Promise<SubmitOutcome> {
  return async (request: TurnRequest, project: string): Promise<SubmitOutcome> => {
    const turnId = (deps.newId ?? (() => randomUUID()))();

    const scanned = await scanPrompt(deps.dir, request.prompt);
    if (scanned.rejected) {
      return { kind: "rejected" };
    }

    const claimed = claimTurnKey(request, turnId, deps.dir);
    if (claimed.existing !== null) {
      const held = readTurnRecord(claimed.existing, deps.dir);
      if (!held.ok && held.reason !== "absent") {
        // A key pointing at a record this process cannot READ is not a
        // duplicate answer to give: `sessionId: ""` on a 200 is a null record
        // standing in for a stated failure, on the one path that reaches a
        // success status. `absent` is different and stays a duplicate — the
        // claim is the authority on what the key holds, and a claim whose
        // record was removed still means "this key is taken".
        return { kind: "unavailable", reason: held.reason };
      }
      return { kind: "duplicate", turnId: claimed.existing, sessionId: held.ok ? held.value.sessionId : "" };
    }

    // Flipped by `runRemoteTurn` immediately before the provider can be
    // invoked. See the catch below.
    let effected = false;
    try {
      const run = await runRemoteTurn({
        onEffect: () => {
          effected = true;
        },
        request,
        project,
        profile: deps.profile,
        provider: deps.provider,
        providerName: deps.providerName,
        model: deps.model,
        dir: deps.dir,
        scanRoot: deps.dir,
        // The id as a VALUE, not as a constant `newId` seam. Passing the seam
        // made the session id and the approval id collide with the turn id.
        turnId,
        ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
        ...(deps.toolRegistry !== undefined ? { toolRegistry: deps.toolRegistry } : {}),
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
        ...(deps.containmentAvailable !== undefined ? { containmentAvailable: deps.containmentAvailable } : {}),
      });
      return { kind: "accepted", turnId: run.turnId, sessionId: run.sessionId };
    } catch (cause) {
      // The release path, and `effected` is the whole of its correctness.
      //
      // The first version released on EVERY throw, described as "the one place
      // that knows a claim was taken and not used". For a throw after the
      // provider has streamed, the claim WAS used: the turn ran, the assistant's
      // answer is on disk, and `terminate` throws only because the terminal
      // write failed. Releasing there turns at-most-once into at-least-once —
      // measured, one idempotency key bought two provider calls — and the route
      // answers a bare 500, which is exactly what a client retries.
      //
      // So: release only on the near side of the effect. A turn that never
      // reached the provider leaves no trace and its key must not be burned; a
      // turn that ran keeps its claim, and a retry is correctly answered as a
      // duplicate of a turn that really happened.
      //
      // Guarded by turnId inside the store, so a release cannot take a claim
      // another turn legitimately re-took while this one was failing.
      if (!effected && request.idempotencyKey !== undefined) {
        // The boolean is read, not discarded. `false` here means the key no
        // longer pointed at this turn — another submission legitimately re-took
        // it while this one was failing — and that is a fact about at-most-once
        // that has no other witness. Not a fault and not an error path: the
        // guard inside the store did its job. The operator is told because a
        // silent no-op is indistinguishable from a release that happened.
        const released = releaseIdempotencyKey(request.idempotencyKey, turnId, deps.dir);
        if (!released) {
          console.error(`keryx serve: idempotency claim for turn ${turnId} was already re-taken; not released`);
        }
      }
      throw cause;
    }
  };
}

/**
 * Claim the idempotency key, if the request carries one.
 *
 * Separated from `runRemoteTurn` so the route can answer a repeated key without
 * creating a record, a session or an id — "returns the original turnId and
 * starts nothing" has to mean nothing, including the side effects that would
 * otherwise happen before the check.
 */
export function claimTurnKey(request: TurnRequest, turnId: string, dir?: string): { existing: string | null } {
  if (request.idempotencyKey === undefined) {
    return { existing: null };
  }
  return claimIdempotencyKey(request.idempotencyKey, turnId, dir);
}

/** True when `project` is a directory that exists. Used only for a clearer 400. */
export function projectPathExists(project: string): boolean {
  try {
    return existsSync(project) && statSync(project).isDirectory();
  } catch {
    return false;
  }
}
