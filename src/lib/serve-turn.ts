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
import { runOffline, type RunDeps } from "../harness/run/run";
import { ToolRegistry } from "../harness/tool/registry";
import type { ToolExecutorPort, ToolInvocation, ToolResult } from "../harness/tool/types";
import type { HarnessRunInput } from "../harness/types";
import { createSecurityService } from "../security/service";
import { listProjects } from "./project-registry";
import {
  appendTurnEvent,
  claimIdempotencyKey,
  createTurnRecord,
  finishTurn,
  readTurnRecord,
  type StreamEvent,
  type StreamEventKind,
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

/** The largest request body accepted, enforced before parsing semantics. */
export const MAX_TURN_BODY_BYTES = 128 * 1024;

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
      // input echoed back — but only the name, and only when it is short enough
      // to be a field name rather than a payload.
      return problem(`Unknown field: ${key.length <= 64 ? key : "(oversized)"}.`);
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
    // conversion into a turn." `redact` and `warn` do not stop it — the first
    // is handled by the redaction itself and the second is advisory by
    // definition.
    const blocking = findings.some((finding) => finding.action === "block" || finding.action === "require-approval");
    return { rejected: blocking };
  } catch {
    // Fail closed. A scanner that errored has not cleared this prompt, and the
    // one thing that must not happen is a prompt reaching the run loop because
    // the check crashed.
    return { rejected: true };
  }
}

/** Redact one outbound string. Never throws; a failure redacts everything. */
async function redactOut(scanRoot: string, text: string): Promise<string> {
  if (text.length === 0) {
    return text;
  }
  try {
    const { redacted } = await createSecurityService(scanRoot).redact(text, { source: "generated" });
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
  const newId = input.newId ?? (() => randomUUID());
  const clock = input.clock ?? (() => new Date().toISOString());
  const turnId = newId();
  const sessionId = input.request.sessionId ?? newId();
  const startedAt = clock();
  let seq = 0;

  createTurnRecord(
    { turnId, sessionId, project: input.project, origin: REMOTE_ORIGIN, startedAt },
    input.dir,
  );

  const emit = (kind: StreamEventKind, extra: Partial<StreamEvent> = {}): void => {
    const event: StreamEvent = { schemaVersion: "1.0.0", turnId, seq, kind, at: clock(), ...extra };
    if (appendTurnEvent(event, input.dir)) {
      seq += 1;
      return;
    }
    // The backlog bound. api-protocol.md §Bounds: the stream is closed with a
    // terminal event rather than truncated silently — so the caller is told the
    // record stopped growing, which is a different thing from the turn ending.
  };

  const terminate = (outcome: TurnResult["outcome"], reasonCode: string, text?: string): RunTurnOutput => {
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
    };
    emit("turn.finished", { terminal: true });
    finishTurn(turnId, result, input.dir);
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
    toolRegistry: new ToolRegistry(),
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
  try {
    const run = await runOffline(runInput, config, deps);
    events = run.events;
    decisions = run.decisions;
    // `summary` is the terminal document's assistant text. There is no `text`
    // field on `HarnessRunOutput`; assuming one is how the first version of
    // this line compiled against a shape that does not exist.
    summary = run.output.summary ?? "";
  } catch (error) {
    // Never let a provider or run failure escape as an exception: it becomes a
    // terminal `failed` result with a stable slug and no provider error body,
    // which api-protocol.md §"Error contract" requires.
    void error;
    return terminate("failed", "run-failed");
  }

  // Any `ask` reaching here terminates in a recorded denial (D3). Approvals are
  // R4d; this is the stated boundary, not the absence of one.
  //
  // Read from the run's POLICY DECISIONS, not from its provider events: the
  // decision trail is where classification is recorded, and a provider event
  // stream has no opinion about policy at all.
  const asked = decisions.some((decision) => decision.decision === "ask");

  // Accumulated while streaming, and used for the terminal result when the run
  // produced no `summary`. The completion gate does not always write one — with
  // no tools registered it wrote an empty string — and a turn result whose
  // `text` is empty while the stream carried the whole answer is a result that
  // contradicts its own stream. Found by asserting the positive control.
  let assistantText = "";
  for (const event of events) {
    if (event.kind === "text_delta" && typeof event.text === "string") {
      const redacted = await redactOut(scanRoot, event.text);
      assistantText += redacted;
      emit("assistant.delta", { text: redacted });
    }
  }

  if (asked) {
    emit("approval.resolved", { resolution: "denied" });
    return terminate("denied", "approval-required-but-approvals-are-not-implemented-in-this-release");
  }

  // `summary` is redacted here; `assistantText` already is, delta by delta.
  return terminate("completed", "ok", summary.length > 0 ? await redactOut(scanRoot, summary) : assistantText);
}

/** What a submission did. Mirrors `SubmitTurnOutcome` in `serve-server.ts`. */
export type SubmitOutcome =
  | { kind: "accepted"; turnId: string; sessionId: string }
  | { kind: "duplicate"; turnId: string; sessionId: string }
  | { kind: "rejected" };

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
 *   1. claim the idempotency key — before anything else, because "returns the
 *      original turnId and starts nothing" has to mean NOTHING, including the
 *      scan and the record that would otherwise already exist.
 *   2. scan the prompt — before a record is created, because a rejected prompt
 *      must leave no turn behind. security-policy.md: "No turn is created."
 *   3. run.
 */
export function createSubmitTurn(deps: SubmitDeps): (request: TurnRequest, project: string) => Promise<SubmitOutcome> {
  return async (request: TurnRequest, project: string): Promise<SubmitOutcome> => {
    const turnId = (deps.newId ?? (() => randomUUID()))();

    const claimed = claimTurnKey(request, turnId, deps.dir);
    if (claimed.existing !== null) {
      const held = readTurnRecord(claimed.existing, deps.dir);
      return { kind: "duplicate", turnId: claimed.existing, sessionId: held?.sessionId ?? "" };
    }

    const scanned = await scanPrompt(deps.dir, request.prompt);
    if (scanned.rejected) {
      return { kind: "rejected" };
    }

    const run = await runRemoteTurn({
      request,
      project,
      profile: deps.profile,
      provider: deps.provider,
      providerName: deps.providerName,
      model: deps.model,
      dir: deps.dir,
      scanRoot: deps.dir,
      newId: () => turnId,
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.containmentAvailable !== undefined ? { containmentAvailable: deps.containmentAvailable } : {}),
    });
    return { kind: "accepted", turnId: run.turnId, sessionId: run.sessionId };
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
