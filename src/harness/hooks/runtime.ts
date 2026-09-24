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
import type {
  HookAnomalyName,
  HookEventName,
  HookFailureKind,
  HookInvocationRecord,
  HookRegistration,
} from "./types";
import type { HookProcessRunner } from "./runner";
import type { PolicyOutcome, PolicyProfileId } from "../policy/types";

export interface HookRuntimePorts {
  learningSink?: LearningObservationSink;
  impactEvidence?: ImpactEvidenceProvider;
}

export interface FireContext {
  toolName?: string;
  /** The underlying `decide()` outcome this event is gating, when known (the gate malformed-output asymmetry). */
  decideOutcome?: PolicyOutcome;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const timeout = delay(timeoutMs).then(
    (): TimeoutRaceResult<T> => ({ ok: false, failure: "timeout", reason: "Builtin hook exceeded its timeout." }),
  );
  return Promise.race([work, timeout]);
}

/** Best-effort file-path extraction from a `PreToolUse` payload's `toolInput` (Write/Edit tool shapes vary). */
function extractFilePath(payload: Record<string, unknown>): string | undefined {
  const toolInput = payload.toolInput;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const record = toolInput as Record<string, unknown>;
  for (const key of ["filePath", "file_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
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

  private selectCandidates(event: HookEventName, toolName: string): HookRegistration[] {
    const perTool = PER_TOOL_EVENTS.includes(event);
    return this.regs
      .filter((reg) => reg.event === event && reg.enabled)
      .filter((reg) => reg.profiles.length === 0 || reg.profiles.includes(this.profileId))
      .filter((reg) => this.matcherMatches(reg, toolName, perTool))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  private buildFailureOutcome(
    reg: HookRegistration,
    event: HookEventName,
    durationMs: number,
    failure: HookFailureKind,
    decideOutcome: PolicyOutcome | undefined,
  ): HookRunOutcome {
    const effect = failureEffect({
      cls: reg.class,
      event,
      failure,
      profileId: this.profileId,
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
      policyProfile: this.profileId,
    });
    const argv = this.argvResolver(reg.handler.argv);
    const raw = await this.runner.run({
      argv,
      cwd: reg.handler.cwd ?? ".",
      env,
      stdin: JSON.stringify(stdinObj),
      timeoutMs: reg.timeoutMs,
      network: reg.network,
      runsIn: reg.runsIn,
    });
    const parsed = parseHookResult(
      { exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr, timedOut: raw.timedOut, ...(raw.spawnError !== undefined ? { spawnError: raw.spawnError } : {}) },
      { cls: reg.class, event },
    );
    if (parsed.kind === "failure") {
      return this.buildFailureOutcome(reg, event, raw.durationMs, parsed.failure, ctx.decideOutcome);
    }
    const anomalies: HookAnomaly[] = parsed.anomalies.map((name) => ({ name, hookId: reg.id }));
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
  ): Promise<HookRunOutcome> {
    if (reg.handler.kind !== "builtin") throw new Error("runBuiltinHook requires a builtin handler");
    const startedAt = Date.now();

    if (reg.handler.name === "learning-observer") {
      const kind = (LEARNING_OBSERVER_EVENT_KIND as Partial<Record<HookEventName, LearningObservation["kind"]>>)[event];
      if (kind === undefined) {
        // Registered on an event outside the fixed seven — should never happen
        // (builtins.ts pins the list), but fail closed rather than crash.
        return this.buildFailureOutcome(reg, event, Date.now() - startedAt, "crash", ctx.decideOutcome);
      }
      const sink = this.ports.learningSink ?? NOOP_LEARNING_OBSERVATION_SINK;
      const result = await runWithTimeout(
        () => sink.record({ kind, sessionId: this.sessionId, runId: this.runId, timestamp: this.clock(), payload }),
        reg.timeoutMs,
      );
      const durationMs = Date.now() - startedAt;
      if (!result.ok) {
        return this.buildFailureOutcome(reg, event, durationMs, result.failure, ctx.decideOutcome);
      }
      return {
        record: { hookId: reg.id, event, class: reg.class, scope: reg.scope, outcome: "none", durationMs, changedOutcome: false },
        anomalies: [],
      };
    }

    if (reg.handler.name === "impact-evidence") {
      const filePath = extractFilePath(payload);
      const firstEdit = filePath !== undefined && !this.editedFiles.has(filePath);
      if (filePath !== undefined && firstEdit) {
        this.editedFiles.add(filePath);
      }
      if (filePath === undefined || !firstEdit) {
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
            filePath,
            toolName,
            projectRoot: this.projectRoot,
            firstEditInSession: true,
          }),
        reg.timeoutMs,
      );
      const durationMs = Date.now() - startedAt;
      if (!result.ok) {
        return this.buildFailureOutcome(reg, event, durationMs, result.failure, ctx.decideOutcome);
      }
      const decision = result.value.decision;
      return {
        record: {
          hookId: reg.id,
          event,
          class: reg.class,
          scope: reg.scope,
          outcome: decision ?? "none",
          durationMs,
          changedOutcome: decision === "ask",
        },
        ...(decision !== undefined ? { decision } : {}),
        ...(result.value.additionalContext !== undefined ? { additionalContext: result.value.additionalContext } : {}),
        anomalies: [],
      };
    }

    // Unknown builtin handler name — fail closed rather than silently no-op.
    return this.buildFailureOutcome(reg, event, Date.now() - startedAt, "crash", ctx.decideOutcome);
  }

  private runOneHook(
    reg: HookRegistration,
    event: HookEventName,
    payload: Record<string, unknown>,
    ctx: FireContext,
  ): Promise<HookRunOutcome> {
    return reg.handler.kind === "command"
      ? this.runCommandHook(reg, event, payload, ctx)
      : this.runBuiltinHook(reg, event, payload, ctx);
  }

  async fire(event: HookEventName, payload: Record<string, unknown>, ctx: FireContext = {}): Promise<HookFireResult> {
    const candidates = this.selectCandidates(event, ctx.toolName ?? "");
    const gateGroup = candidates.filter((r) => r.class === "gate" || r.class === "gate-advisory");
    const parallelGroup = candidates.filter((r) => r.class === "observe" || r.class === "context");

    const outcomes: HookRunOutcome[] = [];

    for (const reg of gateGroup) {
      const outcome = await this.runOneHook(reg, event, payload, ctx);
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
        const raced = await Promise.race<
          { timedOut: false; outcome: HookRunOutcome } | { timedOut: true }
        >([
          this.runOneHook(reg, event, payload, ctx).then((outcome) => ({ timedOut: false as const, outcome })),
          delay(reg.timeoutMs).then(() => ({ timedOut: true as const })),
        ]);
        if (raced.timedOut) {
          return this.buildFailureOutcome(reg, event, Date.now() - started, "timeout", ctx.decideOutcome);
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
