// The hook runtime: selection, ordering, execution, and per-invocation
// bookkeeping for one lifecycle event (flow 306, W6, T5).
//
// `createHookRuntime` builds a `HookRuntime` whose `fire()` resolves every
// enabled, profile-matching, matcher-matching registration for one event,
// runs `gate`/`gate-advisory` hooks sequentially (first `deny` short-circuits
// the remaining ones for THIS event), runs `observe`/`context` hooks in
// parallel without ever waiting past their own timeout, and returns the
// per-hook decisions, accumulated `additionalContext`, invocation records,
// and named warnings/anomalies. `PreToolUse` composition against a real
// `PolicyDecision` happens OUTSIDE this module (a later task's `run.ts`
// integration, via `compose.ts`'s `composeDecision`); for the three other
// gate-capable events (`UserPromptSubmit`/`Stop`/`SubagentStart`), which have
// no `PolicyDecision` of their own, this module computes the tightened
// outcome itself via `compose.ts`'s `tightenOutcome`.
import {
  LEARNING_OBSERVER_EVENT_KIND,
  NOOP_IMPACT_EVIDENCE_PROVIDER,
  NOOP_LEARNING_OBSERVATION_SINK,
  resolveKeryxArgv,
} from "./builtins";
import type { ImpactEvidenceProvider, LearningObservation, LearningObservationSink } from "./builtins";
import { buildHookStdin, parseHookResult } from "./codec";
import { tightenOutcome } from "./compose";
import { buildHookEnv } from "./runner";
import { failureEffect } from "./semantics";
import { GATE_CAPABLE_EVENTS, PER_TOOL_EVENTS } from "./types";
import { resolveLocalProfile } from "../policy/profiles";
import { parsePatchTargets } from "../../lib/patch-risk";
import type {
  HookAnomalyName,
  HookEventName,
  HookFailureKind,
  HookInvocationRecord,
  HookRegistration,
} from "./types";
import type { HookProcessRunner } from "./runner";
import type { PolicyOutcome, PolicyProfileId } from "../policy/types";

/**
 * The `runsIn` a built-in COMMAND hook actually spawns with, for THIS fire
 * (flow 306, W6, T15).
 *
 * A built-in gate hook (`keryx.ctx-guard`, `keryx.security-check-input`,
 * `keryx.security-check-output`) spawns the running `keryx` binary itself —
 * the same trust domain and containment as the Keryx process that spawns it,
 * not an untrusted third-party command. Wrapping it in the OS sandbox adds no
 * containment (there is no boundary between Keryx and Keryx) while making the
 * hook load-bearing on a launcher (`bwrap`/`sandbox-exec`) that is frequently
 * unavailable — a Linux user without bubblewrap would see EVERY prompt denied
 * by `keryx.security-check-input`'s fail-closed sandbox-unavailable path,
 * which is a usability regression, not a security gain.
 *
 * So a built-in command hook runs `unsandboxed` whenever the active profile's
 * isolation is not `required-fail-closed` (`read-only-review` and
 * `monitored-trusted-local` today — see `policy/profiles.ts`). Under a
 * profile that DOES require fail-closed isolation (`unattended-untrusted`),
 * the built-in stays sandboxed and fails closed exactly like before — an
 * unattended/untrusted turn gets no exception.
 *
 * User/project hooks are unaffected: this only ever widens a `scope:
 * "builtin"` + `handler.kind: "command"` registration, so a project's own
 * configured hook keeps whatever `runsIn` its registration resolved to
 * (default `sandbox`, fail-closed when the launcher is unavailable).
 */
export function resolveBuiltinCommandRunsIn(
  reg: Pick<HookRegistration, "scope" | "handler" | "runsIn">,
  profileId: PolicyProfileId,
): "sandbox" | "unsandboxed" {
  if (reg.scope !== "builtin" || reg.handler.kind !== "command") {
    return reg.runsIn;
  }
  return isIsolationRequired(profileId) ? "sandbox" : "unsandboxed";
}

/**
 * Whether `profileId`'s active policy profile requires fail-closed OS
 * isolation (`requiredControls.isolation === "required-fail-closed"`) — the
 * SAME question the real runner refuses `runsIn: "unsandboxed"` against
 * (`runner.ts`'s `req.isolationRequired === true` check).
 *
 * Flow 306 fix round 2 (finding F): extracted from the inline computation
 * this function and {@link runCommandHook} each carried, so `commands/
 * hooks.ts`'s `hooks test`/`hooks list` — which used to resolve
 * `runsIn`/spawn a hook WITHOUT ever computing this — apply the exact same
 * refusal a live session would, instead of two call sites quietly agreeing by
 * coincidence (or, as found, one of them not agreeing at all).
 */
export function isIsolationRequired(profileId: PolicyProfileId): boolean {
  return resolveLocalProfile(profileId).requiredControls.isolation === "required-fail-closed";
}

export interface HookRuntimePorts {
  learningSink?: LearningObservationSink;
  impactEvidence?: ImpactEvidenceProvider;
}

export interface FireContext {
  toolName?: string;
  /** The underlying `decide()` outcome this event is gating, when known (the gate malformed-output asymmetry). */
  decideOutcome?: PolicyOutcome;
  /**
   * Per-fire policy-profile override (flow 306, W6, T14). Absent ⇒ the
   * runtime's own constructed `profileId` (byte-identical to before this
   * field existed). Lets a caller that already knows the LIVE profile for
   * this one fire (e.g. `keryx shell`'s `/plan` read-only toggle, resolved
   * fresh per tool call via `derivePolicyProfileId`) select registrations
   * against it without rebuilding the whole runtime.
   */
  profileId?: PolicyProfileId;
}

export interface HookWarning {
  name: HookAnomalyName;
  hookId: string;
  detail?: string;
}

export interface HookAnomaly {
  name: HookAnomalyName;
  hookId: string;
}

export interface HookFireResult {
  decisions: Array<{ hookId: string; decision: PolicyOutcome }>;
  /** Only computed for non-tool gate-capable events; `PreToolUse` composition happens externally. */
  tightened?: PolicyOutcome;
  denyReason?: string;
  additionalContext: string[];
  records: HookInvocationRecord[];
  warnings: HookWarning[];
  anomalies: HookAnomaly[];
}

export interface HookRuntime {
  fire(event: HookEventName, payload: Record<string, unknown>, ctx?: FireContext): Promise<HookFireResult>;
  inheritedHookIds(): string[];
  registrations(): readonly HookRegistration[];
  interactive: boolean;
  /**
   * Derive a restricted runtime for a spawned child agent (flow 306, W6,
   * T13). Contains only the registrations `inheritedHookIds()` names
   * (enabled, `appliesToChildAgents !== false`) — so the child runtime's own
   * `inheritedHookIds()` is exactly that same set, never a superset (a
   * registration this runtime itself has already excluded, whether by
   * `enabled: false` or `appliesToChildAgents: false`, can never reappear for
   * a child derived from it). Same runner/clock/profileId/projectRoot/ports
   * as the parent; fresh per-child invocation state (e.g. the
   * `impact-evidence` first-edit-in-session tracking starts empty for the
   * child rather than sharing the parent's). `interactive` is always `false`
   * on the returned runtime — a spawned child never has an interactive
   * approver at this layer (mirrors `spawnChildWithHooks`'s own "no
   * interactive approver to resolve an `ask`" fail-closed posture).
   */
  forChild(ids: { sessionId: string; runId: string }): HookRuntime;
}

export interface CreateHookRuntimeOptions {
  registrations: readonly HookRegistration[];
  runner: HookProcessRunner;
  clock: () => string;
  profileId: PolicyProfileId;
  interactive: boolean;
  sessionId: string;
  runId: string;
  projectRoot: string;
  ports?: HookRuntimePorts;
  /** Overrides `resolveKeryxArgv` (tests). */
  builtinArgvResolver?: (argv: readonly string[]) => string[];
}

interface HookRunOutcome {
  record: HookInvocationRecord;
  decision?: PolicyOutcome;
  additionalContext?: string;
  warning?: HookWarning;
  anomalies: HookAnomaly[];
}

/**
 * A cancellable delay (flow 306, W6, fix round 1, finding 15). A bare
 * `setTimeout` left running past the `Promise.race` that lost to it keeps
 * the event loop alive for up to `timeoutMs` (max 60s, `MAX_TIMEOUT_MS`)
 * after `fire()` has already resolved — e.g. every `runOffline` call that
 * completed well within its hooks' timeouts still had to wait out those
 * timeouts before the process could exit. `clear()` lets the race's winner
 * cancel the loser's still-pending timer; `unref()` (absent on some fakes,
 * hence the optional call) additionally keeps a timer that nobody clears
 * from blocking process exit on its own.
 */
function delay(ms: number): { promise: Promise<void>; clear: () => void } {
  let timer!: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { promise, clear: () => clearTimeout(timer) };
}

type TimeoutRaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: "timeout" | "crash"; reason: string };

/** Race an in-process port call against its own timeout; classifies a thrown error as a crash. */
async function runWithTimeout<T>(fn: () => Promise<T> | T, timeoutMs: number): Promise<TimeoutRaceResult<T>> {
  const work = (async (): Promise<TimeoutRaceResult<T>> => {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      return { ok: false, failure: "crash", reason: err instanceof Error ? err.message : String(err) };
    }
  })();
  const timeoutDelay = delay(timeoutMs);
  const timeout = timeoutDelay.promise.then(
    (): TimeoutRaceResult<T> => ({ ok: false, failure: "timeout", reason: "Builtin hook exceeded its timeout." }),
  );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    timeoutDelay.clear();
  }
}

/**
 * Best-effort target-file extraction from a `PreToolUse` payload's
 * `toolInput` (Write/Edit tool shapes vary) — fix round 3, F-001.
 *
 * Two shapes are understood:
 *   - A single-path tool (`Write`/`Edit`-shaped hosts): `filePath`/`file_path`/
 *     `path` is a string naming the one file touched.
 *   - Keryx's own `apply_patch` tool (`{ patch: string }`, aliased to `Edit`
 *     for matcher purposes by `commands/agent-hooks.ts`'s
 *     `HOOK_TOOL_NAME_ALIASES` — see `apply-patch-tool.ts`): the patch can
 *     name several files in one call, so every target `parsePatchTargets`
 *     finds is returned, not just the first. Reusing `parsePatchTargets`
 *     (the same parser `apply-patch-tool.ts`/`unattended.ts` use to classify
 *     patch risk) rather than a second, driftable copy.
 *
 * Neither shape is required to be present — an unrecognized `toolInput`
 * (or one with no path field and no `patch` string) yields no targets, and
 * the caller's `runBuiltinHook` treats that as "nothing to gate", exactly
 * as the single-path-only version did.
 */
function extractFilePaths(payload: Record<string, unknown>): string[] {
  const toolInput = payload.toolInput;
  if (typeof toolInput !== "object" || toolInput === null) return [];
  const record = toolInput as Record<string, unknown>;
  if (typeof record.patch === "string") {
    const targets = parsePatchTargets(record.patch);
    if (targets.length > 0) {
      return targets.map((target) => target.path);
    }
    // A `patch` field that parses to zero targets (malformed/empty diff)
    // falls through to the single-path fields below rather than reporting
    // no targets outright — harmless in practice (apply_patch's own input
    // never carries both), and keeps this function's behavior a strict
    // superset of the pre-F-001 single-path extractor.
  }
  for (const key of ["filePath", "file_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return [value];
  }
  return [];
}

class HookRuntimeImpl implements HookRuntime {
  readonly interactive: boolean;
  private readonly regs: readonly HookRegistration[];
  private readonly runner: HookProcessRunner;
  private readonly clock: () => string;
  private readonly profileId: PolicyProfileId;
  private readonly sessionId: string;
  private readonly runId: string;
  private readonly projectRoot: string;
  private readonly ports: HookRuntimePorts;
  private readonly argvResolver: (argv: readonly string[]) => string[];
  private readonly editedFiles = new Set<string>();
  /**
   * Anomaly names already reported once for this runtime/session (flow 306,
   * W6, fix round 1, finding 13). `hook-attempted-input-rewrite` fires from
   * `codec.ts` on EVERY invocation of a hook whose output carries
   * `updatedInput` — a hook that always echoes it back (or a buggy one)
   * would otherwise spam one anomaly per tool call for the life of the
   * session. Reported once per runtime, not once per hook id, since the
   * point is "this session saw at least one hook attempt a rewrite", not a
   * per-hook tally.
   */
  private readonly reportedOnceAnomalies = new Set<HookAnomalyName>();

  /** Drop a repeat of a once-per-session anomaly name; first occurrence passes through unchanged. */
  private dedupeOncePerSession(anomalies: HookAnomaly[]): HookAnomaly[] {
    return anomalies.filter((a) => {
      if (a.name !== "hook-attempted-input-rewrite") return true;
      if (this.reportedOnceAnomalies.has(a.name)) return false;
      this.reportedOnceAnomalies.add(a.name);
      return true;
    });
  }

  constructor(opts: CreateHookRuntimeOptions) {
    this.regs = opts.registrations;
    this.runner = opts.runner;
    this.clock = opts.clock;
    this.profileId = opts.profileId;
    this.interactive = opts.interactive;
    this.sessionId = opts.sessionId;
    this.runId = opts.runId;
    this.projectRoot = opts.projectRoot;
    this.ports = opts.ports ?? {};
    this.argvResolver = opts.builtinArgvResolver ?? resolveKeryxArgv;
  }

  registrations(): readonly HookRegistration[] {
    return this.regs;
  }

  inheritedHookIds(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const reg of this.regs) {
      if (!reg.enabled || reg.appliesToChildAgents === false) continue;
      if (seen.has(reg.id)) continue;
      seen.add(reg.id);
      result.push(reg.id);
    }
    return result;
  }

  forChild(ids: { sessionId: string; runId: string }): HookRuntime {
    // Same filter `inheritedHookIds()` applies (enabled && appliesToChildAgents
    // !== false), kept as a REGISTRATION LIST rather than just an id list so
    // the child runtime can still actually run these hooks (matcher/order/
    // class all need the full registration, not just its id). A registration
    // this runtime has already excluded — disabled, or explicitly scoped
    // parent-only — can never reappear on the derived runtime: filtering here
    // is the only place child eligibility is decided, so the child's own
    // later `inheritedHookIds()` call (were something to call it) reads back
    // the identical set, in the identical order.
    const childRegs = this.regs.filter((reg) => reg.enabled && reg.appliesToChildAgents !== false);
    return new HookRuntimeImpl({
      registrations: childRegs,
      runner: this.runner,
      clock: this.clock,
      profileId: this.profileId,
      // A spawned child never has an interactive approver at this layer
      // (mirrors `spawnChildWithHooks`'s own fail-closed "ask reads as deny"
      // posture) — hard-`false` regardless of the parent's own `interactive`.
      interactive: false,
      sessionId: ids.sessionId,
      runId: ids.runId,
      projectRoot: this.projectRoot,
      ports: this.ports,
      builtinArgvResolver: this.argvResolver,
    });
  }

  private matcherMatches(reg: HookRegistration, toolName: string, perTool: boolean): boolean {
    if (!perTool || reg.matcher === "*") return true;
    try {
      const re = new RegExp(`^(?:${reg.matcher})$`);
      return re.test(toolName);
    } catch {
      // An invalid matcher regex never matches (fail closed on selection).
      return false;
    }
  }

  private selectCandidates(event: HookEventName, toolName: string, profileId: PolicyProfileId): HookRegistration[] {
    const perTool = PER_TOOL_EVENTS.includes(event);
    return this.regs
      .filter((reg) => reg.event === event && reg.enabled)
      .filter((reg) => reg.profiles.length === 0 || reg.profiles.includes(profileId))
      .filter((reg) => this.matcherMatches(reg, toolName, perTool))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  private buildFailureOutcome(
    reg: HookRegistration,
    event: HookEventName,
    durationMs: number,
    failure: HookFailureKind,
    decideOutcome: PolicyOutcome | undefined,
    fireProfileId: PolicyProfileId = this.profileId,
  ): HookRunOutcome {
    const effect = failureEffect({
      cls: reg.class,
      event,
      failure,
      // Per-fire profile (flow 306, W6, fix round 1, finding 16) — a
      // `ctx.profileId` override changes which registrations were even
      // SELECTED for this fire, so the failure semantics it triggers (e.g.
      // gate-advisory's `unattended-untrusted` deny-instead-of-proceed) must
      // reason about that same live profile, not the runtime's construction
      // profile. Defaults to `this.profileId` for every failure path that
      // has no fire in flight yet (byte-identical when no `ctx.profileId`
      // override is given, which is every existing failure-matrix test).
      profileId: fireProfileId,
      ...(decideOutcome !== undefined ? { decideOutcome } : {}),
    });
    const decision: PolicyOutcome | undefined = effect.effect === "deny" ? "deny" : undefined;
    const record: HookInvocationRecord = {
      hookId: reg.id,
      event,
      class: reg.class,
      scope: reg.scope,
      outcome: decision ?? "none",
      failure,
      reason: effect.reason,
      durationMs,
      changedOutcome: effect.effect === "deny",
    };
    return {
      record,
      ...(decision !== undefined ? { decision } : {}),
      ...(effect.warning !== undefined ? { warning: { name: effect.warning, hookId: reg.id, detail: effect.reason } } : {}),
      anomalies: [],
    };
  }

  private async runCommandHook(
    reg: HookRegistration,
    event: HookEventName,
    payload: Record<string, unknown>,
    ctx: FireContext,
    fireProfileId: PolicyProfileId,
  ): Promise<HookRunOutcome> {
    if (reg.handler.kind !== "command") throw new Error("runCommandHook requires a command handler");
    const stdinObj = buildHookStdin(event, payload, {
      hookId: reg.id,
      timestamp: this.clock(),
      projectRoot: this.projectRoot,
    });
    const env = buildHookEnv({
      processEnv: process.env,
      ...(reg.handler.env !== undefined ? { commandEnv: reg.handler.env } : {}),
      hookEvent: event,
      hookId: reg.id,
      sessionId: this.sessionId,
      runId: this.runId,
      projectRoot: this.projectRoot,
      policyProfile: fireProfileId,
    });
    const argv = this.argvResolver(reg.handler.argv);
    const isolationRequired = isIsolationRequired(fireProfileId);
    const raw = await this.runner.run({
      argv,
      cwd: reg.handler.cwd ?? ".",
      env,
      stdin: JSON.stringify(stdinObj),
      timeoutMs: reg.timeoutMs,
      network: reg.network,
      runsIn: resolveBuiltinCommandRunsIn(reg, fireProfileId),
      isolationRequired,
    });
    const parsed = parseHookResult(
      { exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr, timedOut: raw.timedOut, ...(raw.spawnError !== undefined ? { spawnError: raw.spawnError } : {}) },
      { cls: reg.class, event },
    );
    if (parsed.kind === "failure") {
      return this.buildFailureOutcome(reg, event, raw.durationMs, parsed.failure, ctx.decideOutcome, fireProfileId);
    }
    const anomalies: HookAnomaly[] = this.dedupeOncePerSession(parsed.anomalies.map((name) => ({ name, hookId: reg.id })));
    const record: HookInvocationRecord = {
      hookId: reg.id,
      event,
      class: reg.class,
      scope: reg.scope,
      outcome: parsed.decision ?? "none",
      durationMs: raw.durationMs,
      changedOutcome: parsed.decision === "deny",
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
    };
    return {
      record,
      ...(parsed.decision !== undefined ? { decision: parsed.decision } : {}),
      ...(parsed.additionalContext !== undefined ? { additionalContext: parsed.additionalContext } : {}),
      anomalies,
    };
  }

  private async runBuiltinHook(
    reg: HookRegistration,
    event: HookEventName,
    payload: Record<string, unknown>,
    ctx: FireContext,
    fireProfileId: PolicyProfileId,
  ): Promise<HookRunOutcome> {
    if (reg.handler.kind !== "builtin") throw new Error("runBuiltinHook requires a builtin handler");
    const startedAt = Date.now();

    if (reg.handler.name === "learning-observer") {
      const kind = (LEARNING_OBSERVER_EVENT_KIND as Partial<Record<HookEventName, LearningObservation["kind"]>>)[event];
      if (kind === undefined) {
        // Registered on an event outside the fixed seven — should never happen
        // (builtins.ts pins the list), but fail closed rather than crash.
        return this.buildFailureOutcome(reg, event, Date.now() - startedAt, "crash", ctx.decideOutcome, fireProfileId);
      }
      const sink = this.ports.learningSink ?? NOOP_LEARNING_OBSERVATION_SINK;
      const result = await runWithTimeout(
        () => sink.record({ kind, sessionId: this.sessionId, runId: this.runId, timestamp: this.clock(), payload }),
        reg.timeoutMs,
      );
      const durationMs = Date.now() - startedAt;
      if (!result.ok) {
        return this.buildFailureOutcome(reg, event, durationMs, result.failure, ctx.decideOutcome, fireProfileId);
      }
      return {
        record: { hookId: reg.id, event, class: reg.class, scope: reg.scope, outcome: "none", durationMs, changedOutcome: false },
        anomalies: [],
      };
    }

    if (reg.handler.name === "impact-evidence") {
      // F-001 (fix round 3): every file this ONE call touches, not just a
      // single `filePath` field — `apply_patch`'s `{patch}` shape can name
      // several files, and W8's batch rule requires none of them dodge the
      // gate just because a sibling target already rode along.
      const files = extractFilePaths(payload);
      // F-002 (fix round 3): a file only leaves `editedFiles` CLEAN once a
      // call for it has actually resolved without escalating or failing —
      // see the "only mark on a clean allow" write below. Marking it here,
      // before the provider has even been asked, used to disarm the gate for
      // the rest of the session on a refused/crashed/timed-out FIRST attempt:
      // the model only had to repeat the same call to skip the gate for
      // good. `firstEdit` is true whenever at least one of `files` has never
      // been cleanly resolved — a batch with one already-clear file and one
      // new one still calls the provider (with the full file list; W8 keeps
      // its own per-file `touched`/`pendingAck`/`denials` state and answers
      // an already-clear file with `skipped-repeat` rather than re-asking).
      const firstEdit = files.some((f) => !this.editedFiles.has(f));
      if (files.length === 0 || !firstEdit) {
        return {
          record: {
            hookId: reg.id,
            event,
            class: reg.class,
            scope: reg.scope,
            outcome: "none",
            durationMs: Date.now() - startedAt,
            changedOutcome: false,
          },
          anomalies: [],
        };
      }
      const provider = this.ports.impactEvidence ?? NOOP_IMPACT_EVIDENCE_PROVIDER;
      const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
      const result = await runWithTimeout(
        () =>
          provider.evidenceFor({
            sessionId: this.sessionId,
            files,
            toolName,
            projectRoot: this.projectRoot,
            firstEditInSession: true,
          }),
        reg.timeoutMs,
      );
      const durationMs = Date.now() - startedAt;
      if (!result.ok) {
        // F-002: NOT marked clean — a retry of the same file(s) must still
        // call the provider, whether this attempt asked-and-was-declined,
        // crashed, or timed out.
        return this.buildFailureOutcome(reg, event, durationMs, result.failure, ctx.decideOutcome, fireProfileId);
      }
      const decision = result.value.decision;
      if (decision === undefined) {
        // A clean, non-escalating outcome (W8 "allow") — NOW it is safe to
        // stop gating these files for the rest of the session (F-002).
        for (const f of files) this.editedFiles.add(f);
      }
      // F-003: forward W8's warnings (e.g. a rejected out-of-root path)
      // rather than dropping them — folded into the invocation record's
      // `reason` so they land somewhere a caller/log can actually see them,
      // without inventing a new anomaly taxonomy for a non-failure signal.
      const warnings = result.value.warnings ?? [];
      const reason = warnings.length > 0 ? warnings.join("; ") : undefined;
      return {
        record: {
          hookId: reg.id,
          event,
          class: reg.class,
          scope: reg.scope,
          outcome: decision ?? "none",
          durationMs,
          changedOutcome: decision !== undefined,
          ...(reason !== undefined ? { reason } : {}),
        },
        ...(decision !== undefined ? { decision } : {}),
        ...(result.value.additionalContext !== undefined ? { additionalContext: result.value.additionalContext } : {}),
        anomalies: [],
      };
    }

    // Unknown builtin handler name — fail closed rather than silently no-op.
    return this.buildFailureOutcome(reg, event, Date.now() - startedAt, "crash", ctx.decideOutcome, fireProfileId);
  }

  /**
   * A hook that throws synchronously, or whose returned promise rejects
   * (e.g. a builtin port implementation with a bug, or — before the
   * `runner.ts` fix for finding 3 — a synchronous `spawn()` throw that used
   * to escape as an unhandled rejection), must never propagate out of
   * `fire()`: an uncaught rejection here was observed reaching
   * `agent.ts`/`spawn-subagent-tool.ts` as "hook failed (ignored)", i.e. a
   * gate crash that failed OPEN instead of running normal crash-failure
   * semantics. Catch it here and route it through the same
   * `buildFailureOutcome("crash", ...)` path every other failure kind uses.
   */
  private async runOneHook(
    reg: HookRegistration,
    event: HookEventName,
    payload: Record<string, unknown>,
    ctx: FireContext,
    fireProfileId: PolicyProfileId,
  ): Promise<HookRunOutcome> {
    const startedAt = Date.now();
    try {
      return await (reg.handler.kind === "command"
        ? this.runCommandHook(reg, event, payload, ctx, fireProfileId)
        : this.runBuiltinHook(reg, event, payload, ctx, fireProfileId));
    } catch {
      return this.buildFailureOutcome(reg, event, Date.now() - startedAt, "crash", ctx.decideOutcome, fireProfileId);
    }
  }

  async fire(event: HookEventName, payload: Record<string, unknown>, ctx: FireContext = {}): Promise<HookFireResult> {
    // T14: a per-fire `ctx.profileId` overrides the runtime's own constructed
    // `profileId` for SELECTION (which registrations' `profiles` match) AND,
    // since flow 306 fix round 1 finding 16, for FAILURE SEMANTICS too —
    // `buildFailureOutcome` takes this same `fireProfileId` (defaulting to
    // `this.profileId` only when no fire is in flight yet), so a gate-advisory
    // failure (e.g. `unattended-untrusted`'s deny-instead-of-proceed) reasons
    // about the LIVE per-fire profile, not the runtime's construction-time
    // one — a `ctx.profileId` override that changed which registrations ran
    // must also change what a crash under them means. Absent ⇒ byte-identical
    // to before this field existed.
    const fireProfileId = ctx.profileId ?? this.profileId;
    const candidates = this.selectCandidates(event, ctx.toolName ?? "", fireProfileId);
    const gateGroup = candidates.filter((r) => r.class === "gate" || r.class === "gate-advisory");
    const parallelGroup = candidates.filter((r) => r.class === "observe" || r.class === "context");

    const outcomes: HookRunOutcome[] = [];

    for (const reg of gateGroup) {
      const outcome = await this.runOneHook(reg, event, payload, ctx, fireProfileId);
      outcomes.push(outcome);
      if (outcome.decision === "deny") {
        break; // First deny short-circuits the remaining gate hooks for this event.
      }
    }

    // Parallel group: raced against its own timeout so `fire()` never waits
    // longer than the slowest observe/context hook's configured budget, even
    // if a runner implementation (e.g. a test fake) fails to resolve on its
    // own. A race loser's eventual settlement is not awaited further.
    const parallelOutcomes = await Promise.all(
      parallelGroup.map(async (reg): Promise<HookRunOutcome> => {
        const started = Date.now();
        const timeoutDelay = delay(reg.timeoutMs);
        let raced: { timedOut: false; outcome: HookRunOutcome } | { timedOut: true };
        try {
          raced = await Promise.race<
            { timedOut: false; outcome: HookRunOutcome } | { timedOut: true }
          >([
            this.runOneHook(reg, event, payload, ctx, fireProfileId).then((outcome) => ({ timedOut: false as const, outcome })),
            timeoutDelay.promise.then(() => ({ timedOut: true as const })),
          ]);
        } finally {
          timeoutDelay.clear();
        }
        if (raced.timedOut) {
          return this.buildFailureOutcome(reg, event, Date.now() - started, "timeout", ctx.decideOutcome, fireProfileId);
        }
        return raced.outcome;
      }),
    );
    outcomes.push(...parallelOutcomes);

    const decisions = outcomes
      .filter((o): o is HookRunOutcome & { decision: PolicyOutcome } => o.decision !== undefined)
      .map((o) => ({ hookId: o.record.hookId, decision: o.decision }));

    let tightened: PolicyOutcome | undefined;
    let denyReason: string | undefined;
    if (GATE_CAPABLE_EVENTS.includes(event) && event !== "PreToolUse") {
      const result = tightenOutcome("allow", decisions, this.interactive);
      tightened = result.outcome;
      if (result.outcome === "deny" && result.matchedRules.length > 0) {
        denyReason = result.matchedRules.join(", ");
      }
    }

    return {
      decisions,
      ...(tightened !== undefined ? { tightened } : {}),
      ...(denyReason !== undefined ? { denyReason } : {}),
      additionalContext: outcomes.flatMap((o) => (o.additionalContext !== undefined ? [o.additionalContext] : [])),
      records: outcomes.map((o) => o.record),
      warnings: outcomes.flatMap((o) => (o.warning !== undefined ? [o.warning] : [])),
      anomalies: outcomes.flatMap((o) => o.anomalies),
    };
  }
}

/** Build a {@link HookRuntime} over a resolved registration list. */
export function createHookRuntime(opts: CreateHookRuntimeOptions): HookRuntime {
  return new HookRuntimeImpl(opts);
}
